//! Direct Windows calls: AppBar, taskbar, volume flyout, fullscreen, z-order, active window,
//! keys, wallpaper.
#![allow(clippy::missing_safety_doc)]
use std::ffi::c_void;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{keybd_event, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP};
use windows::Win32::UI::Shell::{
    SHAppBarMessage, SHGetFileInfoW, ShellExecuteW, ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS,
    ABM_SETSTATE, APPBARDATA, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::*;

pub fn hwnd(h: isize) -> HWND { HWND(h as *mut c_void) }
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }

fn text_of(h: HWND, class: bool) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { if class { GetClassNameW(h, &mut buf) } else { GetWindowTextW(h, &mut buf) } };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn ex_style(h: HWND) -> isize { unsafe { GetWindowLongPtrW(h, GWL_EXSTYLE) } }

// --- Kysland windows ----------------------------------------------------------------------

/// Non-activating tool window: not in Alt+Tab, never steals focus, ignored by GlazeWM.
pub fn make_tool_window(h: isize) {
    let h = hwnd(h);
    let ex = ex_style(h);
    let ex = (ex | WS_EX_TOOLWINDOW.0 as isize | WS_EX_NOACTIVATE.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
    unsafe { SetWindowLongPtrW(h, GWL_EXSTYLE, ex) };
}

/// Placement in physical pixels, without Windows snapping the window back into the work area.
pub fn place_window(h: isize, rc: (i32, i32, i32, i32), topmost: bool) {
    let after = if topmost { HWND_TOPMOST } else { HWND_NOTOPMOST };
    unsafe { let _ = SetWindowPos(hwnd(h), Some(after), rc.0, rc.1, rc.2, rc.3, SWP_NOACTIVATE | SWP_NOOWNERZORDER); }
}

pub fn window_rect(h: isize) -> Option<RECT> {
    let mut rc = RECT::default();
    unsafe { GetWindowRect(hwnd(h), &mut rc).ok()? };
    Some(rc)
}

pub fn cursor_pos() -> (i32, i32) {
    let mut p = POINT::default();
    unsafe { let _ = GetCursorPos(&mut p); }
    (p.x, p.y)
}

/// A window created while the session starts can keep WS_EX_TOPMOST yet sit below normal
/// windows: walk the z-order down to ours.
pub fn is_buried(ours: isize) -> bool {
    let ours = hwnd(ours);
    unsafe {
        let mut h = GetTopWindow(None).unwrap_or_default();
        for _ in 0..2000 {
            if h.is_invalid() || h == ours { return false; }
            if IsWindowVisible(h).as_bool() && !IsIconic(h).as_bool() && ex_style(h) & WS_EX_TOPMOST.0 as isize == 0 {
                let mut cloaked = 0u32;
                let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
                let mut rc = RECT::default();
                let _ = GetWindowRect(h, &mut rc);
                if cloaked == 0 && rc.right > rc.left && rc.bottom > rc.top { return true; }
            }
            h = GetWindow(h, GW_HWNDNEXT).unwrap_or_default();
        }
    }
    false
}

pub fn raise_topmost(h: isize) {
    let flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    unsafe {
        let _ = SetWindowPos(hwnd(h), Some(HWND_NOTOPMOST), 0, 0, 0, 0, flags);
        let _ = SetWindowPos(hwnd(h), Some(HWND_TOPMOST), 0, 0, 0, 0, flags);
    }
}

pub fn set_foreground(h: isize) -> isize {
    unsafe {
        let prev = GetForegroundWindow();
        let _ = SetForegroundWindow(hwnd(h));
        prev.0 as isize
    }
}

// --- AppBar: reserves a strip of the screen --------------------------------------------------

pub struct AppBar { h: isize, last: Option<(String, RECT)> }

fn abd(h: isize) -> APPBARDATA {
    APPBARDATA { cbSize: std::mem::size_of::<APPBARDATA>() as u32, hWnd: hwnd(h), ..Default::default() }
}

impl AppBar {
    pub fn register(h: isize) -> Self {
        let mut d = abd(h);
        d.uCallbackMessage = WM_USER + 0x57;
        unsafe { SHAppBarMessage(ABM_NEW, &mut d) };
        AppBar { h, last: None }
    }

    /// `monitor` and `thickness` in physical pixels; returns the reserved rect.
    pub fn set_pos(&mut self, bottom: bool, monitor: RECT, thickness: i32) -> RECT {
        let key = format!("{bottom}{monitor:?}{thickness}");
        if let Some((k, rc)) = &self.last { if *k == key { return *rc; } }
        let mut d = abd(self.h);
        d.uEdge = if bottom { 3 } else { 1 }; // ABE_BOTTOM / ABE_TOP
        d.rc = monitor;
        let fit = |d: &mut APPBARDATA| if bottom { d.rc.top = d.rc.bottom - thickness } else { d.rc.bottom = d.rc.top + thickness };
        fit(&mut d);
        unsafe { SHAppBarMessage(ABM_QUERYPOS, &mut d) };
        fit(&mut d);
        unsafe { SHAppBarMessage(ABM_SETPOS, &mut d) };
        self.last = Some((key, d.rc));
        d.rc
    }
}

impl Drop for AppBar {
    fn drop(&mut self) { unsafe { SHAppBarMessage(ABM_REMOVE, &mut abd(self.h)) }; }
}

/// Makes explorer recompute the work areas (orphaned AppBars after a crash).
pub fn reset_work_area() {
    unsafe {
        let mut rc = RECT { left: 0, top: 0, right: GetSystemMetrics(SM_CXSCREEN), bottom: GetSystemMetrics(SM_CYSCREEN) };
        let _ = SystemParametersInfoW(SPI_SETWORKAREA, 0, Some(&mut rc as *mut RECT as *mut c_void), SPIF_SENDCHANGE);
    }
}

// --- Windows taskbar ----------------------------------------------------------------------------

fn taskbars() -> Vec<HWND> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(h) = FindWindowW(windows::core::w!("Shell_TrayWnd"), PCWSTR::null()) { out.push(h); }
        let mut after: Option<HWND> = None;
        while let Ok(h) = FindWindowExW(None, after, windows::core::w!("Shell_SecondaryTrayWnd"), PCWSTR::null()) {
            if h.is_invalid() { break; }
            out.push(h);
            after = Some(h);
        }
    }
    out
}

fn set_taskbar_state(state: u32) {
    if let Some(&h) = taskbars().first() {
        let mut d = abd(h.0 as isize);
        d.lParam = LPARAM(state as isize);
        unsafe { SHAppBarMessage(ABM_SETSTATE, &mut d) };
    }
}

/// Shows the taskbar again (--repair, or a taskbar left hidden by an older version that
/// offered to hide it).
pub fn show_taskbar(state: Option<u32>) {
    set_taskbar_state(state.unwrap_or(0));
    for h in taskbars() { unsafe { let _ = ShowWindow(h, SW_SHOW); } }
}

// --- Windows 11 volume flyout ---------------------------------------------------------------------
// Explorer's untitled, small, non-activating XAML window (Alt+Tab uses the same class but has a
// title and covers the screen). Once minimized, explorer can no longer show it.

fn find_volume_osd() -> Option<HWND> {
    unsafe {
        let mut after: Option<HWND> = None;
        while let Ok(h) = FindWindowExW(None, after, windows::core::w!("XamlExplorerHostIslandWindow"), PCWSTR::null()) {
            if h.is_invalid() { break; }
            after = Some(h);
            if !text_of(h, false).is_empty() || ex_style(h) & WS_EX_NOACTIVATE.0 as isize == 0 { continue; }
            if IsIconic(h).as_bool() { return Some(h); }
            let mut rc = RECT::default();
            let _ = GetWindowRect(h, &mut rc);
            if rc.bottom - rc.top < 200 && rc.right - rc.left < 800 { return Some(h); }
        }
    }
    None
}

pub fn hide_volume_osd() {
    if let Some(h) = find_volume_osd() {
        unsafe { if !IsIconic(h).as_bool() { let _ = ShowWindow(h, SW_SHOWMINNOACTIVE); } }
    }
}

pub fn restore_volume_osd() {
    if let Some(h) = find_volume_osd() {
        unsafe {
            if IsIconic(h).as_bool() {
                let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
                let _ = ShowWindow(h, SW_HIDE);
            }
        }
    }
}

// --- Fullscreen -------------------------------------------------------------------------------------

/// Rect of the foreground window (fullscreen means the rect exactly matches the monitor; a
/// maximized window overflows by ~8 px on each side).
pub fn foreground_rect(ignored: &[isize]) -> Option<RECT> {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() || ignored.contains(&(h.0 as isize)) { return None; }
        let class = text_of(h, true);
        if ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"].contains(&class.as_str()) { return None; }
        let mut rc = RECT::default();
        GetWindowRect(h, &mut rc).ok()?;
        Some(rc)
    }
}

// --- Active window ("window" module) -------------------------------------------------------------

pub struct Foreground { pub hwnd: isize, pub title: String, pub class: String, pub exe: String }

pub fn foreground_window() -> Option<Foreground> {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() { return None; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        Some(Foreground { hwnd: h.0 as isize, title: text_of(h, false), class: text_of(h, true), exe: process_path(pid) })
    }
}

fn process_path(pid: u32) -> String {
    unsafe {
        let Ok(p) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(p);
        if ok { String::from_utf16_lossy(&buf[..len as usize]) } else { String::new() }
    }
}

/// 32 px icon of an executable, as a PNG data URL.
pub fn exe_icon_png(exe: &str) -> Option<String> {
    unsafe {
        let mut info = SHFILEINFOW::default();
        let path = wide(exe);
        let r = SHGetFileInfoW(PCWSTR(path.as_ptr()), Default::default(), Some(&mut info), std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON);
        if r == 0 || info.hIcon.is_invalid() { return None; }
        let icon = info.hIcon;
        let mut ii = ICONINFO::default();
        let result = (|| {
            GetIconInfo(icon, &mut ii).ok()?;
            let (w, hgt) = (32i32, 32i32);
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -hgt, biPlanes: 1,
                biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
            };
            let mut px = vec![0u8; (w * hgt * 4) as usize];
            let dc = GetDC(None);
            let lines = GetDIBits(dc, ii.hbmColor, 0, hgt as u32, Some(px.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            if lines == 0 { return None; }
            for p in px.chunks_mut(4) { p.swap(0, 2); } // BGRA → RGBA
            Some(crate::util::png_data_url(&px, w as u32, hgt as u32))
        })();
        if !ii.hbmColor.is_invalid() { let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0)); }
        if !ii.hbmMask.is_invalid() { let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0)); }
        let _ = DestroyIcon(icon);
        result
    }
}

// --- Screens ---------------------------------------------------------------------------------------

/// Friendly monitor names ("SyncMaster") by GDI device name ("\\.\DISPLAY1").
pub fn monitor_names() -> std::collections::HashMap<String, String> {
    use windows::Win32::Devices::Display::*;
    let mut names = std::collections::HashMap::new();
    let from_wide = |w: &[u16]| String::from_utf16_lossy(&w[..w.iter().position(|&c| c == 0).unwrap_or(w.len())]);
    unsafe {
        let (mut n_paths, mut n_modes) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, &mut n_modes).is_err() { return names; }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_paths as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_modes as usize];
        if QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut n_paths, paths.as_mut_ptr(), &mut n_modes, modes.as_mut_ptr(), None).is_err() { return names; }
        for path in &paths[..n_paths as usize] {
            let mut target = DISPLAYCONFIG_TARGET_DEVICE_NAME::default();
            target.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, size: std::mem::size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32,
                adapterId: path.targetInfo.adapterId, id: path.targetInfo.id,
            };
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
            source.header = DISPLAYCONFIG_DEVICE_INFO_HEADER {
                r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME, size: std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                adapterId: path.sourceInfo.adapterId, id: path.sourceInfo.id,
            };
            if DisplayConfigGetDeviceInfo(&mut target.header) == 0 && DisplayConfigGetDeviceInfo(&mut source.header) == 0 {
                names.insert(from_wide(&source.viewGdiDeviceName), from_wide(&target.monitorFriendlyDeviceName));
            }
        }
    }
    names
}

// --- Screen sampling -------------------------------------------------------------------------------

/// Share of dark pixels (luma <= `max_luma`) in `outer` minus `inner`, read from the composed
/// screen (physical pixels). Used to tell whether the island blends into what's around it.
pub fn dark_ratio(outer: RECT, inner: RECT, max_luma: u32) -> Option<f32> {
    let (w, h) = (outer.right - outer.left, outer.bottom - outer.top);
    if w <= 0 || h <= 0 { return None; }
    let mut px = vec![0u8; (w * h * 4) as usize];
    unsafe {
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, bmp.into());
        let copied = BitBlt(mem, 0, 0, w, h, Some(screen), outer.left, outer.top, SRCCOPY).is_ok();
        SelectObject(mem, old); // GetDIBits needs the bitmap out of the DC
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32, biWidth: w, biHeight: -h, biPlanes: 1,
            biBitCount: 32, biCompression: BI_RGB.0, ..Default::default()
        };
        let lines = if copied { GetDIBits(mem, bmp, 0, h as u32, Some(px.as_mut_ptr() as *mut c_void), &mut bmi, DIB_RGB_COLORS) } else { 0 };
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        if lines != h { return None; }
    }
    let (mut dark, mut total) = (0u32, 0u32);
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = (outer.left + x, outer.top + y);
            if sx >= inner.left && sx < inner.right && sy >= inner.top && sy < inner.bottom { continue; }
            let i = ((y * w + x) * 4) as usize;
            let (b, g, r) = (px[i] as u32, px[i + 1] as u32, px[i + 2] as u32);
            total += 1;
            if (r * 54 + g * 183 + b * 19) >> 8 <= max_luma { dark += 1; } // Rec. 709 luma
        }
    }
    (total > 0).then(|| dark as f32 / total as f32)
}

// --- Keys, misc ------------------------------------------------------------------------------------

pub const VK_LWIN: u8 = 0x5B;
pub const VK_MEDIA_NEXT: u8 = 0xB0;
pub const VK_MEDIA_PREV: u8 = 0xB1;
pub const VK_MEDIA_PLAY_PAUSE: u8 = 0xB3;

/// Key combination: press in order, release in reverse order.
pub fn press_keys(vks: &[u8]) {
    unsafe {
        for &vk in vks { keybd_event(vk, 0, KEYBD_EVENT_FLAGS(0), 0); }
        for &vk in vks.iter().rev() { keybd_event(vk, 0, KEYEVENTF_KEYUP, 0); }
    }
}

pub fn lock_workstation() {
    unsafe { let _ = windows::Win32::System::Shutdown::LockWorkStation(); }
}

pub fn set_wallpaper(file: &str) {
    let path = wide(file);
    unsafe {
        let _ = SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, Some(path.as_ptr() as *mut c_void), SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
    }
}

/// Opens a link, file or folder with its associated app (no shell involved).
pub fn shell_open(target: &str) {
    let t = wide(target);
    unsafe { ShellExecuteW(None, windows::core::w!("open"), PCWSTR(t.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL); }
}
