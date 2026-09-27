//! Notifications Windows : lues dans la base du centre de notifications (l'API officielle
//! met ~2 s par lecture ; la base répond en 1 ms et son dossier signale chaque écriture),
//! supprimées via UserNotificationListener (qui, lui, est rapide).
use crate::{hub, util, win32};
use notify::{RecursiveMode, Watcher};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;
use windows::UI::Notifications::Management::UserNotificationListener;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

static DB: Mutex<Option<Connection>> = Mutex::new(None);
static ICONS: LazyLock<Mutex<HashMap<String, Option<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

const QUERY: &str = "
    select n.[Order], n.Id, (n.ArrivalTime - 116444736000000000) / 10000, h.PrimaryId, n.Payload,
      (select AssetValue from HandlerAssets a where a.HandlerId = h.RecordId and a.AssetKey = 'DisplayName'),
      (select AssetValue from HandlerAssets a where a.HandlerId = h.RecordId and a.AssetKey = 'LaunchArgs')
    from Notification n join NotificationHandler h on h.RecordId = n.HandlerId
    where n.Type = 'toast'";

fn dir() -> PathBuf {
    PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Microsoft").join("Windows").join("Notifications")
}

struct Row { ord: i64, nid: i64, at: i64, aumid: String, payload: Vec<u8>, name: Option<String>, launch_args: Option<String> }

fn rows(sql_tail: &str, param: i64) -> Vec<Row> {
    let guard = DB.lock().unwrap();
    let Some(db) = guard.as_ref() else { return vec![] };
    let mut stmt = match db.prepare(&format!("{QUERY} {sql_tail}")) { Ok(s) => s, Err(e) => { eprintln!("[kysland] notifications : {e}"); return vec![]; } };
    stmt.query_map([param], |r| Ok(Row {
        ord: r.get(0)?, nid: r.get(1)?, at: r.get(2)?, aumid: r.get(3)?, payload: r.get(4).unwrap_or_default(),
        name: r.get(5).ok(), launch_args: r.get(6).ok(),
    }))
    .map(|it| it.filter_map(|r| r.map_err(|e| eprintln!("[kysland] notification illisible : {e}")).ok()).collect())
    .unwrap_or_default()
}

pub fn start(epoch: u64) {
    let conn = Connection::open_with_flags(dir().join("wpndatabase.db"), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX);
    let Ok(conn) = conn else { return eprintln!("[kysland] notifications indisponibles") };
    let mut last: i64 = conn.query_row("select coalesce(max([Order]), 0) from Notification", [], |r| r.get(0)).unwrap_or(0);
    *DB.lock().unwrap() = Some(conn);
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let mut watcher = notify::recommended_watcher(move |_| { let _ = tx.send(()); }).ok();
        if let Some(w) = watcher.as_mut() { let _ = w.watch(&dir(), RecursiveMode::NonRecursive); }
        while hub::alive(epoch) {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(()) => { std::thread::sleep(Duration::from_millis(80)); while rx.try_recv().is_ok() {} }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            for r in rows("and n.[Order] > ?1 order by n.[Order]", last) {
                last = last.max(r.ord);
                if util::now_ms() - r.at > 60_000 { continue; } // ancienne notification resynchronisée
                if let Some(n) = parse(&r) { hub::event("notification", n); }
            }
        }
        drop(watcher);
        *DB.lock().unwrap() = None;
    });
}

pub fn list(limit: i64) -> Vec<Value> {
    rows("order by n.[Order] desc limit ?1", limit).iter().filter_map(parse).collect()
}

fn decode(s: &str) -> String {
    static ENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(#x[0-9a-fA-F]+|#\d+|\w+);").unwrap());
    ENT.replace_all(s, |c: &regex::Captures| {
        let e = &c[1];
        if let Some(hex) = e.strip_prefix("#x") { return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(String::from).unwrap_or_default(); }
        if let Some(dec) = e.strip_prefix('#') { return dec.parse().ok().and_then(char::from_u32).map(String::from).unwrap_or_default(); }
        match e { "amp" => "&", "lt" => "<", "gt" => ">", "quot" => "\"", "apos" => "'", _ => return c[0].to_owned() }.to_owned()
    }).into_owned()
}

/// Nom lisible depuis l'identifiant d'appli (AUMID) quand Windows n'en stocke pas.
fn app_name(aumid: &str) -> String {
    if let Some(pkg) = aumid.split('!').next().filter(|_| aumid.contains('!')) {
        return pkg.split('_').next().unwrap_or(pkg).rsplit('.').next().unwrap_or(pkg).to_owned();
    }
    if aumid.contains('\\') || aumid.to_lowercase().ends_with(".exe") {
        let base = aumid.rsplit(['\\', '/']).next().unwrap_or(aumid);
        return base.strip_suffix(".exe").or(base.strip_suffix(".EXE")).unwrap_or(base).to_owned();
    }
    let last = aumid.rsplit('.').find(|s| !s.is_empty()).unwrap_or(aumid);
    let mut c = last.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn parse(r: &Row) -> Option<Value> {
    static TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<text\b([^>]*)>(.*?)</text>").unwrap());
    static LOGO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"<image\b[^>]*placement="appLogoOverride"[^>]*>|<image\b[^>]*>"#).unwrap());
    static SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"src="([^"]+)""#).unwrap());
    static TOAST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<toast\b([^>]*)>").unwrap());
    static LAUNCH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"launch="([^"]*)""#).unwrap());
    let xml = String::from_utf8_lossy(&r.payload);
    let texts: Vec<String> = TEXT.captures_iter(&xml)
        .filter(|c| !c[1].contains("placement=\"attribution\""))
        .map(|c| decode(c[2].trim()))
        .filter(|t| !t.is_empty())
        .collect();
    let title = texts.first()?.clone();
    let logo = LOGO.find_iter(&xml).map(|m| m.as_str()).find(|t| t.contains("appLogoOverride"))
        .and_then(|t| SRC.captures(t)).map(|c| decode(&c[1])).filter(|s| !s.starts_with("ms-app"));
    // Lien d'ouverture de la notification (protocole), sinon celui de l'appli (ex. ms-phone:).
    let toast = TOAST.captures(&xml).map(|c| c[1].to_owned()).unwrap_or_default();
    let launch = if toast.contains("activationType=\"protocol\"") { LAUNCH.captures(&toast).map(|c| decode(&c[1])) } else { None }
        .or_else(|| r.launch_args.clone().filter(|a| a.contains(':') && !a.starts_with(':')));
    Some(json!({
        "id": r.ord, "nid": r.nid, "aumid": r.aumid, "launch": launch,
        "app": r.name.clone().unwrap_or_else(|| app_name(&r.aumid)),
        "title": title, "body": texts[1..].join("\n"), "at": r.at, "icon": logo.and_then(|s| icon(&s)),
    }))
}

fn icon(src: &str) -> Option<String> {
    if let Some(cached) = ICONS.lock().unwrap().get(src) { return cached.clone(); }
    let bytes = if src.starts_with("http") {
        ureq::get(src).call().ok().and_then(|mut r| r.body_mut().read_to_vec().ok())
    } else {
        let path = src.trim_start_matches("file:///").trim_start_matches("file://").replace("%20", " ");
        std::fs::read(path).ok()
    };
    let url = bytes.map(|b| util::data_url(&b, util::image_mime(&b)));
    ICONS.lock().unwrap().insert(src.to_owned(), url.clone());
    url
}

/// Suppression dans le centre de notifications (ClearNotifications ne fait rien pour une appli
/// non packagée : on retire donc chaque notification une par une).
pub fn remove(ids: Vec<u32>) {
    std::thread::spawn(move || {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let Ok(listener) = UserNotificationListener::Current() else { return };
        for id in ids { let _ = listener.RemoveNotification(id); }
    });
}

pub fn clear_all() {
    let ids = rows("and ?1 = ?1", 0).into_iter().map(|r| r.nid as u32).collect();
    remove(ids);
}

/// Ouvre l'appli d'une notification : son lien s'il y en a un, sinon l'appli via son identifiant.
pub fn open(aumid: Option<&str>, launch: Option<&str>) {
    if let Some(l) = launch.filter(|l| !l.to_lowercase().starts_with("file:") && !l.to_lowercase().starts_with("javascript:")) {
        return win32::shell_open(l);
    }
    if let Some(a) = aumid { win32::shell_open(&format!("shell:AppsFolder\\{a}")); }
}
