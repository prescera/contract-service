# stacks/2-gateway (Contract Service, optional)

Optional public front for the Contract Service, identical in shape to the KMS
gateway: ledger private endpoint(s) + per-ledger DNS zone, private ACME storage,
Application Gateway WAF_v2 (host-header check, default-deny route allowlist,
Let's Encrypt certificate from Key Vault, backend TLS pinned to the ledger
service identity) and monitoring (backend health + multi-region availability
test with certificate lifetime check).

Default `public_routes`: GET/HEAD `/app/info` only. Requires phase 1 with
`enable_gateway = true`, the out-of-band ledger Private Link Service alias, and
approval of the private endpoint connections after apply. Certificate renewal
uses the same certbot hooks/workflow as `depa-training-kms-azure`
(`deploy/letsencrypt`, `refresh-frontend-certificate.yml`) with the values from
`renewal_workflow_settings`.
