use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TargetWindow {
    pub hwnd: u64,
    pub pid: u32,
    pub process_name: String,
    pub title: String,
    pub class_name: String,
    pub visible: bool,
    pub minimized: bool,
    pub client_width: i32,
    pub client_height: i32,
    pub dpi: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetCapabilities {
    pub hwnd: u64,
    pub process_name: String,
    pub title: String,
    pub backend: String,
    pub background_mouse: bool,
    pub background_keyboard: bool,
    pub confirmed_effects: bool,
    pub reason: String,
}

#[cfg(windows)]
mod win {
    use super::{TargetCapabilities, TargetWindow};
    use crate::macro_engine::TargetSelector;
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
    use windows_sys::Win32::System::SystemServices::{MK_LBUTTON, MK_MBUTTON, MK_RBUTTON};
    use windows_sys::Win32::System::Threading::OpenProcess;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetClientRect, GetWindowTextW, GetWindowThreadProcessId,
        IsIconic, IsWindow, IsWindowVisible, PostMessageW, WM_LBUTTONDOWN, WM_LBUTTONUP,
        WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn QueryFullProcessImageNameW(
            process: *mut c_void,
            flags: u32,
            image_name: *mut u16,
            size: *mut u32,
        ) -> i32;
    }

    fn exe_name(pid: u32) -> Option<String> {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut path = [0u16; 1024];
            let mut length = path.len() as u32;
            let result = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length);
            CloseHandle(process);
            if result == 0 || length == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&path[..length as usize]);
            Some(path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string())
        }
    }

    unsafe fn read_text(hwnd: HWND, class_name: bool) -> String {
        let mut buffer = [0u16; 1024];
        let length = if class_name {
            GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32)
        } else {
            GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32)
        };
        if length <= 0 {
            String::new()
        } else {
            String::from_utf16_lossy(&buffer[..length as usize])
        }
    }

    unsafe fn describe(hwnd: HWND) -> Option<TargetWindow> {
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 {
            return None;
        }
        let process_name = exe_name(pid)?;
        let mut rect: RECT = std::mem::zeroed();
        let _ = GetClientRect(hwnd, &mut rect);
        Some(TargetWindow {
            hwnd: hwnd as usize as u64,
            pid,
            process_name,
            title: read_text(hwnd, false),
            class_name: read_text(hwnd, true),
            visible: IsWindowVisible(hwnd) != 0,
            minimized: IsIconic(hwnd) != 0,
            client_width: rect.right.saturating_sub(rect.left),
            client_height: rect.bottom.saturating_sub(rect.top),
            dpi: GetDpiForWindow(hwnd),
        })
    }

    unsafe extern "system" fn collect_window(hwnd: HWND, data: LPARAM) -> i32 {
        let windows = &mut *(data as *mut Vec<TargetWindow>);
        if let Some(window) = describe(hwnd) {
            if window.visible && !window.title.trim().is_empty() {
                windows.push(window);
            }
        }
        1
    }

    pub fn list() -> Vec<TargetWindow> {
        let mut result: Vec<TargetWindow> = Vec::new();
        unsafe {
            EnumWindows(Some(collect_window), &mut result as *mut _ as LPARAM);
        }
        result.sort_by(|a, b| {
            a.process_name
                .to_lowercase()
                .cmp(&b.process_name.to_lowercase())
                .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
                .then_with(|| a.pid.cmp(&b.pid))
        });
        result
    }

    fn matches(window: &TargetWindow, selector: &TargetSelector) -> bool {
        selector.process.as_ref().is_none_or(|process| {
            window.process_name.eq_ignore_ascii_case(process)
                || window
                    .process_name
                    .eq_ignore_ascii_case(&format!("{process}.exe"))
        }) && selector
            .title_contains
            .as_ref()
            .is_none_or(|title| window.title.to_lowercase().contains(&title.to_lowercase()))
            && selector
                .class_name
                .as_ref()
                .is_none_or(|class| window.class_name.eq_ignore_ascii_case(class))
    }

    pub fn resolve(
        selector: &TargetSelector,
        selected_hwnd: Option<u64>,
    ) -> Result<TargetWindow, String> {
        let windows = list();
        let mut matches = windows
            .into_iter()
            .filter(|window| matches(window, selector))
            .collect::<Vec<_>>();
        if let Some(hwnd) = selected_hwnd {
            matches.retain(|window| window.hwnd == hwnd);
        }
        match matches.len() {
            0 => Err("No visible target window matches the selected process/title/class.".into()),
            1 => Ok(matches.remove(0)),
            count => Err(format!(
                "{count} target windows match. Select a specific window in the picker."
            )),
        }
    }

    pub fn resolve_selected(hwnd: u64) -> Result<TargetWindow, String> {
        let hwnd = hwnd as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("The selected target window has closed. Pick it again.".into());
        }
        unsafe { describe(hwnd) }.ok_or_else(|| {
            "The selected target process could not be inspected at this integrity level.".into()
        })
    }

    pub fn capabilities(window: &TargetWindow) -> TargetCapabilities {
        TargetCapabilities {
            hwnd: window.hwnd,
            process_name: window.process_name.clone(),
            title: window.title.clone(),
            backend: "Background Win32 messages".into(),
            background_mouse: !window.minimized,
            background_keyboard: false,
            confirmed_effects: false,
            reason: if window.minimized {
                "The window is minimized. Background messages are not offered for minimized windows.".into()
            } else {
                "Mouse move/click messages can be queued to this window. Windows cannot confirm that the application acted on them; keyboard, text, drag, UI Automation, elevated, and game-rendered input are unsupported.".into()
            },
        }
    }

    fn valid(hwnd: u64, expected_pid: u32) -> Result<HWND, String> {
        let hwnd = hwnd as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("Target window was destroyed during the macro.".into());
        }
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid != expected_pid {
            return Err("Target window identity changed; refusing to send input.".into());
        }
        if unsafe { IsIconic(hwnd) } != 0 {
            return Err("Target window is minimized; background input is unsupported.".into());
        }
        Ok(hwnd)
    }

    fn client_point(hwnd: HWND, x: i32, y: i32, screen_space: bool) -> Result<(i32, i32), String> {
        let mut point = POINT { x, y };
        unsafe {
            let ok = if screen_space {
                ScreenToClient(hwnd, &mut point)
            } else {
                1
            };
            if ok == 0 {
                return Err(
                    "Could not convert screen coordinates to target client coordinates.".into(),
                );
            }
        }
        if point.x < i16::MIN as i32
            || point.x > i16::MAX as i32
            || point.y < i16::MIN as i32
            || point.y > i16::MAX as i32
        {
            return Err("Target client coordinates exceed the Win32 mouse-message range.".into());
        }
        Ok((point.x, point.y))
    }

    fn pack_point(x: i32, y: i32) -> LPARAM {
        (((y as u16 as u32) << 16) | x as u16 as u32) as LPARAM
    }

    pub fn post_move(
        window: &TargetWindow,
        x: i32,
        y: i32,
        screen_space: bool,
    ) -> Result<(), String> {
        let hwnd = valid(window.hwnd, window.pid)?;
        let (x, y) = client_point(hwnd, x, y, screen_space)?;
        let ok = unsafe { PostMessageW(hwnd, WM_MOUSEMOVE, 0, pack_point(x, y)) };
        if ok == 0 {
            return Err("Windows rejected the target mouse-move message.".into());
        }
        Ok(())
    }

    pub fn post_click(
        window: &TargetWindow,
        x: i32,
        y: i32,
        screen_space: bool,
        button: &str,
        count: u32,
    ) -> Result<(), String> {
        let hwnd = valid(window.hwnd, window.pid)?;
        let (x, y) = client_point(hwnd, x, y, screen_space)?;
        let (down, up, held) = match button {
            "left" => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
            "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
            "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
            _ => return Err("Unsupported mouse button.".into()),
        };
        for _ in 0..count {
            let moved = unsafe { PostMessageW(hwnd, WM_MOUSEMOVE, 0, pack_point(x, y)) };
            let pressed = unsafe { PostMessageW(hwnd, down, held as usize, pack_point(x, y)) };
            let released = unsafe { PostMessageW(hwnd, up, 0, pack_point(x, y)) };
            if moved == 0 || pressed == 0 || released == 0 {
                return Err("Windows rejected one or more target mouse messages.".into());
            }
        }
        Ok(())
    }

    pub fn to_screen(hwnd_value: u64, x: i32, y: i32) -> Result<(i32, i32), String> {
        let hwnd = hwnd_value as usize as HWND;
        if unsafe { IsWindow(hwnd) } == 0 {
            return Err("Target window is no longer available.".into());
        }
        let mut point = POINT { x, y };
        if unsafe { ClientToScreen(hwnd, &mut point) } == 0 {
            return Err("Could not convert target client coordinates.".into());
        }
        Ok((point.x, point.y))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
        use windows_sys::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, RECT, WPARAM};
        use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows_sys::Win32::System::Threading::GetCurrentProcessId;
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            ClipCursor, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
            GetClipCursor, GetCursorPos, GetForegroundWindow, PeekMessageW, RegisterClassW,
            UnregisterClassW, MSG, PM_REMOVE, WM_LBUTTONDOWN, WNDCLASSW, WS_OVERLAPPEDWINDOW,
        };

        static RECEIVED_CLICKS: AtomicUsize = AtomicUsize::new(0);

        struct CursorClipGuard(RECT);

        impl Drop for CursorClipGuard {
            fn drop(&mut self) {
                unsafe {
                    ClipCursor(&self.0);
                }
            }
        }

        unsafe extern "system" fn count_background_clicks(
            hwnd: HWND,
            message: u32,
            w_param: WPARAM,
            l_param: LPARAM,
        ) -> LRESULT {
            if message == WM_LBUTTONDOWN {
                RECEIVED_CLICKS.fetch_add(1, Ordering::SeqCst);
            }
            DefWindowProcW(hwnd, message, w_param, l_param)
        }

        #[test]
        fn compatible_non_foreground_window_receives_click_without_cursor_or_focus_change() {
            unsafe {
                let unique = format!(
                    "BlurMacroBackgroundTest_{}_{}",
                    GetCurrentProcessId(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                );
                let class_name: Vec<u16> = unique.encode_utf16().chain(Some(0)).collect();
                let title: Vec<u16> = "Blur Macro background target test"
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let instance: HINSTANCE = GetModuleHandleW(std::ptr::null());
                let mut window_class: WNDCLASSW = std::mem::zeroed();
                window_class.lpfnWndProc = Some(count_background_clicks);
                window_class.hInstance = instance;
                window_class.lpszClassName = class_name.as_ptr();
                assert_ne!(RegisterClassW(&window_class), 0);
                let hwnd = CreateWindowExW(
                    0,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPEDWINDOW,
                    0,
                    0,
                    200,
                    100,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                assert!(!hwnd.is_null());
                RECEIVED_CLICKS.store(0, Ordering::SeqCst);

                let foreground_before = GetForegroundWindow();
                let mut cursor_before = POINT { x: 0, y: 0 };
                assert_ne!(GetCursorPos(&mut cursor_before), 0);
                let mut original_clip = RECT {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                };
                assert_ne!(GetClipCursor(&mut original_clip), 0);
                let pinned_clip = RECT {
                    left: cursor_before.x,
                    top: cursor_before.y,
                    right: cursor_before.x.saturating_add(1),
                    bottom: cursor_before.y.saturating_add(1),
                };
                assert_ne!(ClipCursor(&pinned_clip), 0);
                let cursor_clip_guard = CursorClipGuard(original_clip);
                let target = TargetWindow {
                    hwnd: hwnd as usize as u64,
                    pid: GetCurrentProcessId(),
                    process_name: "background-test.exe".into(),
                    title: "Blur Macro background target test".into(),
                    class_name: unique,
                    visible: false,
                    minimized: false,
                    client_width: 200,
                    client_height: 100,
                    dpi: 96,
                };
                let dispatched = post_click(&target, 20, 30, false, "left", 1);
                let deadline = Instant::now() + Duration::from_secs(1);
                while RECEIVED_CLICKS.load(Ordering::SeqCst) < 1 && Instant::now() < deadline {
                    let mut message: MSG = std::mem::zeroed();
                    while PeekMessageW(&mut message, hwnd, 0, 0, PM_REMOVE) != 0 {
                        DispatchMessageW(&message);
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
                let click_count = RECEIVED_CLICKS.load(Ordering::SeqCst);
                let foreground_after = GetForegroundWindow();
                let mut cursor_after = POINT { x: 0, y: 0 };
                let cursor_read = GetCursorPos(&mut cursor_after);
                drop(cursor_clip_guard);
                DestroyWindow(hwnd);
                UnregisterClassW(class_name.as_ptr(), instance);

                assert!(dispatched.is_ok());
                assert_eq!(click_count, 1, "target WndProc observed the click");
                assert_eq!(foreground_after, foreground_before);
                assert_ne!(cursor_read, 0);
                assert_eq!(cursor_after.x, cursor_before.x);
                assert_eq!(cursor_after.y, cursor_before.y);
            }
        }
    }
}

#[cfg(windows)]
pub fn list_target_windows() -> Vec<TargetWindow> {
    win::list()
}

#[cfg(not(windows))]
pub fn list_target_windows() -> Vec<TargetWindow> {
    Vec::new()
}

#[cfg(windows)]
pub fn resolve_target(
    selector: &crate::macro_engine::TargetSelector,
    selected_hwnd: Option<u64>,
) -> Result<TargetWindow, String> {
    win::resolve(selector, selected_hwnd)
}

#[cfg(not(windows))]
pub fn resolve_target(
    _selector: &crate::macro_engine::TargetSelector,
    _selected_hwnd: Option<u64>,
) -> Result<TargetWindow, String> {
    Err("Target window automation is only supported on Windows.".into())
}

#[cfg(windows)]
pub fn resolve_selected_target(hwnd: u64) -> Result<TargetWindow, String> {
    win::resolve_selected(hwnd)
}

#[cfg(not(windows))]
pub fn resolve_selected_target(_hwnd: u64) -> Result<TargetWindow, String> {
    Err("Target window automation is only supported on Windows.".into())
}

#[cfg(windows)]
pub fn target_capabilities(window: &TargetWindow) -> TargetCapabilities {
    win::capabilities(window)
}

#[cfg(not(windows))]
pub fn target_capabilities(window: &TargetWindow) -> TargetCapabilities {
    TargetCapabilities {
        hwnd: window.hwnd,
        process_name: window.process_name.clone(),
        title: window.title.clone(),
        backend: "Unsupported".into(),
        background_mouse: false,
        background_keyboard: false,
        confirmed_effects: false,
        reason: "Background window input is only supported on Windows.".into(),
    }
}

#[cfg(windows)]
pub fn background_move(window: &TargetWindow, x: i32, y: i32, space: &str) -> Result<(), String> {
    win::post_move(window, x, y, space == "screen")
}

#[cfg(not(windows))]
pub fn background_move(
    _window: &TargetWindow,
    _x: i32,
    _y: i32,
    _space: &str,
) -> Result<(), String> {
    Err("Background window input is only supported on Windows.".into())
}

#[cfg(windows)]
pub fn background_click(
    window: &TargetWindow,
    x: i32,
    y: i32,
    space: &str,
    button: &str,
    count: u32,
) -> Result<(), String> {
    win::post_click(window, x, y, space == "screen", button, count)
}

#[cfg(not(windows))]
pub fn background_click(
    _window: &TargetWindow,
    _x: i32,
    _y: i32,
    _space: &str,
    _button: &str,
    _count: u32,
) -> Result<(), String> {
    Err("Background window input is only supported on Windows.".into())
}

#[cfg(windows)]
pub fn client_to_screen(hwnd: u64, x: i32, y: i32) -> Result<(i32, i32), String> {
    win::to_screen(hwnd, x, y)
}

#[cfg(not(windows))]
pub fn client_to_screen(_hwnd: u64, x: i32, y: i32) -> Result<(i32, i32), String> {
    Err("Client coordinate conversion is only supported on Windows.".into())
}
