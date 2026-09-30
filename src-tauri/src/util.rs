//! Shared helpers.
use base64::Engine;
use std::os::windows::process::CommandExt;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static LOG: OnceLock<Mutex<PathBuf>> = OnceLock::new();

/// Where the log goes: kysland.log in Kysland's data folder (the previous one kept as kysland.old.log
/// once it grows past 512 KB).
pub fn init_log(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("kysland.log");
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > 512 * 1024) { let _ = std::fs::rename(&file, dir.join("kysland.old.log")); }
    let _ = LOG.set(Mutex::new(file));
}

/// A line in the log (errors, the main thread stuck...), with the local time; also on the console.
pub fn log(text: &str) {
    eprintln!("[kysland] {text}");
    let Some(file) = LOG.get() else { return };
    let file = file.lock().unwrap();
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let line = format!("{}-{:02}-{:02} {:02}:{:02}:{:02}.{:03} {text}\n", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&*file) { let _ = f.write_all(line.as_bytes()); }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn data_url(bytes: &[u8], mime: &str) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Image type from its first bytes (album art comes without a reliable content type).
pub fn image_mime(bytes: &[u8]) -> &'static str {
    match bytes {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [0x52, 0x49, 0x46, 0x46, ..] => "image/webp",
        [0x47, 0x49, 0x46, ..] => "image/gif",
        _ => "image/png",
    }
}

pub fn png_data_url(rgba: &[u8], w: u32, h: u32) -> String {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        if let Ok(mut writer) = enc.write_header() { let _ = writer.write_image_data(rgba); }
    }
    data_url(&out, "image/png")
}

/// Command without a console window.
pub fn hidden(program: &str) -> Command {
    let mut c = Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Shell command (cmd.exe), fire and forget ("on-click" actions of the config).
pub fn spawn_shell(cmd: &str) {
    let _ = hidden("cmd.exe").args(["/C", cmd]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// Shell command whose output is returned (custom/* modules).
pub fn run_shell(cmd: &str) -> (bool, String) {
    match hidden("cmd.exe").args(["/C", cmd]).stdin(Stdio::null()).output() {
        Ok(o) => (o.status.success(), String::from_utf8_lossy(&o.stdout).trim().to_owned()),
        Err(_) => (false, String::new()),
    }
}

pub fn format_rate(bytes_per_sec: f64) -> String {
    if bytes_per_sec <= 0.0 { return "0 B/s".into(); }
    let units = ["B/s", "KB/s", "MB/s", "GB/s"];
    let (mut v, mut i) = (bytes_per_sec, 0);
    while v >= 1024.0 && i < units.len() - 1 { v /= 1024.0; i += 1; }
    if i == 0 { format!("{v:.0} {}", units[i]) } else { format!("{v:.1} {}", units[i]) }
}

pub fn round1(v: f64) -> f64 { (v * 10.0).round() / 10.0 }
