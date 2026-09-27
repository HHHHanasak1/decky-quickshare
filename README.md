# Quick Share (Decky plugin)

Google Quick Share for the Steam Deck / SteamOS handhelds — usable in **Game Mode**, with no game interrupted:

- Receive and send files, text and links with nearby Android phones and Windows PCs (Quick Share for Windows).
- A **Quick Share** entry is added to Steam's own share sheet, so screenshots and clips can be sent straight from
  there — Steam exports the file itself, this plugin just offers it to a nearby device.
- When sender and receiver are not on the same Wi-Fi, transfers automatically upgrade from Bluetooth to a temporary
  **Wi-Fi Direct** group hosted on a second wireless interface, so the handheld's own Wi-Fi connection is never
  interrupted.
- Devices whose Quick Share visibility is "Your devices" / "Contacts" are listed with an explanation, since sending
  to them isn't possible without a Google account (see [Limitations](#limitations)).

Built on [`rqs_lib`](https://github.com/ignotusbucius/open-quickshare) (itself based on
[Martichou/rquickshare](https://github.com/Martichou/rquickshare)), a Rust implementation of the Quick Share /
Nearby Share protocol.

## Why not just use EasyEffects-style GUI ports?

The existing Linux Quick Share clients ([open-quickshare](https://github.com/ignotusbucius/open-quickshare),
[rquickshare](https://github.com/Martichou/rquickshare)) ship as desktop GUI apps. That's the wrong shape for a
handheld's Game Mode, where nothing should need its own window. This plugin instead runs the protocol engine
(`rqs_lib`) as a small headless daemon driven over stdin/stdout, and gives it a Decky panel plus a Steam share-sheet
hook.

## Architecture

```
src/index.tsx        Decky panel: send/receive UI, visibility, device name, log
src/sharesheet.tsx    Hooks Steam's own share sheet (screenshots/clips) to add a "Quick Share" option
main.py               Backend: supervises the qsd daemon, relays its events to the frontend, hosts the
                       Wi-Fi Direct bandwidth-upgrade group
p2p.py                 Wi-Fi Direct group host (wpa_supplicant + a tiny built-in DHCP server) - runs as root only
                       for this; qsd itself runs as the `deck` user
daemon/               qsd: a small Rust wrapper around rqs_lib, JSON lines on stdin/stdout
  patches/            Our changes to rqs_lib, as patches against a pinned open-quickshare commit (see below)
```

### The qsd daemon protocol

Commands in (one JSON object per line on stdin):

```jsonc
{"cmd": "visibility", "value": "visible|invisible|temporarily"}
{"cmd": "discover", "on": true}
{"cmd": "send", "id": "...", "name": "...", "addr": "ip:port", "ble": false, "files": ["/path", ...]}
{"cmd": "accept" | "decline" | "cancel", "id": "..."}
{"cmd": "hotspot_ready", "req": 1, "ok": true, "ssid": "...", "password": "...", "gateway": "...", "frequency": 2437}
{"cmd": "quit"}
```

Events out (stdout): `ready`, `endpoint` (a discovered device; `hidden: true` if it's contacts/your-devices-only),
`transfer` (state machine updates, PIN, progress), `hotspot_up` / `hotspot_down` (the daemon asking the backend to
bring up / tear down the Wi-Fi Direct group), `error`.

## Building

Needs Rust (`rustup`) and `pnpm`. The daemon links against a patched fork of `open-quickshare`'s `rqs_lib`, which is
**not vendored in this repo** (it's GPL-3.0 code we didn't write) — `daemon/setup-vendor.sh` clones the pinned
upstream commit and applies our patches from `daemon/patches/`.

```bash
pnpm install
pnpm run build            # frontend -> dist/
./daemon/build.sh         # clones+patches rqs_lib into daemon/vendor/, builds -> bin/qsd
```

`daemon/build.sh` targets glibc 2.43 (SteamOS 3.10); build on Linux, or from Windows via WSL:

```bash
wsl -d <distro> --exec bash ./daemon/build.sh
```

`deploy.sh` packages `plugin.json`, `package.json`, `main.py`, `p2p.py`, `dist/` and `bin/` and installs them to
`/home/deck/homebrew/plugins/QuickShare` over SSH, then restarts Decky's plugin loader.

## Our changes to rqs_lib (daemon/patches/)

- **Wi-Fi Direct bandwidth-upgrade hook** (`hotspot.rs`): `rqs_lib` normally hosts its own bandwidth-upgrade hotspot
  by switching the machine's Wi-Fi interface to AP/Wi-Fi-Direct mode — which would drop the handheld off its own
  network. `set_hotspot_provider()` lets the embedding application supply its own hotspot instead; `p2p.py` answers
  by bringing up a Wi-Fi Direct group on a *second* interface, so the primary Wi-Fi connection is untouched. Also
  respected by `QSD_KEEP_WIFI=1`, which makes the daemon refuse any Wi-Fi switching if no provider is registered.
- **Reporting contacts/your-devices-only receivers** (`mdns_discovery.rs`): these advertise a 17-byte encrypted
  identity that the upstream parser (which expects a name-bearing payload) silently skips. We surface them anyway,
  as `EndpointInfo { hidden: true, name: <mDNS hostname>, .. } }`, so the UI can explain why they can't be selected
  (see below) instead of just not listing them.

## Limitations

- **Contacts / "Your devices" visibility isn't supported.** That requires a device to hold a certificate issued by
  Google's private Nearby Share backend (proof of being signed into the same account, or a mutual contact) — an
  API that isn't open to third-party clients. Sending to such a device fails the identity check after the initial
  handshake. Set the receiving device's Quick Share visibility to "Everyone" to work around this.
- Wi-Fi Direct bandwidth upgrades are 2.4 GHz only (regulatory: this handheld's 5 GHz radio is receive-only in
  Wi-Fi Direct/AP mode in most regions), so off-LAN transfers, while much faster than Bluetooth, don't reach full
  Wi-Fi speeds.
- Requires BlueZ (for BLE discovery/advertising) and NetworkManager (for the Wi-Fi Direct group); developed and
  tested on SteamOS 3.10 with an Intel BE201 (CNVi) Wi-Fi/BT combo.

## License

GPL-3.0 (see [LICENSE](LICENSE)) — `rqs_lib` is GPL-3.0, and this daemon links against it.
