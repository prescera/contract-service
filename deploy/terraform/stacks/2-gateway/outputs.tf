output "gateway_public_ip" {
  description = "Public IP of the CS gateway."
  value       = module.gateway.public_ip_address
}

output "gateway_public_ip_id" {
  description = "Resource ID of the gateway public IP (set gateway_public_ip_id to keep it across rebuilds)."
  value       = module.gateway.public_ip_id
}

output "dns_record" {
  description = "DNS record to create in the public zone before the first Let's Encrypt issuance."
  value = {
    name  = local.hostname
    type  = "A"
    value = module.gateway.public_ip_address
  }
}

output "public_base_url" {
  description = "Public base URL of the CS gateway."
  value       = "https://${local.hostname}"
}

output "ledger_private_endpoint_ids" {
  description = "Private endpoints whose connections must be approved on the ledger PLS."
  value       = module.ledger_private_endpoint.private_endpoint_ids
}

output "application_gateway_name" {
  description = "Name of the Application Gateway."
  value       = module.gateway.name
}

output "renewal_workflow_settings" {
  description = "Settings for a Let's Encrypt renewal job (same hooks/workflow as depa-training-kms-azure)."
  value = {
    DOMAIN          = local.hostname
    KEY_VAULT_NAME  = data.azurerm_key_vault.this.name
    CERT_NAME       = var.core.frontend_certificate_name
    STORAGE_ACCOUNT = module.acme_storage.name
  }
}
