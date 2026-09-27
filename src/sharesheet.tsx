// Adds a "Quick Share" entry to Steam's own share sheet (screenshots, and media-manager multi-select incl. clips).
//
// The sheet component (t$ in the media module) renders `options.map(({label,key,...rest}) => <Item .../>)`. Its webpack
// export is a non-configurable getter, but every Steam module calls the shared CJS jsx runtime (window.SP_JSX) at render
// time, and that object's jsx/jsxs are writable: we wrap jsx and append our option whenever the sheet is rendered with an
// "export" (save to file) option. Selecting it re-uses Steam's own export: SteamClient.System.OpenFileDialog is answered
// with a fresh outbox directory for that one call, so Steam writes the screenshot / exported clip there itself; we then
// offer the files to nearby Quick Share devices.
import { callable, toaster } from "@decky/api";
import { DialogButton, Focusable, ModalRoot, findModuleExport, showModal } from "@decky/ui";
import { useEffect, useState } from "react";
import { FaShareAlt } from "react-icons/fa";

type Endpoint = { id: string; name?: string; ip?: string; ble?: boolean; hidden?: boolean };
type OutFile = { path: string; size: number };

const makeShareDir = callable<[], string>("make_share_dir");
const listDir = callable<[string], OutFile[]>("list_dir");
const getState = callable<[], { running: boolean; endpoints: Endpoint[]; discovering: boolean }>("get_state");
const discover = callable<[boolean], { ok: boolean }>("discover");
const sendFiles = callable<[string, string[]], { ok: boolean; error?: string }>("send_files");
const startDaemon = callable<[], { ok: boolean; error?: string }>("start_daemon");

const KEY = "quickshare";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const base = (p: string) => p.split("/").pop() || p;
const size = (n: number) => n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB" : Math.ceil(n / 1024) + " KB";

/* ---------- export capture ---------- */

async function captureExport(exportOpt: any, ev: any): Promise<OutFile[]> {
  const dir = await makeShareDir();
  const sys = (window as any).SteamClient.System;
  const orig = sys.OpenFileDialog;
  let answered = false;
  sys.OpenFileDialog = async (opts: any) => {
    // answer exactly one dialog, then hand the function back
    sys.OpenFileDialog = orig;
    answered = true;
    if (opts?.bChooseDirectory) return dir;
    return `${dir}/${(opts?.strInitialFile || "shared").replace(/[\/\\]/g, "_")}`;
  };
  try {
    await exportOpt.onSelected(ev);
  } catch (e) {
    console.warn("[QuickShare] export failed", e);
  } finally {
    if (!answered) sys.OpenFileDialog = orig;
  }
  if (!answered) return [];
  // wait until the export has landed and sizes stopped changing (clips are transcoded to mp4 first)
  let last = "";
  let stable = 0;
  for (let i = 0; i < 240; i++) {
    const files = await listDir(dir);
    const sig = JSON.stringify(files);
    if (files.length && files.every(f => f.size > 0) && sig === last) {
      if (++stable >= 2) return files;
    } else stable = 0;
    last = sig;
    await sleep(500);
  }
  return await listDir(dir);
}

/* ---------- device picker ---------- */

function SendModal({ files, closeModal }: { files: OutFile[]; closeModal?: () => void }) {
  const [eps, setEps] = useState<Endpoint[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const st = await getState();
      if (!st.running) await startDaemon();
      await discover(true);
      while (alive) {
        try { setEps((await getState()).endpoints); } catch { }
        await sleep(700);
      }
    })();
    return () => { alive = false; discover(false); };
  }, []);
  const total = files.reduce((a, f) => a + f.size, 0);
  const visible = eps.filter(ep => !ep.hidden);
  const hidden = eps.filter(ep => ep.hidden);
  const send = async (ep: Endpoint) => {
    setBusy(true);
    const r = await sendFiles(ep.id, files.map(f => f.path));
    if (!r.ok) { toaster.toast({ title: "Quick Share", body: r.error || "发送失败" }); setBusy(false); return; }
    toaster.toast({ title: "Quick Share", body: `正在发送到 ${ep.name || ep.id}，请在对方设备上接受` });
    closeModal?.();
  };
  return (
    <ModalRoot closeModal={closeModal}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 22, fontWeight: 600, marginBottom: 8 }}>
        <FaShareAlt /> Quick Share
      </div>
      <div style={{ opacity: 0.75, marginBottom: 14 }}>
        {files.length === 1 ? base(files[0].path) : `${files.length} 个文件`} · {size(total)}
      </div>
      <div style={{ opacity: 0.75, marginBottom: 8 }}>
        {visible.length ? "选择接收设备：" : "正在搜索附近设备… 请在手机上打开 Quick Share 的「接收」"}
      </div>
      {hidden.length > 0 && (
        <div style={{ opacity: 0.6, fontSize: 13, marginBottom: 8 }}>
          {hidden.map(ep => ep.name || ep.ip).join("、")} 仅对联系人可见 — 请在对方的 Quick Share 里把「谁可以与你分享」设为「所有人」
        </div>
      )}
      <Focusable style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {visible.map(ep => (
          <DialogButton key={ep.id} disabled={busy} onClick={() => send(ep)}>
            {(ep.name || ep.id) + (ep.ble ? "（蓝牙）" : "")}
          </DialogButton>
        ))}
        <DialogButton onClick={() => closeModal?.()}>取消</DialogButton>
      </Focusable>
    </ModalRoot>
  );
}

async function onQuickShare(exportOpt: any, ev: any) {
  toaster.toast({ title: "Quick Share", body: "正在准备文件…", duration: 2000 });
  const files = await captureExport(exportOpt, ev);
  if (!files.length) {
    toaster.toast({ title: "Quick Share", body: "没有拿到要分享的文件" });
    return;
  }
  showModal(<SendModal files={files} />);
}

/* ---------- jsx hook ---------- */

// Decky's FCTrampoline (@decky/ui) temporarily swaps window.SP_JSX.jsx for a stub while it renders some components and
// then RESTORES the native function it captured earlier - which wiped a plainly assigned wrapper again and again (seen
// via a setter trap: applyStubsIfNeeded / removeStubsIfNeeded). So `jsx` becomes an accessor: the getter always returns
// our wrapper, the setter only records what others assign as the underlying implementation (native, or Decky's stub),
// and the wrapper delegates to whatever is underneath at call time. The state lives on window because Decky loads a new
// plugin instance before it dismounts the old one.
const W = window as any;
let myWrapper: any = null;
let retryTimer: number | undefined;
let watchTimer: number | undefined;

const SHEET_RE = /\.options\.map\(\(\{label:\w+,key:\w+,\.\.\.\w+\}\)/;
const isSheet = (e: any) => typeof e === "function" && SHEET_RE.test(Function.prototype.toString.call(e));

function findShareSheet(): any {
  // 1) already-loaded modules
  try {
    const hit = findModuleExport(isSheet);
    if (hit) return hit;
  } catch { /* fall through */ }
  // 2) Steam evaluates the media modules lazily (first visit of the media page), so at boot the sheet is usually not
  //    loaded yet: scan the module *sources* for the sheet's render loop and require that module ourselves.
  try {
    let req: any;
    W.webpackChunksteamui.push([[Symbol()], {}, (r: any) => { req = r; }]);
    for (const id of Object.keys(req.m)) {
      let src = "";
      try { src = Function.prototype.toString.call(req.m[id]); } catch { continue; }
      if (!SHEET_RE.test(src)) continue;
      const exp = req(id);
      for (const k of Object.keys(exp || {})) {
        try { if (isSheet(exp[k])) return exp[k]; } catch { /* getter threw */ }
      }
    }
  } catch (e) {
    console.warn("[QuickShare] module scan failed", e);
  }
  return null;
}

type HookState = { rt: any; base: any; underlying: any; active: any; wrappers: Set<any> };

function hookState(rt: any): HookState {
  let st: HookState | undefined = W.__qsHook;
  if (!st || st.rt !== rt) {
    const created: HookState = { rt, base: rt.jsx, underlying: rt.jsx, active: null, wrappers: new Set() };
    st = W.__qsHook = created;
    Object.defineProperty(rt, "jsx", {
      configurable: true, enumerable: true,
      get: () => created.active ?? created.underlying,
      // Decky may have captured the getter's value (our wrapper) as its "old" jsx and write that back when it removes its
      // stub: that means "back to normal", i.e. the original function, never a self-reference
      set: (v: any) => { created.underlying = (v === created.active || created.wrappers.has(v)) ? created.base : v; },
    });
  }
  return st;
}

export function installShareSheet(attempt = 0) {
  const rt = W.SP_JSX;
  const shareSheet = rt ? findShareSheet() : null;
  if (!shareSheet || !rt) {
    // keep trying (2 s, backing off to 10 s): the entry must appear whenever the media modules become available
    if (attempt === 40) console.warn("[QuickShare] share sheet not found yet; still retrying");
    retryTimer = window.setTimeout(() => installShareSheet(attempt + 1), Math.min(10000, 2000 + attempt * 500));
    return;
  }
  const st = hookState(rt);
  const wrapper = function (this: any, type: any, props: any, key: any) {
    if (type === shareSheet && Array.isArray(props?.options)) {
      const exp = props.options.find((o: any) => o && o.key === "export");
      if (exp && !props.options.some((o: any) => o?.key === KEY)) {
        props = {
          ...props,
          options: [...props.options, {
            key: KEY, label: "Quick Share", icon: <FaShareAlt />, onSelected: (ev: any) => onQuickShare(exp, ev),
          }],
        };
        return st.underlying.call(this, type, props, key);
      }
    }
    return st.underlying.apply(this, arguments as any);
  };
  st.wrappers.add(wrapper);
  st.active = wrapper;
  myWrapper = wrapper;

  // window.SP_JSX itself being replaced would leave us on a dead object: hook the new one
  window.clearInterval(watchTimer);
  watchTimer = window.setInterval(() => {
    if (myWrapper && W.SP_JSX && W.SP_JSX !== rt) {
      (W.__qsHealLog ||= []).push({ t: Date.now(), what: "SP_JSX object replaced" });
      console.warn("[QuickShare] SP_JSX object replaced; re-hooking");
      window.clearInterval(watchTimer);
      myWrapper = null;
      installShareSheet();
    }
  }, 5000);
}

export function uninstallShareSheet() {
  window.clearTimeout(retryTimer);
  window.clearInterval(watchTimer);
  const st: HookState | undefined = W.__qsHook;
  // only switch off our own wrapper (an old instance must not strip the new instance's hook); the accessor stays, harmless
  if (st && myWrapper && st.active === myWrapper) st.active = null;
  myWrapper = null;
}
