//! Kysland : Dynamic Island (et barre de statut) pour Windows.
mod audio;
mod autostart;
mod config;
mod glaze;
mod hub;
mod media;
mod notifs;
mod system;
mod util;
mod win32;

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Copy, Deserialize)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }

struct Bar {
    label: String,
    hwnd: isize,
    index: usize,
    primary: bool,
    monitor: (i32, i32, i32, i32), // x, y, largeur, hauteur (pixels physiques)
    scale: f64,
    appbar: Option<win32::AppBar>,
    rects: Vec<Rect>,
    interactive: bool,
    fullscreen: bool,
}

#[derive(Default)]
struct Shared {
    cfg: Value,
    bars: Vec<Bar>,
    layout: String,
    taskbar_hidden: bool,
    hide_osd: bool,
    wallpaper: Option<String>,
    autostart_on: bool,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static BAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn with<R>(f: impl FnOnce(&mut Shared) -> R) -> R { f(SHARED.lock().unwrap().get_or_insert_with(Shared::default)) }

const LAYOUT_KEYS: [&str; 5] = ["position", "height", "monitors", "popup-space", "reserve"];

fn resources(app: &AppHandle) -> PathBuf { app.path().resource_dir().unwrap_or_default() }

fn styles(app: &AppHandle, cfg: &Value) -> Value {
    let theme = cfg["theme"].as_str().and_then(|t| config::theme_file(&resources(app), t));
    json!({ "theme": theme, "style": config::style_file(), "v": util::now_ms() })
}

/// Message dans l'encoche (erreurs de config, scripts : --island="...").
fn island_message(text: &str, icon: &str) {
    eprintln!("[kysland] {text}");
    hub::emit("island", json!({ "text": text, "icon": icon }));
}

// --- Fenêtres (une par écran) -------------------------------------------------------------------

fn create_bars(app: &AppHandle, cfg: &Value) {
    let mut monitors = app.available_monitors().unwrap_or_default();
    monitors.sort_by_key(|m| (m.position().x, m.position().y));
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let chosen: Vec<(usize, &tauri::Monitor)> = match &cfg["monitors"] {
        Value::Array(list) => list.iter().filter_map(|i| i.as_u64()).filter_map(|i| monitors.get(i as usize).map(|m| (i as usize, m))).collect(),
        Value::String(s) if s == "all" => monitors.iter().enumerate().collect(),
        _ => monitors.iter().enumerate().filter(|(_, m)| Some((m.position().x, m.position().y)) == primary).collect(),
    };
    for (index, m) in chosen {
        let label = format!("bar-{}", BAR_COUNTER.fetch_add(1, Ordering::SeqCst));
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
            .title("Kysland")
            .transparent(true)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(false)
            .resizable(false)
            .focused(false)
            .visible(false)
            .build();
        let Ok(win) = built else { continue };
        let Ok(h) = win.hwnd() else { continue };
        let hwnd = h.0 as isize;
        win32::make_tool_window(hwnd);
        let (p, s) = (m.position(), m.size());
        let mut bar = Bar {
            label, hwnd, index, primary: Some((p.x, p.y)) == primary,
            monitor: (p.x, p.y, s.width as i32, s.height as i32), scale: m.scale_factor(),
            appbar: (cfg["reserve"] == true).then(|| win32::AppBar::register(hwnd)),
            rects: vec![], interactive: false, fullscreen: false,
        };
        position_bar(&mut bar, cfg);
        let _ = win.set_ignore_cursor_events(true);
        let _ = win.show();
        with(|s| s.bars.push(bar));
    }
}

fn position_bar(bar: &mut Bar, cfg: &Value) {
    let (x, y, w, h) = bar.monitor;
    let height = cfg["height"].as_f64().unwrap_or(32.0);
    let total = ((height + cfg["popup-space"].as_f64().unwrap_or(420.0)) * bar.scale).round() as i32;
    let bottom = cfg["position"] == "bottom";
    let monitor = windows::Win32::Foundation::RECT { left: x, top: y, right: x + w, bottom: y + h };
    let rc = match bar.appbar.as_mut() {
        Some(ab) => ab.set_pos(bottom, monitor, (height * bar.scale).round() as i32),
        None => monitor,
    };
    let top = if bottom { rc.bottom - total } else { rc.top };
    win32::place_window(bar.hwnd, (x, top, w, total), !bar.fullscreen);
}

fn destroy_bars(app: &AppHandle) {
    let bars = with(|s| std::mem::take(&mut s.bars));
    for bar in bars {
        drop(bar.appbar); // ABM_REMOVE
        if let Some(w) = app.get_webview_window(&bar.label) { let _ = w.destroy(); }
    }
}

fn bar_hwnds() -> Vec<isize> { with(|s| s.bars.iter().map(|b| b.hwnd).collect()) }

// --- Application de la config ------------------------------------------------------------------

fn reload(app: &AppHandle, force_layout: bool) {
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => return island_message(&e, "triangle-alert"),
    };
    let layout = LAYOUT_KEYS.iter().map(|k| cfg[*k].to_string()).collect::<Vec<_>>().join("|");
    let relayout = force_layout || with(|s| s.bars.is_empty() || s.layout != layout);
    with(|s| { s.cfg = cfg.clone(); s.layout = layout; });
    if relayout {
        destroy_bars(app);
        create_bars(app, &cfg);
    } else {
        hub::emit("reload", Value::Null);
    }
    start_pollers(app, &cfg);
    apply_system(&cfg);
    update_tray(app);
}

fn apply_system(cfg: &Value) {
    let hide = cfg["hideWindowsTaskbar"] == true;
    let was = with(|s| std::mem::replace(&mut s.taskbar_hidden, hide));
    if hide && !was {
        let original = win32::hide_taskbar();
        let _ = std::fs::write(config::config_dir().join(".taskbar-state"), original.to_string());
    } else if !hide && was {
        win32::show_taskbar(None);
        let _ = std::fs::remove_file(config::config_dir().join(".taskbar-state"));
    }
    let island = config::island_conf(cfg);
    let hide_osd = config::island_name(cfg).is_some() && island["hide-windows-osd"] != false;
    with(|s| s.hide_osd = hide_osd);
    if hide_osd { win32::hide_volume_osd(); } else { win32::restore_volume_osd(); }
    audio::set_key_hook(hide_osd.then(|| island["volume-step"].as_u64().unwrap_or(2) as u32));
    if let Some(w) = cfg["wallpaper"].as_str() {
        if with(|s| s.wallpaper.as_deref() != Some(w)) {
            let file = config::config_dir().join(w.replacen('~', &config::home().to_string_lossy(), 1));
            if file.exists() { win32::set_wallpaper(&file.to_string_lossy()); with(|s| s.wallpaper = Some(w.to_owned())); }
            else { island_message(&format!("Fond d'écran introuvable : {}", file.display()), "image"); }
        }
    }
}

/// Démarre les sondes utilisées par les modules de la config (arrêtées au rechargement suivant).
fn start_pollers(_app: &AppHandle, cfg: &Value) {
    let epoch = hub::next_generation();
    let mut need: std::collections::HashMap<&str, f64> = std::collections::HashMap::new();
    let mut want = |topic: &'static str, secs: f64| {
        let e = need.entry(topic).or_insert(secs);
        if secs < *e { *e = secs; }
    };
    let mut kemhome = None;
    let mut glaze_on = false;
    for name in config::all_modules(cfg) {
        let kind = name.split(['/', '#']).next().unwrap_or("");
        let iv = cfg[&name]["interval"].as_f64();
        match kind {
            "island" => {
                let c = &cfg[&name];
                for (t, s) in [("audio", 1.0), ("media", 1.0), ("battery", 20.0), ("network", 2.0), ("cpu", 2.0), ("memory", 3.0)] { want(t, s); }
                if c["notifications"] != false { want("notification", 1.0); }
                if c["claude"] == true && system::claude_installed() { want("claude", c["claude-interval"].as_f64().unwrap_or(60.0)); }
                kemhome = match &c["kemhome"] { Value::Bool(false) => None, Value::String(s) => Some(s.clone()), _ => Some("http://localhost:8080".into()) };
                glaze_on = true;
            }
            "workspaces" | "mode" => glaze_on = true,
            "cpu" => want("cpu", iv.unwrap_or(2.0)),
            "memory" => want("memory", iv.unwrap_or(3.0)),
            "disk" => want("disk", iv.unwrap_or(30.0)),
            "battery" => want("battery", iv.unwrap_or(20.0)),
            "network" => want("network", iv.unwrap_or(2.0)),
            "audio" => want("audio", 1.0),
            "window" => want("window", 0.25),
            "media" => want("media", 1.0),
            _ => {}
        }
    }
    for (topic, secs) in need {
        match topic {
            "cpu" => system::cpu(epoch, secs),
            "memory" => system::memory(epoch, secs),
            "disk" => system::disk(epoch, secs),
            "battery" => system::battery(epoch, secs),
            "network" => system::network(epoch, secs),
            "window" => system::window(epoch, bar_hwnds),
            "claude" => system::claude(epoch, secs),
            "audio" => audio::start(),
            "media" => media::start(epoch, kemhome.clone()),
            "notification" => notifs::start(epoch),
            _ => {}
        }
    }
    if glaze_on { glaze::start(epoch); }
}

// --- Boucle de fond : souris, plein écran, premier plan ------------------------------------------

/// La fenêtre couvre tout le haut de l'écran mais ne capte la souris qu'au-dessus des zones
/// envoyées par la page (encoche, popups, modules) : ailleurs, les clics passent dessous.
fn background_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let (mut fs_at, mut top_at, mut shell_at) = (Instant::now(), Instant::now(), Instant::now());
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let (cx, cy) = win32::cursor_pos();
            let mut toggles: Vec<(String, bool)> = Vec::new();
            with(|s| for bar in &mut s.bars {
                let Some(rc) = win32::window_rect(bar.hwnd) else { continue };
                let inside = !bar.fullscreen && bar.rects.iter().any(|r| {
                    let (x, y) = (rc.left as f64 + r.x * bar.scale, rc.top as f64 + r.y * bar.scale);
                    (cx as f64) >= x && (cx as f64) < x + r.w * bar.scale && (cy as f64) >= y && (cy as f64) < y + r.h * bar.scale
                });
                if inside != bar.interactive { bar.interactive = inside; toggles.push((bar.label.clone(), inside)); }
            });
            for (label, inside) in toggles {
                if let Some(w) = app.get_webview_window(&label) { let _ = w.set_ignore_cursor_events(!inside); }
                if !inside { let _ = app.emit("pointer-left", json!({ "label": label })); }
            }
            // Plein écran : la fenêtre au premier plan épouse exactement l'écran (à 1 px près).
            if fs_at.elapsed() >= Duration::from_millis(400) {
                fs_at = Instant::now();
                let enabled = with(|s| s.cfg["hide-on-fullscreen"] != false);
                let rc = if enabled { win32::foreground_rect(&bar_hwnds()) } else { None };
                let changes: Vec<(String, isize, bool)> = with(|s| s.bars.iter_mut().filter_map(|b| {
                    let (x, y, w, h) = b.monitor;
                    let covers = rc.is_some_and(|r| (r.left - x).abs() <= 1 && (r.top - y).abs() <= 1 && (r.right - x - w).abs() <= 1 && (r.bottom - y - h).abs() <= 1);
                    (covers != b.fullscreen).then(|| { b.fullscreen = covers; (b.label.clone(), b.hwnd, covers) })
                }).collect());
                for (label, hwnd, full) in changes {
                    if let Some(w) = app.get_webview_window(&label) {
                        let _ = w.set_always_on_top(!full);
                        if full { let _ = w.hide(); } else { let _ = w.show(); win32::raise_topmost(hwnd); }
                    }
                }
            }
            // Premier plan perdu (fenêtre créée à l'ouverture de session...).
            if top_at.elapsed() >= Duration::from_secs(1) {
                top_at = Instant::now();
                for hwnd in with(|s| s.bars.iter().filter(|b| !b.fullscreen).map(|b| b.hwnd).collect::<Vec<_>>()) {
                    if win32::is_buried(hwnd) { win32::raise_topmost(hwnd); }
                }
            }
            // Explorer peut réafficher la barre des tâches ou recréer la pastille de volume.
            if shell_at.elapsed() >= Duration::from_millis(1500) {
                shell_at = Instant::now();
                let (taskbar, osd) = with(|s| (s.taskbar_hidden, s.hide_osd));
                if taskbar { win32::hide_taskbar(); }
                if osd { win32::hide_volume_osd(); }
            }
        }
    });
}

/// Rechargement à chaud : style.css / thèmes → styles ; config.jsonc → rechargement.
fn watch_config(app: AppHandle) {
    use notify::{RecursiveMode, Watcher};
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
        let Ok(mut watcher) = notify::recommended_watcher(tx) else { return };
        let _ = watcher.watch(&config::config_dir(), RecursiveMode::Recursive);
        while let Ok(first) = rx.recv() {
            std::thread::sleep(Duration::from_millis(250));
            let mut events = vec![first];
            while let Ok(e) = rx.try_recv() { events.push(e); }
            let paths: Vec<PathBuf> = events.into_iter().flatten().flat_map(|e| e.paths).collect();
            if paths.iter().any(|p| p.file_name().is_some_and(|n| n == "config.jsonc")) {
                let a = app.clone();
                let _ = app.run_on_main_thread(move || reload(&a, false));
            } else if paths.iter().any(|p| p.extension().is_some_and(|x| x == "css")) {
                let cfg = with(|s| s.cfg.clone());
                hub::emit("style", styles(&app, &cfg));
            }
        }
    });
}

// --- Commandes appelées par l'interface -------------------------------------------------------------

#[tauri::command]
fn init(window: WebviewWindow) -> Value {
    let app = window.app_handle();
    let (cfg, monitor) = with(|s| {
        let bar = s.bars.iter().find(|b| b.label == window.label());
        (s.cfg.clone(), bar.map(|b| json!({
            "index": b.index, "primary": b.primary, "scaleFactor": b.scale,
            "physical": { "x": b.monitor.0, "y": b.monitor.1, "width": b.monitor.2, "height": b.monitor.3 },
        })))
    });
    json!({ "config": cfg, "styles": styles(app, &cfg), "monitor": monitor, "glaze": glaze::state(), "data": hub::snapshot() })
}

#[tauri::command]
async fn run_command(cmd: String) -> Value {
    let (ok, output) = tauri::async_runtime::spawn_blocking(move || util::run_shell(&cmd)).await.unwrap_or((false, String::new()));
    json!({ "ok": ok, "output": output })
}

#[tauri::command]
async fn notifications() -> Vec<Value> {
    tauri::async_runtime::spawn_blocking(|| notifs::list(30)).await.unwrap_or_default()
}

#[tauri::command]
fn set_hit_rects(window: WebviewWindow, rects: Vec<Rect>) {
    with(|s| if let Some(b) = s.bars.iter_mut().find(|b| b.label == window.label()) { b.rects = rects; });
}

#[tauri::command]
fn action(window: WebviewWindow, name: String, arg: Value, extra: Value) {
    let app = window.app_handle().clone();
    let text = arg.as_str().unwrap_or("").to_owned();
    match name.as_str() {
        "exec" => util::spawn_shell(&text),
        "open" => win32::shell_open(&text),
        "audio" => {
            let step = extra.as_u64().unwrap_or(5) as u32;
            audio::command(match (arg.as_u64(), text.as_str()) {
                (Some(v), _) => audio::Command::Set(v as u32),
                (_, "up") => audio::Command::Up(step),
                (_, "down") => audio::Command::Down(step),
                _ => audio::Command::ToggleMute,
            });
        }
        "glaze" => glaze::command(&text),
        "start-menu" => win32::press_keys(&[win32::VK_LWIN]),
        "media" => {
            // Contrôle précis via SMTC ; touches multimédia si aucune session n'est connue.
            let ctl = match text.as_str() {
                "play-pause" => Some(media::Control::PlayPause), "next" => Some(media::Control::Next),
                "prev" => Some(media::Control::Prev), "seek" => Some(media::Control::Seek(extra.as_f64().unwrap_or(0.0))), _ => None,
            };
            let handled = media::has_session() && ctl.is_some_and(media::control);
            if !handled {
                let vk = match text.as_str() { "next" => win32::VK_MEDIA_NEXT, "prev" => win32::VK_MEDIA_PREV, _ => win32::VK_MEDIA_PLAY_PAUSE };
                win32::press_keys(&[vk]);
            }
        }
        "power" => match text.as_str() {
            "lock" => win32::lock_workstation(),
            "sleep" => util::spawn_shell("rundll32.exe powrprof.dll,SetSuspendState 0,1,0"),
            "logout" => util::spawn_shell("shutdown /l"),
            "restart" => util::spawn_shell("shutdown /r /t 0"),
            "shutdown" => util::spawn_shell("shutdown /s /t 0"),
            _ => {}
        },
        "reload" => { let a = app.clone(); let _ = app.run_on_main_thread(move || reload(&a, true)); }
        "open-config" => win32::shell_open(&config::config_dir().to_string_lossy()),
        "notification-center" => win32::press_keys(&[win32::VK_LWIN, 0x4E]),
        "notif-remove" => if let Some(id) = arg.as_u64() { notifs::remove(vec![id as u32]) },
        "notif-clear" => notifs::clear_all(),
        "notif-open" => notifs::open(arg["aumid"].as_str(), arg["launch"].as_str()),
        "menu" => show_menu(&app, Some(window.label().to_owned())),
        _ => {}
    }
}

// --- Menu (zone de notification, clic droit sur l'encoche, Ctrl+Alt+W) -----------------------------

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let cfg = with(|s| s.cfg.clone());
    let island = config::island_conf(&cfg);
    let claude = system::claude_installed();
    let themes: Vec<CheckMenuItem<tauri::Wry>> = config::list_themes(&resources(app)).into_iter()
        .map(|t| CheckMenuItem::with_id(app, format!("theme:{t}"), &t, true, cfg["theme"] == t.as_str(), None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let theme_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = themes.iter().map(|t| t as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    Menu::with_items(app, &[
        &MenuItem::with_id(app, "title", "Kysland", false, None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "reload", "Recharger", true, None::<&str>)?,
        &MenuItem::with_id(app, "open-config", "Ouvrir le dossier de config", true, None::<&str>)?,
        &MenuItem::with_id(app, "edit-config", "Éditer config.jsonc", true, None::<&str>)?,
        &MenuItem::with_id(app, "edit-style", "Éditer style.css", true, None::<&str>)?,
        &MenuItem::with_id(app, "devtools", "Inspecteur CSS (DevTools)", true, None::<&str>)?,
        &Submenu::with_items(app, "Thème", true, &theme_refs)?,
        &PredefinedMenuItem::separator(app)?,
        &CheckMenuItem::with_id(app, "taskbar", "Masquer la barre des tâches Windows", true, cfg["hideWindowsTaskbar"] == true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "fullscreen", "Cacher en plein écran (jeux, vidéos)", true, cfg["hide-on-fullscreen"] != false, None::<&str>)?,
        &CheckMenuItem::with_id(app, "claude",
            if claude { "Afficher l'utilisation Claude" } else { "Afficher l'utilisation Claude (Claude Code non détecté)" },
            claude, claude && island["claude"] == true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "autostart", "Lancer au démarrage de Windows", true, with(|s| s.autostart_on), None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?,
    ])
}

fn on_menu(app: &AppHandle, id: &str) {
    let cfg = with(|s| s.cfg.clone());
    let island = config::island_name(&cfg).unwrap_or_else(|| "island".into());
    let result = match id {
        "reload" => { reload(app, true); Ok(()) }
        "open-config" => { win32::shell_open(&config::config_dir().to_string_lossy()); Ok(()) }
        "edit-config" => { win32::shell_open(&config::config_file().to_string_lossy()); Ok(()) }
        "edit-style" => { win32::shell_open(&config::style_file().to_string_lossy()); Ok(()) }
        "devtools" => { if let Some(b) = with(|s| s.bars.first().map(|b| b.label.clone())) { if let Some(w) = app.get_webview_window(&b) { w.open_devtools(); } } Ok(()) }
        "taskbar" => config::set_value(&["hideWindowsTaskbar"], json!(cfg["hideWindowsTaskbar"] != true)),
        "fullscreen" => config::set_value(&["hide-on-fullscreen"], json!(cfg["hide-on-fullscreen"] == false)),
        "claude" => config::set_value(&[&island, "claude"], json!(config::island_conf(&cfg)["claude"] != true)),
        "autostart" => { set_autostart(app, !with(|s| s.autostart_on)); Ok(()) }
        "quit" => { app.exit(0); Ok(()) }
        t if t.starts_with("theme:") => config::set_value(&["theme"], json!(&t[6..])),
        _ => Ok(()),
    };
    if let Err(e) = result { island_message(&format!("Impossible de modifier la config : {e}"), "triangle-alert"); }
}

fn update_tray(app: &AppHandle) {
    let Ok(menu) = build_menu(app) else { return };
    if let Some(tray) = app.tray_by_id("main") { let _ = tray.set_menu(Some(menu)); return; }
    let _ = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| tauri::image::Image::new(&[0, 0, 0, 0], 1, 1)))
        .tooltip("Kysland")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|_, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                win32::shell_open(&config::config_dir().to_string_lossy());
            }
        })
        .build(app);
}

/// Menu à la position du curseur, depuis l'encoche. Windows referme un menu dont la fenêtre
/// n'est pas au premier plan : on la passe au premier plan le temps du menu.
fn show_menu(app: &AppHandle, label: Option<String>) {
    let label = label.or_else(|| with(|s| s.bars.first().map(|b| b.label.clone())));
    let Some(win) = label.and_then(|l| app.get_webview_window(&l)) else { return };
    let Ok(menu) = build_menu(app) else { return };
    if let Ok(h) = win.hwnd() { win32::set_foreground(h.0 as isize); }
    let _ = win.popup_menu(&menu);
}

// --- Lancement avec Windows ------------------------------------------------------------------------

fn autostart_file() -> PathBuf { config::config_dir().join(".autostart") }

fn set_autostart(app: &AppHandle, on: bool) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let result = if on { autostart::enable(&exe, &[]) } else { autostart::disable(); Ok(()) };
    match result {
        Ok(()) => { with(|s| s.autostart_on = on); let _ = std::fs::write(autostart_file(), if on { "on" } else { "off" }); }
        Err(e) => island_message(&format!("Lancement au démarrage impossible : {e}"), "triangle-alert"),
    }
    update_tray(app);
}

/// Version installée : activé par défaut, puis selon le choix mémorisé (recréé si la tâche a
/// disparu). En développement, on ne touche à rien tout seul.
fn ensure_autostart(app: &AppHandle) {
    let active = autostart::is_enabled();
    with(|s| s.autostart_on = active);
    if cfg!(debug_assertions) { return update_tray(app); }
    let wanted = std::fs::read_to_string(autostart_file()).map(|s| s.trim().to_owned()).unwrap_or_else(|_| "on".into());
    if wanted == "on" && !active { set_autostart(app, true); }
    else if wanted == "off" && active { set_autostart(app, false); }
    else { update_tray(app); }
}

// --- Arguments, cycle de vie ------------------------------------------------------------------------

fn opt(argv: &[String], name: &str) -> Option<String> {
    argv.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_owned))
}

fn handle_args(app: &AppHandle, argv: Vec<String>) {
    if argv.iter().any(|a| a == "--quit") { return app.exit(0); }
    if let Some(text) = opt(&argv, "island") {
        return hub::emit("island", json!({ "text": text, "icon": opt(&argv, "icon").unwrap_or_else(|| "bell".into()) }));
    }
    if let Some(v) = opt(&argv, "autostart") { return set_autostart(app, v == "on"); }
    reload(app, true);
}

/// Barre des tâches, pastille de volume et zone de travail remises d'aplomb.
fn repair() {
    win32::show_taskbar(Some(0));
    win32::restore_volume_osd();
    win32::reset_work_area();
    let _ = std::fs::remove_file(config::config_dir().join(".taskbar-state"));
}

fn cleanup(app: &AppHandle) {
    destroy_bars(app);
    if with(|s| s.taskbar_hidden) { win32::show_taskbar(None); let _ = std::fs::remove_file(config::config_dir().join(".taskbar-state")); }
    win32::restore_volume_osd();
    audio::set_key_hook(None);
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--repair") { repair(); return; }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| handle_args(app, argv)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+alt+w"]).expect("raccourci")
                .with_handler(|app, _, e| {
                    if e.state == tauri_plugin_global_shortcut::ShortcutState::Pressed { show_menu(app, None); }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![init, run_command, notifications, set_hit_rects, action])
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            hub::init(handle.clone());
            if args.iter().any(|a| a == "--quit") { handle.exit(0); return Ok(()); }
            // Après un crash : barre des tâches laissée masquée / réservations d'écran orphelines.
            if let Ok(state) = std::fs::read_to_string(config::config_dir().join(".taskbar-state")) {
                win32::show_taskbar(state.trim().parse().ok());
            }
            win32::reset_work_area();
            config::ensure(&resources(&handle).join("defaults"));
            reload(&handle, true);
            ensure_autostart(&handle);
            background_loop(handle.clone());
            watch_config(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("impossible de démarrer Kysland")
        .run(|app, event| match event {
            // Fenêtres détruites par un rechargement : l'appli continue (zone de notification).
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => cleanup(app),
            _ => {}
        });
}
