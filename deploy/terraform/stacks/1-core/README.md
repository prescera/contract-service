# stacks/1-core (Contract Service)

Phase 1 of the DEPA Contract Service deployment (provider-less; instantiated by
`environments/*/1-core` or the DC composition in `prescera/depa-training`):

| Resource | Notes |
|---|---|
| Resource group | `<name_prefix>-<env>-<region_short>-rg` (default prefix `depa-cs`) |
| Key Vault | premium, RBAC, purge protection, firewall; EC P-384 HSM member certificate |
| Confidential Ledger | Public; certificate Administrator = member cert; AAD Administrators = `ledger_administrator_principal_ids` (default: deployer) |
| Optional (`enable_gateway = true`) | VNet, `-agw-mi` and `-ops-mi` identities with certificate-scoped grants, bootstrap frontend certificate for `gateway_hostname` |

`key_vault_purge_protection_enabled` (default `true`) and `key_vault_soft_delete_retention_days`
(default 90) are production settings. Demos may disable purge protection (with the azurerm
provider feature `key_vault.purge_soft_delete_on_destroy`) so a teardown frees the vault name.

Parties, the CLI and CCRs call the CS directly on `ledger_endpoint`, pinning
`ledger_tls_certificate_pem` (CCF service identity, e.g. via
`DEPA_TRUST_BUNDLE`); the gateway is an optional convenience (publicly trusted
TLS + WAF) and is not on any security-critical path. `gateway_stack_inputs` is
`null` unless the gateway is enabled.
