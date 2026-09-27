//! Diffusion des données vers l'interface, avec mémoire de la dernière valeur de chaque sujet
//! (envoyée aux fenêtres qui se créent) et "génération" pour arrêter les sondes au rechargement.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn init(app: AppHandle) { let _ = APP.set(app); }
pub fn app() -> &'static AppHandle { APP.get().expect("hub non initialisé") }

pub fn emit(channel: &str, payload: Value) {
    if let Some(app) = APP.get() { let _ = app.emit(channel, payload); }
}

/// Donnée d'un sujet (cpu, audio, media...) : mémorisée et diffusée.
pub fn publish(topic: &str, data: Value) {
    LAST.lock().unwrap().get_or_insert_with(HashMap::new).insert(topic.to_owned(), data.clone());
    emit("data", json!({ "topic": topic, "data": data }));
}

/// Événement ponctuel (notification) : diffusé sans être mémorisé.
pub fn event(topic: &str, data: Value) { emit("data", json!({ "topic": topic, "data": data })); }

pub fn last(topic: &str) -> Option<Value> { LAST.lock().unwrap().as_ref()?.get(topic).cloned() }

pub fn snapshot() -> Value {
    let map: Map<String, Value> = LAST.lock().unwrap().as_ref().map(|m| m.clone().into_iter().collect()).unwrap_or_default();
    Value::Object(map)
}

pub fn generation() -> u64 { GENERATION.load(Ordering::SeqCst) }
pub fn next_generation() -> u64 { GENERATION.fetch_add(1, Ordering::SeqCst) + 1 }
pub fn alive(epoch: u64) -> bool { generation() == epoch }

/// Boucle de sondage arrêtée au prochain rechargement de la config.
pub fn every(epoch: u64, period: std::time::Duration, mut f: impl FnMut() + Send + 'static) {
    std::thread::spawn(move || {
        while alive(epoch) {
            f();
            std::thread::sleep(period);
        }
    });
}
