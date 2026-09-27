//! Client IPC GlazeWM (tiling façon Hyprland) : WebSocket sur ws://localhost:6123.
use crate::hub;
use serde_json::{json, Value};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::Message;

static COMMANDS: Mutex<Option<Sender<String>>> = Mutex::new(None);
static STATE: Mutex<Option<Value>> = Mutex::new(None);

fn disconnected() -> Value { json!({ "connected": false, "monitors": [], "bindingModes": [] }) }

pub fn state() -> Value { STATE.lock().unwrap().clone().unwrap_or_else(disconnected) }

fn set_state(v: Value) {
    *STATE.lock().unwrap() = Some(v.clone());
    hub::emit("glaze", v);
}

pub fn command(cmd: &str) {
    if let Some(tx) = COMMANDS.lock().unwrap().as_ref() { let _ = tx.send(format!("command {cmd}")); }
}

pub fn start(epoch: u64) {
    let (tx, rx) = channel::<String>();
    *COMMANDS.lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        while hub::alive(epoch) {
            if let Ok((mut ws, _)) = tungstenite::connect("ws://localhost:6123") {
                if let MaybeTlsStream::Plain(tcp) = ws.get_mut() { let _ = TcpStream::set_read_timeout(tcp, Some(Duration::from_millis(150))); }
                for m in ["sub -e all", "query monitors", "query binding-modes"] { let _ = ws.send(Message::text(m)); }
                let mut modes = json!([]);
                while hub::alive(epoch) {
                    while let Ok(cmd) = rx.try_recv() { let _ = ws.send(Message::text(cmd)); }
                    let msg = match ws.read() {
                        Ok(Message::Text(t)) => t,
                        Ok(_) => continue,
                        Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => continue,
                        Err(_) => break,
                    };
                    let Ok(v) = serde_json::from_str::<Value>(&msg) else { continue };
                    if v["messageType"] == "event_subscription" {
                        if v["data"]["eventType"] == "binding_modes_changed" { modes = names(&v["data"]["newBindingModes"]); }
                        let _ = ws.send(Message::text("query monitors"));
                        continue;
                    }
                    if v["messageType"] != "client_response" || v["success"] != true {
                        // Anciennes versions : "all" n'est pas reconnu, abonnement événement par événement.
                        if v["clientMessage"] == "sub -e all" {
                            let _ = ws.send(Message::text("sub -e focus_changed workspace_activated workspace_deactivated workspace_updated window_managed window_unmanaged monitor_added monitor_removed binding_modes_changed"));
                        }
                        continue;
                    }
                    match v["clientMessage"].as_str() {
                        Some("query binding-modes") => modes = names(&v["data"]["bindingModes"]),
                        Some("query monitors") => {
                            let monitors: Vec<Value> = v["data"]["monitors"].as_array().map(|a| a.iter().map(map_monitor).collect()).unwrap_or_default();
                            set_state(json!({ "connected": true, "monitors": monitors, "bindingModes": modes }));
                        }
                        _ => {}
                    }
                }
                set_state(disconnected());
            }
            for _ in 0..30 { if !hub::alive(epoch) { return; } std::thread::sleep(Duration::from_millis(100)); }
        }
    });
}

fn names(list: &Value) -> Value {
    json!(list.as_array().map(|a| a.iter().map(|m| m["displayName"].as_str().or(m["name"].as_str()).unwrap_or("").to_owned()).collect::<Vec<_>>()).unwrap_or_default())
}

fn windows_of(node: &Value, out: &mut Vec<Value>) {
    for c in node["children"].as_array().into_iter().flatten() {
        if c["type"] == "window" { out.push(json!({ "process": c["processName"], "title": c["title"], "focused": c["hasFocus"] })); }
        else { windows_of(c, out); }
    }
}

fn map_monitor(m: &Value) -> Value {
    let workspaces: Vec<Value> = m["children"].as_array().into_iter().flatten().filter(|w| w["type"] == "workspace").map(|w| {
        let mut wins = Vec::new();
        windows_of(w, &mut wins);
        json!({
            "name": w["name"], "displayName": w["displayName"].as_str().or(w["name"].as_str()),
            "focused": w["hasFocus"], "visible": w["isDisplayed"], "windows": wins,
        })
    }).collect();
    json!({ "x": m["x"], "y": m["y"], "width": m["width"], "height": m["height"], "workspaces": workspaces })
}
