//! qsd - headless Quick Share for the Decky plugin.
//!
//! Runs the rqs_lib service (mDNS + TCP + BLE advert/GATT/L2CAP) and speaks JSON lines:
//!   stdin  (commands): {"cmd":"visibility","value":"visible|invisible|temporarily"}
//!                      {"cmd":"discover","on":true}
//!                      {"cmd":"send","id":..,"name":..,"addr":"ip:port","ble":false,"files":["/path",..]}
//!                      {"cmd":"accept"|"decline"|"cancel","id":..}
//!                      {"cmd":"quit"}
//!   stdout (events):   {"ev":"ready",..} {"ev":"endpoint",..} {"ev":"transfer",..} {"ev":"error",..}
//! Startup settings come from the environment: QSD_NAME, QSD_DOWNLOAD, QSD_VISIBILITY. Logs go to stderr.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rqs_lib::channel::{ChannelMessage, Message, TransferAction, TransferKind};
use rqs_lib::hdl::info::{TransferMetadata, TransferPayload};
use rqs_lib::{EndpointInfo, OutboundPayload, RQS, SendInfo, Visibility};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{broadcast, oneshot};
use tracing_subscriber::EnvFilter;

fn emit(v: Value) {
    // stdout is a LineWriter: every event reaches the backend as one flushed line
    println!("{v}");
}

fn visibility(s: &str) -> Visibility {
    match s {
        "invisible" => Visibility::Invisible,
        "temporarily" => Visibility::Temporarily,
        _ => Visibility::Visible,
    }
}

#[derive(Deserialize)]
struct Cmd {
    cmd: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    value: String,
    #[serde(default)]
    on: bool,
    #[serde(default)]
    name: String,
    #[serde(default)]
    addr: String,
    #[serde(default)]
    ble: bool,
    #[serde(default)]
    files: Vec<String>,
    // hotspot_ready (answer to a hotspot_up request)
    #[serde(default)]
    req: u64,
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    ssid: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    gateway: String,
    #[serde(default)]
    frequency: i32,
    #[serde(default)]
    error: String,
}

type HotspotAnswer = Result<(String, String, std::net::Ipv4Addr, i32), anyhow::Error>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<HotspotAnswer>>>>;

/// The backend hosts the bandwidth-upgrade network (a Wi-Fi Direct group on a second interface, so wlan0 stays on
/// its network): rqs_lib asks through this provider, we ask the backend over stdout and wait for hotspot_ready.
fn install_hotspot_provider(pending: Pending) {
    let next = Arc::new(AtomicU64::new(1));
    let up: rqs_lib::hdl::HotspotUp = Arc::new(move || {
        let pending = pending.clone();
        let req = next.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            let (tx, rx) = oneshot::channel();
            pending.lock().unwrap().insert(req, tx);
            emit(json!({"ev": "hotspot_up", "req": req}));
            match tokio::time::timeout(Duration::from_secs(40), rx).await {
                Ok(Ok(answer)) => answer,
                _ => {
                    pending.lock().unwrap().remove(&req);
                    Err(anyhow::anyhow!("backend did not bring up the Wi-Fi Direct group"))
                }
            }
        })
    });
    let down: rqs_lib::hdl::HotspotDown = Arc::new(|| emit(json!({"ev": "hotspot_down"})));
    rqs_lib::hdl::set_hotspot_provider(up, down);
}

fn metadata_json(md: &TransferMetadata) -> Value {
    let (files, text, wifi_ssid) = match &md.payload {
        Some(TransferPayload::Files(f)) => (Some(f.clone()), None, None),
        Some(TransferPayload::Text(t)) | Some(TransferPayload::Url(t)) => (None, Some(t.clone()), None),
        Some(TransferPayload::Wifi { ssid, .. }) => (None, None, Some(ssid.clone())),
        None => (None, None, None),
    };
    json!({
        "from": md.source.as_ref().map(|s| s.name.clone()),
        "device_type": md.source.as_ref().map(|s| format!("{:?}", s.device_type)),
        "pin": md.pin_code,
        "payload_kind": format!("{:?}", md.payload_kind),
        "preview": md.payload_preview,
        "files": files,
        "text": text,
        "wifi_ssid": wifi_ssid,
        "destination": md.destination,
        "total": md.total_bytes,
        "ack": md.ack_bytes,
    })
}

#[tokio::main]
async fn main() -> Result<(), anyhow::Error> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(if std::env::var("RUST_LOG").is_ok() {
            EnvFilter::builder().from_env_lossy()
        } else {
            EnvFilter::builder()
                .parse_lossy("info,mdns_sd=error,polling=error,neli=error,bluez_async=error,btleplug=error")
        })
        .init();

    let name = std::env::var("QSD_NAME").unwrap_or_else(|_| "Steam Deck".into());
    let download = PathBuf::from(std::env::var("QSD_DOWNLOAD").unwrap_or_else(|_| {
        format!("{}/Downloads/QuickShare", std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
    }));
    std::fs::create_dir_all(&download).ok();
    let vis = visibility(&std::env::var("QSD_VISIBILITY").unwrap_or_default());

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    if std::env::var("QSD_HOTSPOT_PROVIDER").is_ok() {
        install_hotspot_provider(pending.clone());
    }

    let mut rqs = RQS::new(vis, None, Some(download.clone()), Some(name.clone()));
    let (send_tx, _ble_rx) = rqs.run().await?;
    emit(json!({"ev": "ready", "name": name, "download": download, "port": rqs.port_number}));

    // transfer state -> events
    let lib_tx = rqs.message_sender.clone();
    let mut msg_rx = rqs.message_sender.subscribe();
    tokio::spawn(async move {
        loop {
            match msg_rx.recv().await {
                Ok(ChannelMessage { id, msg: Message::Client(mc) }) => {
                    let mut ev = json!({
                        "ev": "transfer",
                        "id": id,
                        "kind": if mc.kind == TransferKind::Inbound { "in" } else { "out" },
                        "state": mc.state.as_ref().map(|s| format!("{s:?}")),
                    });
                    if let Some(md) = &mc.metadata {
                        ev["meta"] = metadata_json(md);
                    }
                    emit(ev);
                }
                Ok(_) => {} // our own Lib actions echoed back
                Err(broadcast::error::RecvError::Lagged(n)) => log::warn!("event channel lagged by {n}"),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // discovery results -> events (the sender lives for the whole process; discovery on/off just starts/stops producers)
    let (ep_tx, mut ep_rx) = broadcast::channel::<EndpointInfo>(50);
    tokio::spawn(async move {
        loop {
            match ep_rx.recv().await {
                Ok(ei) => {
                    let mut v = serde_json::to_value(&ei).unwrap_or(Value::Null);
                    v["ev"] = json!("endpoint");
                    v["ble"] = json!(ei.ble_addr.is_some());
                    emit(v);
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut discovering = false;
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l,
            _ = tokio::signal::ctrl_c() => Ok(None),
        };
        let line = match line {
            Ok(Some(l)) => l,
            _ => break, // stdin closed: the backend went away
        };
        if line.trim().is_empty() {
            continue;
        }
        let cmd: Cmd = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(e) => {
                emit(json!({"ev": "error", "msg": format!("bad command: {e}")}));
                continue;
            }
        };
        let lib_action = |action: TransferAction| {
            let _ = lib_tx.send(ChannelMessage { id: cmd.id.clone(), msg: Message::Lib { action } });
        };
        match cmd.cmd.as_str() {
            "visibility" => rqs.change_visibility(visibility(&cmd.value)),
            "discover" => {
                if cmd.on {
                    // restart on every "on": the backend drops its endpoint list, and mDNS reports a service only once per browse
                    if discovering {
                        rqs.stop_discovery();
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    match rqs.discovery(ep_tx.clone()) {
                        Ok(()) => discovering = true,
                        Err(e) => emit(json!({"ev": "error", "msg": format!("discovery: {e}")})),
                    }
                } else if discovering {
                    rqs.stop_discovery();
                    discovering = false;
                }
            }
            "send" => {
                let si = SendInfo {
                    id: cmd.id.clone(),
                    name: cmd.name.clone(),
                    addr: cmd.addr.clone(),
                    ob: OutboundPayload::Files(cmd.files.clone()),
                    ble: cmd.ble,
                };
                if let Err(e) = send_tx.send(si).await {
                    emit(json!({"ev": "error", "msg": format!("send: {e}")}));
                }
            }
            "accept" => lib_action(TransferAction::ConsentAccept),
            "decline" => lib_action(TransferAction::ConsentDecline),
            "cancel" => lib_action(TransferAction::TransferCancel),
            "hotspot_ready" => {
                if let Some(tx) = pending.lock().unwrap().remove(&cmd.req) {
                    let answer = if cmd.ok {
                        cmd.gateway
                            .parse::<std::net::Ipv4Addr>()
                            .map(|gw| (cmd.ssid.clone(), cmd.password.clone(), gw, cmd.frequency))
                            .map_err(|e| anyhow::anyhow!("bad gateway {}: {e}", cmd.gateway))
                    } else {
                        Err(anyhow::anyhow!("hotspot failed: {}", cmd.error))
                    };
                    let _ = tx.send(answer);
                }
            }
            "quit" => break,
            other => emit(json!({"ev": "error", "msg": format!("unknown command {other}")})),
        }
    }

    // bounded teardown: mdns/bluer shutdown can wedge
    let _ = tokio::time::timeout(Duration::from_secs(8), rqs.stop()).await;
    std::process::exit(0);
}
