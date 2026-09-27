//! Sondes système : CPU, mémoire, disques, réseau, batterie, fenêtre active, utilisation Claude.
use crate::{config, hub, util, win32};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

pub fn cpu(epoch: u64, secs: f64) {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    hub::every(epoch, Duration::from_secs_f64(secs), move || {
        sys.refresh_cpu_all();
        let cpus = sys.cpus();
        hub::publish("cpu", json!({
            "usage": sys.global_cpu_usage().round() as u32, "cores": cpus.len(),
            "model": cpus.first().map(|c| c.brand().trim().to_owned()).unwrap_or_default(),
            "speed": util::round1(cpus.first().map(|c| c.frequency()).unwrap_or(0) as f64 / 1000.0),
        }));
    });
}

pub fn memory(epoch: u64, secs: f64) {
    let mut sys = System::new();
    hub::every(epoch, Duration::from_secs_f64(secs), move || {
        sys.refresh_memory();
        let (total, avail) = (sys.total_memory() as f64, sys.available_memory() as f64);
        hub::publish("memory", json!({
            "percentage": ((total - avail) / total * 100.0).round() as u32,
            "used": util::round1((total - avail) / GIB), "total": util::round1(total / GIB), "avail": util::round1(avail / GIB),
        }));
    });
}

pub fn disk(epoch: u64, secs: f64) {
    hub::every(epoch, Duration::from_secs_f64(secs), || {
        let disks = Disks::new_with_refreshed_list();
        let mut out = Map::new();
        for d in disks.list() {
            let letter = d.mount_point().to_string_lossy().chars().next().unwrap_or('?').to_ascii_uppercase().to_string();
            let (total, free) = (d.total_space() as f64, d.available_space() as f64);
            if total <= 0.0 || out.contains_key(&letter) { continue; }
            out.insert(letter, json!({
                "total": util::round1(total / GIB), "free": util::round1(free / GIB), "used": util::round1((total - free) / GIB),
                "percentage": ((total - free) / total * 100.0).round() as u32,
            }));
        }
        hub::publish("disk", Value::Object(out));
    });
}

pub fn battery(epoch: u64, secs: f64) {
    hub::every(epoch, Duration::from_secs_f64(secs), || {
        let mut s = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut s) }.is_err() { return; }
        let life = s.BatteryLifeTime;
        hub::publish("battery", json!({
            "present": s.BatteryFlag & 128 == 0 && s.BatteryFlag != 255,
            "capacity": if s.BatteryLifePercent <= 100 { s.BatteryLifePercent as u32 } else { 0 },
            "plugged": s.ACLineStatus == 1,
            "charging": s.BatteryFlag & 8 != 0 || (s.ACLineStatus == 1 && s.BatteryLifePercent < 100),
            "time": if life != u32::MAX && life > 0 { format!("{}h{:02}", life / 3600, life % 3600 / 60) } else { String::new() },
        }));
    });
}

fn wlan_info() -> (Option<String>, Option<u32>) {
    let out = util::hidden("netsh").args(["wlan", "show", "interfaces"]).output().ok();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    let field = |name: &str| text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == name).then(|| v.trim().to_owned())
    });
    (field("SSID"), field("Signal").and_then(|s| s.trim_end_matches('%').trim().parse().ok()))
}

pub fn network(epoch: u64, secs: f64) {
    let mut nets = Networks::new_with_refreshed_list();
    let mut last = Instant::now();
    let mut wifi: (Option<String>, Option<u32>) = (None, None);
    let mut wifi_at = Instant::now() - Duration::from_secs(60);
    hub::every(epoch, Duration::from_secs_f64(secs), move || {
        nets.refresh(true);
        let dt = last.elapsed().as_secs_f64().max(0.1);
        last = Instant::now();
        let skip = ["loopback", "vethernet", "vmware", "virtualbox", "wsl", "bluetooth", "teredo", "isatap"];
        // Interface par défaut : celle qui a le plus de trafic parmi celles qui ont une IPv4.
        let best = nets.iter()
            .filter(|(name, _)| !skip.iter().any(|s| name.to_lowercase().contains(s)))
            .filter_map(|(name, d)| {
                let ip = d.ip_networks().iter().map(|n| n.addr).find(|a| a.is_ipv4() && !a.to_string().starts_with("169.254"))?;
                Some((name.clone(), ip, d.received(), d.transmitted(), d.total_received()))
            })
            .max_by_key(|x| x.4);
        let Some((name, ip, rx, tx, _)) = best else { return hub::publish("network", json!({ "connected": false, "type": "disconnected" })) };
        let lower = name.to_lowercase();
        let wireless = ["wi-fi", "wifi", "wireless", "wlan"].iter().any(|s| lower.contains(s));
        if wireless && wifi_at.elapsed() > Duration::from_secs(15) { wifi = wlan_info(); wifi_at = Instant::now(); }
        let (down, up) = (rx as f64 / dt, tx as f64 / dt);
        hub::publish("network", json!({
            "connected": true, "type": if wireless { "wifi" } else { "ethernet" }, "ifname": name, "ipaddr": ip.to_string(),
            "essid": if wireless { wifi.0.clone().unwrap_or_default() } else { String::new() },
            "signal": if wireless { json!(wifi.1.unwrap_or(0)) } else { Value::Null },
            "down": util::format_rate(down), "up": util::format_rate(up), "downBytes": down, "upBytes": up,
        }));
    });
}

/// Fenêtre active (module "window" de la barre).
pub fn window(epoch: u64, ignored: impl Fn() -> Vec<isize> + Send + 'static) {
    let mut last_key = String::from("-");
    let mut icons: HashMap<String, Option<String>> = HashMap::new();
    hub::every(epoch, Duration::from_millis(250), move || {
        let w = win32::foreground_window();
        let shell = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];
        let w = w.filter(|w| !ignored().contains(&w.hwnd) && !shell.contains(&w.class.as_str()));
        let key = w.as_ref().map(|w| format!("{}|{}", w.hwnd, w.title)).unwrap_or_default();
        if key == last_key { return; }
        last_key = key;
        let Some(w) = w else { return hub::publish("window", json!({ "title": "", "app": "", "icon": null, "empty": true })) };
        let icon = icons.entry(w.exe.clone()).or_insert_with(|| win32::exe_icon_png(&w.exe)).clone();
        let app = w.exe.rsplit('\\').next().unwrap_or("").trim_end_matches(".exe").to_owned();
        hub::publish("window", json!({ "title": w.title, "app": app, "exe": w.exe, "icon": icon, "empty": w.title.is_empty() }));
    });
}

// --- Utilisation du forfait Claude -----------------------------------------------------------------
// Même source que la commande /usage de Claude Code. Le jeton est relu à chaque fois (Claude Code
// le renouvelle lui-même) et n'est jamais renouvelé ici : ça déconnecterait Claude Code.

fn claude_credentials() -> std::path::PathBuf { config::home().join(".claude").join(".credentials.json") }

pub fn claude_installed() -> bool { claude_credentials().exists() }

/// Compte connecté à Claude Code, adresse masquée : jo****83@gmail.com
fn claude_account() -> Option<String> {
    let text = std::fs::read_to_string(config::home().join(".claude.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let email = v["oauthAccount"]["emailAddress"].as_str()?;
    let (user, domain) = email.split_once('@')?;
    let chars: Vec<char> = user.chars().collect();
    Some(if chars.len() <= 4 {
        format!("{}****@{domain}", chars[0])
    } else {
        format!("{}****{}@{domain}", chars[..2].iter().collect::<String>(), chars[chars.len() - 2..].iter().collect::<String>())
    })
}

// Derniers chiffres connus et prochain appel autorisé : conservés d'un rechargement à l'autre,
// pour réafficher tout de suite à la réactivation et ne pas dépasser la limite de requêtes
// de l'API (cocher / décocher l'option ne relance pas d'appel immédiat).
fn claude_cache_file() -> std::path::PathBuf { config::config_dir().join(".claude-usage.json") }

static CLAUDE_CACHE: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
static CLAUDE_NEXT: std::sync::Mutex<Option<(Instant, u64)>> = std::sync::Mutex::new(None); // (prochain appel, attente en cas de refus)
static CLAUDE_LAST_TRY: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
static CLAUDE_FORCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Bouton "actualiser" de l'encoche : appel immédiat, sauf si le dernier date de moins de 20 s.
pub fn claude_refresh() { CLAUDE_FORCE.store(true, std::sync::atomic::Ordering::SeqCst); }

fn republish_cache() {
    let cached = CLAUDE_CACHE.lock().unwrap().clone();
    if let Some(c) = cached { hub::publish("claude", c); }
}

pub fn claude(epoch: u64, secs: f64) {
    let interval = Duration::from_secs_f64(secs.max(60.0));
    // Derniers chiffres : en mémoire, sinon ceux enregistrés sur le disque (redémarrage de Kysland).
    // Verrou relâché avant de lire le fichier : le reprendre dans la même instruction bloquerait.
    let in_memory = CLAUDE_CACHE.lock().unwrap().clone();
    let cached = in_memory.or_else(|| {
        let v = std::fs::read_to_string(claude_cache_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())?;
        *CLAUDE_CACHE.lock().unwrap() = Some(v.clone());
        Some(v)
    });
    if let Some(c) = cached { hub::publish("claude", c); }
    hub::every(epoch, Duration::from_secs(1), move || {
        let now = Instant::now();
        let forced = CLAUDE_FORCE.swap(false, std::sync::atomic::Ordering::SeqCst);
        if forced {
            // Appel récent : on réaffiche simplement les derniers chiffres.
            if CLAUDE_LAST_TRY.lock().unwrap().is_some_and(|t| now.duration_since(t) < Duration::from_secs(20)) { return republish_cache(); }
        } else if CLAUDE_NEXT.lock().unwrap().is_some_and(|(next, _)| now < next) {
            return;
        }
        *CLAUDE_LAST_TRY.lock().unwrap() = Some(now);
        let oauth = std::fs::read_to_string(claude_credentials()).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .map(|v| v["claudeAiOauth"].clone());
        let Some(token) = oauth.as_ref().and_then(|o| o["accessToken"].as_str()) else {
            return hub::publish("claude", json!({ "ok": false, "reason": "absent" }));
        };
        let oauth = oauth.as_ref().unwrap();
        if oauth["expiresAt"].as_i64().is_some_and(|e| e < util::now_ms()) {
            return hub::publish("claude", json!({ "ok": false, "reason": "expired" }));
        }
        let res = ureq::get("https://api.anthropic.com/api/oauth/usage")
            .header("Authorization", &format!("Bearer {token}"))
            .header("anthropic-beta", "oauth-2025-04-20")
            .header("User-Agent", "Kysland")
            .call();
        let mut res = match res {
            Ok(r) => r,
            Err(ureq::Error::StatusCode(401)) => {
                *CLAUDE_NEXT.lock().unwrap() = Some((now + interval, 0));
                return hub::publish("claude", json!({ "ok": false, "reason": "expired" }));
            }
            Err(ureq::Error::StatusCode(429)) => {
                // Trop de requêtes : attente croissante (2, 4, 8 puis 15 min), derniers chiffres gardés.
                let wait = CLAUDE_NEXT.lock().unwrap().map(|(_, w)| w).filter(|w| *w > 0).map(|w| (w * 2).min(900)).unwrap_or(120);
                *CLAUDE_NEXT.lock().unwrap() = Some((now + Duration::from_secs(wait), wait));
                let has_cache = CLAUDE_CACHE.lock().unwrap().is_some();
                if !has_cache {
                    hub::publish("claude", json!({ "ok": false, "reason": "rate-limited", "retryAt": util::now_ms() + wait as i64 * 1000 }));
                } else {
                    republish_cache(); // arrête l'animation du bouton, chiffres inchangés
                }
                return;
            }
            Err(_) => { *CLAUDE_NEXT.lock().unwrap() = Some((now + Duration::from_secs(30), 0)); return republish_cache(); } // hors ligne
        };
        *CLAUDE_NEXT.lock().unwrap() = Some((now + interval, 0));
        let Ok(u) = res.body_mut().read_json::<Value>() else { return };
        let window = |w: &Value| if w.is_object() {
            json!({
                "percent": w["utilization"].as_f64().unwrap_or(0.0).round() as u32,
                "resetsAt": w["resets_at"].as_str().and_then(parse_iso_ms),
            })
        } else { Value::Null };
        let data = json!({
            "ok": true, "plan": oauth["subscriptionType"], "account": claude_account(), "fetchedAt": util::now_ms(),
            "session": window(&u["five_hour"]), "week": window(&u["seven_day"]),
        });
        *CLAUDE_CACHE.lock().unwrap() = Some(data.clone());
        let _ = std::fs::write(claude_cache_file(), data.to_string());
        hub::publish("claude", data);
    });
}

/// "2026-09-27T06:29:59.860705+00:00" → millisecondes Unix (UTC).
fn parse_iso_ms(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let time = &rest[..8.min(rest.len())];
    let mut t = time.split(':').map(|x| x.parse::<i64>());
    let (hh, mm, ss) = (t.next()?.ok()?, t.next()?.ok()?, t.next()?.ok()?);
    let tz = rest.get(rest.len().saturating_sub(6)..).filter(|z| z.starts_with('+') || z.starts_with('-'));
    let offset = tz.map(|z| {
        let sign = if z.starts_with('-') { -1 } else { 1 };
        sign * (z[1..3].parse::<i64>().unwrap_or(0) * 60 + z[4..6].parse::<i64>().unwrap_or(0))
    }).unwrap_or(0);
    // Jours depuis 1970 (algorithme de Howard Hinnant).
    let (yy, mo) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mo + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3600 + mm * 60 + ss) - offset * 60) * 1000)
}
