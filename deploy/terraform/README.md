# depa-contract-service infrastructure (Azure)

Terraform for the DEPA Training v2 Contract Service: an Azure Confidential
Ledger instance hosting the CS CCF JavaScript app, a Key Vault holding the ACL
member certificate, and an optional public Application Gateway.

```
modules/      building blocks, vendored from depa-training-kms-azure (keep .tf identical)
stacks/
  1-core      RG, Key Vault + member certificate, ledger (+ gateway prerequisites if enabled)
  2-gateway   optional: ledger private endpoint, ACME storage, WAF_v2 gateway, monitoring
environments/
  example/    root modules per phase; see environments/example/README.md
scripts/validate.sh   fmt -check + init -backend=false + validate for every dir
```

The stacks are also consumed by the DC composition in `prescera/depa-training`
(`deploy/terraform/environments/dc`). Static checks (no cloud access):
`./scripts/validate.sh .`
