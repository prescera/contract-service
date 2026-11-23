// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.
//
// Run authorization and the Run Authorization Token (spec §9.3), run events
// and execution receipts (spec §9.5).

import * as ccfapp from "@microsoft/ccf-app";
import {
  ApiError,
  arr,
  AttestedClaims,
  bindClaim,
  checkReleaseReceiptForRun,
  checkTrustBundle,
  consumeFreshJti,
  digest,
  DIGEST_RE,
  EcPublicJwk,
  endpoint,
  EXEC_RECEIPT_TYP,
  formatRfc3339,
  getSettings,
  int,
  isObject,
  JsonObject,
  JsonTable,
  jsonBody,
  keys,
  matchingApprovedReleases,
  nowSeconds,
  num,
  obj,
  oneOf,
  optStr,
  parseJws,
  parseRfc3339,
  pathParam,
  Platform,
  RAT_AUDIENCE,
  RAT_LIFETIME_S,
  RAT_TYP,
  RELEASE_RECEIPT_TYP,
  requireBaseUrl,
  requireBootstrapped,
  requirePeer,
  RUN_EVENT_TYP,
  RunBinding,
  serviceSigningKey,
  signedEnvelope,
  str,
  UUID4_RE,
  validateReleaseReceiptClaims,
  validateRunBinding,
  verifyAttestation,
  verifyJws,
  verifyPeerJws,
} from "../packages/depa-ccf-common/src/index";
import { PEER_NAME } from "./constants";
import { ContractRecord, contractIdFromPath, contractsTable, effectiveContractState, requireContract } from "./contracts";

export type RunState = "authorized" | "running" | "completed" | "failed";
const EVENT_TYPES = ["started", "progress", "completed", "failed"] as const;
type EventType = (typeof EVENT_TYPES)[number];
const MAX_EVENTS_PER_RUN = 10000;

export interface RunRecord {
  run_id: string;
  contract_id: string;
  contract_digest: string;
  binding: RunBinding;
  binding_hash: string;
  run_key: EcPublicJwk;
  recipe_digest: string;
  platform: Platform;
  measurement_id: string;
  tier: 1 | 2 | 3;
  release_id: string | null;
  attestation: Record<string, unknown>;
  state: RunState;
  authorized_at: number;
  deadline: number;
  last_seq: number;
  event_count: number;
  terminal_at?: number;
  receipt?: JsonObject;
  receipt_jws?: string;
  /** RAT claims without iat/exp; refreshes re-issue exactly these (spec §9.3a). */
  rat_claims: RatBaseClaims;
}

type RatBaseClaims = Record<string, unknown> & { deadline: number };

interface RunEvent {
  seq: number;
  type: EventType;
  at: string;
  data: unknown;
  jws: string;
  received_at: number;
}

const runsTable = new JsonTable<RunRecord>("public:depa.runs");
const runEventsTable = new JsonTable<RunEvent>("public:depa.run_events");
const contractRunsTable = new JsonTable<string[]>("public:depa.contract_runs");

/** Spec §9.3 measurement rule. Returns the matched release id (tier 1/2) or null (tier 3). */
function checkMeasurement(c: ContractRecord, claims: AttestedClaims): string | null {
  const p = c.parsed;
  if (p.tier === 3) {
    const cc = p.custom_ccr as NonNullable<typeof p.custom_ccr>;
    if (claims.platform !== cc.platform || claims.measurement_id !== cc.measurement_id) {
      throw ApiError.forbidden("attested measurement is not the contract's custom CCR", "measurement_not_approved");
    }
    return null;
  }
  const r = matchingApprovedReleases(claims).find(
    (rel) => p.ccr_releases.includes(rel.release_id) && (rel.tiers as number[]).includes(p.tier),
  );
  if (!r) {
    throw ApiError.forbidden(
      "attested measurement is not in an approved, non-revoked release listed in the contract",
      "measurement_not_approved",
    );
  }
  return r.release_id;
}

/** Signs a RAT with exp = min(now + 300, deadline) and binds it to the transaction. */
function issueRat(base: RatBaseClaims, now: number): string {
  const rat = { ...base, iat: now, exp: Math.min(now + RAT_LIFETIME_S, base.deadline) };
  bindClaim(rat);
  return serviceSigningKey.sign(RAT_TYP, rat);
}

export const authorizeRun = endpoint("runs.authorize", (request) => {
  requireBootstrapped();
  const contractId = contractIdFromPath(request);
  const body = obj(jsonBody(request), "body");
  keys(body, "body", ["binding", "attestation"]);
  const now = nowSeconds();
  const { binding, binding_hash } = validateRunBinding(body.binding);
  const settings = getSettings();
  checkTrustBundle(binding, settings);
  const claims = verifyAttestation(body.attestation, binding_hash, request, settings, now);
  if (claims.platform !== binding.platform) throw ApiError.forbidden("attested platform does not match binding.platform", "platform_mismatch");
  if (binding.contract_id !== contractId) throw ApiError.badRequest("binding.contract_id must equal the path contract_id", "invalid_input");

  const c = requireContract(contractId);
  if (binding.contract_digest !== c.contract_digest) throw ApiError.forbidden("binding.contract_digest does not match", "digest_mismatch");
  const state = effectiveContractState(c, now);
  if (state !== "active") throw ApiError.forbidden(`contract is ${state}`, "contract_not_active");
  const p = c.parsed;
  if (!p.recipe_digests.includes(binding.recipe_digest)) throw ApiError.forbidden("recipe is not part of the contract", "recipe_not_allowed");
  if (!p.platforms.includes(claims.platform)) throw ApiError.forbidden("platform is not allowed by the contract", "platform_not_allowed");
  const releaseId = checkMeasurement(c, claims);
  if (runsTable.has(binding.run_id)) throw ApiError.conflict("run_id already used", "run_exists");

  c.runs_used += 1;
  contractsTable.set(contractId, c);
  const deadline = now + p.max_duration_minutes * 60;
  const ratClaims: RatBaseClaims = {
    iss: requireBaseUrl(),
    aud: RAT_AUDIENCE,
    sub: binding.run_id,
    contract_id: contractId,
    contract_digest: c.contract_digest,
    run_id: binding.run_id,
    binding_hash,
    platform: claims.platform,
    measurement_id: claims.measurement_id,
    tier: p.tier,
    custom_measurement: p.tier === 3,
    ccr_releases: p.ccr_releases,
    recipe_digest: binding.recipe_digest,
    tdc: p.tdc,
    purpose: p.purpose,
    datasets: p.datasets,
    privacy: p.privacy,
    output: { mode: p.output_mode, recipients: p.recipients },
    deadline,
  };
  const run: RunRecord = {
    run_id: binding.run_id,
    contract_id: contractId,
    contract_digest: c.contract_digest,
    binding,
    binding_hash,
    run_key: binding.run_key,
    recipe_digest: binding.recipe_digest,
    platform: claims.platform,
    measurement_id: claims.measurement_id,
    tier: p.tier,
    release_id: releaseId,
    attestation: claims.raw,
    state: "authorized",
    authorized_at: now,
    deadline,
    last_seq: -1,
    event_count: 0,
    rat_claims: ratClaims,
  };
  runsTable.set(run.run_id, run);
  contractRunsTable.set(contractId, [...(contractRunsTable.get(contractId) ?? []), run.run_id]);

  const rat = issueRat(ratClaims, now);
  return { run_id: run.run_id, rat, deadline };
});

/** Validates an Execution Receipt for `run` (spec §9.5). */
export function validateExecutionReceipt(data: unknown, run: RunRecord, c: ContractRecord): JsonObject {
  const r = obj(data, "receipt");
  keys(
    r,
    "receipt",
    ["run_id", "contract_id", "contract_digest", "recipe_digest", "platform", "measurement_id", "started_at", "finished_at", "inputs", "outputs", "status"],
    ["privacy_spent", "metrics"],
  );
  const mismatch = (f: string) => ApiError.badRequest(`receipt.${f} does not match the run`, "receipt_mismatch");
  if (r.run_id !== run.run_id) throw mismatch("run_id");
  if (r.contract_id !== run.contract_id) throw mismatch("contract_id");
  if (r.contract_digest !== run.contract_digest) throw mismatch("contract_digest");
  if (r.recipe_digest !== run.recipe_digest) throw mismatch("recipe_digest");
  if (r.platform !== run.platform) throw mismatch("platform");
  if (r.measurement_id !== run.measurement_id) throw mismatch("measurement_id");
  if (r.status !== "succeeded") throw ApiError.badRequest("receipt.status must be succeeded for a completed event", "invalid_input");
  const started = parseRfc3339(r.started_at, "receipt.started_at");
  const finished = parseRfc3339(r.finished_at, "receipt.finished_at");
  if (finished < started) throw ApiError.badRequest("receipt.finished_at precedes started_at", "invalid_input");

  // Every contract dataset needs a valid KMS release receipt for this run.
  const kms = requirePeer(PEER_NAME);
  const p = c.parsed;
  const inputs = arr(r.inputs, "receipt.inputs", (x, q) => obj(x, q), { max: 64 });
  if (inputs.length !== p.datasets.length) {
    throw ApiError.badRequest("receipt.inputs must list exactly the contract datasets", "receipt_inputs");
  }
  for (const d of p.datasets) {
    const matches = inputs.filter((i) => i.dataset_id === d.dataset_id);
    if (matches.length !== 1) throw ApiError.badRequest(`receipt.inputs: need exactly one entry for ${d.dataset_id}`, "receipt_inputs");
    const input = matches[0];
    keys(input, "receipt.inputs[]", ["dataset_id", "version", "manifest_digest", "release_receipt"]);
    if (input.version !== d.version || input.manifest_digest !== d.manifest_digest) {
      throw ApiError.badRequest(`receipt.inputs: ${d.dataset_id} version/manifest does not match the contract`, "receipt_inputs");
    }
    const claims = validateReleaseReceiptClaims(verifyPeerJws(input.release_receipt, kms, RELEASE_RECEIPT_TYP));
    checkReleaseReceiptForRun(claims, run, d.dataset_id);
  }

  if (p.privacy.mode === "dp") {
    const ps = obj(r.privacy_spent, "receipt.privacy_spent");
    keys(ps, "receipt.privacy_spent", ["mode", "epsilon", "delta"], ["accountant"]);
    oneOf(ps.mode, "receipt.privacy_spent.mode", ["dp"] as const);
    const eps = num(ps.epsilon, "receipt.privacy_spent.epsilon", { min: 0 });
    const delta = num(ps.delta, "receipt.privacy_spent.delta", { min: 0 });
    optStr(ps.accountant, "receipt.privacy_spent.accountant", { max: 64 });
    if (eps > (p.privacy.epsilon as number) || delta > (p.privacy.delta as number)) {
      throw ApiError.forbidden("receipt.privacy_spent exceeds the contract budget", "privacy_exceeded");
    }
  } else if (r.privacy_spent !== undefined) {
    const ps = obj(r.privacy_spent, "receipt.privacy_spent");
    keys(ps, "receipt.privacy_spent", ["mode"]);
    oneOf(ps.mode, "receipt.privacy_spent.mode", ["none"] as const);
  }

  const outputKidPrefix = `kms:output:${run.contract_id}#`;
  arr(
    r.outputs,
    "receipt.outputs",
    (x, q) => {
      const o = obj(x, q);
      keys(o, q, ["name", "format", "manifest_digest", "location", "recipients"]);
      str(o.name, `${q}.name`, { re: /^[A-Za-z0-9._-]{1,128}$/ });
      if (!p.allowed_formats.includes(str(o.format, `${q}.format`, { max: 32 }))) {
        throw ApiError.forbidden(`${q}.format is not allowed by the contract`, "output_format");
      }
      str(o.manifest_digest, `${q}.manifest_digest`, { re: DIGEST_RE });
      str(o.location, `${q}.location`, { max: 2048 });
      const recips = arr(o.recipients, `${q}.recipients`, (y, s) => str(y, s, { max: 256 }), { min: 1, max: 32, unique: true });
      for (const rc of recips) {
        const ok = p.output_mode === "tdc" ? p.recipients.includes(rc) : rc.startsWith(outputKidPrefix);
        if (!ok) throw ApiError.forbidden(`${q}.recipients: ${rc} is not allowed by the contract`, "output_recipient");
      }
      return o;
    },
    { max: 64 },
  );

  if (r.metrics !== undefined) {
    const m = obj(r.metrics, "receipt.metrics");
    for (const k of Object.keys(m)) {
      if (!p.metrics_allowlist.includes(k)) throw ApiError.forbidden(`receipt.metrics.${k} is not in the metrics allowlist`, "metric_not_allowed");
      num(m[k], `receipt.metrics.${k}`);
    }
  }
  return r;
}

function runIdFromPath(request: ccfapp.Request): string {
  const id = pathParam(request, "run_id");
  if (!UUID4_RE.test(id)) throw ApiError.badRequest("invalid run_id");
  return id;
}

export const postRunEvent = endpoint("runs.event", (request) => {
  requireBootstrapped();
  const contractId = contractIdFromPath(request);
  const runId = runIdFromPath(request);
  const run = runsTable.get(runId);
  if (!run || run.contract_id !== contractId) throw ApiError.notFound(`run ${runId} not found`);
  const parsed = parseJws(signedEnvelope(request), RUN_EVENT_TYP);
  if (parsed.alg !== "ES256" || !verifyJws(parsed, run.run_key)) {
    throw ApiError.unauthorized("run event signature is not valid under the run key", "invalid_signature");
  }
  const e = parsed.payload;
  keys(e, "event", ["run_id", "seq", "type", "at", "data"]);
  if (e.run_id !== runId) throw ApiError.badRequest("event.run_id does not match the path", "invalid_input");
  const seq = int(e.seq, "event.seq", { min: 0 });
  const type = oneOf(e.type, "event.type", EVENT_TYPES);
  const at = str(e.at, "event.at", { max: 64 });
  parseRfc3339(at, "event.at");
  if (seq <= run.last_seq) throw ApiError.conflict("event.seq must be strictly increasing", "stale_seq");
  if (run.state === "completed" || run.state === "failed") throw ApiError.conflict(`run is ${run.state}`, "run_terminal");
  if (run.event_count >= MAX_EVENTS_PER_RUN) throw ApiError.conflict("event limit reached", "event_limit");
  const now = nowSeconds();
  if (now > run.deadline && type !== "completed" && type !== "failed") {
    throw ApiError.conflict("run deadline has passed; only completed/failed are accepted", "deadline_passed");
  }

  const c = requireContract(contractId);
  let response: Record<string, unknown> = { run_id: runId, seq, state: run.state };
  if (type === "started") {
    if (run.state !== "authorized") throw ApiError.conflict("run already started", "run_state");
    run.state = "running";
  } else if (type === "progress") {
    if (!isObject(e.data) && e.data !== null) throw ApiError.badRequest("event.data must be an object", "invalid_input");
  } else if (type === "failed") {
    if (!isObject(e.data)) throw ApiError.badRequest("event.data must be an object", "invalid_input");
    run.state = "failed";
    run.terminal_at = now;
  } else {
    const receipt = validateExecutionReceipt(e.data, run, c);
    const signed = {
      iss: requireBaseUrl(),
      iat: now,
      sub: runId,
      receipt_digest: digest(receipt),
      receipt,
    };
    run.state = "completed";
    run.terminal_at = now;
    run.receipt = receipt;
    run.receipt_jws = serviceSigningKey.sign(EXEC_RECEIPT_TYP, signed);
    bindClaim(signed);
    response = { receipt_jws: run.receipt_jws };
  }
  runEventsTable.set(`${runId}#${run.event_count}`, { seq, type, at, data: e.data, jws: parsed.raw, received_at: now });
  run.last_seq = seq;
  run.event_count += 1;
  runsTable.set(runId, run);
  return { ...response, run_id: runId, seq, state: run.state };
});

/**
 * POST /contracts/{id}/runs/{run_id}/rat — RAT refresh (spec §9.3a), signed
 * with the run key. Re-checks run and contract state; does not consume a run.
 */
export const refreshRat = endpoint("runs.refresh_rat", (request) => {
  requireBootstrapped();
  const contractId = contractIdFromPath(request);
  const runId = runIdFromPath(request);
  const run = runsTable.get(runId);
  if (!run || run.contract_id !== contractId) throw ApiError.notFound(`run ${runId} not found`);
  const parsed = parseJws(signedEnvelope(request), RUN_EVENT_TYP);
  if (parsed.alg !== "ES256" || !verifyJws(parsed, run.run_key)) {
    throw ApiError.unauthorized("refresh request signature is not valid under the run key", "invalid_signature");
  }
  const p = parsed.payload;
  keys(p, "payload", ["op", "contract_id", "run_id", "iat", "jti"]);
  if (p.op !== "run.refresh_rat") throw ApiError.unauthorized("payload op must be run.refresh_rat", "wrong_operation");
  if (p.contract_id !== contractId || p.run_id !== runId) throw ApiError.badRequest("payload does not match the path", "invalid_input");
  consumeFreshJti(p.iat, p.jti);
  if (run.state === "completed" || run.state === "failed") throw ApiError.conflict(`run is ${run.state}`, "run_terminal");
  const now = nowSeconds();
  if (now >= run.deadline) throw ApiError.forbidden("run deadline has passed", "deadline_passed");
  const c = requireContract(contractId);
  // "exhausted" is fine here: the in-flight run already consumed its slot.
  if (c.state !== "signed" || now > c.parsed.not_after) {
    throw ApiError.forbidden(`contract is ${effectiveContractState(c, now)}`, "contract_not_active");
  }
  return { run_id: runId, rat: issueRat(run.rat_claims, now), deadline: run.deadline };
});

function runView(run: RunRecord, withEvents: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    run_id: run.run_id,
    contract_id: run.contract_id,
    contract_digest: run.contract_digest,
    state: run.state,
    platform: run.platform,
    measurement_id: run.measurement_id,
    tier: run.tier,
    release_id: run.release_id,
    recipe_digest: run.recipe_digest,
    binding_hash: run.binding_hash,
    run_key: run.run_key,
    attestation: run.attestation,
    authorized_at: formatRfc3339(run.authorized_at),
    deadline: formatRfc3339(run.deadline),
    terminal_at: run.terminal_at === undefined ? null : formatRfc3339(run.terminal_at),
    receipt: run.receipt ?? null,
    receipt_jws: run.receipt_jws ?? null,
  };
  if (withEvents) {
    const events: RunEvent[] = [];
    for (let i = 0; i < run.event_count; i++) {
      const ev = runEventsTable.get(`${run.run_id}#${i}`);
      if (ev) events.push(ev);
    }
    view.events = events;
  }
  return view;
}

export const getRun = endpoint("runs.get", (request) => {
  const runId = runIdFromPath(request);
  const run = runsTable.get(runId);
  if (!run) throw ApiError.notFound(`run ${runId} not found`);
  return runView(run, true);
});

export const listRuns = endpoint("runs.list", (request) => {
  const contractId = contractIdFromPath(request);
  requireContract(contractId);
  const ids = contractRunsTable.get(contractId) ?? [];
  return { runs: ids.map((id) => runView(runsTable.get(id) as RunRecord, false)) };
});
