output "dns_record" {
  description = "Public DNS record to create (hostname -> gateway IP)."
  value       = module.cs_gateway.dns_record
}

output "gateway_public_ip_id" {
  description = "Public IP resource ID (pin via gateway_public_ip_id)."
  value       = module.cs_gateway.gateway_public_ip_id
}

output "public_base_url" {
  description = "Public base URL of the CS gateway."
  value       = module.cs_gateway.public_base_url
}

output "ledger_private_endpoint_ids" {
  description = "Private endpoint connections to approve on the ledger PLS."
  value       = module.cs_gateway.ledger_private_endpoint_ids
}

output "renewal_workflow_settings" {
  description = "Settings for the certificate renewal job."
  value       = module.cs_gateway.renewal_workflow_settings
}
