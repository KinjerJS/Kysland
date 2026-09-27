//! Volume via Core Audio : notifications instantanées, commandes, et interception des touches
//! volume (Kysland règle le volume lui-même, donc la pastille de volume Windows ne s'affiche plus).
use crate::hub;
use serde_json::json;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, Once};
use std::time::Duration;
use windows::core::implement;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioEndpointVolumeCallback, IAudioEndpointVolumeCallback_Impl};
use windows::Win32::Media::Audio::{eMultimedia, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, AUDIO_VOLUME_NOTIFICATION_DATA};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_SYSKEYDOWN,
};

fn com_init() { unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); } }

fn endpoint() -> windows::core::Result<(IMMDevice, IAudioEndpointVolume)> {
    unsafe {
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let dev = en.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
        let vol: IAudioEndpointVolume = dev.Activate(CLSCTX_ALL, None)?;
        Ok((dev, vol))
    }
}

static LAST: Mutex<Option<(u32, bool)>> = Mutex::new(None);

fn publish(volume: u32, muted: bool) {
    let mut last = LAST.lock().unwrap();
    if *last == Some((volume, muted)) { return; }
    *last = Some((volume, muted));
    hub::publish("audio", json!({ "volume": volume, "muted": muted }));
}

fn publish_from(vol: &IAudioEndpointVolume) {
    unsafe {
        if let (Ok(v), Ok(m)) = (vol.GetMasterVolumeLevelScalar(), vol.GetMute()) {
            publish((v * 100.0).round() as u32, m.as_bool());
        }
    }
}

#[implement(IAudioEndpointVolumeCallback)]
struct VolumeCallback;

impl IAudioEndpointVolumeCallback_Impl for VolumeCallback_Impl {
    fn OnNotify(&self, data: *mut AUDIO_VOLUME_NOTIFICATION_DATA) -> windows::core::Result<()> {
        if let Some(d) = unsafe { data.as_ref() } {
            publish((d.fMasterVolume * 100.0).round() as u32, d.bMuted.as_bool());
        }
        Ok(())
    }
}

static STARTED: Once = Once::new();
static COMMANDS: Mutex<Option<Sender<Command>>> = Mutex::new(None);

pub enum Command { Set(u32), Up(u32), Down(u32), ToggleMute }

/// Démarre (une seule fois) le suivi du volume et le fil des commandes.
pub fn start() {
    STARTED.call_once(|| {
        // Notifications : réabonnement quand la sortie audio par défaut change.
        std::thread::spawn(|| {
            com_init();
            let cb: IAudioEndpointVolumeCallback = VolumeCallback.into();
            let mut current: Option<(String, IAudioEndpointVolume)> = None;
            loop {
                if let Ok((dev, vol)) = endpoint() {
                    let id = unsafe {
                        dev.GetId().map(|p| { let s = p.to_string().unwrap_or_default(); CoTaskMemFree(Some(p.0 as _)); s }).unwrap_or_default()
                    };
                    if current.as_ref().map(|c| &c.0) != Some(&id) {
                        unsafe {
                            if let Some((_, old)) = &current { let _ = old.UnregisterControlChangeNotify(&cb); }
                            let _ = vol.RegisterControlChangeNotify(&cb);
                        }
                        publish_from(&vol);
                        current = Some((id, vol));
                    }
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
        // Commandes (molette, slider, clic "muet").
        let (tx, rx) = channel::<Command>();
        *COMMANDS.lock().unwrap() = Some(tx);
        std::thread::spawn(move || {
            com_init();
            for cmd in rx {
                let Ok((_, vol)) = endpoint() else { continue };
                apply(&vol, cmd);
            }
        });
    });
}

fn apply(vol: &IAudioEndpointVolume, cmd: Command) {
    unsafe {
        let cur = vol.GetMasterVolumeLevelScalar().map(|v| (v * 100.0).round() as i32).unwrap_or(50);
        let set = |v: i32| { let _ = vol.SetMasterVolumeLevelScalar(v.clamp(0, 100) as f32 / 100.0, std::ptr::null()); };
        match cmd {
            Command::Set(v) => set(v as i32),
            Command::Up(step) => { let _ = vol.SetMute(false, std::ptr::null()); set(cur + step as i32) }
            Command::Down(step) => set(cur - step as i32),
            Command::ToggleMute => {
                let m = vol.GetMute().map(|m| m.as_bool()).unwrap_or(false);
                let _ = vol.SetMute(!m, std::ptr::null());
            }
        }
    }
}

pub fn command(cmd: Command) {
    start();
    if let Some(tx) = COMMANDS.lock().unwrap().as_ref() { let _ = tx.send(cmd); }
}

// --- Interception des touches volume ---------------------------------------------------------

static HOOK_ENABLED: AtomicBool = AtomicBool::new(false);
static HOOK_STEP: AtomicU32 = AtomicU32::new(2);
static HOOK_STARTED: Once = Once::new();

thread_local! {
    static HOOK_VOL: RefCell<Option<IAudioEndpointVolume>> = const { RefCell::new(None) };
}

unsafe extern "system" fn keyboard_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 && HOOK_ENABLED.load(Ordering::Relaxed) {
        let k = unsafe { &*(l.0 as *const KBDLLHOOKSTRUCT) };
        if matches!(k.vkCode, 0xAD..=0xAF) {
            let msg = w.0 as u32;
            if msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN {
                let step = HOOK_STEP.load(Ordering::Relaxed);
                let cmd = match k.vkCode { 0xAD => Command::ToggleMute, 0xAE => Command::Down(step), _ => Command::Up(step) };
                HOOK_VOL.with(|slot| {
                    let mut slot = slot.borrow_mut();
                    if slot.is_none() { *slot = endpoint().ok().map(|(_, v)| v); }
                    match slot.as_ref() {
                        Some(vol) => apply(vol, cmd),
                        None => {}
                    }
                });
            }
            return LRESULT(1); // touche consommée : Windows n'affiche pas sa pastille
        }
    }
    unsafe { CallNextHookEx(None, code, w, l) }
}

/// `Some(pas)` : touches volume gérées par Kysland ; `None` : rendues à Windows.
pub fn set_key_hook(step: Option<u32>) {
    HOOK_ENABLED.store(step.is_some(), Ordering::Relaxed);
    if let Some(s) = step { HOOK_STEP.store(s, Ordering::Relaxed); }
    if step.is_none() { return; }
    HOOK_STARTED.call_once(|| {
        std::thread::spawn(|| unsafe {
            com_init();
            let module = GetModuleHandleW(None).ok().map(|m| m.into());
            if SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0).is_err() { return; }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    });
}
