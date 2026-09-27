#!/bin/bash
# Build the frontend and deploy the plugin to the deck (root-owned plugin dir), then restart Decky.
# usage (Git Bash): ./deploy.sh [host]   - rebuild qsd first with daemon/build.sh (WSL) when the Rust side changed
set -e
HOST=${1:-deck@192.168.1.216}
cd "$(dirname "$0")"
timeout 120 pnpm run build >/dev/null 2>&1 || true   # rollup sometimes never exits on Windows; dist is written first
test -s dist/index.js
tar -cf QuickShare.tar plugin.json package.json main.py p2p.py dist bin
scp -q QuickShare.tar "$HOST":/tmp/
ssh "$HOST" 'P(){ echo deck | sudo -S -p "" "$@"; }
D=/home/deck/homebrew/plugins/QuickShare
P mkdir -p $D && P tar -xf /tmp/QuickShare.tar -C $D && P chown -R root:root $D && P chmod 755 $D/bin/qsd
P systemctl restart plugin_loader.service; sleep 12
ps -eo pid,ppid,args | grep -E "Quick Share|qsd|go-librespot" | grep -v grep'
