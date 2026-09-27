#!/bin/bash
# Builds qsd against glibc 2.43 (SteamOS 3.10) and copies it into the plugin's bin/. Run on Linux, or from Windows via
# WSL: `wsl -d <distro> --exec bash /path/to/decky-quickshare/daemon/build.sh`. Needs Rust (rustup) and git.
set -euo pipefail
cd "$(dirname "$0")"

./setup-vendor.sh

CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target}"
LOG="$CARGO_TARGET_DIR/build.log"
mkdir -p "$CARGO_TARGET_DIR"

"$CARGO" build --release >"$LOG" 2>&1
rc=$?
echo "rc=$rc" >>"$LOG"
grep -E "^(error|warning: unused)" -A6 "$LOG" | head -60
tail -3 "$LOG"

if [ $rc -eq 0 ]; then
  mkdir -p ../bin
  cp "$CARGO_TARGET_DIR/release/qsd" ../bin/qsd
  ls -la ../bin/qsd
fi
exit $rc
