//! Sends data to the page, keeping the last value of each topic (for windows created later)
//! and a "generation" number used to stop the pollers on reload.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn init(app: AppHandle) { let _ = APP.set(app); }

pub fn emit(channel: &str, payload: Value) {
    if let Some(app) = APP.get() { let _ = app.emit(channel, payload); }
}

/// Topic data (cpu, audio, media...): stored and broadcast.
pub fn publish(topic: &str, data: Value) {
    LAST.lock().unwrap().get_or_insert_with(HashMap::new).insert(topic.to_owned(), data.clone());
    emit("data", json!({ "topic": topic, "data": data }));
}

/// One-off event (notification): broadcast, not stored.
pub fn event(topic: &str, data: Value) { emit("data", json!({ "topic": topic, "data": data })); }

pub fn last(topic: &str) -> Option<Value> { LAST.lock().unwrap().as_ref()?.get(topic).cloned() }

/// Forgets topics that are no longer polled (option turned off), so a reloaded window
/// doesn't show stale values.
pub fn retain(topics: &[&str]) {
    if let Some(map) = LAST.lock().unwrap().as_mut() { map.retain(|k, _| topics.contains(&k.as_str())); }
}

pub fn snapshot() -> Value {
    let map: Map<String, Value> = LAST.lock().unwrap().as_ref().map(|m| m.clone().into_iter().collect()).unwrap_or_default();
    Value::Object(map)
}

pub fn generation() -> u64 { GENERATION.load(Ordering::SeqCst) }
pub fn next_generation() -> u64 { GENERATION.fetch_add(1, Ordering::SeqCst) + 1 }
pub fn alive(epoch: u64) -> bool { generation() == epoch }

/// Polling loop, stopped at the next config reload.
pub fn every(epoch: u64, period: std::time::Duration, mut f: impl FnMut() + Send + 'static) {
    std::thread::spawn(move || {
        while alive(epoch) {
            f();
            std::thread::sleep(period);
        }
    });
}
