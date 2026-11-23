// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.
//
// Contracts (spec §8): schema "depa-training/contract/v2", signed by the TDC
// and the owner of every dataset, immutable once proposed. Governance can only
// revoke a contract; it can never change its content.

import * as ccfapp from "@microsoft/ccf-app";
import {
  ActionHandler,
  ApiError,
  arr,
  digest,
  DIGEST_RE,
  endpoint,
  formatRfc3339,
  int,
  JsonObject,
  JsonTable,
  keys,
  nowSeconds,
  obj,
  oneOf,
  optStr,
  parseRfc3339,
  PARTY_ID_RE,
  pathParam,
  Platform,
  PLATFORMS,
  queryParam,
  RatPrivacy,
  RELEASE_ID_RE,
  releasesTable,
  requireActiveParty,
  requireBootstrapped,
  str,
  UUID4_RE,
  validatePrivacy,
  verifySignedRequest,
} from "../packages/depa-ccf-common/src/index";
import { getCatalogVersionRecord, validateLocation } from "./catalog";
import { SERVICE_NAME } from "./constants";

export const CONTRACT_SCHEMA = "depa-training/contract/v2";
export const OUTPUT_FORMATS = ["safetensors", "onnx", "xgboost-json", "skops", "keras"] as const;
const RECIPIENT_RE = /^party:([a-z0-9][a-z0-9-]{1,62})#([A-Za-z0-9._-]{1,64})$/;

export interface ContractDataset {
  dataset_id: string;
  version: string;
  manifest_digest: string;
}

export interface CustomCcr {
  platform: Platform;
  measurement_id: string;
  image: string;
  source: string;
  review_report_digest: string;
}

/** Typed view of the security-relevant parts of a validated contract. */
export interface ParsedContract {
  contract_id: string;
  purpose: string;
  tdc: string;
  tdps: string[];
  ccrp: string | null;
  not_before: number;
  not_after: number;
  datasets: ContractDataset[];
  tier: 1 | 2 | 3;
  platforms: Platform[];
  ccr_releases: string[];
  custom_ccr: CustomCcr | null;
  recipe_digests: string[];
  max_runs: number;
  max_duration_minutes: number;
  privacy: RatPrivacy;
  output_mode: "tdc" | "tee-only";
  recipients: string[];
  allowed_formats: string[];
  max_bytes: number;
  metrics_allowlist: string[];
}

export interface Signature {
  party: string;
  jws: string;
  at: string;
}

export interface Revocation {
  by: string;
  reason: string;
  at: string;
  jws?: string;
  proposal_id?: string;
}

export interface ContractRecord {
  contract_id: string;
  contract: JsonObject;
  contract_digest: string;
  parsed: ParsedContract;
  required_signers: string[];
  signatures: Signature[];
  state: "draft" | "signed" | "revoked";
  revocation: Revocation | null;
  runs_used: number;
  proposed_by: string;
  propose_jws: string;
  created_at: string;
}

export type EffectiveContractState = "draft" | "signed" | "active" | "revoked" | "expired" | "exhausted";

export const contractsTable = new JsonTable<ContractRecord>("public:depa.contracts");
const contractsByParty = new JsonTable<string[]>("public:depa.contracts_by_party");

export function effectiveContractState(c: ContractRecord, now: number): EffectiveContractState {
  if (c.state === "revoked") return "revoked";
  if (now > c.parsed.not_after) return "expired";
  if (c.runs_used >= c.parsed.max_runs) return "exhausted";
  if (c.state === "draft") return "draft";
  return now >= c.parsed.not_before ? "active" : "signed";
}

function validateDatasets(v: unknown, tdps: string[]): ContractDataset[] {
  const datasets = arr(
    v,
    "contract.datasets",
    (x, p) => {
      const d = obj(x, p);
      keys(d, p, ["dataset_id", "version", "manifest_digest"]);
      const ds: ContractDataset = {
        dataset_id: str(d.dataset_id, `${p}.dataset_id`, { max: 200 }),
        version: str(d.version, `${p}.version`, { max: 64 }),
        manifest_digest: str(d.manifest_digest, `${p}.manifest_digest`, { re: DIGEST_RE }),
      };
      const rec = getCatalogVersionRecord(ds.dataset_id, ds.version);
      if (!rec) throw ApiError.badRequest(`${p}: ${ds.dataset_id}@${ds.version} is not in the catalog`, "unknown_dataset");
      if (rec.manifest_digest !== ds.manifest_digest) {
        throw ApiError.badRequest(`${p}.manifest_digest: does not match the catalog`, "manifest_mismatch");
      }
      const owner = ds.dataset_id.slice(0, ds.dataset_id.indexOf("/"));
      if (!tdps.includes(owner)) throw ApiError.badRequest(`${p}: owner ${owner} is not listed in parties.tdps`, "invalid_input");
      return ds;
    },
    { min: 1, max: 64 },
  );
  if (new Set(datasets.map((d) => d.dataset_id)).size !== datasets.length) {
    throw ApiError.badRequest("contract.datasets: dataset_id must be unique", "invalid_input");
  }
  for (const tdp of tdps) {
    if (!datasets.some((d) => d.dataset_id.startsWith(`${tdp}/`))) {
      throw ApiError.badRequest(`parties.tdps: ${tdp} owns no dataset of this contract`, "invalid_input");
    }
  }
  return datasets;
}

/** Validates a contract document (spec §8.1) against registry and catalog state. */
export function validateContract(v: unknown, now: number): ParsedContract {
  const c = obj(v, "contract");
  keys(
    c,
    "contract",
    ["schema", "contract_id", "title", "purpose", "parties", "validity", "datasets", "computation", "privacy", "output"],
    ["description", "terms"],
  );
  oneOf(c.schema, "contract.schema", [CONTRACT_SCHEMA] as const);
  const contract_id = str(c.contract_id, "contract.contract_id", { re: UUID4_RE });
  str(c.title, "contract.title", { max: 256 });
  optStr(c.description, "contract.description", { min: 0, max: 16384 });
  const purpose = str(c.purpose, "contract.purpose", { re: /^[A-Z][A-Z0-9_]{0,63}$/ });

  const parties = obj(c.parties, "contract.parties");
  keys(parties, "contract.parties", ["tdc", "tdps"], ["ccrp"]);
  const tdc = str(parties.tdc, "contract.parties.tdc", { re: PARTY_ID_RE });
  requireActiveParty(tdc, "tdc");
  const tdps = arr(parties.tdps, "contract.parties.tdps", (x, p) => str(x, p, { re: PARTY_ID_RE }), { min: 1, max: 64, unique: true });
  for (const t of tdps) requireActiveParty(t, "tdp");
  let ccrp: string | null = null;
  if (parties.ccrp !== undefined && parties.ccrp !== null) {
    ccrp = str(parties.ccrp, "contract.parties.ccrp", { re: PARTY_ID_RE });
    requireActiveParty(ccrp, "ccrp");
  }

  const validity = obj(c.validity, "contract.validity");
  keys(validity, "contract.validity", ["not_before", "not_after"]);
  const not_before = parseRfc3339(validity.not_before, "contract.validity.not_before");
  const not_after = parseRfc3339(validity.not_after, "contract.validity.not_after");
  if (not_after <= not_before) throw ApiError.badRequest("contract.validity: not_after must be after not_before", "invalid_input");
  if (not_after <= now) throw ApiError.badRequest("contract.validity: not_after is in the past", "invalid_input");

  const datasets = validateDatasets(c.datasets, tdps);

  const comp = obj(c.computation, "contract.computation");
  keys(comp, "contract.computation", ["tier", "platforms", "recipes", "max_runs", "max_duration_minutes"], ["ccr_releases", "custom_ccr"]);
  const tier = oneOf(comp.tier, "contract.computation.tier", [1, 2, 3] as const);
  const platforms = arr(comp.platforms, "contract.computation.platforms", (x, p) => oneOf(x, p, PLATFORMS), {
    min: 1,
    max: PLATFORMS.length,
    unique: true,
  });
  const ccr_releases =
    comp.ccr_releases === undefined
      ? []
      : arr(comp.ccr_releases, "contract.computation.ccr_releases", (x, p) => str(x, p, { re: RELEASE_ID_RE }), { max: 32, unique: true });
  let custom_ccr: CustomCcr | null = null;
  if (tier === 3) {
    if (ccr_releases.length !== 0) throw ApiError.badRequest("contract.computation.ccr_releases: must be empty for tier 3", "invalid_input");
    const cc = obj(comp.custom_ccr, "contract.computation.custom_ccr");
    keys(cc, "contract.computation.custom_ccr", ["platform", "measurement_id", "image", "source", "review_report_digest"]);
    custom_ccr = {
      platform: oneOf(cc.platform, "contract.computation.custom_ccr.platform", PLATFORMS),
      measurement_id: str(cc.measurement_id, "contract.computation.custom_ccr.measurement_id", { max: 256 }),
      image: str(cc.image, "contract.computation.custom_ccr.image", { max: 1024 }),
      source: str(cc.source, "contract.computation.custom_ccr.source", { max: 2048 }),
      review_report_digest: str(cc.review_report_digest, "contract.computation.custom_ccr.review_report_digest", { re: DIGEST_RE }),
    };
    if (!platforms.includes(custom_ccr.platform)) {
      throw ApiError.badRequest("contract.computation.custom_ccr.platform: must be one of computation.platforms", "invalid_input");
    }
  } else {
    if (comp.custom_ccr !== undefined && comp.custom_ccr !== null) {
      throw ApiError.badRequest("contract.computation.custom_ccr: only allowed for tier 3", "invalid_input");
    }
    if (ccr_releases.length === 0) throw ApiError.badRequest("contract.computation.ccr_releases: required for tier 1/2", "invalid_input");
    for (const id of ccr_releases) {
      const e = releasesTable.get(id);
      if (!e || e.state !== "approved") throw ApiError.badRequest(`ccr release ${id} is not approved`, "release_not_approved");
      if (!platforms.includes(e.release.platform)) {
        throw ApiError.badRequest(`ccr release ${id} platform ${e.release.platform} is not in computation.platforms`, "invalid_input");
      }
      if (!(e.release.tiers as number[]).includes(tier)) throw ApiError.badRequest(`ccr release ${id} does not support tier ${tier}`, "invalid_input");
    }
  }
  const recipes = arr(
    comp.recipes,
    "contract.computation.recipes",
    (x, p) => {
      const r = obj(x, p);
      keys(r, p, ["digest", "document"]);
      const d = str(r.digest, `${p}.digest`, { re: DIGEST_RE });
      if (digest(obj(r.document, `${p}.document`)) !== d) throw ApiError.badRequest(`${p}.digest: does not match digest(document)`, "recipe_digest_mismatch");
      return d;
    },
    { min: 1, max: 16, unique: true },
  );
  const max_runs = int(comp.max_runs, "contract.computation.max_runs", { min: 1, max: 10000 });
  const max_duration_minutes = int(comp.max_duration_minutes, "contract.computation.max_duration_minutes", { min: 1, max: 10080 });

  const privacy = validatePrivacy(c.privacy, "contract.privacy");

  const out = obj(c.output, "contract.output");
  keys(out, "contract.output", ["mode", "allowed_formats", "max_bytes", "location"], ["recipients", "metrics_allowlist"]);
  const output_mode = oneOf(out.mode, "contract.output.mode", ["tdc", "tee-only"] as const);
  const recipients =
    out.recipients === undefined ? [] : arr(out.recipients, "contract.output.recipients", (x, p) => str(x, p, { re: RECIPIENT_RE }), { max: 32, unique: true });
  if (output_mode === "tdc") {
    if (recipients.length === 0) throw ApiError.badRequest("contract.output.recipients: required for mode tdc", "invalid_input");
    for (const r of recipients) {
      const [, partyId, kid] = RECIPIENT_RE.exec(r) as RegExpExecArray;
      if (partyId !== tdc && !tdps.includes(partyId)) {
        throw ApiError.badRequest(`contract.output.recipients: ${partyId} is not a contract party`, "invalid_input");
      }
      if (!requireActiveParty(partyId).hpke_public_keys.some((k) => k.kid === kid)) {
        throw ApiError.badRequest(`contract.output.recipients: ${r} is not a registered HPKE key`, "invalid_input");
      }
    }
  } else if (recipients.length !== 0) {
    throw ApiError.badRequest("contract.output.recipients: must be empty for mode tee-only", "invalid_input");
  }
  const allowed_formats = arr(out.allowed_formats, "contract.output.allowed_formats", (x, p) => oneOf(x, p, OUTPUT_FORMATS), {
    min: 1,
    max: OUTPUT_FORMATS.length,
    unique: true,
  });
  const max_bytes = int(out.max_bytes, "contract.output.max_bytes", { min: 1, max: 2 ** 40 });
  const metrics_allowlist =
    out.metrics_allowlist === undefined
      ? []
      : arr(out.metrics_allowlist, "contract.output.metrics_allowlist", (x, p) => str(x, p, { re: /^[A-Za-z0-9_.-]{1,64}$/ }), { max: 64, unique: true });
  validateLocation(out.location, "contract.output.location", true);

  if (c.terms !== undefined) {
    const t = obj(c.terms, "contract.terms");
    keys(t, "contract.terms", [], ["legal_text_digest", "uri", "governing_law"]);
    if (t.legal_text_digest !== undefined) str(t.legal_text_digest, "contract.terms.legal_text_digest", { re: DIGEST_RE });
    optStr(t.uri, "contract.terms.uri", { max: 2048 });
    optStr(t.governing_law, "contract.terms.governing_law", { max: 64 });
  }

  return {
    contract_id,
    purpose,
    tdc,
    tdps,
    ccrp,
    not_before,
    not_after,
    datasets,
    tier,
    platforms,
    ccr_releases,
    custom_ccr,
    recipe_digests: recipes,
    max_runs,
    max_duration_minutes,
    privacy,
    output_mode,
    recipients,
    allowed_formats,
    max_bytes,
    metrics_allowlist,
  };
}

export function contractView(c: ContractRecord, now: number): Record<string, unknown> {
  return {
    contract: c.contract,
    contract_digest: c.contract_digest,
    state: effectiveContractState(c, now),
    required_signers: c.required_signers,
    signatures: c.signatures,
    runs_used: c.runs_used,
    revocation: c.revocation,
    proposed_by: c.proposed_by,
    created_at: c.created_at,
  };
}

export function requireContract(id: string): ContractRecord {
  const c = contractsTable.get(id);
  if (!c) throw ApiError.notFound(`contract ${id} not found`);
  return c;
}

export function contractIdFromPath(request: ccfapp.Request): string {
  const id = pathParam(request, "contract_id");
  if (!UUID4_RE.test(id)) throw ApiError.badRequest("invalid contract_id");
  return id;
}

export const proposeContract = endpoint("contracts.propose", (request) => {
  requireBootstrapped();
  const v = verifySignedRequest(request, { service: SERVICE_NAME, op: "contract.propose", roles: ["tdc"] });
  const now = nowSeconds();
  const contract = obj(v.payload.body, "body");
  const parsed = validateContract(contract, now);
  if (parsed.tdc !== v.party.party_id) throw ApiError.forbidden("contract.parties.tdc must be the signer", "not_tdc");
  if (contractsTable.has(parsed.contract_id)) throw ApiError.conflict(`contract ${parsed.contract_id} already exists`, "exists");
  const required = [parsed.tdc, ...parsed.tdps.filter((t) => t !== parsed.tdc)];
  const record: ContractRecord = {
    contract_id: parsed.contract_id,
    contract,
    contract_digest: digest(contract),
    parsed,
    required_signers: required,
    signatures: [],
    state: "draft",
    revocation: null,
    runs_used: 0,
    proposed_by: v.party.party_id,
    propose_jws: v.jws,
    created_at: formatRfc3339(now),
  };
  contractsTable.set(parsed.contract_id, record);
  const involved = new Set([...required, ...(parsed.ccrp ? [parsed.ccrp] : [])]);
  for (const p of involved) contractsByParty.set(p, [...(contractsByParty.get(p) ?? []), parsed.contract_id]);
  return contractView(record, now);
});

export const getContract = endpoint("contracts.get", (request) => contractView(requireContract(contractIdFromPath(request)), nowSeconds()));

export const listContracts = endpoint("contracts.list", (request) => {
  const party = queryParam(request, "party");
  const now = nowSeconds();
  if (party !== undefined) {
    if (!PARTY_ID_RE.test(party)) throw ApiError.badRequest("invalid party");
    return { contracts: (contractsByParty.get(party) ?? []).map((id) => contractView(requireContract(id), now)) };
  }
  return { contracts: contractsTable.entries().map(([, c]) => contractView(c, now)) };
});

export const signContract = endpoint("contracts.sign", (request) => {
  requireBootstrapped();
  const id = contractIdFromPath(request);
  const v = verifySignedRequest(request, { service: SERVICE_NAME, op: "contract.sign", roles: ["tdc", "tdp"] });
  const b = obj(v.payload.body, "body");
  keys(b, "body", ["contract_digest"]);
  const d = str(b.contract_digest, "body.contract_digest", { re: DIGEST_RE });
  const c = requireContract(id);
  if (d !== c.contract_digest) throw ApiError.conflict("contract_digest does not match the contract", "digest_mismatch");
  const now = nowSeconds();
  const state = effectiveContractState(c, now);
  if (state !== "draft") throw ApiError.conflict(`contract is ${state}`, "contract_state");
  const signer = v.party.party_id;
  if (!c.required_signers.includes(signer)) throw ApiError.forbidden(`${signer} is not a required signer`, "not_required_signer");
  if (c.signatures.some((s) => s.party === signer)) throw ApiError.conflict(`${signer} has already signed`, "already_signed");
  c.signatures.push({ party: signer, jws: v.jws, at: formatRfc3339(now) });
  if (c.required_signers.every((p) => c.signatures.some((s) => s.party === p))) c.state = "signed";
  contractsTable.set(id, c);
  return contractView(c, now);
});

function applyRevocation(c: ContractRecord, rev: Revocation): void {
  c.state = "revoked";
  c.revocation = rev;
  contractsTable.set(c.contract_id, c);
}

export const revokeContract = endpoint("contracts.revoke", (request) => {
  requireBootstrapped();
  const id = contractIdFromPath(request);
  const v = verifySignedRequest(request, { service: SERVICE_NAME, op: "contract.revoke", roles: ["tdc", "tdp"] });
  const b = obj(v.payload.body, "body");
  keys(b, "body", ["contract_id", "reason"]);
  if (b.contract_id !== id) throw ApiError.badRequest("body.contract_id must equal the contract in the path", "invalid_input");
  const reason = str(b.reason, "body.reason", { max: 1024 });
  const c = requireContract(id);
  if (!c.required_signers.includes(v.party.party_id)) throw ApiError.forbidden("only a required party may revoke", "not_required_signer");
  if (c.state === "revoked") throw ApiError.conflict("contract is already revoked", "contract_state");
  const now = nowSeconds();
  applyRevocation(c, { by: v.party.party_id, reason, at: formatRfc3339(now), jws: v.jws });
  return contractView(c, now);
});

interface RevokeArgs {
  contract_id: string;
  reason: string;
}

export const contractGovernanceActions: Array<ActionHandler<RevokeArgs>> = [
  {
    name: "revoke_contract",
    validate: (args) => {
      const o = obj(args, "args");
      keys(o, "args", ["contract_id", "reason"]);
      const contract_id = str(o.contract_id, "args.contract_id", { re: UUID4_RE });
      if (requireContract(contract_id).state === "revoked") throw ApiError.conflict("contract is already revoked", "contract_state");
      return { contract_id, reason: str(o.reason, "args.reason", { max: 1024 }) };
    },
    apply: (a, ctx) => {
      applyRevocation(requireContract(a.contract_id), {
        by: "dc-governance",
        reason: a.reason,
        at: formatRfc3339(ctx.now),
        proposal_id: ctx.proposal_id,
      });
    },
  },
];

