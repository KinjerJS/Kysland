//! User-facing strings of the engine (tray menu, messages shown in the island).
//! Code and logs stay in English; only displayed text goes through `t()`.
//! The island's own strings live in `ui/i18n.js`.
use std::sync::RwLock;

/// Languages with a translation, as (code, native name).
pub const SUPPORTED: &[(&str, &str)] = &[("en", "English"), ("fr", "Français")];

static LANG: RwLock<&'static str> = RwLock::new("en");

/// Windows display language, if Kysland has a translation for it (English otherwise).
pub fn windows_language() -> &'static str {
    // Primary language of the user's UI language ID (LANG_FRENCH = 0x0C).
    let id = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() };
    match id & 0x3FF {
        0x0C => "fr",
        _ => "en",
    }
}

/// `"auto"` (or missing / unknown) → Windows language; otherwise the requested language.
pub fn resolve(setting: Option<&str>) -> &'static str {
    setting
        .and_then(|s| SUPPORTED.iter().find(|(code, _)| *code == s))
        .map(|(code, _)| *code)
        .unwrap_or_else(windows_language)
}

pub fn set(lang: &'static str) { *LANG.write().unwrap() = lang; }
pub fn lang() -> &'static str { *LANG.read().unwrap() }

/// Translated string for `key` (the key itself if it is missing).
pub fn t(key: &'static str) -> &'static str {
    let fr = lang() == "fr";
    STRINGS
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, en, french)| if fr { *french } else { *en })
        .unwrap_or(key)
}

/// `t()` with `{name}` placeholders replaced.
pub fn tf(key: &'static str, vars: &[(&str, &str)]) -> String {
    vars.iter().fold(t(key).to_owned(), |s, (name, value)| s.replace(&format!("{{{name}}}"), value))
}

const STRINGS: &[(&str, &str, &str)] = &[
    ("menu.reload", "Reload", "Recharger"),
    ("menu.open_config", "Open config folder", "Ouvrir le dossier de config"),
    ("menu.edit_config", "Edit config.jsonc", "Éditer config.jsonc"),
    ("menu.edit_style", "Edit style.css", "Éditer style.css"),
    ("menu.devtools", "CSS inspector (DevTools)", "Inspecteur CSS (DevTools)"),
    ("menu.settings", "Settings…", "Réglages…"),
    ("menu.screen", "Screen", "Écran"),
    ("menu.screen_primary", "Main screen", "Écran principal"),
    ("menu.screen_all", "All screens", "Tous les écrans"),
    ("menu.island", "Dynamic Island", "Dynamic Island"),
    ("menu.dodge", "Hide when approached slowly", "Se cacher quand on s'approche doucement"),
    ("menu.dodge_eyes", "Eyes while hidden", "Yeux quand elle est cachée"),
    ("menu.peek", "Eyes peek out now and then", "Les yeux jettent un œil de temps en temps"),
    ("menu.auto_hide", "Hide when the mouse is far away", "Se cacher quand la souris est loin"),
    ("menu.dodge_roam", "Eyes wander if you stay close", "Les yeux se baladent si on reste près"),
    ("menu.dodge_speed", "Hides…", "Se cache…"),
    ("menu.dodge_speed_low", "Rarely (very slow approach)", "Rarement (approche très lente)"),
    ("menu.dodge_speed_medium", "Normally", "Normalement"),
    ("menu.dodge_speed_high", "Easily", "Facilement"),
    ("menu.outline", "Outline", "Contour"),
    ("menu.outline_auto", "On dark backgrounds", "Sur fond sombre"),
    ("menu.outline_on", "Always", "Toujours"),
    ("menu.outline_off", "Never", "Jamais"),
    ("menu.fullscreen", "Hide in fullscreen (games, videos)", "Cacher en plein écran (jeux, vidéos)"),
    ("menu.claude", "Show Claude usage", "Afficher l'utilisation Claude"),
    ("menu.claude_missing", "Show Claude usage (Claude Code not found)", "Afficher l'utilisation Claude (Claude Code non détecté)"),
    ("menu.autostart", "Start with Windows", "Lancer au démarrage de Windows"),
    ("menu.language", "Language", "Langue"),
    ("menu.language_auto", "Automatic (Windows)", "Automatique (Windows)"),
    ("menu.quit", "Quit", "Quitter"),
    ("settings.title", "Kysland settings", "Réglages de Kysland"),
    ("msg.config_unreadable", "Can't read config.jsonc: {error}", "config.jsonc illisible : {error}"),
    ("msg.config_invalid", "config.jsonc: {error} (line {line}, column {column})", "config.jsonc : {error} (ligne {line}, colonne {column})"),
    ("msg.config_write", "Can't update the config: {error}", "Impossible de modifier la config : {error}"),
    ("msg.wallpaper_missing", "Wallpaper not found: {path}", "Fond d'écran introuvable : {path}"),
    ("msg.autostart_failed", "Can't change start with Windows: {error}", "Lancement au démarrage impossible : {error}"),
];
