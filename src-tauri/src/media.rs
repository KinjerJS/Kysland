//! Now playing: Windows SMTC (Spotify, browsers, media players) + the KemHome agent
//! (Chrome extension, with the album art Chrome doesn't pass on to Windows).
use crate::{hub, util};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tungstenite::stream::MaybeTlsStream;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, InputStreamOptions};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

#[derive(Default)]
struct State {
    smtc: Option<Value>,
    kem: Option<(Value, Instant)>,
    thumbs: HashMap<String, Option<String>>,
    published: Option<Value>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static CONTROL: Mutex<Option<Sender<Control>>> = Mutex::new(None);

pub enum Control { PlayPause, Next, Prev, Seek(f64) }

fn with_state<R>(f: impl FnOnce(&mut State) -> R) -> R {
    f(STATE.lock().unwrap().get_or_insert_with(State::default))
}

pub fn control(c: Control) -> bool {
    match CONTROL.lock().unwrap().as_ref() { Some(tx) => tx.send(c).is_ok(), None => false }
}

pub fn has_session() -> bool { hub::last("media").and_then(|m| m.get("has")?.as_bool()).unwrap_or(false) }

pub fn start(epoch: u64, kemhome: Option<String>) {
    with_state(|s| *s = State::default());
    let (tx, rx) = channel::<Control>();
    *CONTROL.lock().unwrap() = Some(tx);
    std::thread::spawn(move || {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let mut mgr: Option<Manager> = None;
        let mut thumb_key: Option<String> = None;
        while hub::alive(epoch) {
            if mgr.is_none() { mgr = Manager::RequestAsync().and_then(|op| op.join()).ok(); }
            let session = mgr.as_ref().and_then(|m| m.GetCurrentSession().ok());
            let smtc = session.as_ref().and_then(|s| read_session(s, &mut thumb_key));
            with_state(|st| {
                if let Some((_, key, thumb)) = &smtc { if let Some(t) = thumb { st.thumbs.insert(key.clone(), Some(t.clone())); } }
                st.smtc = smtc.map(|(v, _, _)| v);
            });
            publish();
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(cmd) => { if let Some(s) = &session { run_control(s, cmd); } std::thread::sleep(Duration::from_millis(120)); }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    if let Some(base) = kemhome { std::thread::spawn(move || kemhome_loop(epoch, base.trim_end_matches('/').to_owned())); }
    hub::every(epoch, Duration::from_secs(1), publish);
}

fn run_control(s: &Session, cmd: Control) {
    let _ = match cmd {
        Control::PlayPause => s.TryTogglePlayPauseAsync().and_then(|op| op.join()),
        Control::Next => s.TrySkipNextAsync().and_then(|op| op.join()),
        Control::Prev => s.TrySkipPreviousAsync().and_then(|op| op.join()),
        Control::Seek(sec) => s.TryChangePlaybackPositionAsync((sec * 10_000_000.0) as i64).and_then(|op| op.join()),
    };
}

/// (data, track key, album art if it's new).
fn read_session(s: &Session, thumb_key: &mut Option<String>) -> Option<(Value, String, Option<String>)> {
    let props = s.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
    let pb = s.GetPlaybackInfo().ok()?;
    let tl = s.GetTimelineProperties().ok()?;
    let app = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let key = format!("{app}|{title}|{artist}");
    let status = match pb.PlaybackStatus().unwrap_or(Status::Closed) {
        Status::Playing => "Playing", Status::Paused => "Paused", Status::Stopped => "Stopped",
        Status::Changing => "Changing", Status::Opened => "Opened", _ => "Closed",
    };
    let secs = |t: windows::Foundation::TimeSpan| t.Duration as f64 / 10_000_000.0;
    let updated = tl.LastUpdatedTime().map(|d| (d.UniversalTime - 116_444_736_000_000_000) / 10_000).unwrap_or(0);
    let can_seek = pb.Controls().and_then(|c| c.IsPlaybackPositionEnabled()).unwrap_or(false);
    // Album art read once per track (retried until it's available).
    let mut thumb = None;
    if thumb_key.as_deref() != Some(&key) {
        if let Some(bytes) = props.Thumbnail().ok().and_then(|r| read_stream(&r)) {
            thumb = Some(util::data_url(&bytes, util::image_mime(&bytes)));
            *thumb_key = Some(key.clone());
        }
    }
    let data = json!({
        "key": key, "source": "smtc", "app": app, "title": title, "artist": artist,
        "album": props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default(),
        "status": status, "position": secs(tl.Position().unwrap_or_default()), "duration": secs(tl.EndTime().unwrap_or_default()),
        "at": if updated > 1_000_000_000_000 { updated } else { util::now_ms() }, "canSeek": can_seek,
    });
    Some((data, key, thumb))
}

fn read_stream(r: &windows::Storage::Streams::IRandomAccessStreamReference) -> Option<Vec<u8>> {
    let stream = r.OpenReadAsync().ok()?.join().ok()?;
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    // The stream size isn't always known up front: read in chunks until the end.
    let _ = reader.SetInputStreamOptions(InputStreamOptions::Partial);
    let mut out = Vec::new();
    while out.len() < 8 * 1024 * 1024 {
        let n = reader.LoadAsync(64 * 1024).ok()?.join().ok()?;
        if n == 0 { break; }
        let mut chunk = vec![0u8; n as usize];
        reader.ReadBytes(&mut chunk).ok()?;
        out.extend_from_slice(&chunk);
    }
    (!out.is_empty()).then_some(out)
}

fn kemhome_loop(epoch: u64, base: String) {
    let ws_url = format!("{}/media/ws", base.replacen("http", "ws", 1));
    while hub::alive(epoch) {
        if let Ok((mut ws, _)) = tungstenite::connect(&ws_url) {
            if let MaybeTlsStream::Plain(tcp) = ws.get_mut() { let _ = TcpStream::set_read_timeout(tcp, Some(Duration::from_secs(2))); }
            while hub::alive(epoch) {
                match ws.read() {
                    Ok(tungstenite::Message::Text(t)) => on_kemhome(&base, &t),
                    Ok(_) => {}
                    Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                    Err(_) => break,
                }
            }
        }
        for _ in 0..10 { if !hub::alive(epoch) { return; } std::thread::sleep(Duration::from_secs(1)); }
    }
}

fn on_kemhome(base: &str, text: &str) {
    let Ok(d) = serde_json::from_str::<Value>(text) else { return };
    let title = d["title"].as_str().unwrap_or("");
    if d["status"] == "no_session" || title.is_empty() { with_state(|s| s.kem = None); return publish(); }
    let artist = d["artist"].as_str().unwrap_or("");
    let key = format!("kem|{title}|{artist}");
    let data = json!({
        "key": key, "source": "kemhome", "app": "Chrome", "title": title, "artist": artist,
        "album": d["albumTitle"].as_str().unwrap_or(""), "status": d["playbackStatus"],
        "position": d["positionMs"].as_f64().unwrap_or(0.0) / 1000.0, "duration": d["durationMs"].as_f64().unwrap_or(0.0) / 1000.0,
        "at": util::now_ms(),
    });
    let need_thumb = d["hasThumbnail"].as_bool().unwrap_or(false) && with_state(|s| !s.thumbs.contains_key(&key));
    with_state(|s| s.kem = Some((data, Instant::now())));
    if need_thumb {
        with_state(|s| s.thumbs.insert(key.clone(), None)); // avoids duplicate requests
        let thumb = ureq::get(&format!("{base}/media/thumbnail")).call().ok()
            .filter(|r| r.status() == 200)
            .and_then(|mut r| r.body_mut().read_to_vec().ok())
            .map(|b| util::data_url(&b, util::image_mime(&b)));
        with_state(|s| match thumb { Some(t) => { s.thumbs.insert(key, Some(t)); } None => { s.thumbs.remove(&key); } });
    }
    publish();
}

/// KemHome wins if it spoke less than 3 s ago (same rule as its MediaService).
fn publish() {
    let data = with_state(|s| {
        let kem = s.kem.as_ref().filter(|(_, at)| at.elapsed() < Duration::from_secs(3)).map(|(v, _)| v.clone());
        let Some(mut m) = kem.or_else(|| s.smtc.clone()) else {
            if s.published.as_ref().map(|p| p["has"] != false).unwrap_or(true) {
                s.published = Some(json!({ "has": false }));
                return s.published.clone();
            }
            return None;
        };
        let key = m["key"].as_str().unwrap_or("").to_owned();
        let title = m["title"].as_str().unwrap_or("").to_owned();
        // Same track seen by the other source (without art): reuse the known album art.
        let thumb = s.thumbs.get(&key).cloned().flatten().or_else(|| {
            s.thumbs.iter().find(|(k, v)| v.is_some() && k.split('|').nth(1) == Some(title.as_str())).and_then(|(_, v)| v.clone())
        });
        let playing = m["status"] == "Playing";
        let obj = m.as_object_mut().unwrap();
        obj.insert("has".into(), json!(true));
        obj.insert("thumb".into(), json!(thumb));
        obj.insert("playing".into(), json!(playing));
        // Nothing to send if only the position moved forward as expected.
        if let Some(p) = &s.published {
            let drift = p["position"].as_f64().unwrap_or(0.0)
                + if p["playing"] == true { (m["at"].as_f64().unwrap_or(0.0) - p["at"].as_f64().unwrap_or(0.0)) / 1000.0 } else { 0.0 }
                - m["position"].as_f64().unwrap_or(0.0);
            if p["key"] == m["key"] && p["status"] == m["status"] && p["thumb"] == m["thumb"] && drift.abs() < 2.0 { return None; }
        }
        s.published = Some(m.clone());
        Some(m)
    });
    if let Some(d) = data { hub::publish("media", d); }
}
