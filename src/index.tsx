import { addEventListener, callable, definePlugin, openFilePicker, removeEventListener, toaster } from "@decky/api";
import {
  ButtonItem, DropdownItem, Field, Navigation, PanelSection, PanelSectionRow, ProgressBarWithInfo, TextField, ToggleField,
  staticClasses,
} from "@decky/ui";
import { useEffect, useState } from "react";
import { FaShareAlt } from "react-icons/fa";
import { installShareSheet, uninstallShareSheet } from "./sharesheet";

/* ---------- backend ---------- */

type Endpoint = { id: string; name?: string; ip?: string; port?: string; rtype?: string; ble?: boolean; hidden?: boolean; seen?: number };
type Meta = {
  from?: string; device_type?: string; pin?: string; payload_kind?: string; preview?: string; files?: string[];
  text?: string; wifi_ssid?: string; destination?: string; total?: number; ack?: number;
};
type Transfer = { id: string; kind: "in" | "out"; state?: string; meta?: Meta; started?: number; updated?: number };
type Settings = { device_name: string; download_dir: string; visibility: string; autostart: boolean; auto_accept: boolean };
type State = {
  running: boolean; ready: any; restarts: number; discovering: boolean; endpoints: Endpoint[]; transfers: Transfer[];
  settings: Settings; has_binary: boolean;
};

const getState = callable<[], State>("get_state");
const setSettings = callable<[Partial<Settings>], Settings>("set_settings");
const discover = callable<[boolean], { ok: boolean }>("discover");
const sendFiles = callable<[string, string[]], { ok: boolean; error?: string }>("send_files");
const respond = callable<[string, string], { ok: boolean }>("respond");
const clearFinished = callable<[], { ok: boolean }>("clear_finished");
const startDaemon = callable<[], { ok: boolean; error?: string }>("start_daemon");
const restartDaemon = callable<[], { ok: boolean; error?: string }>("restart_daemon");
const getLog = callable<[number], string[]>("get_log");

/* ---------- shared store (events arrive while the panel is closed too) ---------- */

let state: State | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(f => f());
const refresh = async () => { try { state = await getState(); notify(); } catch (e) { console.warn("[QuickShare]", e); } };

const FINAL = new Set(["Finished", "Cancelled", "Rejected", "Disconnected"]);
const STATE_LABEL: Record<string, string> = {
  WaitingForUserConsent: "等待确认", ReceivingFiles: "接收中", SendingFiles: "发送中", Finished: "完成",
  Cancelled: "已取消", Rejected: "被拒绝", Disconnected: "连接中断", SentIntroduction: "等待对方接受",
};
const label = (s?: string) => (s && STATE_LABEL[s]) || (s ? "连接中…" : "");
const base = (p: string) => p.split("/").pop() || p;
const size = (n?: number) => !n ? "" : n > 1 << 30 ? (n / (1 << 30)).toFixed(1) + " GB" : n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB";

function describe(m?: Meta): string {
  if (!m) return "";
  if (m.files?.length) return m.files.length === 1 ? base(m.files[0]) : `${m.files.length} 个文件`;
  if (m.text) return m.text.length > 60 ? m.text.slice(0, 60) + "…" : m.text;
  if (m.wifi_ssid) return "Wi-Fi：" + m.wifi_ssid;
  return m.preview || "";
}

const toasted = new Set<string>();
function onEvent(ev: any) {
  if (ev?.ev === "transfer" && ev.kind === "in") {
    const key = ev.id + ":" + ev.state;
    if (ev.state === "WaitingForUserConsent" && !toasted.has(key)) {
      toasted.add(key);
      const m: Meta = ev.meta || {};
      toaster.toast({
        title: `Quick Share：${m.from || "附近设备"}`,
        body: `${describe(m) || "想发送内容"}${m.pin ? `（PIN ${m.pin}）` : ""} — 打开快捷菜单接受`,
        duration: 8000, critical: true,
        onClick: () => Navigation.OpenQuickAccessMenu(),
      });
    } else if (ev.state === "Finished" && !toasted.has(key)) {
      toasted.add(key);
      toaster.toast({ title: "Quick Share：已收到", body: describe(ev.meta) + (ev.meta?.destination ? ` → ${ev.meta.destination}` : ""), duration: 5000 });
    }
  }
  if (ev?.ev === "transfer" && ev.kind === "out" && FINAL.has(ev.state) && !toasted.has(ev.id + ":" + ev.state)) {
    toasted.add(ev.id + ":" + ev.state);
    toaster.toast({ title: "Quick Share", body: `发送${label(ev.state)}：${describe(ev.meta)}`, duration: 4000 });
  }
  refresh();
}

/* ---------- UI ---------- */

const VISIBILITY = [
  { data: "visible", label: "所有人可见" },
  { data: "temporarily", label: "临时可见" },
  { data: "invisible", label: "隐藏" },
];

function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force(n => n + 1);
    listeners.add(f);
    refresh();
    return () => { listeners.delete(f); };
  }, []);
  return state;
}

function TransferRow({ t }: { t: Transfer }) {
  const m = t.meta || {};
  const pct = m.total ? Math.min(100, (100 * (m.ack || 0)) / m.total) : undefined;
  const waiting = t.kind === "in" && t.state === "WaitingForUserConsent";
  const active = !FINAL.has(t.state || "");
  return (
    <>
      <PanelSectionRow>
        <Field label={`${t.kind === "in" ? "⬇ " : "⬆ "}${m.from || (t.kind === "out" ? "发送" : "附近设备")}`}
          description={`${describe(m)}${m.total ? " · " + size(m.total) : ""}${m.pin ? ` · PIN ${m.pin}` : ""}`}
          bottomSeparator="none">
          {label(t.state)}
        </Field>
      </PanelSectionRow>
      {active && pct !== undefined && (t.state === "ReceivingFiles" || t.state === "SendingFiles") && (
        <PanelSectionRow>
          <ProgressBarWithInfo nProgress={pct} sOperationText={`${size(m.ack)} / ${size(m.total)}`} />
        </PanelSectionRow>
      )}
      {waiting && (
        <>
          <PanelSectionRow><ButtonItem layout="below" onClick={() => respond(t.id, "accept")}>接受</ButtonItem></PanelSectionRow>
          <PanelSectionRow><ButtonItem layout="below" onClick={() => respond(t.id, "decline")}>拒绝</ButtonItem></PanelSectionRow>
        </>
      )}
      {active && !waiting && (
        <PanelSectionRow><ButtonItem layout="below" onClick={() => respond(t.id, "cancel")}>取消</ButtonItem></PanelSectionRow>
      )}
      {t.state === "Finished" && t.kind === "in" && m.text && (
        <PanelSectionRow><Field label="内容" description={m.text} /></PanelSectionRow>
      )}
    </>
  );
}

let picked: string[] = [];

function Content() {
  const s = useStore();
  const [files, setFiles] = useState<string[]>(picked);
  const [log, setLog] = useState<string[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  useEffect(() => { picked = files; }, [files]);
  if (!s) return <PanelSection><PanelSectionRow>加载中…</PanelSectionRow></PanelSection>;
  const cfg = s.settings;
  const pending = s.transfers.filter(t => t.kind === "in" && t.state === "WaitingForUserConsent");
  const others = s.transfers.filter(t => !(t.kind === "in" && t.state === "WaitingForUserConsent"));

  const pick = async () => {
    try {
      const r = await openFilePicker(0 as any, files.length ? files[files.length - 1].replace(/\/[^/]*$/, "") : "/home/deck");
      if (r?.realpath && !files.includes(r.realpath)) setFiles([...files, r.realpath]);
    } catch { /* cancelled */ }
  };
  const send = async (ep: Endpoint) => {
    const r = await sendFiles(ep.id, files);
    if (!r.ok) toaster.toast({ title: "Quick Share", body: r.error || "发送失败" });
    else setFiles([]);
  };

  return (
    <>
      {pending.length > 0 && (
        <PanelSection title="接收请求">
          {pending.map(t => <TransferRow key={t.id} t={t} />)}
        </PanelSection>
      )}

      <PanelSection title="Quick Share">
        {!s.has_binary && <PanelSectionRow><Field label="缺少 qsd 程序" description="插件安装不完整" /></PanelSectionRow>}
        <PanelSectionRow>
          <ToggleField label="服务" description={s.running ? (s.ready ? `运行中 · ${s.ready.name}` : "启动中…") : "已停止"}
            checked={s.running}
            onChange={async v => { if (v) await startDaemon(); else await callable("stop_daemon")(); refresh(); }} />
        </PanelSectionRow>
        <PanelSectionRow>
          <DropdownItem label="可见性" rgOptions={VISIBILITY} selectedOption={cfg.visibility}
            onChange={async o => { await setSettings({ visibility: o.data }); refresh(); }} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="发送文件">
        {files.map(f => (
          <PanelSectionRow key={f}>
            <ButtonItem layout="below" description="按一下移除" onClick={() => setFiles(files.filter(x => x !== f))}>{base(f)}</ButtonItem>
          </PanelSectionRow>
        ))}
        <PanelSectionRow><ButtonItem layout="below" onClick={pick}>{files.length ? "再添加文件" : "选择文件"}</ButtonItem></PanelSectionRow>
        <PanelSectionRow>
          <ToggleField label="搜索附近设备" description="手机上打开 Quick Share 的「接收」" checked={s.discovering}
            onChange={async v => { await discover(v); refresh(); }} />
        </PanelSectionRow>
        {s.discovering && s.endpoints.length === 0 && <PanelSectionRow><Field label="正在搜索…" /></PanelSectionRow>}
        {s.endpoints.filter(ep => ep.hidden).length > 0 && (
          <PanelSectionRow>
            <Field label={`${s.endpoints.filter(ep => ep.hidden).map(ep => ep.name || ep.ip).join("、")} 仅对联系人可见`}
              description="请在对方的 Quick Share 里把「谁可以与你分享」设为「所有人」" />
          </PanelSectionRow>
        )}
        {s.endpoints.filter(ep => !ep.hidden).map(ep => (
          <PanelSectionRow key={ep.id}>
            <ButtonItem layout="below" disabled={!files.length}
              description={(ep.ble ? "蓝牙" : ep.ip || "") + (files.length ? "" : " · 先选择文件")}
              onClick={() => send(ep)}>
              {"发送到 " + (ep.name || ep.id)}
            </ButtonItem>
          </PanelSectionRow>
        ))}
      </PanelSection>

      {others.length > 0 && (
        <PanelSection title="传输">
          {others.map(t => <TransferRow key={t.id} t={t} />)}
          <PanelSectionRow><ButtonItem layout="below" onClick={async () => { await clearFinished(); refresh(); }}>清除已结束</ButtonItem></PanelSectionRow>
        </PanelSection>
      )}

      <PanelSection title="设置">
        <PanelSectionRow>
          <TextField label="设备名称" value={name ?? cfg.device_name} onChange={e => setName(e.target.value)} />
        </PanelSectionRow>
        {name !== null && name.trim() && name !== cfg.device_name && (
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={async () => { await setSettings({ device_name: name.trim() }); setName(null); refresh(); }}>保存名称（重启服务）</ButtonItem>
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ToggleField label="自动接受" description="收到文件时不再询问（仍会提示）" checked={cfg.auto_accept}
            onChange={async v => { await setSettings({ auto_accept: v }); refresh(); }} />
        </PanelSectionRow>
        <PanelSectionRow><Field label="保存位置" description={cfg.download_dir} /></PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={async () => setLog(log ? null : await getLog(30))}>{log ? "隐藏日志" : "显示日志"}</ButtonItem>
        </PanelSectionRow>
        {log && (
          <PanelSectionRow>
            <div style={{ fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-all", opacity: 0.8 }}>{log.join("\n")}</div>
          </PanelSectionRow>
        )}
        {log && <PanelSectionRow><ButtonItem layout="below" onClick={async () => { await restartDaemon(); refresh(); }}>重启服务</ButtonItem></PanelSectionRow>}
      </PanelSection>
    </>
  );
}

/* Deep Idle (screen off + music) asks background work to stop: the daemon is stopped only if it is running, and started again
   only if this handler stopped it, so a daemon the user switched off stays off */
const stopDaemonCall = callable<[], { ok: boolean }>("stop_daemon");
let stoppedByIdle = false;
async function onDeepIdle(e: any) {
  const active = !!e?.detail?.active;
  if (active && e?.detail?.stopQuickShare) {
    try {
      const st = await getState();
      if (st.running) { stoppedByIdle = true; await stopDaemonCall(); refresh(); }
    } catch { /* ignore */ }
  } else if (!active && stoppedByIdle) {
    stoppedByIdle = false;
    try { await startDaemon(); refresh(); } catch { /* ignore */ }
  }
}

export default definePlugin(() => {
  const handler = addEventListener("qs_event", onEvent);
  window.addEventListener("deepidle", onDeepIdle as any);
  refresh();
  installShareSheet();
  return {
    name: "Quick Share",
    titleView: <div className={staticClasses.Title}>Quick Share</div>,
    content: <Content />,
    icon: <FaShareAlt />,
    onDismount() { removeEventListener("qs_event", handler); window.removeEventListener("deepidle", onDeepIdle as any); uninstallShareSheet(); },
  };
});
