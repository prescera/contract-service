# depa-contract-service API

Base URL: `https://<host>/app`. Errors: non-2xx with `{"error": {"code", "message"}}`; failed
requests leave no state behind. Write responses carry `x-ms-ccf-transaction-id`.

Signed requests, attestation envelopes, run bindings and all governance endpoints/actions are
identical to the KMS (see `depa-training-kms-azure/docs/api.md`), with `aud =
"depa-contract-service"`, peer `set_peer_service.name = "depa-kms"` and the extra action
`revoke_contract {contract_id, reason}`.

## Service

`GET /info` → `{service, version, bundle_digest, bundle_digest_approved, bootstrapped, jwks}`

`GET /receipt?transaction_id=<view>.<seqno>` → `200 {transaction_id, receipt}` or `202`.
RAT issuance and execution receipts bind their claims with `setClaimsDigest`.

## Catalog (§7.2)

`POST /catalog/datasets` — signed, op `catalog.publish`, role tdp or tdc; signer must own the
`dataset_id` prefix. Body = Dataset Descriptor:

```json
{"dataset_id": "bank-a/credit-applications", "version": "2026-11-01", "name": "…", "description": "…",
 "format": "dedf/1", "manifest_digest": "sha256:…", "schema": {…},
 "location": {"connector": "s3|azure-blob|gcs|https|file", "uri": "…", "region": "…"},
 "federation": {"aws": {"role_arn"}, "gcp": {"audience", "service_account?"}, "azure": {"tenant_id", "client_id"}},
 "kms": {"url": "https://…", "kid": "<dataset_id>#n"}, "size_bytes": 0, "records": 0}
```

→ `{dataset_id, version, descriptor, descriptor_digest, manifest_digest, publisher, published_at, jws}`.
Versions are immutable (409 `exists`).

`GET /catalog/datasets` → `{datasets: [{dataset_id, owner, latest_version, versions}]}`;
`GET /catalog/datasets/{owner}/{name}` → entry + `latest` record;
`GET /catalog/datasets/{owner}/{name}/versions/{version}` → record.

## Contracts (§8)

`POST /contracts` — signed, op `contract.propose`, role tdc; `parties.tdc` must be the signer.
Body = contract `depa-training/contract/v2` (§8.1). Validation (400 with code):
schema and members (unknown members rejected); parties exist, active, with roles; validity
(`not_after > now`, `not_before < not_after`); datasets exist in the catalog with matching
`manifest_digest` (`unknown_dataset`, `manifest_mismatch`), each owned by a listed TDP and every
TDP owning one; tier 1/2: `ccr_releases` approved in the CS registry, on a listed platform and
supporting the tier (`release_not_approved`); tier 3: `custom_ccr` on a listed platform and no
releases; `recipes[].digest = digest(document)` (`recipe_digest_mismatch`); privacy; output
recipients are `party:<id>#<hpke kid>` of contract parties (mode `tdc`) or empty (`tee-only`).
→ contract view `{contract, contract_digest, state, required_signers, signatures, runs_used, revocation, proposed_by, created_at}`.

States: `draft` → `signed` (all signatures, before `not_before`) → `active` → `revoked` |
`expired` | `exhausted` (`runs_used ≥ max_runs`).

`GET /contracts?party=<id>`, `GET /contracts/{id}`.

`POST /contracts/{id}/signatures` — signed, op `contract.sign`, by a required signer (TDC and
each dataset owner). Body `{contract_digest}` (409 `digest_mismatch`, `already_signed`,
`contract_state`).

`POST /contracts/{id}/revoke` — signed, op `contract.revoke`, by a required signer.
Body `{contract_id, reason}`. Governance: `revoke_contract`.

## Runs (§9.3)

`POST /contracts/{id}/runs` — authn `jwt` or none. Body `{binding, attestation}`. →

```json
{"run_id": "…", "rat": "<JWS typ depa-rat+jwt>", "deadline": 1764003600}
```

RAT claims: `{iss: <CS base_url>, aud: "depa-kms", sub: run_id, iat, exp: iat + 300, contract_id, contract_digest, run_id, binding_hash, platform, measurement_id, tier, custom_measurement, ccr_releases, recipe_digest, tdc, purpose, datasets, privacy, output: {mode, recipients}, deadline}`.
Errors: `attestation_invalid` 401, `platform_mismatch` / `digest_mismatch` /
`contract_not_active` / `recipe_not_allowed` / `platform_not_allowed` /
`measurement_not_approved` 403, `run_exists` 409. The transaction id is in the
`x-ms-ccf-transaction-id` header.

Before attestation, `binding.trust_bundle_digest` is checked against
`settings.trust_bundle_digest` (403 `trust_bundle_not_configured` for non-virtual platforms
while unset, 403 `trust_bundle_mismatch`).

`POST /contracts/{id}/runs/{run_id}/rat` — RAT refresh (§9.3a). Body `{"jws": …}`, JWS
`typ depa-run-event+jws`, ES256, signed with `binding.run_key`; payload
`{"op": "run.refresh_rat", contract_id, run_id, iat, jti}` (±300 s iat window and jti replay as
for signed requests: `stale_request`, `replay` 401; `wrong_operation` 401;
`invalid_signature` 401). Requires the run to be neither completed nor failed (409
`run_terminal`), `now < deadline` (403 `deadline_passed`) and the contract not revoked or
expired (403 `contract_not_active`; an exhausted contract is fine for an in-flight run). →
`{run_id, rat, deadline}` with the run's original RAT claims and
`exp = min(now + 300, deadline)`. Does not consume a run.

`GET /contracts/{id}/runs` → `{runs: [run view]}`.

## Events and execution receipts (§9.5)

`POST /contracts/{id}/runs/{run_id}/events` — body `{"jws": …}`, JWS `typ depa-run-event+jws`,
ES256, signed with `binding.run_key`. Payload `{run_id, seq, type: started|progress|completed|failed, at, data}`.

- `seq` strictly increasing (409 `stale_seq`); terminal runs reject further events (409
  `run_terminal`); after `deadline` only `completed`/`failed` (409 `deadline_passed`).
- `completed.data` = Execution Receipt (§9.5). Checks: identity fields equal the run;
  `status = "succeeded"`; `inputs` lists exactly the contract datasets with matching
  `version`/`manifest_digest`, each with a `release_receipt` signed by the pinned KMS key and
  bound to this run (`receipt_inputs` 400, `invalid_token` 401, `receipt_mismatch` 403);
  `privacy_spent` ≤ contract budget (`privacy_exceeded`); outputs use allowed formats and
  recipients (`kms:output:<contract_id>#…` for tee-only); metrics in the allowlist
  (`metric_not_allowed`).

Response for `completed`: `{receipt_jws, run_id, seq, state}` where `receipt_jws` is
`typ depa-exec-receipt+jwt` with payload `{iss, iat, sub: run_id, receipt_digest: digest(receipt), receipt}`.
Other events: `{run_id, seq, state}`.

`GET /runs/{run_id}` →
`{run_id, contract_id, contract_digest, state, platform, measurement_id, tier, release_id, recipe_digest, binding_hash, run_key, attestation, authorized_at, deadline, terminal_at, receipt, receipt_jws, events: [{seq, type, at, data, jws, received_at}]}`
