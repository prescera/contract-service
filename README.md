# DEPA Training v2 — Contract Service (`depa-contract-service`)

A CCF JavaScript application, hosted on Azure Confidential Ledger (ACL), that is one of the two
Data Collaborative (DC) trust services of DEPA Training v2. It registers parties, publishes the
dataset catalog, records multi-party training contracts, authorises individual clean-room runs
(issuing Run Authorization Tokens for the KMS), and records run events and execution receipts
in the ledger.

Version 2 replaces the earlier C++ SCITT application, which cannot run on ACL. The normative
protocol is `docs/specs/protocol.md` in the `depa-training` repository (§ references below).

## What the contract service holds

| State | Changed by |
|---|---|
| Parties, members, constitution, settings, pinned KMS JWKS, JWT validation policies, approved app digests, CCR release registry | app-level DC governance (§4), same engine and actions as the KMS |
| Dataset catalog: immutable, owner-signed descriptor versions (§7.2) | dataset owner (`catalog.publish`) |
| Contracts `depa-training/contract/v2` with signatures, state, runs used (§8) | TDC proposes; TDC + every dataset owner sign; any required party or governance revokes |
| Runs, events and execution receipts (§9.3, §9.5) | attested CCRs (authorisation), run signing key (events) |
| Service signing key (ES256, signs RATs and execution receipts) | generated inside CCF at bootstrap |

Governance cannot change contract content; it can only revoke (`revoke_contract`).

## Role in a run

1. **Contract.** The TDC proposes a contract naming exact catalog versions (`manifest_digest`),
   recipes (by digest), platforms, CCR releases (tier 1/2) or a custom CCR (tier 3), privacy
   budget and output rules. The CS validates it against the party registry, its own release
   registry and the catalog. It becomes `active` once the TDC and every dataset owner have
   signed `contract_digest` and `not_before` has passed.
2. **Run authorisation** (`POST /contracts/{id}/runs`, one transaction): the binding's
   `trust_bundle_digest` equals the governance setting (mandatory for non-virtual platforms,
   §9.1); attestation proves the binding; contract active and within validity; `runs_used < max_runs`; recipe and platform
   allowed; the attested measurement belongs to an approved, non-revoked release in the CS
   registry that the contract lists (tier 3: equals `custom_ccr.measurement_id`). The CS
   increments `runs_used`, stores the run and returns a RAT (300 s) for the KMS. In-flight runs
   refresh it with `POST /contracts/{id}/runs/{run_id}/rat` (§9.3a), which re-checks run and
   contract state, so revocation stops a running CCR at its next refresh.
3. **Events.** The CCR posts `started` / `progress` / `completed` / `failed` events signed with
   the run key from the binding; `seq` strictly increases; after the deadline only
   `completed`/`failed` are accepted, once.
4. **Execution receipt.** `completed` carries the receipt. The CS requires a valid KMS release
   receipt (verified against the pinned KMS JWKS, bound to this run's `run_id` and
   `binding_hash`) for **every** contract dataset, checks privacy spent ≤ budget, output formats
   and recipients, and the metrics allowlist, then returns a CS-signed receipt.

## Signing contracts (how parties use this service)

Parties never call this API by hand: the `depa` CLI and the `depa-console` web UI in
[depa-training](https://github.com/prescera/depa-training) sign every request with the party's
own ES256 key. Each organisation is a separate party, registered by a Data Collaborative
governance vote; there are no GitHub DIDs and no shared provider identity.

```bash
depa --party tdc    contract propose contract.json      # consumer
depa --party bank-a contract verify  <contract_id>      # each data provider reviews…
depa --party bank-a contract sign    <contract_id>      # …and signs (refused unless verify passes)
depa contract status <contract_id>                      # active once every required party signed
```

Walkthrough: [identities, contracts and keys](https://github.com/prescera/depa-training/blob/main/docs/guides/identities-contracts-keys.md).

## API

All paths are under `/app`. "signed" = body `{"jws": …}` (§3.2). Details: [docs/api.md](docs/api.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/info` | — | service, version, `bundle_digest`, `bundle_digest_approved`, JWKS |
| GET | `/receipt?transaction_id=` | — | CCF receipt (202 while fetching) |
| POST | `/gov/bootstrap` | ACL Administrator (sandbox: CCF user cert) | one-time bootstrap |
| POST/GET | `/gov/proposals` | signed (dc-member) / — | propose, list |
| GET | `/gov/proposals/{id}` | — | proposal with tally |
| POST | `/gov/proposals/{id}/ballots` | signed (dc-member) | vote |
| GET | `/gov/members`, `/gov/constitution`, `/gov/state` | — | governance state |
| GET | `/parties[/{id}]`, `/releases[/{id}]` | — | registries |
| POST | `/catalog/datasets` | signed (owner) | publish a descriptor version |
| GET | `/catalog/datasets`, `/catalog/datasets/{owner}/{name}`, `…/versions/{version}` | — | catalog |
| POST | `/contracts` | signed (tdc) | propose |
| GET | `/contracts?party=`, `/contracts/{id}` | — | list / get (`state`, signatures, `runs_used`) |
| POST | `/contracts/{id}/signatures` | signed (required party) | sign `contract_digest` |
| POST | `/contracts/{id}/revoke` | signed (required party) | revoke |
| POST | `/contracts/{id}/runs` | attested | authorise a run, issue RAT |
| GET | `/contracts/{id}/runs` | — | runs of a contract |
| POST | `/contracts/{id}/runs/{run_id}/rat` | run signing key | refresh the RAT of an in-flight run |
| POST | `/contracts/{id}/runs/{run_id}/events` | run signing key | run event / execution receipt |
| GET | `/runs/{run_id}` | — | run, events, receipt |

Governance actions: the common set (`set_member`, `remove_member`, `set_party`,
`remove_party`, `set_constitution`, `set_peer_service`, `set_jwt_validation_policy`,
`set_settings`, `approve_app_digest`, `approve_ccr_release`, `revoke_ccr_release`) plus
`revoke_contract`.

## Local development

Requirements: Node ≥ 18, Docker, jq, Python ≥ 3.10 (integration tests). The integration tests
and `check-common` expect `../depa-training-kms-azure` (or `DEPA_KMS_REPO`).

```bash
make build              # tsc + rollup + dist/bundle.json, dist/bundle_digest.txt
make test               # unit tests (jest; shared + contract-service)
make sandbox-up         # CCF virtual sandbox on 127.0.0.1:18011 with the app
make test-integration   # both services in two sandboxes, end-to-end
make check-common       # vendored shared code identical to the KMS repository
scripts/sync-common.sh  # re-vendor shared code from the KMS repository
```

### Sandbox script interface (stable)

```
scripts/sandbox-up.sh <port> [--jwt-issuer <issuer.json>] [--no-build] [--recreate]
scripts/sandbox-down.sh [<port> | --all] [--purge]
```

Identical to the KMS scripts (container `depa2-dc-cs-<port>`, ports 18000–18199, idempotent).
stdout is one JSON line with `url`, `app_url`, `service_cert`, `user_cert`, `user_key`,
`member_cert`, `member_key`, `container`, `bundle_digest`, `workspace`; files live in
`${DEPA_SANDBOX_DIR:-<repo>/workspace}/sandbox-<port>/`. See the KMS README for bootstrap and
the Python ≥ 3.13 TLS note.

### Shared code

`packages/depa-ccf-common/` (governance engine, signed requests, JCS, JWS, attestation,
party and release registries, peer tokens, HTTP/logging) and the files listed in
`scripts/common-paths.txt` (integration tests, sandbox and deploy scripts, build tooling) are
developed in `depa-training-kms-azure` and vendored verbatim. Do not edit them here; change them
in the KMS repository and run `scripts/sync-common.sh`. `scripts/check-common.sh` fails if the
copies differ.

## ACL deployment

```bash
ACL_NAME=<ledger> scripts/deploy-acl.sh      # or ACL_URL + ACL_CACERT; ACL_TOKEN optional (az CLI)
```

Then `POST /app/gov/bootstrap` once as ACL Administrator, and propose `set_settings`
(`base_url` = public URL, the RAT `iss`; `trust_bundle_digest`, identical to the KMS), `set_peer_service` (KMS URL + KMS `/info` JWKS),
`set_party` for each TDP/TDC/CCRP, `approve_ccr_release` (the CLI submits identical release
proposals to both services), `set_jwt_validation_policy` for the GCA issuer, and
`approve_app_digest`. For GCP Confidential Space CCRs the GCA issuer must be registered at
ledger level on the ACL instance.

## Security notes

- **ACL Administrator can replace the bundle.** Mitigations: reproducible
  `bundle_digest` (sha256 over JCS of app metadata and modules, excluding the generated
  `build_info.js`), exposed by `/info` with `bundle_digest_approved`; all bundle updates are in
  the ledger; `depa dc audit` recomputes the digest of the bundle served by
  `GET /app/userDefinedEndpoints` and compares it with the governance-approved digest. `/info`
  is an indicator only; auditors must recompute. Restrict the Administrator role and alert on
  `userDefinedEndpoints` writes.
- **Independent checks.** The CS and KMS each verify attestation and keep their own release
  registry; compromise of one service's governance alone cannot release keys (the KMS also
  enforces the TDP's policy and pinned CS keys).
- **Revocation latency.** Revoking a contract stops new runs and RAT refreshes immediately; a RAT
  issued before revocation remains usable at the KMS for at most 300 s.
- **Host time is untrusted** (validity windows, deadlines); attestation, signatures and
  ledger state are not affected by it.
- Contract content, signatures, run events and receipts are stored in public (auditable) ledger
  tables; do not put secrets in contracts or event data.
- Virtual attestation requires `allow_virtual_attestation = true` (unanimous) and is for
  development only.

## Repository layout

```
src/                          catalog, contracts, runs/receipts, service wiring
packages/depa-ccf-common/     vendored shared code (do not edit here)
test/unit/                    contract-service unit tests   test/integration/  shared e2e tests
scripts/                      sandbox-up/down, deploy-acl, sync-common, check-common
docker/Dockerfile.ccf-sandbox app.json (CCF endpoint metadata)  build_bundle.js
```

`deploy/` and `.github/` are owned by the infrastructure workstream.

License: MIT (see LICENSE.txt, NOTICE).
