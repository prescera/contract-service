#!/usr/bin/env bash
# Copyright (c) iSPIRT Foundation.
# Licensed under the MIT license.
#
# Vendor the shared code from depa-training-kms-azure (the source of truth)
# into this repository. Shared paths are listed in scripts/common-paths.txt.
#
# Usage: scripts/sync-common.sh [<path-to-depa-training-kms-azure>]
#        (default: $DEPA_KMS_REPO or ../depa-training-kms-azure)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$(cd "${1:-${DEPA_KMS_REPO:-$REPO_ROOT/../depa-training-kms-azure}}" && pwd)"
[[ -d "$SRC/packages/depa-ccf-common" ]] || { echo "not a depa-training-kms-azure checkout: $SRC" >&2; exit 1; }

while IFS= read -r p; do
  [[ -z "$p" || "$p" == \#* ]] && continue
  if [[ -d "$SRC/$p" ]]; then
    rm -rf "${REPO_ROOT:?}/$p"
    mkdir -p "$(dirname "$REPO_ROOT/$p")"
    cp -R "$SRC/$p" "$REPO_ROOT/$p"
  else
    mkdir -p "$(dirname "$REPO_ROOT/$p")"
    cp "$SRC/$p" "$REPO_ROOT/$p"
  fi
  echo "synced $p" >&2
done < "$REPO_ROOT/scripts/common-paths.txt"
"$REPO_ROOT/scripts/check-common.sh" "$SRC"
