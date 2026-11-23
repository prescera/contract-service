# Contract Service example environment

Two root modules with separate state. Copy per environment, fill
`terraform.tfvars` from the `.example` files, enable the commented backend.
Prerequisites as for the KMS (Terraform >= 1.9, `az login` with rights to create
resources and role assignments, your egress IP in `key_vault_allowed_ip_ranges`).

## Apply order

1. **Phase 1 - core** (`1-core/`): resource group, Key Vault + member
   certificate, Confidential Ledger (plus VNet/identities/bootstrap certificate
   if `enable_gateway = true`).
   ```bash
   cd 1-core && terraform init && terraform apply
   ```
2. **Application (CS app tooling, not Terraform):**
   `PUT <ledger_endpoint>/app/userDefinedEndpoints?api-version=2024-08-22-preview`
   with an ACL Administrator AAD token, then `POST <ledger_endpoint>/app/gov/bootstrap`
   once (spec §3.3), `approve_app_digest` with the release digest, and
   `set_peer_service` in both services (KMS <-> CS JWKS pinning, spec §5).
   Distribute `ledger_endpoint` + `ledger_tls_certificate_pem` to parties/CCRs.
3. *Optional gateway:*
   1. Manual: create the ledger Private Link Service out of band, record its alias.
   2. `cd ../2-gateway && terraform init && terraform apply` with
      `core = <1-core gateway_stack_inputs>`.
   3. Approve the connections in `ledger_private_endpoint_ids` on the PLS.
   4. Create the DNS record from `dns_record`; run a Let's Encrypt renewal job
      with `renewal_workflow_settings` (same hooks/workflow as the KMS repo).

Destroy in reverse order.
