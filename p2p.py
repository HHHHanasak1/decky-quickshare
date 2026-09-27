"""Wi-Fi Direct group for Quick Share's bandwidth upgrade, hosted on a SECOND interface so wlan0 keeps its network.

Findings on the OXP3 (Intel BE201, iwlmld, iwd owns wlan0):
  * an AP-type vif is limited to wlan0's channel (#channels <= 1) and 5 GHz is NO_IR -> no plain AP next to a 5 GHz link;
  * a P2P-GO may use a second channel (#channels <= 2): wpa_supplicant on an extra managed vif + p2p_group_add
    gives an autonomous GO (DIRECT-xx, WPA2-PSK, legacy clients welcome) on 2.4 GHz while wlan0 stays connected;
  * only one P2P-device wdev may exist and iwd holds one (unused here) -> it is deleted; iwd re-creates it on restart.
Needs root. Clients get addresses from the tiny DHCP server below (no dnsmasq on SteamOS)."""
import asyncio
import ipaddress
import os
import re
import shutil
import socket
import struct
import subprocess
import time

BASE_IF = "qsp2p0"
CTRL = "/run/quickshare-p2p"
CONF = "/run/quickshare-p2p.conf"
PIDFILE = "/run/quickshare-p2p.pid"
LOGFILE = "/run/quickshare-p2p.log"
NET = ipaddress.ip_network("192.168.49.0/24")   # Android's Wi-Fi Direct convention
GW = "192.168.49.1"


def system_env() -> dict:
    """Environment for system binaries: Decky is a PyInstaller bundle whose LD_LIBRARY_PATH points at its own (older)
    libssl/libcrypto, which makes e.g. wpa_supplicant fail with "version OPENSSL_3.2.0 not found"."""
    env = dict(os.environ)
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    env.pop("LD_LIBRARY_PATH", None)
    if orig:
        env["LD_LIBRARY_PATH"] = orig
    return env


def _run(*args, check=False, timeout=10) -> subprocess.CompletedProcess:
    r = subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, env=system_env())
    if check and r.returncode != 0:
        raise RuntimeError(f"{args[0]} failed ({r.returncode}): {(r.stderr or r.stdout).strip()[:300]}")
    return r


def _wpa(iface: str, *args) -> str:
    return _run("wpa_cli", "-p", CTRL, "-i", iface, *args).stdout.strip()


def _wlan0_freq() -> int | None:
    m = re.search(r"channel \d+ \((\d+) MHz\)", _run("iw", "dev", "wlan0", "info").stdout)
    return int(m.group(1)) if m else None


def _group_iface() -> str | None:
    m = re.search(r"Interface (p2p-" + BASE_IF + r"-\d+)", _run("iw", "dev").stdout)
    return m.group(1) if m else None


class DhcpServer(asyncio.DatagramProtocol):
    """Minimal DHCPv4 server: OFFER/ACK for DISCOVER/REQUEST on one interface, broadcast replies."""

    def __init__(self, iface: str, log):
        self.iface, self.log = iface, log
        self.leases: dict[bytes, str] = {}
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def _addr_for(self, mac: bytes) -> str:
        if mac not in self.leases:
            used = set(self.leases.values())
            for host in list(NET.hosts())[1:200]:        # .2 .. .200
                if str(host) not in used:
                    self.leases[mac] = str(host)
                    break
        return self.leases[mac]

    def datagram_received(self, data, addr):
        try:
            if len(data) < 240 or data[0] != 1 or data[236:240] != b"\x63\x82\x53\x63":
                return
            xid, flags = data[4:8], data[10:12]
            chaddr = data[28:44]
            mac = chaddr[:6]
            opts, i = {}, 240
            while i < len(data) and data[i] != 255:
                if data[i] == 0:
                    i += 1
                    continue
                opts[data[i]] = data[i + 2:i + 2 + data[i + 1]]
                i += 2 + data[i + 1]
            mtype = opts.get(53, b"\x00")[0]
            if mtype not in (1, 3):                        # DISCOVER / REQUEST
                return
            yiaddr = self._addr_for(mac)
            reply_type = 2 if mtype == 1 else 5            # OFFER / ACK
            if mtype == 3 and 50 in opts and socket.inet_ntoa(opts[50]) != yiaddr:
                reply_type = 6                             # NAK: asked for an address we did not hand out
            pkt = bytearray(240)
            pkt[0], pkt[1], pkt[2] = 2, 1, 6
            pkt[4:8], pkt[10:12] = xid, flags
            if reply_type != 6:
                pkt[16:20] = socket.inet_aton(yiaddr)
            pkt[20:24] = socket.inet_aton(GW)
            pkt[28:44] = chaddr
            pkt[236:240] = b"\x63\x82\x53\x63"
            o = bytes([53, 1, reply_type]) + bytes([54, 4]) + socket.inet_aton(GW)
            if reply_type != 6:
                o += bytes([1, 4]) + socket.inet_aton(str(NET.netmask))
                o += bytes([3, 4]) + socket.inet_aton(GW)
                o += bytes([51, 4]) + struct.pack("!I", 3600)
            pkt += o + b"\xff"
            self.transport.sendto(bytes(pkt), ("255.255.255.255", 68))
            self.log(f"dhcp: {['', 'DISCOVER', '', 'REQUEST'][mtype]} {mac.hex(':')} -> "
                     f"{ {2: 'OFFER', 5: 'ACK', 6: 'NAK'}[reply_type]} {yiaddr}")
        except Exception as e:  # never let a bad packet kill the server
            self.log(f"dhcp: {e}")


class P2PHost:
    def __init__(self, log):
        self.log = log
        self.refs = 0
        self.creds: dict | None = None
        self.dhcp = None
        self.iface: str | None = None
        self.lock = asyncio.Lock()

    async def up(self) -> dict:
        async with self.lock:
            if self.creds:
                self.refs += 1
                return self.creds
            try:
                creds = await asyncio.get_running_loop().run_in_executor(None, self._bring_up)
                await self._start_dhcp(creds["iface"])
            except Exception:
                await asyncio.get_running_loop().run_in_executor(None, self._tear_down)
                raise
            self.creds, self.refs = creds, 1
            return creds

    async def down(self, force=False):
        async with self.lock:
            if not self.creds and not force:
                return
            self.refs = 0 if force else max(0, self.refs - 1)
            if self.refs:
                return
            if self.dhcp:
                self.dhcp.close()
                self.dhcp = None
            self.creds = None
            await asyncio.get_running_loop().run_in_executor(None, self._tear_down)

    # ---- blocking helpers (executor) ----
    def _bring_up(self) -> dict:
        if not shutil.which("wpa_supplicant"):
            raise RuntimeError("wpa_supplicant missing")
        self._tear_down()
        # the phy allows a single P2P-device wdev and iwd keeps one it never uses here
        for wdev in re.findall(r"wdev (0x[0-9a-f]+)\n\s+addr [0-9a-f:]+\n\s+type P2P-device", _run("iw", "dev").stdout):
            _run("iw", "wdev", wdev, "del")
            self.log(f"p2p: removed P2P-device wdev {wdev}")
        _run("iw", "phy", "phy0", "interface", "add", BASE_IF, "type", "managed", check=True)
        with open(CONF, "w") as f:
            f.write(f"ctrl_interface={CTRL}\ncountry=JP\ndevice_name=OneXPlayer 3\ndevice_type=1-0050F204-1\n"
                    "p2p_go_intent=15\np2p_go_ht40=1\nupdate_config=0\n")
        _run("wpa_supplicant", "-B", "-i", BASE_IF, "-D", "nl80211", "-c", CONF, "-P", PIDFILE, "-f", LOGFILE, check=True)
        for _ in range(30):
            if os.path.exists(os.path.join(CTRL, BASE_IF)):
                break
            time.sleep(0.1)
        f0 = _wlan0_freq()
        freq = f0 if f0 and f0 < 3000 else 2437            # 5 GHz is NO_IR for a GO; share wlan0's 2.4 GHz channel if any
        res = _wpa(BASE_IF, "p2p_group_add", f"freq={freq}", "ht40")
        if "OK" not in res:
            res = _wpa(BASE_IF, "p2p_group_add", f"freq={freq}")
        if "OK" not in res:
            raise RuntimeError(f"p2p_group_add failed: {res}")
        iface = None
        for _ in range(60):
            iface = _group_iface()
            if iface and "COMPLETED" in _wpa(iface, "status"):
                break
            time.sleep(0.2)
        if not iface:
            raise RuntimeError("Wi-Fi Direct group did not start")
        st = dict(l.split("=", 1) for l in _wpa(iface, "status").splitlines() if "=" in l)
        psk = _wpa(iface, "p2p_get_passphrase")
        _run("ip", "addr", "add", f"{GW}/{NET.prefixlen}", "dev", iface)
        _run("ip", "link", "set", iface, "up")
        if _run("systemctl", "is-active", "firewalld").stdout.strip() == "active":
            _run("firewall-cmd", "--zone=trusted", f"--add-interface={iface}", timeout=20)
        self.iface = iface
        creds = {"iface": iface, "ssid": st.get("ssid", ""), "password": psk, "gateway": GW,
                 "frequency": int(st.get("freq", freq))}
        self.log(f"p2p: group {creds['ssid']} on {iface} {creds['frequency']} MHz (wlan0 {f0} MHz)")
        return creds

    async def _start_dhcp(self, iface: str):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
        sock.bind(("0.0.0.0", 67))
        transport, _ = await asyncio.get_running_loop().create_datagram_endpoint(
            lambda: DhcpServer(iface, self.log), sock=sock)
        self.dhcp = transport

    def _tear_down(self):
        iface = self.iface or _group_iface()
        if iface:
            if _run("systemctl", "is-active", "firewalld").stdout.strip() == "active":
                _run("firewall-cmd", "--zone=trusted", f"--remove-interface={iface}", timeout=20)
            _wpa(BASE_IF, "p2p_group_remove", iface)
        try:
            with open(PIDFILE) as f:
                os.kill(int(f.read().strip()), 15)
            time.sleep(0.5)
        except (OSError, ValueError):
            pass
        for p in (PIDFILE, CONF):
            try:
                os.remove(p)
            except OSError:
                pass
        _run("iw", "dev", BASE_IF, "del")
        if iface:
            _run("iw", "dev", iface, "del")
        if self.iface:
            self.log(f"p2p: torn down {self.iface}")
        self.iface = None
