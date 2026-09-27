//! Petits outils partagés.
use base64::Engine;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn data_url(bytes: &[u8], mime: &str) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Type d'image d'après ses premiers octets (les pochettes arrivent sans en-tête fiable).
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

/// Commande sans fenêtre de console.
pub fn hidden(program: &str) -> Command {
    let mut c = Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Commande shell (cmd.exe) lancée sans attendre (actions "on-click" de la config).
pub fn spawn_shell(cmd: &str) {
    let _ = hidden("cmd.exe").args(["/C", cmd]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
}

/// Commande shell dont on récupère la sortie (modules custom/*).
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
