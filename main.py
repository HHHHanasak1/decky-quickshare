"""Quick Share (Decky) backend: runs the headless qsd daemon (rqs_lib) and relays its JSON-line events to the frontend.
Game Mode friendly: no window of its own; consent, PIN and progress are shown in the QAM / toasts.
The backend runs as root (flag "root") only to host the Wi-Fi Direct group used for bandwidth upgrades (p2p.py);
qsd itself is started as the deck user, so received files and exports stay deck's."""
import asyncio
import json
import os
import shutil
import signal
import time

import decky

import sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from p2p import P2PHost, system_env  # noqa: E402

DECK_UID = DECK_GID = 1000   # the backend runs as root (Wi-Fi Direct needs it); qsd and every file it touches stay deck's


def makedirs_deck(path: str) -> None:
    """os.makedirs, but every directory created is handed to the deck user."""
    missing = []
    p = os.path.abspath(path)
    while not os.path.exists(p):
        missing.append(p)
        p = os.path.dirname(p)
    os.makedirs(path, exist_ok=True)
    for d in missing:
        try:
            os.chown(d, DECK_UID, DECK_GID)
        except OSError:
            pass

PLUGIN_DIR = decky.DECKY_PLUGIN_DIR
BIN = os.path.join(PLUGIN_DIR, "bin", "qsd")
HOME = decky.DECKY_USER_HOME
LOG_FILE = os.path.join(decky.DECKY_PLUGIN_LOG_DIR, "qsd.log")
SETTINGS_FILE = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
SHARE_ROOT = os.path.join(HOME, ".cache", "quickshare-deck", "outbox")  # Steam share-sheet exports land here

DEFAULTS = {
    "device_name": "OneXPlayer 3",
    "download_dir": os.path.join(HOME, "Downloads", "QuickShare"),
    "visibility": "visible",       # visible | invisible | temporarily
    "autostart": True,
    "auto_accept": False,          # accept without asking (still shows a toast)
}
FINAL_STATES = {"Finished", "Cancelled", "Rejected", "Disconnected"}


def load_settings() -> dict:
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as f:
            return {**DEFAULTS, **json.load(f)}
    except Exception:
        return dict(DEFAULTS)


def save_settings(s: dict) -> None:
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=1)


class Plugin:
    proc: asyncio.subprocess.Process | None = None
    reader_task: asyncio.Task | None = None
    monitor_task: asyncio.Task | None = None
    want_running = False
    restarts = 0
    started_at = 0.0
    ready: dict | None = None
    endpoints: dict = {}
    transfers: dict = {}
    discovering = False

    # ---------------- daemon lifecycle ----------------
    async def start_daemon(self):
        if self.proc and self.proc.returncode is None:
            return {"ok": True, "pid": self.proc.pid, "already": True}
        if not os.path.isfile(BIN):
            return {"ok": False, "error": "qsd binary missing: " + BIN}
        s = load_settings()
        makedirs_deck(s["download_dir"])
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        env = system_env()
        env.update({
            "HOME": HOME,
            "XDG_RUNTIME_DIR": "/run/user/1000",
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
            "QSD_NAME": s["device_name"],
            "QSD_DOWNLOAD": s["download_dir"],
            "QSD_VISIBILITY": s["visibility"],
            "QSD_KEEP_WIFI": "1",  # never switch wlan0 to a hotspot / the phone's network
            "QSD_HOTSPOT_PROVIDER": "1",  # bandwidth upgrades use our Wi-Fi Direct group on a second interface
            "USER": "deck", "LOGNAME": "deck",
        })
        try:
            os.chmod(BIN, 0o755)
        except Exception:
            pass
        logf = open(LOG_FILE, "ab")
        self.proc = await asyncio.create_subprocess_exec(
            BIN, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=logf, env=env,
            user=DECK_UID, group=DECK_GID, extra_groups=[], cwd=HOME,
            start_new_session=True)
        logf.close()
        self.want_running = True
        self.started_at = time.time()
        self.ready = None
        self.endpoints = {}
        self.discovering = False
        decky.logger.info("qsd started pid=%s", self.proc.pid)
        self.reader_task = asyncio.create_task(self._reader(self.proc))
        if not self.monitor_task or self.monitor_task.done():
            self.monitor_task = asyncio.create_task(self._monitor())
        return {"ok": True, "pid": self.proc.pid}

    async def stop_daemon(self):
        self.want_running = False
        p = self.proc
        self.proc = None
        if p and p.returncode is None:
            try:
                await self._send_raw(p, {"cmd": "quit"})
                try:
                    await asyncio.wait_for(p.wait(), 9)
                except asyncio.TimeoutError:
                    p.send_signal(signal.SIGTERM)
                    try:
                        await asyncio.wait_for(p.wait(), 3)
                    except asyncio.TimeoutError:
                        p.kill()
            except Exception as e:
                decky.logger.warning("stop: %s", e)
        await self._emit({"ev": "stopped"})
        return {"ok": True}

    async def restart_daemon(self):
        await self.stop_daemon()
        await asyncio.sleep(0.5)
        return await self.start_daemon()

    async def _monitor(self):
        while True:
            await asyncio.sleep(3)
            p = self.proc
            if self.want_running and (p is None or p.returncode is not None):
                self.restarts += 1
                decky.logger.warning("qsd exited (code %s), restarting (#%d)", p.returncode if p else None, self.restarts)
                await asyncio.sleep(3)
                if self.want_running:
                    self.proc = None
                    await self.start_daemon()

    async def _reader(self, p: asyncio.subprocess.Process):
        assert p.stdout
        while True:
            line = await p.stdout.readline()
            if not line:
                break
            try:
                ev = json.loads(line)
            except Exception:
                continue
            await self._handle(ev)
        await self._emit({"ev": "exited", "code": p.returncode})
        await self.p2p.down(force=True)   # qsd is gone: nobody holds the group any more

    async def _handle(self, ev: dict):
        kind = ev.get("ev")
        if kind == "ready":
            self.ready = ev
        elif kind == "endpoint":
            eid = ev.get("id")
            if eid:
                if ev.get("present") is False:
                    self.endpoints.pop(eid, None)
                else:
                    ev["seen"] = time.time()
                    self.endpoints[eid] = ev
        elif kind == "hotspot_up":
            asyncio.create_task(self._hotspot_up(ev.get("req", 0)))
            return
        elif kind == "hotspot_down":
            asyncio.create_task(self.p2p.down())
            return
        elif kind == "transfer":
            tid = ev.get("id")
            prev = self.transfers.get(tid, {})
            meta = {**(prev.get("meta") or {}), **{k: v for k, v in (ev.get("meta") or {}).items() if v is not None}}
            t = {**prev, **ev, "meta": meta, "updated": time.time()}
            t.setdefault("started", time.time())
            self.transfers[tid] = t
            if (t.get("state") == "WaitingForUserConsent" and t.get("kind") == "in"
                    and load_settings().get("auto_accept") and not prev.get("auto_accepted")):
                t["auto_accepted"] = True
                await self._send({"cmd": "accept", "id": tid})
            self._prune()
            ev = t
        await self._emit(ev)

    async def _hotspot_up(self, req: int):
        try:
            c = await self.p2p.up()
            await self._send({"cmd": "hotspot_ready", "req": req, "ok": True, "ssid": c["ssid"],
                              "password": c["password"], "gateway": c["gateway"], "frequency": c["frequency"]})
            await self._emit({"ev": "wifi_direct", "state": "up", "ssid": c["ssid"], "frequency": c["frequency"]})
        except Exception as e:
            decky.logger.warning("Wi-Fi Direct group failed: %s", e)
            await self._send({"cmd": "hotspot_ready", "req": req, "ok": False, "error": str(e)})

    def _prune(self):
        done = [k for k, t in self.transfers.items() if t.get("state") in FINAL_STATES]
        for k in sorted(done, key=lambda k: self.transfers[k].get("updated", 0))[:-10]:
            self.transfers.pop(k, None)

    async def _emit(self, ev: dict):
        try:
            await decky.emit("qs_event", ev)
        except Exception as e:
            decky.logger.debug("emit: %s", e)

    async def _send_raw(self, p, obj: dict):
        if p and p.stdin and p.returncode is None:
            p.stdin.write((json.dumps(obj) + "\n").encode())
            await p.stdin.drain()
            return True
        return False

    async def _send(self, obj: dict):
        return await self._send_raw(self.proc, obj)

    # ---------------- frontend API ----------------
    async def get_state(self):
        running = bool(self.proc and self.proc.returncode is None)
        now = time.time()
        return {
            "running": running,
            "ready": self.ready,
            "restarts": self.restarts,
            "uptime": (now - self.started_at) if running else 0,
            "discovering": self.discovering,
            "endpoints": list(self.endpoints.values()),
            "transfers": sorted(self.transfers.values(), key=lambda t: t.get("started", 0), reverse=True),
            "settings": load_settings(),
            "has_binary": os.path.isfile(BIN),
        }

    async def get_log(self, lines: int = 40):
        try:
            with open(LOG_FILE, "rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 16000))
                tail = f.read().decode("utf-8", "replace")
            return [l for l in tail.splitlines() if l.strip()][-lines:]
        except Exception:
            return []

    async def set_settings(self, patch: dict):
        s = load_settings()
        old = dict(s)
        s.update({k: v for k, v in patch.items() if k in DEFAULTS})
        save_settings(s)
        if s["visibility"] != old["visibility"]:
            await self._send({"cmd": "visibility", "value": s["visibility"]})
        if s["device_name"] != old["device_name"] or s["download_dir"] != old["download_dir"]:
            if self.proc and self.proc.returncode is None and not self._busy():
                await self.restart_daemon()
        return s

    def _busy(self) -> bool:
        return any(t.get("state") not in FINAL_STATES for t in self.transfers.values())

    async def discover(self, on: bool):
        if on:
            # drop stale endpoints from an earlier scan
            self.endpoints = {}
        self.discovering = bool(on)
        await self._send({"cmd": "discover", "on": bool(on)})
        return {"ok": True}

    async def send_files(self, endpoint_id: str, files: list):
        ep = self.endpoints.get(endpoint_id)
        if not ep:
            return {"ok": False, "error": "设备已离线，请重新扫描"}
        files = [f for f in files if os.path.isfile(f)]
        if not files:
            return {"ok": False, "error": "没有可发送的文件"}
        is_ble = bool(ep.get("ble"))
        addr = "" if is_ble else f"{ep.get('ip')}:{ep.get('port')}"
        await self._send({"cmd": "send", "id": ep["id"], "name": ep.get("name") or "", "addr": addr, "ble": is_ble,
                          "files": files})
        return {"ok": True}

    async def respond(self, transfer_id: str, action: str):
        if action not in ("accept", "decline", "cancel"):
            return {"ok": False}
        await self._send({"cmd": action, "id": transfer_id})
        return {"ok": True}

    # ---------------- Steam share-sheet export target ----------------
    async def make_share_dir(self):
        """Fresh directory for Steam's own "save" export (the share-sheet entry points its file dialog here)."""
        makedirs_deck(SHARE_ROOT)
        now = time.time()
        for name in os.listdir(SHARE_ROOT):  # drop exports older than a day
            p = os.path.join(SHARE_ROOT, name)
            try:
                if now - os.path.getmtime(p) > 86400:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                pass
        d = os.path.join(SHARE_ROOT, time.strftime("%Y%m%d-%H%M%S") + f"-{int(now * 1000) % 1000:03d}")
        makedirs_deck(d)   # Steam (running as deck) writes the export into it
        return d

    async def list_dir(self, path: str):
        real = os.path.realpath(path)
        if not real.startswith(os.path.realpath(SHARE_ROOT) + os.sep):
            return []
        out = []
        for name in sorted(os.listdir(real)):
            p = os.path.join(real, name)
            if os.path.isfile(p):
                out.append({"path": p, "size": os.path.getsize(p)})
        return out

    async def clear_finished(self):
        self.transfers = {k: t for k, t in self.transfers.items() if t.get("state") not in FINAL_STATES}
        return {"ok": True}

    # ---------------- decky hooks ----------------
    async def _main(self):
        self.endpoints, self.transfers = {}, {}
        self.p2p = P2PHost(lambda m: decky.logger.info("%s", m))
        await self.p2p.down(force=True)   # leftovers of a crashed previous run
        if load_settings().get("autostart", True):
            res = await self.start_daemon()
            decky.logger.info("autostart: %s", res)

    async def wifi_direct_test(self):
        """Bring the group up for 60 s (manual check from the QAM/log: SSID visible on a phone, wlan0 untouched)."""
        c = await self.p2p.up()
        asyncio.get_running_loop().call_later(60, lambda: asyncio.create_task(self.p2p.down()))
        return {k: c[k] for k in ("ssid", "frequency", "gateway", "iface")}

    async def _unload(self):
        await self.p2p.down(force=True)
        await self.stop_daemon()
        if self.monitor_task:
            self.monitor_task.cancel()

    async def _uninstall(self):
        pass
