//! Kys's brain: what it understands and answers when you talk to it (its page in the island).
//! Two levels. "Simple" recognizes a set of phrasings (French and English) with no model at all:
//! nothing to download, nothing running. "Smart" (an option) runs a small language model, Qwen3
//! 1.7B, downloaded on demand and run by llama.cpp (installed with Kysland, build.rs) on the CPU:
//! loaded while you talk, unloaded a minute after. Either way the answer is a line to say, an
//! action to take on the music or the volume, and a mood for its eyes.
use crate::{audio, hub, i18n, kys, media, win32};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::token::data::LlamaTokenData;
use llama_cpp_2::token::data_array::LlamaTokenDataArray;
use serde_json::{json, Value};
use std::num::NonZeroU32;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use windows::Win32::System::LibraryLoader::SetDllDirectoryW;
use windows::core::PCWSTR;

// --- What Kys can do ------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action { None, PlayPause, Next, Previous, VolumeUp, VolumeDown, VolumeSet(u32), Mute }

pub struct Reply {
    pub say: String,
    pub action: Action,
    pub mood: &'static str,
    /// A command or a question of fact, recognized for sure: no need for the smart brain.
    pub sure: bool,
}

const MOODS: [&str; 8] = ["happy", "curious", "surprised", "suspicious", "grumpy", "worried", "sleepy", "sad"];

fn act(action: Action) {
    // Like the island's buttons: through the media session, the media keys when there's none.
    let media_ctl = |c, vk| if !(media::has_session() && media::control(c)) { win32::press_keys(&[vk]) };
    match action {
        Action::None => {}
        Action::PlayPause => media_ctl(media::Control::PlayPause, win32::VK_MEDIA_PLAY_PAUSE),
        Action::Next => media_ctl(media::Control::Next, win32::VK_MEDIA_NEXT),
        Action::Previous => media_ctl(media::Control::Prev, win32::VK_MEDIA_PREV),
        Action::VolumeUp => audio::command(audio::Command::Up(10)),
        Action::VolumeDown => audio::command(audio::Command::Down(10)),
        Action::VolumeSet(v) => audio::command(audio::Command::Set(v.min(100))),
        Action::Mute => audio::command(audio::Command::ToggleMute),
    }
}

// --- What it knows about the moment ----------------------------------------------------------------

struct Now { hour: u16, minute: u16, weekday: usize, day: u16, month: usize, food: f64, joy: f64, track: Option<(String, String)> }

fn now() -> Now {
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let k = kys::state();
    let media = hub::last("media").filter(|m| m["has"] == true);
    Now {
        hour: t.wHour, minute: t.wMinute, weekday: t.wDayOfWeek as usize, day: t.wDay, month: t.wMonth as usize,
        food: k["food"].as_f64().unwrap_or(50.0), joy: k["joy"].as_f64().unwrap_or(50.0),
        track: media.map(|m| (m["title"].as_str().unwrap_or("").to_owned(), m["artist"].as_str().unwrap_or("").to_owned())),
    }
}

const DAYS: [[&str; 7]; 2] = [
    ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
];
const MONTHS: [[&str; 12]; 2] = [
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
];

// --- Simple brain -----------------------------------------------------------------------------------

/// Kys's lines (displayed text, so in both languages), by situation; one is picked at random.
const LINES: &[(&str, &[&str], &[&str])] = &[
    ("hello", &["Hi there!", "Hey! 👀", "Oh, hello!"], &["Coucou !", "Salut toi ! 👀", "Oh, bonjour !"]),
    ("fine", &["All good! And you?", "Great, thanks!", "Never better. 😊"], &["Ça va super ! Et toi ?", "Très bien, merci !", "Au top. 😊"]),
    ("hungry", &["I'm starving… a cookie maybe? 🍪", "My belly is rumbling…", "Food. Please. 🥺"], &["J'ai trop faim… un biscuit peut-être ? 🍪", "Mon ventre gargouille…", "À manger. Stp. 🥺"]),
    ("full", &["I'm full, thanks!", "Not hungry, I ate well. 😋"], &["J'ai bien mangé, merci !", "Pas faim, je suis repu. 😋"]),
    ("down", &["Not great… play with me?", "I'm a bit sad… 🥺"], &["Bof… tu joues avec moi ?", "Je suis un peu triste… 🥺"]),
    ("who", &["I'm Kys! I live in your island. 👀", "Kys. Your island's little eyes."], &["Moi c'est Kys ! J'habite dans ton island. 👀", "Kys. Les petits yeux de ton island."]),
    ("thanks", &["You're welcome!", "Anytime! 😊"], &["Avec plaisir !", "De rien ! 😊"]),
    ("love", &["Aww… 🥰", "You're nice too!", "Stop it, I'm blushing. ☺️"], &["Ohh… 🥰", "T'es gentil aussi !", "Arrête, je rougis. ☺️"]),
    ("mean", &["Hey! That's not nice. 😠", "Hmph."], &["Hé ! C'est pas gentil. 😠", "Pff."]),
    ("sixseven", &["Six… seveeen! 🙌", "6… 7! 👐", "SIX SEVEN! 😎"], &["Six… seveeen ! 🙌", "6… 7 ! 👐", "SIX SEVEN ! 😎"]),
    ("joke", &[
        "Why do eyes never lie? They'd look bad. 👀",
        "I told the mouse a joke. It clicked.",
    ], &[
        "Tu sais pourquoi les yeux ne mentent jamais ? Ça se verrait. 👀",
        "J'ai raconté une blague à la souris. Elle a cliqué.",
    ]),
    ("pause", &["Paused. ⏸️", "OK, quiet."], &["Pause. ⏸️", "OK, silence."]),
    ("play", &["Here we go! 🎶", "Music! 🎶"], &["C'est reparti ! 🎶", "Musique ! 🎶"]),
    ("next", &["Next! ⏭️", "Skipping."], &["Suivante ! ⏭️", "Je passe."]),
    ("previous", &["Back we go. ⏮️"], &["On revient en arrière. ⏮️"]),
    ("louder", &["Louder! 🔊"], &["Plus fort ! 🔊"]),
    ("quieter", &["A bit softer. 🔉"], &["Un peu moins fort. 🔉"]),
    ("mute", &["Shh… 🔇"], &["Chut… 🔇"]),
    ("no_music", &["Nothing's playing right now."], &["Rien ne joue pour l'instant."]),
    ("huh", &[
        "Huh? I didn't get that… (try \"pause\", \"volume 30\" or \"what time is it?\")",
        "Hmm, I'm just a little pair of eyes… (try \"next\" or \"are you hungry?\")",
    ], &[
        "Hein ? J'ai pas compris… (essaie « pause », « volume 30 » ou « quelle heure ? »)",
        "Hmm, je ne suis qu'une petite paire d'yeux… (essaie « suivant » ou « t'as faim ? »)",
    ]),
];

fn fr() -> bool { i18n::lang() == "fr" }

fn line(key: &str) -> String {
    let (_, en, fr_lines) = LINES.iter().find(|l| l.0 == key).expect("line");
    let pool = if fr() { fr_lines } else { en };
    pool[(crate::util::now_ms() as usize / 7) % pool.len()].to_owned()
}

/// Lowercase, accents removed, apostrophes as spaces: "Ça va ?" → "ca va ?".
fn normalize(text: &str) -> String {
    text.to_lowercase().chars().map(|c| match c {
        'à' | 'â' | 'ä' => 'a', 'é' | 'è' | 'ê' | 'ë' => 'e', 'î' | 'ï' => 'i', 'ô' | 'ö' => 'o',
        'ù' | 'û' | 'ü' => 'u', 'ç' => 'c', '\'' | '’' => ' ', c => c,
    }).collect()
}

fn has(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| {
        // Whole words (or word starts for the stems ending with '*').
        let (stem, prefix) = w.strip_suffix('*').map_or((*w, false), |s| (s, true));
        text.match_indices(stem).any(|(i, _)| {
            let before = text[..i].chars().last().is_none_or(|c| !c.is_alphanumeric());
            let after = text[i + stem.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric());
            before && (prefix || after)
        })
    })
}

/// Words about the music or the sound: the smart brain may only act on those when they're there.
const ABOUT_SOUND: &[&str] = &["musique", "music", "son", "sound", "volume", "chanson", "song", "morceau", "track", "titre", "spotify", "audio"];

/// "6 7" (the meme): Kys does it (the pages play it, see the "emote" of `talk`).
fn is_67(text: &str) -> bool {
    has(&normalize(text), &["67", "6 7", "6-7", "six seven", "six-seven", "sixseven", "six sept"])
}

/// The simple brain: intents recognized from a set of phrasings.
pub fn simple(text: &str) -> Reply {
    let t = normalize(text);
    let bare = t.trim_matches(|c: char| !c.is_alphanumeric());
    let n = now();
    let sure = |say: String, action: Action, mood: &'static str| Reply { say, action, mood, sure: true };
    let chat = |say: String, mood: &'static str| Reply { say, action: Action::None, mood, sure: false };
    // Volume to a given level: "volume 30", "mets le son a 30", "volume to 30%".
    let number = t.split(|c: char| !c.is_ascii_digit()).find(|s| !s.is_empty()).and_then(|s| s.parse::<u32>().ok());
    if has(&t, &["volume", "son", "sound"]) && let Some(v) = number.filter(|v| *v <= 100) {
        let say = if fr() { format!("Volume à {v}. 🔊") } else { format!("Volume at {v}. 🔊") };
        return sure(say, Action::VolumeSet(v), "happy");
    }
    if matches!(bare, "mute" | "unmute" | "chut") || has(&t, &["coupe le son", "coupe le volume", "remets le son", "mute the sound", "mute it"]) {
        return sure(line("mute"), Action::Mute, "sleepy");
    }
    if has(&t, &["plus fort", "monte le son", "monte le volume", "augmente le son", "augmente le volume", "louder", "turn it up", "volume up"]) {
        return sure(line("louder"), Action::VolumeUp, "happy");
    }
    if has(&t, &["moins fort", "baisse le son", "baisse le volume", "diminue le son", "diminue le volume", "quieter", "turn it down", "volume down"]) {
        return sure(line("quieter"), Action::VolumeDown, "curious");
    }
    if matches!(bare, "next" | "suivant" | "suivante" | "skip") || has(&t, &[
        "musique suivante", "chanson suivante", "titre suivant", "morceau suivant", "passe a la suivante", "passe la musique", "passe la chanson",
        "change de musique", "change de chanson", "autre musique", "autre chanson", "next song", "next track", "skip this", "skip the song",
    ]) {
        return sure(line("next"), Action::Next, "happy");
    }
    if matches!(bare, "previous" | "precedent" | "precedente") || has(&t, &[
        "musique precedente", "chanson precedente", "titre precedent", "morceau precedent", "la d avant", "previous song", "previous track",
    ]) {
        return sure(line("previous"), Action::Previous, "curious");
    }
    let playing = hub::last("media").is_some_and(|m| m["playing"] == true);
    if matches!(bare, "pause" | "stop") || has(&t, &[
        "mets en pause", "mets pause", "met pause", "stop la musique", "arrete la musique", "coupe la musique", "pause the music", "stop the music",
    ]) {
        return sure(line("pause"), if playing { Action::PlayPause } else { Action::None }, "sleepy");
    }
    if matches!(bare, "play" | "lecture" | "resume") || has(&t, &[
        "remets la musique", "mets de la musique", "mets la musique", "lance la musique", "joue de la musique", "relance la musique", "reprends la musique",
        "play music", "play the music", "play some music", "resume the music", "unpause",
    ]) {
        return sure(line("play"), if playing { Action::None } else { Action::PlayPause }, "happy");
    }
    if has(&t, &["c est quoi cette musique", "c est quoi la musique", "c est quoi ce son", "quelle musique", "quelle chanson", "qu est-ce qu on ecoute",
        "what s playing", "what is playing", "what song", "which song"]) {
        return match n.track {
            Some((title, artist)) if !title.is_empty() => {
                let say = match (fr(), artist.is_empty()) {
                    (true, false) => format!("C'est « {title} » de {artist}. 🎶"),
                    (true, true) => format!("C'est « {title} ». 🎶"),
                    (false, false) => format!("It's \"{title}\" by {artist}. 🎶"),
                    (false, true) => format!("It's \"{title}\". 🎶"),
                };
                sure(say, Action::None, "happy")
            }
            _ => sure(line("no_music"), Action::None, "curious"),
        };
    }
    if has(&t, &["quelle heure", "l heure", "what time", "the time"]) {
        let say = if fr() { format!("Il est {}h{:02}. ⏰", n.hour, n.minute) } else { format!("It's {}:{:02}. ⏰", n.hour, n.minute) };
        return sure(say, Action::None, "curious");
    }
    if has(&t, &["quel jour", "on est quel", "on est le combien", "la date", "what day", "what s the date", "what is the date", "today s date"]) {
        let (d, m) = (DAYS[fr() as usize][n.weekday % 7], MONTHS[fr() as usize][(n.month + 11) % 12]);
        let say = if fr() { format!("On est {d} {} {m}. 📅", n.day) } else { format!("It's {d}, {m} {}. 📅", n.day) };
        return sure(say, Action::None, "curious");
    }
    // Small talk: the smart brain does better, when it's on.
    if has(&t, &["faim", "hungry", "manger", "eat"]) {
        return if n.food < 30.0 { chat(line("hungry"), "worried") } else { chat(line("full"), "happy") };
    }
    if has(&t, &["ca va", "comment vas", "comment tu vas", "how are you", "how s it going", "tu vas bien"]) {
        return if n.food < 30.0 { chat(line("hungry"), "worried") }
            else if n.joy < 30.0 { chat(line("down"), "sad") }
            else { chat(line("fine"), "happy") };
    }
    if has(&t, &["qui es", "t es qui", "ton nom", "tu t appelle*", "who are you", "your name"]) { return chat(line("who"), "happy"); }
    if has(&t, &["merci", "thanks", "thank you"]) { return chat(line("thanks"), "happy"); }
    if has(&t, &["je t aime", "t es mignon", "trop mignon", "love you", "cute", "adorable", "bravo", "good boy", "t es beau"]) {
        return chat(line("love"), "happy");
    }
    if has(&t, &["nul", "idiot", "stupid", "bete", "je te deteste", "hate you", "moche", "ugly"]) { return chat(line("mean"), "grumpy"); }
    if is_67(text) { return sure(line("sixseven"), Action::None, "happy"); }
    if has(&t, &["blague", "joke", "drole", "funny"]) { return chat(line("joke"), "happy"); }
    if has(&t, &["bonjour", "salut", "coucou", "hello", "hey", "hi", "yo", "bonsoir"]) { return chat(line("hello"), "happy"); }
    chat(line("huh"), "curious")
}

// --- Smart brain: a small model run by llama.cpp ----------------------------------------------------

/// A model the smart brain can run: Qwen3 (Apache 2.0), 4-bit, from Hugging Face.
pub struct Model {
    /// Its name in the config (`kys-brain`).
    pub id: &'static str,
    file: &'static str,
    url: &'static str,
    size: u64,
    /// A model that can think before answering: told not to, with an empty thought.
    thinks: bool,
}

/// Light answers in about a second but has little to say; smart is much better company, in two or
/// three seconds.
const MODELS: [Model; 2] = [
    Model {
        id: "light", file: "Qwen3-1.7B-Q4_K_M.gguf", size: 1_107_409_472, thinks: true,
        url: "https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
    },
    Model {
        id: "smart", file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", size: 2_497_281_120, thinks: false,
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
    },
];

pub fn model(id: &str) -> Option<&'static Model> { MODELS.iter().find(|m| m.id == id) }

/// The model stays loaded this long after the last message, then its memory is freed.
const UNLOAD_AFTER: Duration = Duration::from_secs(60);
/// A conversation quiet for this long starts over.
const FORGET_AFTER: Duration = Duration::from_secs(600);
/// Tokens the model can hold: its instructions, the conversation and the answer.
const N_CTX: usize = 2048;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static BACKEND: OnceLock<Option<LlamaBackend>> = OnceLock::new();
/// The download under way: which model, how far.
static DOWNLOADING: Mutex<Option<(&'static str, u64, u64)>> = Mutex::new(None);
/// The thread running a model while it's loaded (see `run_model`): its number, its model.
static WORKER: Mutex<Option<(u64, &'static str, Sender<Job>)>> = Mutex::new(None);
static WORKERS: AtomicU64 = AtomicU64::new(0);
/// Last exchanges (what Kys was told, what it answered), for a bit of continuity, and when.
type Exchange = (String, String);
static HISTORY: Mutex<(Vec<Exchange>, Option<Instant>)> = Mutex::new((Vec::new(), None));

enum Job { Talk(String, Sender<Result<Reply, String>>), Warm, Quit }

/// Where the models live: Kysland's data folder (%LOCALAPPDATA%\com.kinjer.kysland, kept across updates).
pub fn init(data_dir: PathBuf) { let _ = DIR.set(data_dir.join("models")); }

fn model_path(m: &Model) -> Option<PathBuf> { DIR.get().map(|d| d.join(m.file)) }

pub fn model_ready(m: &Model) -> bool {
    model_path(m).and_then(|p| std::fs::metadata(p).ok()).is_some_and(|f| f.len() == m.size)
}

/// For the settings: the models (downloaded or not), the download under way, the one loaded.
pub fn state() -> Value {
    let downloading = *DOWNLOADING.lock().unwrap();
    json!({
        "available": libraries().is_some(),
        "models": MODELS.iter().map(|m| json!({ "id": m.id, "size": m.size, "ready": model_ready(m) })).collect::<Vec<_>>(),
        "downloading": downloading.map(|(id, done, total)| json!({ "model": id, "done": done, "total": total })),
        "loaded": WORKER.lock().unwrap().as_ref().map(|w| w.1),
    })
}

fn broadcast() { hub::emit("kys-brain", state()); }

/// Downloads a model in the background, telling the pages how far it got.
pub fn download(m: &'static Model) {
    if model_ready(m) || DOWNLOADING.lock().unwrap().is_some() { return; }
    *DOWNLOADING.lock().unwrap() = Some((m.id, 0, m.size));
    broadcast();
    std::thread::spawn(move || {
        let result = (|| -> Result<(), String> {
            let dir = DIR.get().ok_or("no data folder")?;
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let part = dir.join(format!("{}.part", m.file));
            let mut response = ureq::get(m.url).call().map_err(|e| e.to_string())?;
            let mut body = response.body_mut().with_config().limit(m.size + 1).reader();
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let (mut done, mut told) = (0u64, Instant::now());
            let mut buf = vec![0u8; 1 << 16];
            loop {
                let n = std::io::Read::read(&mut body, &mut buf).map_err(|e| e.to_string())?;
                if n == 0 { break; }
                std::io::Write::write_all(&mut file, &buf[..n]).map_err(|e| e.to_string())?;
                done += n as u64;
                if told.elapsed() > Duration::from_millis(400) {
                    told = Instant::now();
                    *DOWNLOADING.lock().unwrap() = Some((m.id, done, m.size));
                    broadcast();
                }
            }
            drop(file);
            if done != m.size {
                let _ = std::fs::remove_file(&part);
                return Err(format!("incomplete download ({done} bytes)"));
            }
            std::fs::rename(&part, dir.join(m.file)).map_err(|e| e.to_string())
        })();
        if let Err(e) = result { eprintln!("[kysland] model download failed: {e}"); }
        *DOWNLOADING.lock().unwrap() = None;
        broadcast();
    });
}

pub fn delete_model(m: &'static Model) {
    if WORKER.lock().unwrap().as_ref().is_some_and(|w| w.1 == m.id) { unload(); }
    // The model's thread lets go of the file as it ends.
    std::thread::spawn(move || {
        for _ in 0..20 {
            if model_path(m).is_none_or(|p| std::fs::remove_file(p).is_ok()) { break; }
            std::thread::sleep(Duration::from_millis(250));
        }
        broadcast();
    });
}

/// Frees the model's memory now.
pub fn unload() {
    if let Some((_, _, jobs)) = WORKER.lock().unwrap().take() { let _ = jobs.send(Job::Quit); }
    broadcast();
}

/// Where llama.cpp's libraries are (build.rs): `llama\` next to kysland.exe once installed,
/// `src-tauri\llama\` in development. None when they're missing.
fn libraries() -> Option<PathBuf> {
    let installed = std::env::current_exe().ok()?.parent()?.join("llama");
    let dir = if installed.is_dir() { installed } else { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("llama") };
    ["llama.dll", "ggml.dll", "ggml-base.dll"].iter().all(|f| dir.join(f).is_file()).then_some(dir)
}

fn backend() -> Option<&'static LlamaBackend> {
    BACKEND.get_or_init(|| {
        // The libraries are delay-loaded, from there (one missing would crash the first call into it).
        let dir = libraries()?;
        let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
        unsafe { SetDllDirectoryW(PCWSTR(wide.as_ptr())).ok()? };
        unsafe extern "C" fn quiet(_: llama_cpp_sys_2::ggml_log_level, _: *const std::ffi::c_char, _: *mut std::ffi::c_void) {}
        unsafe { llama_cpp_sys_2::llama_log_set(Some(quiet), std::ptr::null_mut()) };
        // ggml for this processor: its best CPU variant among those installed.
        llama_cpp_2::llama_backend::load_backends_from_path(&dir);
        LlamaBackend::init().ok()
    }).as_ref()
}

/// Who Kys is and how it answers, in the language it should answer in. It never changes, so the
/// model reads it once per loading (see `answer`).
fn persona() -> &'static str {
    if fr() {
        "Tu es Kys, une petite créature faite de deux yeux, qui vit dans la Dynamic Island en haut de l'écran de ton humain. \
         Ton caractère : curieux, espiègle, taquin mais affectueux, parfois boudeur. \
         Tu as tes propres goûts et tes avis, et tu les donnes.\n\
         Règles :\n\
         - Réponds en une ou deux phrases courtes et familières (moins de 25 mots), comme un ami, parfois avec un emoji.\n\
         - Varie tes sujets. Ne parle de manger que si ton ventre est bas (moins de 30).\n\
         - Ne répète pas et ne reformule pas ce que dit ton humain : réagis, donne ton avis, fais une blague, raconte \
         quelque chose ou pose une question.\n\
         - Tu peux seulement discuter et régler la musique et le volume. Pour le reste, dis-le avec humour.\n\
         - Chaque message commence, entre crochets, par ce qui se passe : l'heure, ton ventre, ta joie, la musique. \
         Parles-en seulement quand ça a du sens.\n\
         - Si on te parle dans une autre langue, réponds dans cette langue.\n\
         Réponds en JSON : action (ce qu'on te demande de faire avec la musique : play_pause, next, previous, volume_up, \
         volume_down, volume_set_N pour mettre le volume à N, mute ; sinon none), say (ta réponse), puis mood : l'émotion \
         de ta réponse (happy, curious, surprised, suspicious, grumpy, worried, sleepy ou sad)."
    } else {
        "You are Kys, a little creature made of two eyes, living in the Dynamic Island at the top of your human's screen. \
         Your personality: curious, mischievous, teasing but affectionate, sometimes sulky. \
         You have your own tastes and opinions, and you share them.\n\
         Rules:\n\
         - Answer in one or two short, casual sentences (under 25 words), like a friend, sometimes with an emoji.\n\
         - Vary your topics. Only talk about food when your belly is low (under 30).\n\
         - Don't repeat or rephrase what your human says: react, give your opinion, make a joke, tell something or ask \
         a question.\n\
         - All you can do is chat and control the music and the volume. For anything else, say so with humor.\n\
         - Each message starts, in brackets, with what's going on: the time, your belly, your joy, the music. \
         Only mention it when it makes sense.\n\
         - If you're spoken to in another language, answer in that language.\n\
         Answer in JSON: action (what you're asked to do with the music: play_pause, next, previous, volume_up, \
         volume_down, volume_set_N to set the volume to N, mute; otherwise none), say (your answer), then mood: the \
         emotion of your answer (happy, curious, surprised, suspicious, grumpy, worried, sleepy or sad)."
    }
}

/// A few exchanges showing Kys's tone, before the real conversation (read once per loading too).
fn examples() -> &'static [(&'static str, &'static str)] {
    if fr() {
        &[
            ("[14h10 · ventre 80/100 · joie 70/100 · musique : « Blinding Lights » de The Weeknd]\nJ'adore cette chanson",
             r#"{"action":"none","say":"Moi aussi ! Mes yeux clignent en rythme sur ce synthé 🎶","mood":"happy"}"#),
            ("[14h12 · ventre 80/100 · joie 72/100 · musique : « Blinding Lights » de The Weeknd]\nRaconte-moi un truc",
             r#"{"action":"none","say":"Tu savais que les pieuvres ont trois cœurs ? Moi j'en ai zéro, mais deux yeux très mignons 👀","mood":"curious"}"#),
            ("[23h47 · ventre 55/100 · joie 60/100 · musique : rien]\nTu fais quoi ?",
             r#"{"action":"none","say":"Je surveille ta souris… mais il est presque minuit, t'irais pas dormir ? 😴","mood":"sleepy"}"#),
            ("[18h05 · ventre 20/100 · joie 40/100 · musique : rien]\nT'es nul",
             r#"{"action":"none","say":"Hé ! Je boude. Et en plus j'ai faim, un cookie pourrait tout arranger 🍪","mood":"grumpy"}"#),
            ("[16h30 · ventre 70/100 · joie 65/100 · musique : « Enter Sandman » de Metallica]\nMets un truc plus calme",
             r#"{"action":"next","say":"Je zappe ! Croisons les yeux pour que la suivante soit plus douce 🎧","mood":"happy"}"#),
            ("[21h15 · ventre 65/100 · joie 75/100 · musique : rien]\nJe suis crevé aujourd'hui",
             r#"{"action":"none","say":"Oh… grosse journée ? Pose-toi un peu, je garde l'écran pour toi 🫶","mood":"worried"}"#),
        ]
    } else {
        &[
            ("[2:10 PM · belly 80/100 · joy 70/100 · music: \"Blinding Lights\" by The Weeknd]\nI love this song",
             r#"{"action":"none","say":"Me too! My eyes blink along to that synth 🎶","mood":"happy"}"#),
            ("[2:12 PM · belly 80/100 · joy 72/100 · music: \"Blinding Lights\" by The Weeknd]\nTell me something",
             r#"{"action":"none","say":"Did you know octopuses have three hearts? I have zero, but two very cute eyes 👀","mood":"curious"}"#),
            ("[11:47 PM · belly 55/100 · joy 60/100 · music: nothing]\nWhat are you doing?",
             r#"{"action":"none","say":"Watching your mouse… but it's almost midnight, shouldn't you sleep? 😴","mood":"sleepy"}"#),
            ("[6:05 PM · belly 20/100 · joy 40/100 · music: nothing]\nYou're useless",
             r#"{"action":"none","say":"Hey! I'm sulking. And I'm hungry, a cookie could fix everything 🍪","mood":"grumpy"}"#),
            ("[4:30 PM · belly 70/100 · joy 65/100 · music: \"Enter Sandman\" by Metallica]\nPut on something calmer",
             r#"{"action":"next","say":"Skipping! Fingers crossed, well, eyes crossed, for a softer one 🎧","mood":"happy"}"#),
            ("[9:15 PM · belly 65/100 · joy 75/100 · music: nothing]\nI'm exhausted today",
             r#"{"action":"none","say":"Oh… rough day? Take a break, I'll watch the screen for you 🫶","mood":"worried"}"#),
        ]
    }
}

/// What's going on right now, at the start of each message.
fn moment(n: &Now) -> String {
    let fr = fr();
    let track = match &n.track {
        Some((title, artist)) if !title.is_empty() && fr => format!("« {title} » de {artist}"),
        Some((title, artist)) if !title.is_empty() => format!("\"{title}\" by {artist}"),
        _ => (if fr { "rien" } else { "nothing" }).to_owned(),
    };
    if fr {
        format!("[{}h{:02} · ventre {:.0}/100 · joie {:.0}/100 · musique : {track}]", n.hour, n.minute, n.food, n.joy)
    } else {
        let (h, pm) = (n.hour % 12, n.hour >= 12);
        format!("[{}:{:02} {} · belly {:.0}/100 · joy {:.0}/100 · music: {track}]", if h == 0 { 12 } else { h }, n.minute,
            if pm { "PM" } else { "AM" }, n.food, n.joy)
    }
}

/// The answer's shape, enforced token by token: the model can't produce anything else. The decision
/// first, then the words, then the emotion that goes with them.
fn grammar() -> String {
    let moods = MOODS.iter().map(|m| format!("\"\\\"{m}\\\"\"")).collect::<Vec<_>>().join(" | ");
    format!(r#"root ::= "{{" ws "\"action\":" ws action "," ws "\"say\":" ws say "," ws "\"mood\":" ws mood ws "}}"
say ::= "\"" char{{1,200}} "\""
char ::= [^"\\\x00-\x1f] | "\\" ["\\/nt]
action ::= "\"" ("none" | "play_pause" | "next" | "previous" | "volume_up" | "volume_down" | "mute" | "volume_set_" volume) "\""
volume ::= [0-9] | [1-9] [0-9] | "100"
mood ::= {moods}
ws ::= " "?
"#)
}

/// Asks the model to answer.
fn smart(m: &'static Model, text: &str) -> Result<Reply, String> {
    let (tx, rx) = mpsc::channel();
    send(m, Job::Talk(text.to_owned(), tx))?;
    rx.recv().map_err(|_| "the model stopped".to_owned())?
}

/// Someone is about to talk to Kys (its input got the focus): the model loads and reads its
/// instructions right away, so the first answer comes sooner.
pub fn warm(brain: &str) {
    if let Some(m) = model(brain).filter(|m| model_ready(m)) {
        std::thread::spawn(move || { let _ = send(m, Job::Warm); });
    }
}

/// Gives the model's thread a job (started, with the model loaded, if there's none or it runs
/// another model).
fn send(m: &'static Model, job: Job) -> Result<(), String> {
    let mut worker = WORKER.lock().unwrap();
    if worker.as_ref().is_some_and(|w| w.1 != m.id) && let Some((_, _, jobs)) = worker.take() { let _ = jobs.send(Job::Quit); }
    let unsent = match worker.as_ref() { Some((_, _, jobs)) => jobs.send(job).err().map(|e| e.0), None => Some(job) };
    if let Some(job) = unsent {
        let backend = backend().ok_or("llama.cpp unavailable")?;
        let path = model_path(m).filter(|_| model_ready(m)).ok_or("model not downloaded")?;
        let (jobs, inbox) = mpsc::channel();
        let _ = jobs.send(job);
        let id = WORKERS.fetch_add(1, Ordering::SeqCst);
        std::thread::Builder::new().name("kys-brain".into())
            .spawn(move || run_model(id, m, backend, &path, &inbox))
            .map_err(|e| e.to_string())?;
        *worker = Some((id, m.id, jobs));
    }
    Ok(())
}

/// The model's thread: loads the model, answers what Kys is told, and ends after a minute without
/// messages, freeing the model's memory. Its context stays between messages, so what the model
/// already read (its instructions, the conversation) isn't read again.
fn run_model(id: u64, m: &'static Model, backend: &'static LlamaBackend, path: &std::path::Path, inbox: &Receiver<Job>) {
    // Stops taking messages (unless another thread already replaced this one).
    let retire = || {
        let mut worker = WORKER.lock().unwrap();
        if worker.as_ref().is_some_and(|w| w.0 == id) { *worker = None; }
    };
    broadcast(); // loading
    let loaded = (|| -> Result<(), String> {
        let model = LlamaModel::load_from_file(backend, path, &LlamaModelParams::default()).map_err(|e| e.to_string())?;
        let threads = std::thread::available_parallelism().map(|n| (n.get() / 2).clamp(2, 8)).unwrap_or(4) as i32;
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(N_CTX as u32))
            .with_n_batch(512)
            .with_n_threads(threads)
            .with_n_threads_batch(threads);
        let mut ctx = model.new_context(backend, params).map_err(|e| e.to_string())?;
        let mut seen = Vec::new();
        loop {
            let job = match inbox.recv_timeout(UNLOAD_AFTER) {
                Ok(job) => job,
                Err(_) => {
                    // Nobody talked to Kys for a minute: done (unless a message just came in).
                    retire();
                    match inbox.try_recv() { Ok(job) => job, Err(_) => return Ok(()) }
                }
            };
            match job {
                Job::Quit => return Ok(()),
                Job::Warm => if let Err(e) = warm_up(m, &model, &mut ctx, &mut seen) { eprintln!("[kysland] smart brain: {e}"); },
                Job::Talk(text, reply) => { let _ = reply.send(answer(m, &model, &mut ctx, &mut seen, &text)); }
            }
        }
    })();
    retire();
    for job in inbox.try_iter() {
        if let Job::Talk(_, reply) = job { let _ = reply.send(Err("the model stopped".into())); }
    }
    if let Err(e) = loaded { eprintln!("[kysland] smart brain: {e}"); }
    broadcast();
}

/// Where `seen` picks `rest` up again after a gap (the oldest exchanges, dropped), if it does.
fn resume(seen: &[LlamaToken], from: usize, rest: &[LlamaToken]) -> Option<usize> {
    let need = rest.len().min(32);
    if need < 8 || seen.len() < need { return None; }
    (from + 1..=seen.len() - need).find(|&b| seen[b..b + need] == rest[..need])
}

/// The start of an answer. A model that can think answers right away, with an empty thought.
fn answer_start(m: &Model) -> &'static str {
    if m.thinks { "<|im_start|>assistant\n<think>\n\n</think>\n\n" } else { "<|im_start|>assistant\n" }
}

/// Kys's instructions, the examples and the conversation so far, as the model reads them.
fn conversation(m: &Model, history: &[Exchange]) -> String {
    let mut prompt = format!("<|im_start|>system\n{}<|im_end|>\n", persona());
    for (user, kys) in examples().iter().copied().chain(history.iter().map(|(u, k)| (u.as_str(), k.as_str()))) {
        prompt += &format!("<|im_start|>user\n{user}<|im_end|>\n{}{kys}<|im_end|>\n", answer_start(m));
    }
    prompt
}

/// The conversation, forgotten after a quiet while.
fn history() -> std::sync::MutexGuard<'static, (Vec<Exchange>, Option<Instant>)> {
    let mut history = HISTORY.lock().unwrap();
    if history.1.is_some_and(|t| t.elapsed() > FORGET_AFTER) { history.0.clear(); }
    history
}

/// Makes the context hold `tokens`, in which `seen` is what it holds: what's in common stays
/// (moved back over the exchanges dropped, if any), the rest is read in batches. Returns the batch
/// last read, whose last token's predictions come next.
fn read(ctx: &mut LlamaContext, seen: &mut Vec<LlamaToken>, tokens: &[LlamaToken]) -> Result<LlamaBatch<'static>, String> {
    let err = |e: &dyn std::fmt::Display| e.to_string();
    let prefix = |seen: &[LlamaToken]| seen.iter().zip(tokens).take_while(|(a, b)| a == b).count().min(tokens.len() - 1);
    let mut common = prefix(seen);
    if let Some(b) = resume(seen, common, &tokens[common..])
        && ctx.kv_cache_seq_rm(0, Some(common as u32), Some(b as u32)).is_ok()
        && ctx.kv_cache_seq_add(0, Some(b as u32), None, common as i32 - b as i32).is_ok()
    {
        seen.drain(common..b);
        common = prefix(seen);
    }
    if !ctx.clear_kv_cache_seq(Some(0), Some(common as u32), None).unwrap_or(false) {
        ctx.clear_kv_cache();
        common = 0;
    }
    seen.truncate(common);
    let mut batch = LlamaBatch::new(512, 1);
    for start in (common..tokens.len()).step_by(512) {
        batch.clear();
        for (i, token) in tokens.iter().enumerate().take((start + 512).min(tokens.len())).skip(start) {
            batch.add(*token, i as i32, &[0], i == tokens.len() - 1).map_err(|e| err(&e))?;
        }
        ctx.decode(&mut batch).map_err(|e| err(&e))?;
    }
    seen.extend_from_slice(&tokens[common..]);
    Ok(batch)
}

/// Reads the instructions and the conversation ahead of the next message.
fn warm_up(m: &Model, model: &LlamaModel, ctx: &mut LlamaContext, seen: &mut Vec<LlamaToken>) -> Result<(), String> {
    let history = history();
    let tokens = model.str_to_token(&conversation(m, &history.0), AddBos::Never).map_err(|e| e.to_string())?;
    if tokens.len() + 300 < N_CTX { read(ctx, seen, &tokens)?; }
    Ok(())
}

/// One answer from the model. `seen` is what the context holds (its tokens, in order): only what
/// it doesn't hold yet is read.
fn answer(m: &Model, model: &LlamaModel, ctx: &mut LlamaContext, seen: &mut Vec<LlamaToken>, text: &str) -> Result<Reply, String> {
    let err = |e: &dyn std::fmt::Display| e.to_string();
    let mut history = history();
    let message = format!("{}\n{text}", moment(&now()));
    let prompt = |history: &[Exchange]| conversation(m, history) + &format!("<|im_start|>user\n{message}<|im_end|>\n{}", answer_start(m));
    let mut tokens = model.str_to_token(&prompt(&history.0), AddBos::Never).map_err(|e| err(&e))?;
    // Room for the answer: the oldest exchanges go.
    while tokens.len() + 240 > N_CTX && !history.0.is_empty() {
        history.0.remove(0);
        tokens = model.str_to_token(&prompt(&history.0), AddBos::Never).map_err(|e| err(&e))?;
    }
    let mut batch = read(ctx, seen, &tokens)?;

    let mut grammar = LlamaSampler::grammar(model, &grammar(), "root").map_err(|e| err(&e))?;
    let pick = || LlamaSampler::chain_simple([
        // Qwen3's advice without thinking.
        LlamaSampler::top_k(20),
        LlamaSampler::top_p(0.8, 1),
        LlamaSampler::temp(0.7),
        LlamaSampler::dist(crate::util::now_ms() as u32),
    ]);
    let mut sampler = pick();
    let mut out = Vec::new();
    let mut last = batch.n_tokens() - 1; // where the last read token's predictions are
    for _ in 0..200 {
        // The token drawn, if the answer's shape allows it; otherwise one among those it allows
        // (checking the whole vocabulary for each token would slow everything down).
        let mut token = sampler.sample(ctx, last);
        let mut drawn = LlamaTokenDataArray::new(vec![LlamaTokenData::new(token, 1.0, 0.0)], false);
        drawn.apply_sampler(&grammar);
        if drawn.data[0].logit() == f32::NEG_INFINITY {
            let mut allowed = ctx.token_data_array_ith(last);
            allowed.apply_sampler(&grammar);
            allowed.apply_sampler(&pick());
            token = allowed.selected_token().ok_or("no token allowed")?;
        }
        if model.is_eog_token(token) { break; }
        grammar.accept(token);
        let piece = match model.token_to_piece_bytes(token, 32, false, None) {
            Err(llama_cpp_2::TokenToStringError::InsufficientBufferSpace(n)) => model.token_to_piece_bytes(token, (-n) as usize, false, None),
            other => other,
        }.map_err(|e| err(&e))?;
        out.extend_from_slice(&piece);
        if out.ends_with(b"}") && serde_json::from_slice::<Value>(&out).is_ok() { break; }
        batch.clear();
        batch.add(token, seen.len() as i32, &[0], true).map_err(|e| err(&e))?;
        ctx.decode(&mut batch).map_err(|e| err(&e))?;
        seen.push(token);
        last = 0;
    }
    let answer: Value = serde_json::from_slice(&out).map_err(|e| format!("unexpected answer: {e}"))?;
    let say = answer["say"].as_str().unwrap_or("…").trim().to_owned();
    let action = match answer["action"].as_str().unwrap_or("none") {
        "play_pause" => Action::PlayPause, "next" => Action::Next, "previous" => Action::Previous,
        "volume_up" => Action::VolumeUp, "volume_down" => Action::VolumeDown, "mute" => Action::Mute,
        other => other.strip_prefix("volume_set_").and_then(|v| v.parse().ok()).map_or(Action::None, Action::VolumeSet),
    };
    // A small model can take "I like this song" for a command: acting needs words about the sound.
    let action = if has(&normalize(text), ABOUT_SOUND) { action } else { Action::None };
    let mood = MOODS.iter().copied().find(|m| Some(*m) == answer["mood"].as_str()).unwrap_or("happy");
    history.0.push((message, String::from_utf8_lossy(&out).into_owned()));
    history.1 = Some(Instant::now());
    Ok(Reply { say, action, mood, sure: false })
}

/// Talking to Kys, then the action it decided on. `brain` is "simple" or a model's name. Commands
/// and facts come from the rules (instant and reliable), the rest from the model when it's chosen
/// and downloaded (the rules if it fails).
pub fn talk(text: &str, brain: &str) -> Value {
    let text = text.trim();
    let started = Instant::now();
    let quick = simple(text);
    let (reply, by) = match model(brain).filter(|m| !quick.sure && model_ready(m)) {
        Some(m) => match smart(m, text) {
            Ok(r) => (r, m.id),
            Err(e) => { eprintln!("[kysland] smart brain: {e}"); (quick, "simple") }
        },
        None => (quick, "simple"),
    };
    act(reply.action);
    json!({
        "emote": (is_67(text) || is_67(&reply.say)).then_some("67"),
        "say": reply.say, "mood": reply.mood, "brain": by, "ms": started.elapsed().as_millis() as u64,
        "action": format!("{:?}", reply.action),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_brain_understands_commands() {
        assert_eq!(simple("mets le volume à 30").action, Action::VolumeSet(30));
        assert_eq!(simple("Volume to 75%").action, Action::VolumeSet(75));
        assert_eq!(simple("musique suivante stp").action, Action::Next);
        assert_eq!(simple("Next!").action, Action::Next);
        assert_eq!(simple("coupe le son").action, Action::Mute);
        assert_eq!(simple("plus fort !").action, Action::VolumeUp);
        assert!(simple("quelle heure est-il ?").sure);
        // Not commands: playing together, passing by, next time...
        for text in ["t'as faim ?", "tu veux jouer ?", "je passe te voir", "next time maybe", "j'aime la musique", "arrête de bouger"] {
            let r = simple(text);
            assert!(r.action == Action::None && !r.sure, "{text}");
        }
        assert_eq!(normalize("Ça va, l’ami ?"), "ca va, l ami ?");
        assert!(has("salut toi", &["salut"]));
        assert!(!has("salutations", &["salut"]));
        assert!(has("baissez", &["baisse*"]));
        assert!(is_67("SIX SEVEN") && is_67("mets le volume à 67") && !is_67("1967") && !is_67("6 heures"));
        assert!(simple("67 !").sure);
    }

    /// Needs the downloaded models: `cargo test --release -- --ignored --nocapture` (KYS_MODEL=light
    /// for the light one).
    #[test]
    #[ignore]
    fn smart_brain_answers() {
        init(PathBuf::from(std::env::var("LOCALAPPDATA").unwrap()).join("com.kinjer.kysland"));
        let m = model(&std::env::var("KYS_MODEL").unwrap_or_else(|_| "smart".into())).expect("model");
        assert!(model_ready(m), "model not downloaded");
        i18n::set("fr");
        warm(m.id); // as when the input gets the focus
        std::thread::sleep(Duration::from_secs(15));
        for text in [
            "Salut Kys, ça va ?", "Tu peux passer à la prochaine musique ?", "J'adore cette chanson", "Raconte-moi un truc",
            "C'est quoi ta couleur préférée ?", "Je suis triste aujourd'hui", "T'es moche", "Tu peux m'aider à faire mes devoirs ?",
            "Tu préfères les chats ou les chiens ?", "J'ai eu une bonne note à mon exam !", "Mets le son un peu moins fort",
            "Qu'est-ce que tu penses de moi ?", "What's your favorite color?", "Tu te souviens de ce que je t'ai dit sur mon exam ?",
            "Tu dors ?", "Je t'aime bien tu sais",
        ] {
            let t = Instant::now();
            let r = smart(m, text).expect("answer");
            println!("{text:?} -> {:?} / {:?} / {} ({} ms)", r.say, r.action, r.mood, t.elapsed().as_millis());
        }
    }
}
