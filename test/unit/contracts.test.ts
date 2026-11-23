// Copyright (c) iSPIRT Foundation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from "@jest/globals";
import { randomUUID } from "crypto";
import { digest } from "../../packages/depa-ccf-common/src/jcs";
import { JsonTable } from "../../packages/depa-ccf-common/src/kv";
import { partiesTable, Party } from "../../packages/depa-ccf-common/src/party";
import { approveRelease, revokeRelease, validateRelease } from "../../packages/depa-ccf-common/src/releases";
import { resetKv, TestParty } from "../../packages/depa-ccf-common/test/helpers";
import { ContractRecord, effectiveContractState, validateContract } from "../../src/contracts";

const NOW = Math.floor(Date.now() / 1000);
const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const tdp = new TestParty("bank-a", ["tdp"]);
const tdc = new TestParty("fintech-x", ["tdc"]);
const RECIPE = { trainer: "xgboost" };
const MANIFEST_DIGEST = "sha256:" + "5".repeat(64);

function contract(overrides: Record<string, unknown> = {}, comp: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "depa-training/contract/v2",
    contract_id: randomUUID(),
    title: "t",
    purpose: "TRAINING",
    parties: { tdc: "fintech-x", tdps: ["bank-a"] },
    validity: { not_before: iso(NOW - 10), not_after: iso(NOW + 3600) },
    datasets: [{ dataset_id: "bank-a/ds", version: "v1", manifest_digest: MANIFEST_DIGEST }],
    computation: {
      tier: 1,
      platforms: ["virtual"],
      ccr_releases: ["rel-v"],
      recipes: [{ digest: digest(RECIPE), document: RECIPE }],
      max_runs: 2,
      max_duration_minutes: 30,
      ...comp,
    },
    privacy: { mode: "dp", epsilon: 4, delta: 1e-5 },
    output: {
      mode: "tdc",
      recipients: ["party:fintech-x#h1"],
      allowed_formats: ["onnx"],
      max_bytes: 1000,
      location: { connector: "azure-blob", uri: "https://a.blob.core.windows.net/o/" },
    },
    ...overrides,
  };
}

beforeEach(() => {
  resetKv();
  partiesTable.set("bank-a", tdp.record() as unknown as Party);
  partiesTable.set("fintech-x", tdc.record() as unknown as Party);
  approveRelease(
    validateRelease({ release_id: "rel-v", platform: "virtual", families: ["classic"], tiers: [1, 2], measurements: { virtual_ids: ["virtual-dev"] }, provenance: {} }),
    "p",
  );
  // Seed the catalog version the contract binds to.
  new JsonTable("public:depa.catalog_versions").set("bank-a/ds@v1", { dataset_id: "bank-a/ds", version: "v1", manifest_digest: MANIFEST_DIGEST });
});

describe("contract validation", () => {
  it("accepts a valid contract", () => {
    expect(validateContract(contract(), NOW)).toMatchObject({ tdc: "fintech-x", tdps: ["bank-a"], tier: 1, ccr_releases: ["rel-v"] });
  });

  it.each<[string, () => Record<string, unknown>, RegExp]>([
    ["unknown member", () => contract({ extra: 1 }), /unknown member/],
    ["recipe digest mismatch", () => contract({}, { recipes: [{ digest: "sha256:" + "0".repeat(64), document: RECIPE }] }), /digest\(document\)/],
    ["release not approved", () => contract({}, { ccr_releases: ["nope"] }), /not approved/],
    ["release on another platform", () => contract({}, { platforms: ["aci-snp"] }), /platform/],
    ["tier 1 without releases", () => contract({}, { ccr_releases: [] }), /required for tier/],
    ["tier 3 with releases", () => contract({}, { tier: 3 }), /must be empty for tier 3/],
    ["dataset not in catalog", () => contract({ datasets: [{ dataset_id: "bank-a/zz", version: "v1", manifest_digest: MANIFEST_DIGEST }] }), /not in the catalog/],
    ["manifest mismatch", () => contract({ datasets: [{ dataset_id: "bank-a/ds", version: "v1", manifest_digest: "sha256:" + "6".repeat(64) }] }), /does not match the catalog/],
    ["tdp without dataset", () => contract({ parties: { tdc: "fintech-x", tdps: ["bank-a", "fintech-x"] } }), /role tdp|owns no dataset/],
    ["recipient is not a party key", () => contract({ output: { ...(contract().output as object), recipients: ["party:fintech-x#h9"] } }), /HPKE/],
    ["tee-only with recipients", () => contract({ output: { ...(contract().output as object), mode: "tee-only" } }), /must be empty/],
    ["expired validity", () => contract({ validity: { not_before: iso(NOW - 100), not_after: iso(NOW - 10) } }), /past/],
    ["inverted validity", () => contract({ validity: { not_before: iso(NOW + 100), not_after: iso(NOW + 10) } }), /after not_before/],
  ])("rejects %s", (_n, make, re) => {
    expect(() => validateContract(make(), NOW)).toThrow(re);
  });

  it("accepts tier 3 with a custom CCR and rejects revoked releases", () => {
    const custom = { platform: "virtual", measurement_id: "custom-1", image: "img", source: "src", review_report_digest: "sha256:" + "7".repeat(64) };
    expect(validateContract(contract({}, { tier: 3, ccr_releases: [], custom_ccr: custom }), NOW).custom_ccr?.measurement_id).toBe("custom-1");
    revokeRelease("rel-v", "p2");
    expect(() => validateContract(contract(), NOW)).toThrow(/not approved/);
  });
});

describe("effective contract state", () => {
  const rec = (patch: Partial<ContractRecord>, parsed: Record<string, number> = {}) =>
    ({ state: "signed", runs_used: 0, parsed: { not_before: NOW - 10, not_after: NOW + 10, max_runs: 2, ...parsed }, ...patch }) as unknown as ContractRecord;

  it("derives the lifecycle state", () => {
    expect(effectiveContractState(rec({ state: "draft" }), NOW)).toBe("draft");
    expect(effectiveContractState(rec({}), NOW)).toBe("active");
    expect(effectiveContractState(rec({}, { not_before: NOW + 5 }), NOW)).toBe("signed");
    expect(effectiveContractState(rec({}), NOW + 11)).toBe("expired");
    expect(effectiveContractState(rec({ runs_used: 2 }), NOW)).toBe("exhausted");
    expect(effectiveContractState(rec({ state: "revoked" }), NOW)).toBe("revoked");
  });
});
