#!/bin/bash
# Clones the pinned open-quickshare commit into vendor/ and applies this project's patches (Wi-Fi Direct bandwidth-upgrade
# hook + reporting hidden/contacts-only receivers). Run once before daemon/build.sh; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

UPSTREAM=https://github.com/ignotusbucius/open-quickshare
PIN=5a31145   # commit our patches were made against

if [ ! -d vendor/open-quickshare/.git ]; then
  mkdir -p vendor
  git clone "$UPSTREAM" vendor/open-quickshare
fi
cd vendor/open-quickshare
git fetch --depth 50 origin "$PIN" 2>/dev/null || git fetch origin
git checkout -q "$PIN"

for p in ../../patches/*.patch; do
  if git apply --check --reverse "$p" 2>/dev/null; then
    echo "already applied: $(basename "$p")"
  else
    echo "applying: $(basename "$p")"
    git apply "$p"
  fi
done
echo "vendor ready at $(pwd)"
