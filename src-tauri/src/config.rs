//! User configuration (~/.config/kysland): JSON with comments, hot-reloaded.
use crate::i18n::tf;
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_dir() -> PathBuf {
    std::env::var_os("KYSLAND_CONFIG").map(PathBuf::from).unwrap_or_else(|| home().join(".config").join("kysland"))
}

pub fn config_file() -> PathBuf { config_dir().join("config.jsonc") }
pub fn style_file() -> PathBuf { config_dir().join("style.css") }

/// Creates the config on first launch: imports WinCustom's if it exists, defaults otherwise.
pub fn ensure(defaults: &Path) {
    let dir = config_dir();
    let _ = fs::create_dir_all(&dir);
    let legacy = home().join(".config").join("wincustom");
    for name in ["config.jsonc", "style.css"] {
        let target = dir.join(name);
        if target.exists() { continue; }
        let from_legacy = legacy.join(name);
        let src = if from_legacy.exists() { from_legacy } else { defaults.join(name) };
        if let Ok(text) = fs::read_to_string(&src) {
            let _ = fs::write(&target, text.replace("wincustom", "kysland").replace("WinCustom", "Kysland"));
        }
    }
}

/// Strips comments and trailing commas to get strict JSON.
fn strip_jsonc(text: &str) -> String {
    let text = text.trim_start_matches('\u{feff}');
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let (mut in_str, mut escaped) = (false, false);
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if escaped { escaped = false; } else if c == '\\' { escaped = true; } else if c == '"' { in_str = false; }
            continue;
        }
        match c {
            '"' => { in_str = true; out.push(c); }
            '/' if chars.peek() == Some(&'/') => {
                while let Some(&n) = chars.peek() { if n == '\n' { break; } chars.next(); }
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() { if prev == '*' && n == '/' { break; } prev = n; }
            }
            _ => out.push(c),
        }
    }
    Regex::new(r",(\s*[}\]])").unwrap().replace_all(&out, "$1").into_owned()
}

const BASE: &str = r#"{
  "language": "auto",
  "position": "top", "height": 32, "reserve": false, "monitors": "primary",
  "hide-on-fullscreen": true,
  "wallpaper": null, "popup-space": 420,
  "modules-left": [], "modules-center": ["island"], "modules-right": []
}"#;

pub fn load() -> Result<Value, String> {
    let text = fs::read_to_string(config_file()).map_err(|e| tf("msg.config_unreadable", &[("error", &e.to_string())]))?;
    let clean = strip_jsonc(&text);
    let user: Value = serde_json::from_str(&clean).map_err(|e| {
        tf("msg.config_invalid", &[("error", &e.to_string()), ("line", &e.line().to_string()), ("column", &e.column().to_string())])
    })?;
    let mut cfg: Value = serde_json::from_str(BASE).unwrap();
    if let (Some(base), Some(user)) = (cfg.as_object_mut(), user.as_object()) {
        for (k, v) in user { base.insert(k.clone(), v.clone()); }
    }
    Ok(cfg)
}

/// Changes a simple option while keeping comments and formatting.
/// `path`: ["hide-on-fullscreen"] or ["island", "claude"]. Adds the key if it's missing.
pub fn set_value(path: &[&str], value: Value) -> Result<(), String> {
    let file = config_file();
    let text = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let key = path.last().ok_or("empty path")?;
    let rendered = serde_json::to_string(&value).unwrap();
    // Simple value (true / false / number / "text" / null / flat array) of the key, inside the right section.
    let scope_start = if path.len() > 1 {
        let re = Regex::new(&format!(r#""{}"\s*:\s*\{{"#, regex::escape(path[0]))).unwrap();
        re.find(&text).map(|m| m.end()).ok_or("section not found")?
    } else {
        0
    };
    let re = Regex::new(&format!(r#"("{}"\s*:\s*)(true|false|null|-?[\d.]+|"(?:[^"\\]|\\.)*"|\[[^\[\]]*\])"#, regex::escape(key))).unwrap();
    let new_text = if let Some(c) = re.captures(&text[scope_start..]) {
        let m = c.get(2).unwrap();
        let (a, b) = (scope_start + m.start(), scope_start + m.end());
        format!("{}{}{}", &text[..a], rendered, &text[b..])
    } else {
        // Missing key: inserted at the top of the section (or of the root object).
        let (at, indent) = if path.len() > 1 {
            (scope_start, "    ")
        } else {
            (text.find('{').ok_or("root object not found")? + 1, "  ")
        };
        format!("{}\n{indent}\"{}\": {},{}", &text[..at], key, rendered, &text[at..])
    };
    fs::write(&file, new_text).map_err(|e| e.to_string())
}

/// Name of the island module in the config (island, island#2...), if it is used.
pub fn island_name(cfg: &Value) -> Option<String> {
    all_modules(cfg).into_iter().find(|m| m.starts_with("island"))
}

pub fn all_modules(cfg: &Value) -> Vec<String> {
    ["modules-left", "modules-center", "modules-right"]
        .iter()
        .filter_map(|k| cfg.get(*k)?.as_array())
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

pub fn island_conf(cfg: &Value) -> Value {
    island_name(cfg).and_then(|n| cfg.get(&n).cloned()).unwrap_or_else(|| json!({}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_value_keeps_comments_and_handles_arrays() {
        let dir = std::env::temp_dir().join(format!("kysland-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        unsafe { std::env::set_var("KYSLAND_CONFIG", &dir) };
        fs::write(config_file(), "{\n  \"monitors\": \"primary\", // where\n  \"island\": {\n    \"dodge\": true\n  }\n}\n").unwrap();

        set_value(&["monitors"], json!([1])).unwrap();
        set_value(&["monitors"], json!([0, 2])).unwrap(); // replaces an array, no duplicate key
        set_value(&["island", "dodge"], json!(false)).unwrap();
        set_value(&["island", "dodge-roam-delay"], json!(40)).unwrap(); // missing: added to the section

        let text = fs::read_to_string(config_file()).unwrap();
        assert!(text.contains("\"monitors\": [0,2], // where"), "{text}");
        assert_eq!(text.matches("\"monitors\"").count(), 1, "{text}");
        let cfg = load().unwrap();
        assert_eq!(cfg["island"]["dodge"], json!(false));
        assert_eq!(cfg["island"]["dodge-roam-delay"], json!(40));
        let _ = fs::remove_dir_all(&dir);
    }
}
