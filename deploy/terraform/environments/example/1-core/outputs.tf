output "ledger_name" {
  description = "Confidential Ledger name."
  value       = module.cs_core.ledger_name
}

output "ledger_endpoint" {
  description = "Ledger endpoint (bundle deployment, direct CCF access)."
  value       = module.cs_core.ledger_endpoint
}

output "identity_service_endpoint" {
  description = "ACL identity service endpoint."
  value       = module.cs_core.identity_service_endpoint
}

output "ledger_tls_certificate_pem" {
  description = "Ledger TLS certificate (pin in DEPA_TRUST_BUNDLE / CLI)."
  value       = module.cs_core.ledger_tls_certificate_pem
}

output "key_vault_name" {
  description = "Key Vault name."
  value       = module.cs_core.key_vault_name
}

output "key_vault_uri" {
  description = "Key Vault URI."
  value       = module.cs_core.key_vault_uri
}

output "member_certificate_name" {
  description = "Member certificate name in Key Vault."
  value       = module.cs_core.member_certificate_name
}

output "member_certificate_key_id" {
  description = "Key Vault key ID for COSE signing with the member identity."
  value       = module.cs_core.member_certificate_key_id
}

output "ops_identity_client_id" {
  description = "AZURE_CLIENT_ID for a gateway certificate renewal job (null without gateway)."
  value       = module.cs_core.ops_identity_client_id
}

output "gateway_stack_inputs" {
  description = "Paste as `core` into ../2-gateway/terraform.tfvars (null without gateway)."
  value       = module.cs_core.gateway_stack_inputs
}
