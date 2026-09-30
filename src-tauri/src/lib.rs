//! Kysland: a Dynamic Island (and optional status bar) for Windows.
mod audio;
mod autostart;
mod config;
mod glaze;
mod hub;
mod i18n;
mod media;
mod notifs;
mod system;
mod util;
mod win32;

use i18n::{t, tf};
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Clickable area reported by the page, in CSS pixels relative to the window.
#[derive(Clone, Copy, PartialEq, Deserialize)]
struct Rect { x: f64, y: f64, w: f64, h: f64 }

/// One transparent window per screen, holding the island (and the bar modules, if any).
struct Bar {
    label: String,
    hwnd: isize,
    index: usize,
    primary: bool,
    monitor: (i32, i32, i32, i32), // x, y, width, height (physical pixels)
    scale: f64,
    appbar: Option<win32::AppBar>,
    rects: Vec<Rect>,
    notch: Option<Rect>,
    interactive: bool,
    fullscreen: bool,
    /// What's around the island is mostly black: the page draws an outline.
    dark: bool,
    /// The island can hide right now (compact, not showing a notification...).
    dodgeable: bool,
    /// Hidden after a slow approach: the island's rect at that moment.
    dodge: Option<Rect>,
    /// The next approach will be judged (the cursor went far enough away since the last one).
    dodge_armed: bool,
    /// The hidden island catches the mouse again (grown, eyes roaming: they can be clicked).
    grab: bool,
    /// The mouse button went down over the island: it keeps the mouse until it's released (drags).
    press_inside: bool,
    /// Eyes peeking into the resting island: the page wants the cursor position.
    watch: bool,
    watch_seen: bool,
    /// Auto-hide: the cursor is on this screen, near the island (so the island shows).
    near: bool,
    /// Auto-hide: since when the cursor is too far (the island hides a moment later).
    far_since: Option<Instant>,
}

#[derive(Default)]
struct Shared {
    cfg: Value,
    bars: Vec<Bar>,
    layout: String,
    hide_osd: bool,
    /// Approaches slower than this (CSS px/s) hide the island; `None`: option turned off.
    dodge_speed: Option<f64>,
    /// Eyes in the hidden island (they need the cursor position).
    dodge_eyes: bool,
    /// Auto-hide: the island shows only with the cursor this close (CSS px); `None`: always shown.
    auto_hide: Option<f64>,
    wallpaper: Option<String>,
    autostart_on: bool,
}

static SHARED: Mutex<Option<Shared>> = Mutex::new(None);
static BAR_COUNTER: AtomicUsize = AtomicUsize::new(0);

fn with<R>(f: impl FnOnce(&mut Shared) -> R) -> R { f(SHARED.lock().unwrap().get_or_insert_with(Shared::default)) }

/// Config keys whose change requires recreating the windows.
const LAYOUT_KEYS: [&str; 5] = ["position", "height", "monitors", "popup-space", "reserve"];

fn resources(app: &AppHandle) -> PathBuf { app.path().resource_dir().unwrap_or_default() }

/// The user's style sheet; `v` busts the WebView cache.
fn styles() -> Value {
    json!({ "style": config::style_file(), "v": util::now_ms() })
}

/// Message shown in the island (config errors, scripts using --island="...").
fn island_message(text: &str, icon: &str) {
    eprintln!("[kysland] {text}");
    hub::emit("island", json!({ "text": text, "icon": icon }));
}

// --- Windows (one per screen) -----------------------------------------------------------------------

/// Screens in the order used by "monitors" (left to right), and the main screen's position.
fn sorted_monitors(app: &AppHandle) -> (Vec<tauri::Monitor>, Option<(i32, i32)>) {
    let mut monitors = app.available_monitors().unwrap_or_default();
    monitors.sort_by_key(|m| (m.position().x, m.position().y));
    (monitors, app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y)))
}

/// Screens for the menu and the settings: index, readable name, size, main screen or not.
fn screen_list(app: &AppHandle) -> Vec<Value> {
    let (monitors, primary) = sorted_monitors(app);
    let names = win32::monitor_names();
    monitors.iter().enumerate().map(|(i, m)| {
        let gdi = m.name().cloned().unwrap_or_default();
        let name = names.get(&gdi).filter(|n| !n.is_empty()).cloned().unwrap_or_else(|| gdi.trim_start_matches(r"\\.\").to_owned());
        json!({
            "index": i, "name": name, "width": m.size().width, "height": m.size().height,
            "primary": Some((m.position().x, m.position().y)) == primary,
        })
    }).collect()
}

fn create_bars(app: &AppHandle, cfg: &Value) {
    let (monitors, primary) = sorted_monitors(app);
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
            rects: vec![], notch: None, interactive: false, fullscreen: false, dark: false,
            dodgeable: false, dodge: None, dodge_armed: false, grab: false, press_inside: false, watch: false, watch_seen: false, near: true, far_since: None,
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

// --- Applying the config ------------------------------------------------------------------------

fn reload(app: &AppHandle, force_layout: bool) {
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => return island_message(&e, "triangle-alert"),
    };
    i18n::set(i18n::resolve(cfg["language"].as_str()));
    let layout = LAYOUT_KEYS.iter().map(|k| cfg[*k].to_string()).collect::<Vec<_>>().join("|");
    let relayout = force_layout || with(|s| s.bars.is_empty() || s.layout != layout);
    with(|s| { s.cfg = cfg.clone(); s.layout = layout; });
    if relayout {
        destroy_bars(app);
        create_bars(app, &cfg);
    } else {
        hub::emit("reload", Value::Null);
    }
    start_pollers(&cfg);
    apply_system(&cfg);
    update_tray(app);
    settings_changed(app);
}

fn apply_system(cfg: &Value) {
    let island = config::island_conf(cfg);
    let hide_osd = config::island_name(cfg).is_some() && island["hide-windows-osd"] != false;
    let dodge_speed = (config::island_name(cfg).is_some() && island["dodge"] != false)
        .then(|| island["dodge-speed"].as_f64().unwrap_or(450.0));
    let dodge_eyes = island["dodge-eyes"] != false;
    let auto_hide = (config::island_name(cfg).is_some() && island["auto-hide"] == true)
        .then(|| island["auto-hide-distance"].as_f64().unwrap_or(300.0));
    with(|s| { s.hide_osd = hide_osd; s.dodge_speed = dodge_speed; s.dodge_eyes = dodge_eyes; s.auto_hide = auto_hide; });
    if hide_osd { win32::hide_volume_osd(); } else { win32::restore_volume_osd(); }
    audio::set_key_hook(hide_osd.then(|| island["volume-step"].as_u64().unwrap_or(2) as u32));
    if let Some(w) = cfg["wallpaper"].as_str() {
        if with(|s| s.wallpaper.as_deref() != Some(w)) {
            let file = config::config_dir().join(w.replacen('~', &config::home().to_string_lossy(), 1));
            if file.exists() {
                win32::set_wallpaper(&file.to_string_lossy());
                with(|s| s.wallpaper = Some(w.to_owned()));
            } else {
                island_message(&tf("msg.wallpaper_missing", &[("path", &file.display().to_string())]), "image");
            }
        }
    }
}

/// Starts the pollers used by the configured modules (stopped at the next reload).
fn start_pollers(cfg: &Value) {
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
    hub::retain(&need.keys().copied().collect::<Vec<_>>());
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

// --- Background loop: mouse, fullscreen, z-order -----------------------------------------------------

/// The window covers the top of the screen but only captures the mouse over the areas reported
/// by the page (island, popups, modules): anywhere else, clicks go through to the windows below.
fn background_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let (mut fs_at, mut top_at, mut shell_at, mut backdrop_at) = (Instant::now(), Instant::now(), Instant::now(), Instant::now());
        let mut last_notch: std::collections::HashMap<String, Rect> = std::collections::HashMap::new();
        let mut trail: std::collections::VecDeque<(Instant, i32, i32)> = std::collections::VecDeque::new();
        let mut was_held = false;
        loop {
            std::thread::sleep(Duration::from_millis(30));
            let (cx, cy) = win32::cursor_pos();
            let held = win32::primary_button_down();
            let pressed = held && !was_held;
            was_held = held;
            let now = Instant::now();
            trail.push_back((now, cx, cy));
            while trail.front().is_some_and(|p| now - p.0 > Duration::from_millis(250)) { trail.pop_front(); }
            let speed = trail_speed(&trail);
            let mut toggles: Vec<(String, bool)> = Vec::new();
            let mut dodges: Vec<(String, bool)> = Vec::new();
            let mut gazes: Vec<(String, f64, f64)> = Vec::new();
            let mut presences: Vec<(String, bool)> = Vec::new();
            let moved = trail.len() < 2 || trail[trail.len() - 2].1 != cx || trail[trail.len() - 2].2 != cy;
            with(|s| {
                let (dodge_speed, eyes, auto_hide) = (s.dodge_speed, s.dodge_eyes, s.auto_hide);
                let bottom = s.cfg["position"] == "bottom";
                for bar in &mut s.bars {
                    let Some(rc) = win32::window_rect(bar.hwnd) else { continue };
                    // Cursor in CSS pixels of the window.
                    let (px, py) = ((cx - rc.left) as f64 / bar.scale, (cy - rc.top) as f64 / bar.scale);
                    if let Some(near) = presence_step(bar, auto_hide, bottom, (cx, cy), rc, (px, py), now) { presences.push((bar.label.clone(), near)); }
                    let change = dodge_step(bar, dodge_speed, px, py, speed / bar.scale);
                    if let Some(on) = change { dodges.push((bar.label.clone(), on)); }
                    // The hidden island no longer gets mouse events: its eyes follow the cursor through the engine.
                    // (and to the eyes peeking into the resting island, from the moment they show up)
                    let peeking_now = bar.watch && !bar.watch_seen;
                    bar.watch_seen = bar.watch;
                    if ((eyes && bar.dodge.is_some()) || bar.watch) && (moved || change.is_some() || peeking_now) {
                        gazes.push((bar.label.clone(), px, py));
                    }
                    // A hidden island lets clicks through to what's behind it.
                    let over = !bar.fullscreen && bar.rects.iter()
                        .filter(|r| bar.dodge.is_none() || bar.grab || Some(**r) != bar.notch)
                        .any(|r| px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
                    // A press that started over the island keeps it until the button is released,
                    // like any window: dragging the volume slider can go past the island.
                    if pressed { bar.press_inside = bar.interactive; }
                    if !held { bar.press_inside = false; }
                    let inside = over || (bar.press_inside && !bar.fullscreen);
                    if inside != bar.interactive {
                        bar.interactive = inside;
                        if inside { bar.dodge_armed = false; } // reached normally: no dodging on the way out
                        toggles.push((bar.label.clone(), inside));
                    }
                }
            });
            for (label, inside) in toggles {
                if let Some(w) = app.get_webview_window(&label) { let _ = w.set_ignore_cursor_events(!inside); }
                if !inside { let _ = app.emit("pointer-left", json!({ "label": label })); }
            }
            for (label, on) in dodges { let _ = app.emit("dodge", json!({ "label": label, "on": on })); }
            for (label, x, y) in gazes { let _ = app.emit("gaze", json!({ "label": label, "x": x, "y": y })); }
            for (label, near) in presences { let _ = app.emit("presence", json!({ "label": label, "near": near })); }
            // Fullscreen: the foreground window exactly matches the screen (within 1 px).
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
            // Lost topmost position (window created while the session was starting...).
            if top_at.elapsed() >= Duration::from_secs(1) {
                top_at = Instant::now();
                for hwnd in with(|s| s.bars.iter().filter(|b| !b.fullscreen).map(|b| b.hwnd).collect::<Vec<_>>()) {
                    if win32::is_buried(hwnd) { win32::raise_topmost(hwnd); }
                }
            }
            // Outline ("outline": "auto"): on when at least 80% of the area around the island is black,
            // off below 70% so it doesn't flicker over moving content.
            if backdrop_at.elapsed() >= Duration::from_millis(400) {
                backdrop_at = Instant::now();
                let bars: Vec<(String, isize, (i32, i32, i32, i32), f64, Rect, bool)> = with(|s| {
                    if config::island_conf(&s.cfg)["outline"].is_boolean() { return vec![]; }
                    s.bars.iter().filter(|b| !b.fullscreen)
                        .filter_map(|b| Some((b.label.clone(), b.hwnd, b.monitor, b.scale, b.notch?, b.dark))).collect()
                });
                last_notch.retain(|label, _| bars.iter().any(|b| &b.0 == label));
                for (label, hwnd, monitor, scale, notch, dark) in bars {
                    // Only judged once the island stopped moving (hover, events...): mid-animation,
                    // the reported rect lags behind and the island itself would be sampled.
                    let steady = last_notch.insert(label.clone(), notch) == Some(notch);
                    if !steady { continue; }
                    let Some(ratio) = win32::window_rect(hwnd).and_then(|rc| backdrop_ratio(rc, monitor, scale, notch)) else { continue };
                    let now_dark = ratio >= if dark { 0.7 } else { 0.8 };
                    if now_dark == dark { continue; }
                    with(|s| if let Some(b) = s.bars.iter_mut().find(|b| b.label == label) { b.dark = now_dark; });
                    let _ = app.emit("backdrop", json!({ "label": label, "dark": now_dark }));
                }
            }
            // Explorer may recreate the volume flyout.
            if shell_at.elapsed() >= Duration::from_millis(1500) {
                shell_at = Instant::now();
                if with(|s| s.hide_osd) { win32::hide_volume_osd(); }
            }
        }
    });
}

/// Cursor speed over the recent trail, in physical pixels per second.
fn trail_speed(trail: &std::collections::VecDeque<(Instant, i32, i32)>) -> f64 {
    let (Some(first), Some(last)) = (trail.front(), trail.back()) else { return 0.0 };
    let path: f64 = trail.iter().zip(trail.iter().skip(1))
        .map(|(a, b)| ((b.1 - a.1) as f64).hypot((b.2 - a.2) as f64))
        .sum();
    path / (last.0 - first.0).as_secs_f64().max(0.03)
}

/// Distance from a point to a rect (0 inside).
fn distance(px: f64, py: f64, r: Rect) -> f64 {
    let dx = (r.x - px).max(px - (r.x + r.w)).max(0.0);
    let dy = (r.y - py).max(py - (r.y + r.h)).max(0.0);
    dx.hypot(dy)
}

/// Auto-hide: the island shows only while the cursor is on its screen and within `reach` CSS px of
/// where the island sits (top or bottom center, a bit wider for the way back out), or over the island.
/// It hides a moment after the cursor goes away. Returns the new state when it changes.
fn presence_step(bar: &mut Bar, reach: Option<f64>, bottom: bool, cursor: (i32, i32), win: windows::Win32::Foundation::RECT,
                 (px, py): (f64, f64), now: Instant) -> Option<bool> {
    let near = match reach {
        None => true,
        Some(reach) => {
            let (mx, my, mw, mh) = bar.monitor;
            let on_screen = cursor.0 >= mx && cursor.0 < mx + mw && cursor.1 >= my && cursor.1 < my + mh;
            let (w, h) = ((win.right - win.left) as f64 / bar.scale, (win.bottom - win.top) as f64 / bar.scale);
            let spot = Rect { x: w / 2.0 - 110.0, y: if bottom { h - 40.0 } else { 0.0 }, w: 220.0, h: 40.0 };
            let limit = if bar.near { reach + 40.0 } else { reach };
            on_screen && (bar.interactive || distance(px, py, spot) <= limit)
        }
    };
    if near {
        bar.far_since = None;
        if bar.near { return None; }
        bar.near = true;
        return Some(true);
    }
    if !bar.near { return None; }
    let since = *bar.far_since.get_or_insert(now);
    if now - since < Duration::from_millis(400) { return None; }
    bar.near = false;
    Some(false)
}

/// Island dodging. Each approach is judged once, when the cursor gets near the island after
/// having been away: slow (aiming at something behind it) hides the island until the cursor
/// moves away again; fast is left to the usual hover. Returns the new state when it changes.
fn dodge_step(bar: &mut Bar, slow_below: Option<f64>, px: f64, py: f64, speed: f64) -> Option<bool> {
    const NEAR: f64 = 24.0; // CSS px around the island where an approach is judged
    const AWAY: f64 = 64.0; // CSS px: far enough to bring it back and judge the next approach
    let notch = bar.notch?;
    let off = bar.fullscreen || slow_below.is_none();
    if let Some(from) = bar.dodge {
        // From its full size, not the hidden one; from its grown size while the eyes roam.
        let area = Rect {
            x: from.x.min(notch.x), y: from.y.min(notch.y),
            w: (from.x + from.w).max(notch.x + notch.w) - from.x.min(notch.x),
            h: (from.y + from.h).max(notch.y + notch.h) - from.y.min(notch.y),
        };
        let away = distance(px, py, area) >= AWAY;
        if !off && !away { return None; }
        bar.dodge = None;
        bar.dodge_armed = !off && away;
        return Some(false);
    }
    if off { return None; }
    let d = distance(px, py, notch);
    if d >= AWAY { bar.dodge_armed = true; return None; }
    if !bar.dodge_armed || d > NEAR || bar.interactive { return None; }
    bar.dodge_armed = false;
    if !bar.dodgeable || speed >= slow_below? { return None; }
    bar.dodge = Some(notch);
    Some(true)
}

/// Share of dark pixels in a band around the island (past its ears, outline and the edge of its
/// shadow), clipped to its screen. `win` in physical pixels, `notch` in CSS pixels of the window.
fn backdrop_ratio(win: windows::Win32::Foundation::RECT, monitor: (i32, i32, i32, i32), scale: f64, notch: Rect) -> Option<f32> {
    let px = |v: f64| (v * scale).round() as i32;
    let (left, top) = (win.left + px(notch.x), win.top + px(notch.y));
    let (right, bottom) = (left + px(notch.w), top + px(notch.h));
    let (side, gap, band) = (px(14.0), px(3.0), px(12.0));
    let inner = windows::Win32::Foundation::RECT { left: left - side, top: top - gap, right: right + side, bottom: bottom + gap };
    let (mx, my, mw, mh) = monitor;
    let outer = windows::Win32::Foundation::RECT {
        left: (inner.left - band).max(mx), top: (inner.top - band).max(my),
        right: (inner.right + band).min(mx + mw), bottom: (inner.bottom + band).min(my + mh),
    };
    win32::dark_ratio(outer, inner, 48)
}

/// Hot reload: style.css → styles only; config.jsonc → full reload.
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
                hub::emit("style", styles());
            }
        }
    });
}

// --- Commands called by the page ---------------------------------------------------------------------

#[tauri::command]
fn init(window: WebviewWindow) -> Value {
    let (cfg, monitor, dark, near) = with(|s| {
        let bar = s.bars.iter_mut().find(|b| b.label == window.label());
        let bar = bar.map(|b| { b.dodge = None; b.dodge_armed = false; &*b }); // fresh page: island shown
        (s.cfg.clone(), bar.map(|b| json!({
            "index": b.index, "primary": b.primary, "scaleFactor": b.scale,
            "physical": { "x": b.monitor.0, "y": b.monitor.1, "width": b.monitor.2, "height": b.monitor.3 },
        })), bar.is_some_and(|b| b.dark), bar.is_none_or(|b| b.near))
    });
    json!({
        "config": cfg, "lang": i18n::lang(), "styles": styles(), "monitor": monitor, "backdropDark": dark, "near": near,
        "glaze": glaze::state(), "data": hub::snapshot(),
    })
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
fn set_hit_rects(window: WebviewWindow, rects: Vec<Rect>, notch: Option<Rect>, dodgeable: bool, grab: bool, watch: bool) {
    with(|s| if let Some(b) = s.bars.iter_mut().find(|b| b.label == window.label()) {
        b.rects = rects;
        b.notch = notch;
        b.dodgeable = dodgeable;
        b.grab = grab;
        b.watch = watch;
    });
}

// --- Settings window ---------------------------------------------------------------------------------

/// Runs `f` on the main thread, on a later turn of the event loop. `run_on_main_thread` runs it
/// right away when already on the main thread, and a sync command runs there, inside the WebView's
/// message callback: building a window (or rebuilding them) from there leaves a blank white window.
fn later(app: &AppHandle, f: impl FnOnce() + Send + 'static) {
    let a = app.clone();
    std::thread::spawn(move || { let _ = a.run_on_main_thread(f); });
}

/// The settings window: the menu's options with more room (built on a later turn, see `later`).
fn open_settings(app: &AppHandle) {
    let a = app.clone();
    later(app, move || {
        if let Some(w) = a.get_webview_window("settings") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return;
        }
        let built = WebviewWindowBuilder::new(&a, "settings", WebviewUrl::App("settings.html".into()))
            .title(t("settings.title"))
            .inner_size(600.0, 780.0)
            .min_inner_size(460.0, 520.0)
            .center()
            .theme(Some(tauri::Theme::Dark))
            .build();
        if let Err(e) = built { eprintln!("[kysland] settings window: {e}"); }
    });
}

/// The config (or start with Windows) changed: the settings window reads everything again.
fn settings_changed(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") { let _ = w.set_title(t("settings.title")); }
    let _ = app.emit_to("settings", "settings-changed", ());
}

#[tauri::command]
fn settings_state(app: AppHandle) -> Value {
    let cfg = with(|s| s.cfg.clone());
    json!({
        "lang": i18n::lang(),
        "version": app.package_info().version.to_string(),
        "language": cfg["language"], "monitors": cfg["monitors"], "hideOnFullscreen": cfg["hide-on-fullscreen"] != false,
        "screens": screen_list(&app),
        "autostart": with(|s| s.autostart_on),
        "claudeInstalled": system::claude_installed(),
        "island": config::island_conf(&cfg),
    })
}

/// Writes one option to config.jsonc (the reload that follows applies it and notifies the window).
#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let island = with(|s| config::island_name(&s.cfg)).unwrap_or_else(|| "island".into());
    match key.as_str() {
        "language" | "monitors" | "hide-on-fullscreen" => config::set_value(&[&key], value),
        "dodge" | "dodge-eyes" | "dodge-roam" | "dodge-roam-delay" | "dodge-speed" | "auto-hide" | "auto-hide-distance" | "peek" | "outline"
        | "claude" | "notifications"
        | "hide-windows-osd" | "expand-on-hover" => {
            config::set_value(&[&island, &key], value)
        }
        "autostart" => { set_autostart(&app, value == true); Ok(()) }
        _ => Err(format!("unknown setting: {key}")),
    }
}

/// Buttons of the settings window, same as the menu entries.
#[tauri::command]
fn settings_action(app: AppHandle, name: String) {
    if !matches!(name.as_str(), "reload" | "open-config" | "edit-config" | "edit-style" | "devtools") { return; }
    let a = app.clone();
    later(&app, move || on_menu(&a, &name));
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
            // Precise control through SMTC; media keys when no session is known.
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
        "reload" => { let a = app.clone(); later(&app, move || reload(&a, true)); }
        "open-config" => win32::shell_open(&config::config_dir().to_string_lossy()),
        "notification-center" => win32::press_keys(&[win32::VK_LWIN, 0x4E]), // Win+N
        "notif-remove" => if let Some(id) = arg.as_u64() { notifs::remove(vec![id as u32]) },
        "notif-clear" => notifs::clear_all(),
        "notif-open" => notifs::open(arg["aumid"].as_str(), arg["launch"].as_str()),
        "claude-refresh" => system::claude_refresh(),
        "menu" => show_menu(&app, Some(window.label().to_owned())),
        "settings" => open_settings(&app),
        _ => {}
    }
}

// --- Menu (tray icon, right-click on the island, Ctrl+Alt+W) -------------------------------------------

/// Hiding sensitivity choices: approaches slower than this many px/s hide the island.
const DODGE_SPEEDS: [(u32, &str); 3] = [(300, "menu.dodge_speed_low"), (450, "menu.dodge_speed_medium"), (650, "menu.dodge_speed_high")];

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let cfg = with(|s| s.cfg.clone());
    let island = config::island_conf(&cfg);
    let claude = system::claude_installed();
    let chosen = cfg["language"].as_str().filter(|l| i18n::SUPPORTED.iter().any(|(c, _)| c == l)).unwrap_or("auto");
    let mut languages = vec![CheckMenuItem::with_id(app, "lang:auto", t("menu.language_auto"), true, chosen == "auto", None::<&str>)?];
    for (code, name) in i18n::SUPPORTED {
        languages.push(CheckMenuItem::with_id(app, format!("lang:{code}"), *name, true, chosen == *code, None::<&str>)?);
    }
    let language_items: Vec<&dyn IsMenuItem<tauri::Wry>> = languages.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    // Screens: the main one, all of them, or a given one.
    let screens = screen_list(app);
    let chosen_screens: Vec<u64> = match &cfg["monitors"] { Value::Array(l) => l.iter().filter_map(Value::as_u64).collect(), _ => vec![] };
    let mut screen_entries = vec![
        CheckMenuItem::with_id(app, "screen:primary", t("menu.screen_primary"), true, cfg["monitors"] != "all" && chosen_screens.is_empty(), None::<&str>)?,
        CheckMenuItem::with_id(app, "screen:all", t("menu.screen_all"), true, cfg["monitors"] == "all", None::<&str>)?,
    ];
    for s in &screens {
        let i = s["index"].as_u64().unwrap_or(0);
        let label = format!("{} · {} ({}×{})", i + 1, s["name"].as_str().unwrap_or(""), s["width"], s["height"]);
        screen_entries.push(CheckMenuItem::with_id(app, format!("screen:{i}"), label, true, chosen_screens.contains(&i), None::<&str>)?);
    }
    let screen_items: Vec<&dyn IsMenuItem<tauri::Wry>> = screen_entries.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    // Island behavior: hiding from a slow cursor (with its eyes and sensitivity), fullscreen, outline, Claude.
    let dodge = island["dodge"] != false;
    let speed = island["dodge-speed"].as_f64().unwrap_or(450.0);
    let mut speeds = Vec::new();
    for (value, key) in DODGE_SPEEDS {
        speeds.push(CheckMenuItem::with_id(app, format!("dodge-speed:{value}"), t(key), dodge, speed == value as f64, None::<&str>)?);
    }
    let speed_items: Vec<&dyn IsMenuItem<tauri::Wry>> = speeds.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let outline = match &island["outline"] { Value::Bool(true) => "on", Value::Bool(false) => "off", _ => "auto" };
    let outline_menu = Submenu::with_items(app, t("menu.outline"), true, &[
        &CheckMenuItem::with_id(app, "outline:auto", t("menu.outline_auto"), true, outline == "auto", None::<&str>)?,
        &CheckMenuItem::with_id(app, "outline:on", t("menu.outline_on"), true, outline == "on", None::<&str>)?,
        &CheckMenuItem::with_id(app, "outline:off", t("menu.outline_off"), true, outline == "off", None::<&str>)?,
    ])?;
    let island_menu = Submenu::with_items(app, t("menu.island"), true, &[
        &CheckMenuItem::with_id(app, "dodge", t("menu.dodge"), true, dodge, None::<&str>)?,
        &CheckMenuItem::with_id(app, "dodge-eyes", t("menu.dodge_eyes"), dodge, island["dodge-eyes"] != false, None::<&str>)?,
        &CheckMenuItem::with_id(app, "dodge-roam", t("menu.dodge_roam"), dodge && island["dodge-eyes"] != false,
            island["dodge-roam"] != false, None::<&str>)?,
        &Submenu::with_items(app, t("menu.dodge_speed"), dodge, &speed_items)?,
        &PredefinedMenuItem::separator(app)?,
        &CheckMenuItem::with_id(app, "peek", t("menu.peek"), true, island["peek"] != false, None::<&str>)?,
        &CheckMenuItem::with_id(app, "auto-hide", t("menu.auto_hide"), true, island["auto-hide"] == true, None::<&str>)?,
        &CheckMenuItem::with_id(app, "fullscreen", t("menu.fullscreen"), true, cfg["hide-on-fullscreen"] != false, None::<&str>)?,
        &outline_menu,
        &CheckMenuItem::with_id(app, "claude", t(if claude { "menu.claude" } else { "menu.claude_missing" }),
            claude, claude && island["claude"] == true, None::<&str>)?,
    ])?;
    Menu::with_items(app, &[
        &MenuItem::with_id(app, "title", "Kysland", true, None::<&str>)?, // opens the settings too
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "settings", t("menu.settings"), true, None::<&str>)?,
        &MenuItem::with_id(app, "reload", t("menu.reload"), true, None::<&str>)?,
        &MenuItem::with_id(app, "open-config", t("menu.open_config"), true, None::<&str>)?,
        &MenuItem::with_id(app, "edit-config", t("menu.edit_config"), true, None::<&str>)?,
        &MenuItem::with_id(app, "edit-style", t("menu.edit_style"), true, None::<&str>)?,
        &MenuItem::with_id(app, "devtools", t("menu.devtools"), true, None::<&str>)?,
        &Submenu::with_items(app, t("menu.language"), true, &language_items)?,
        &PredefinedMenuItem::separator(app)?,
        &Submenu::with_items(app, t("menu.screen"), true, &screen_items)?,
        &island_menu,
        &CheckMenuItem::with_id(app, "autostart", t("menu.autostart"), true, with(|s| s.autostart_on), None::<&str>)?,
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "quit", t("menu.quit"), true, None::<&str>)?,
    ])
}

fn on_menu(app: &AppHandle, id: &str) {
    let cfg = with(|s| s.cfg.clone());
    let island = config::island_name(&cfg).unwrap_or_else(|| "island".into());
    let result = match id {
        "title" | "settings" => { open_settings(app); Ok(()) }
        "reload" => { reload(app, true); Ok(()) }
        "open-config" => { win32::shell_open(&config::config_dir().to_string_lossy()); Ok(()) }
        "edit-config" => { win32::shell_open(&config::config_file().to_string_lossy()); Ok(()) }
        "edit-style" => { win32::shell_open(&config::style_file().to_string_lossy()); Ok(()) }
        "devtools" => {
            if let Some(w) = with(|s| s.bars.first().map(|b| b.label.clone())).and_then(|l| app.get_webview_window(&l)) { w.open_devtools(); }
            Ok(())
        }
        "fullscreen" => config::set_value(&["hide-on-fullscreen"], json!(cfg["hide-on-fullscreen"] == false)),
        "claude" => config::set_value(&[&island, "claude"], json!(config::island_conf(&cfg)["claude"] != true)),
        "dodge" | "dodge-eyes" | "dodge-roam" | "peek" => config::set_value(&[&island, id], json!(config::island_conf(&cfg)[id] == false)),
        "auto-hide" => config::set_value(&[&island, id], json!(config::island_conf(&cfg)[id] != true)),
        "outline:auto" => config::set_value(&[&island, "outline"], json!("auto")),
        "outline:on" | "outline:off" => config::set_value(&[&island, "outline"], json!(id == "outline:on")),
        s if s.starts_with("dodge-speed:") => config::set_value(&[&island, "dodge-speed"], json!(s[12..].parse::<u32>().unwrap_or(450))),
        "autostart" => { set_autostart(app, !with(|s| s.autostart_on)); Ok(()) }
        "quit" => { app.exit(0); Ok(()) }
        l if l.starts_with("lang:") => config::set_value(&["language"], json!(&l[5..])),
        "screen:primary" => config::set_value(&["monitors"], json!("primary")),
        "screen:all" => config::set_value(&["monitors"], json!("all")),
        s if s.starts_with("screen:") => config::set_value(&["monitors"], json!([s[7..].parse::<u64>().unwrap_or(0)])),
        _ => Ok(()),
    };
    if let Err(e) = result { island_message(&tf("msg.config_write", &[("error", &e)]), "triangle-alert"); }
}

fn update_tray(app: &AppHandle) {
    let Ok(menu) = build_menu(app) else { return };
    if let Some(tray) = app.tray_by_id("main") { let _ = tray.set_menu(Some(menu)); return; }
    let _ = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| tauri::image::Image::new(&[0, 0, 0, 0], 1, 1)))
        .tooltip("Kysland")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                open_settings(tray.app_handle());
            }
        })
        .build(app);
}

/// Menu at the cursor, from the island. Windows closes a menu whose window isn't in the
/// foreground, so the window is brought to the foreground for the menu's lifetime.
fn show_menu(app: &AppHandle, label: Option<String>) {
    let label = label.or_else(|| with(|s| s.bars.first().map(|b| b.label.clone())));
    let Some(win) = label.and_then(|l| app.get_webview_window(&l)) else { return };
    let Ok(menu) = build_menu(app) else { return };
    if let Ok(h) = win.hwnd() { win32::set_foreground(h.0 as isize); }
    let _ = win.popup_menu(&menu);
}

// --- Start with Windows -----------------------------------------------------------------------------

fn autostart_file() -> PathBuf { config::config_dir().join(".autostart") }

fn set_autostart(app: &AppHandle, on: bool) {
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let result = if on { autostart::enable(&exe, &[]) } else { autostart::disable(); Ok(()) };
    match result {
        Ok(()) => {
            with(|s| s.autostart_on = on);
            let _ = std::fs::write(autostart_file(), if on { "on" } else { "off" });
        }
        Err(e) => island_message(&tf("msg.autostart_failed", &[("error", &e)]), "triangle-alert"),
    }
    update_tray(app);
    settings_changed(app);
}

/// Installed build: on by default, then follows the saved choice (recreated if the task went
/// missing). Development builds never change it on their own.
fn ensure_autostart(app: &AppHandle) {
    let active = autostart::is_enabled();
    with(|s| s.autostart_on = active);
    if cfg!(debug_assertions) { return update_tray(app); }
    let wanted = std::fs::read_to_string(autostart_file()).map(|s| s.trim().to_owned()).unwrap_or_else(|_| "on".into());
    if wanted == "on" && !active { set_autostart(app, true); }
    else if wanted == "off" && active { set_autostart(app, false); }
    else { update_tray(app); }
}

// --- Command line, lifecycle ------------------------------------------------------------------------

fn opt(argv: &[String], name: &str) -> Option<String> {
    argv.iter().find_map(|a| a.strip_prefix(&format!("--{name}=")).map(str::to_owned))
}

/// Arguments of a second instance, forwarded to the running one.
fn handle_args(app: &AppHandle, argv: Vec<String>) {
    if argv.iter().any(|a| a == "--quit") { return app.exit(0); }
    if argv.iter().any(|a| a == "--settings") { return open_settings(app); }
    if let Some(text) = opt(&argv, "island") {
        return hub::emit("island", json!({ "text": text, "icon": opt(&argv, "icon").unwrap_or_else(|| "bell".into()) }));
    }
    if let Some(v) = opt(&argv, "autostart") { return set_autostart(app, v == "on"); }
    reload(app, true);
}

/// Restores the volume flyout, the taskbar and the work area (after a crash, or from the
/// uninstaller). Older versions could hide the taskbar.
fn repair() {
    win32::show_taskbar(Some(0));
    win32::restore_volume_osd();
    win32::reset_work_area();
    let _ = std::fs::remove_file(config::config_dir().join(".taskbar-state"));
}

fn cleanup(app: &AppHandle) {
    destroy_bars(app);
    win32::restore_volume_osd();
    audio::set_key_hook(None);
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--repair") { repair(); return; }
    i18n::set(i18n::windows_language());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| handle_args(app, argv)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["ctrl+alt+w"]).expect("invalid shortcut")
                .with_handler(|app, _, e| {
                    if e.state == tauri_plugin_global_shortcut::ShortcutState::Pressed { show_menu(app, None); }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![init, run_command, notifications, set_hit_rects, action, settings_state, set_setting, settings_action])
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(move |app| {
            let handle = app.handle().clone();
            hub::init(handle.clone());
            if args.iter().any(|a| a == "--quit") { handle.exit(0); return Ok(()); }
            // After a crash: taskbar left hidden by an older version / orphaned screen reservations.
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
        .expect("failed to start Kysland")
        .run(|app, event| match event {
            // Windows destroyed by a reload: keep running (tray icon).
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => cleanup(app),
            _ => {}
        });
}
