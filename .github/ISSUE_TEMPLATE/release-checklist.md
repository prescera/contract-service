---
name: Release checklist
about: Issue for tracking the release of a new version
title: x.y.z release checklist
labels: release-checklist
assignees: ''

---

Checklist:
- [ ] Link this issue to the milestone for this version and make sure its issues/PRs are closed.
- [ ] `scripts/check-common.sh` passes against the matching depa-training-kms-azure release (shared code is identical).
- [ ] Update `CHANGELOG.md`, including any protocol changes (`docs/specs/protocol.md` in depa-training).
- [ ] If the release upgrades CCF to a new major version, note that existing services must first upgrade to the preceding version, and confirm the version is available on Azure Confidential Ledger.
- [ ] Tag `vX.Y.Z` and check that CI and the release workflow are green.
- [ ] Publish the bundle digest from the release workflow, so Data Collaborative members can approve it (`approve_app_digest`) before it is deployed.
- [ ] Close the milestone and this issue.
