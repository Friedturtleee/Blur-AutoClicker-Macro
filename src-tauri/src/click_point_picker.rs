use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetAncestor, GetWindowThreadProcessId, PostThreadMessageW, WindowFromPoint,
    GA_ROOT, HHOOK, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, WM_KEYDOWN, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WM_QUIT, WM_RBUTTONDBLCLK, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_SYSKEYDOWN,
};

use crate::engine::mouse::{current_virtual_screen_rect, VirtualScreenRect};
use crate::error::poisoned_inner;
use crate::error::AppError;
use crate::error::AppResult;
use crate::ClickerState;

const CURSOR_EMIT_INTERVAL: Duration = Duration::from_millis(16);
const MACRO_DRAG_THRESHOLD_SQUARED: i64 = 16;
const MAX_MACRO_DRAG_POINTS: usize = 5_000;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClickPointPickedPayload {
    x: i32,
    y: i32,
    continue_picking: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClickPointDeleteRequestedPayload {
    x: i32,
    y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacroMouseButton {
    Left,
    Right,
}

impl MacroMouseButton {
    fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MacroGesturePoint {
    x: i32,
    y: i32,
    elapsed_ms: u64,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MacroGesturePickedPayload {
    kind: &'static str,
    button: &'static str,
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    points: Vec<MacroGesturePoint>,
}

struct MacroGestureCapture {
    button: MacroMouseButton,
    start_x: i32,
    start_y: i32,
    started_at: Instant,
    last_sample_at: Instant,
    max_distance_squared: i64,
    furthest_point: MacroGesturePoint,
    points: Vec<MacroGesturePoint>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MouseHookDecision {
    Pass,
    Swallow,
    Pick { continue_picking: bool },
    Delete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyboardHookDecision {
    Pass,
    Cancel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum PickerPurpose {
    #[default]
    ClickPoints,
    MacroCoordinate,
}

#[derive(Default)]
struct PickerRuntime {
    active: bool,
    generation: u64,
    mouse_hook: HHOOK,
    keyboard_hook: HHOOK,
    thread_id: u32,
    app: Option<AppHandle>,
    purpose: PickerPurpose,
    last_cursor_emit: Option<Instant>,
    stop_after_right_up: bool,
    macro_gesture: Option<MacroGestureCapture>,
    passthrough_button: Option<MacroMouseButton>,
}

unsafe impl Send for PickerRuntime {}
unsafe impl Sync for PickerRuntime {}

static PICKER: OnceLock<Mutex<PickerRuntime>> = OnceLock::new();

fn picker() -> &'static Mutex<PickerRuntime> {
    PICKER.get_or_init(|| Mutex::new(PickerRuntime::default()))
}

fn classify_mouse_message(message: u32, shift_down: bool, ctrl_down: bool) -> MouseHookDecision {
    match message {
        WM_RBUTTONDOWN if ctrl_down => MouseHookDecision::Delete,
        WM_RBUTTONDOWN => MouseHookDecision::Pick {
            continue_picking: shift_down,
        },
        WM_RBUTTONUP | WM_RBUTTONDBLCLK => MouseHookDecision::Swallow,
        _ => MouseHookDecision::Pass,
    }
}

fn classify_keyboard_message(message: u32, virtual_key: u32) -> KeyboardHookDecision {
    match (message, virtual_key) {
        (WM_KEYDOWN | WM_SYSKEYDOWN, key) if key == VK_ESCAPE as u32 => {
            KeyboardHookDecision::Cancel
        }
        _ => KeyboardHookDecision::Pass,
    }
}

pub fn start_click_point_pick_inner(app: AppHandle) -> AppResult<()> {
    start_coordinate_picker(app, PickerPurpose::ClickPoints)
}

pub fn start_macro_coordinate_pick_inner(app: AppHandle) -> AppResult<()> {
    start_coordinate_picker(app, PickerPurpose::MacroCoordinate)
}

fn start_coordinate_picker(app: AppHandle, purpose: PickerPurpose) -> AppResult<()> {
    crate::custom_stop_zone_picker::cancel_custom_stop_zone_pick_inner(&app);

    let generation = {
        let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if runtime.active {
            if runtime.purpose != purpose {
                return Err(AppError::State(
                    "Another coordinate picker is already active.".into(),
                ));
            }
            match runtime.purpose {
                PickerPurpose::ClickPoints => crate::overlay::show_click_point_pick_overlay(&app)?,
                PickerPurpose::MacroCoordinate => {
                    crate::overlay::show_macro_coordinate_pick_overlay(&app)?
                }
            }
            return Ok(());
        }
        if !runtime.mouse_hook.is_null()
            || !runtime.keyboard_hook.is_null()
            || runtime.thread_id != 0
        {
            return Err(AppError::State(
                "The coordinate picker is still stopping. Try again in a moment.".into(),
            ));
        }

        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.active = true;
        runtime.app = Some(app.clone());
        runtime.purpose = purpose;
        runtime.last_cursor_emit = None;
        runtime.stop_after_right_up = false;
        runtime.macro_gesture = None;
        runtime.passthrough_button = None;
        runtime.generation
    };

    app.state::<ClickerState>()
        .click_point_pick_active
        .store(true, std::sync::atomic::Ordering::SeqCst);

    let overlay_result = match purpose {
        PickerPurpose::ClickPoints => crate::overlay::show_click_point_pick_overlay(&app),
        PickerPurpose::MacroCoordinate => crate::overlay::show_macro_coordinate_pick_overlay(&app),
    };
    if let Err(error) = overlay_result {
        stop_click_point_pick(Some(app.clone()), true);
        return Err(error);
    }

    let hook_result = crate::picker_hook_thread::start_low_level_picker_hooks(
        "blur-coordinate-picker",
        "Coordinate picker",
        Some(mouse_hook_proc),
        Some(keyboard_hook_proc),
        move |thread_id| {
            let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
            if runtime.generation != generation || !runtime.active {
                return false;
            }
            runtime.thread_id = thread_id;
            true
        },
        move |thread_id, mouse_hook, keyboard_hook| {
            let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
            if runtime.generation != generation || !runtime.active {
                return false;
            }
            runtime.mouse_hook = mouse_hook;
            runtime.keyboard_hook = keyboard_hook;
            runtime.thread_id = thread_id;
            true
        },
        move |thread_id, mouse_hook, keyboard_hook| {
            let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
            if runtime.mouse_hook == mouse_hook {
                runtime.mouse_hook = std::ptr::null_mut();
            }
            if runtime.keyboard_hook == keyboard_hook {
                runtime.keyboard_hook = std::ptr::null_mut();
            }
            if runtime.thread_id == thread_id
                && runtime.mouse_hook.is_null()
                && runtime.keyboard_hook.is_null()
            {
                runtime.thread_id = 0;
            }
        },
    );
    if let Err(error) = hook_result {
        cancel_click_point_pick_inner(&app);
        return Err(error);
    }
    Ok(())
}

fn cancel_click_point_pick_from_hook() {
    let app = stop_click_point_pick(None, true);
    if let Some(app) = app {
        let _ = crate::overlay::hide_overlay(app);
    }
}

pub fn cancel_click_point_pick_inner(app: &AppHandle) {
    stop_click_point_pick(Some(app.clone()), true);
    let _ = crate::overlay::hide_overlay(app.clone());
}

fn stop_click_point_pick(
    app_override: Option<AppHandle>,
    notify_overlay: bool,
) -> Option<AppHandle> {
    let (app, thread_id) = {
        let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
        let app = app_override.or_else(|| runtime.app.clone());
        let thread_id = runtime.thread_id;
        runtime.active = false;
        runtime.generation = runtime.generation.wrapping_add(1);
        runtime.app = None;
        runtime.last_cursor_emit = None;
        runtime.stop_after_right_up = false;
        runtime.macro_gesture = None;
        runtime.passthrough_button = None;
        (app, thread_id)
    };

    if let Some(app) = &app {
        app.state::<ClickerState>()
            .click_point_pick_active
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = app.emit("click-pick-ended", ());
        if notify_overlay {
            let _ = crate::overlay::set_click_point_pick_mode(app, false);
        }
    }

    if thread_id != 0 {
        unsafe {
            PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
        }
    }

    app
}

fn is_cursor_over_own_window(x: i32, y: i32) -> bool {
    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.is_null() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        let root = if root.is_null() { hwnd } else { root };
        let mut pid = 0;
        GetWindowThreadProcessId(root, &mut pid);
        pid == GetCurrentProcessId()
    }
}

// Returns true when the picker owns and should swallow this button press.
fn begin_macro_gesture(button: MacroMouseButton, x: i32, y: i32) -> bool {
    let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
    if !runtime.active || runtime.purpose != PickerPurpose::MacroCoordinate {
        return false;
    }
    if runtime.macro_gesture.is_some() {
        return true;
    }
    if is_cursor_over_own_window(x, y) {
        runtime.passthrough_button = Some(button);
        return false;
    }

    let now = Instant::now();
    runtime.macro_gesture = Some(MacroGestureCapture {
        button,
        start_x: x,
        start_y: y,
        started_at: now,
        last_sample_at: now,
        max_distance_squared: 0,
        furthest_point: MacroGesturePoint {
            x,
            y,
            elapsed_ms: 0,
        },
        points: Vec::with_capacity(64),
    });
    true
}

fn record_macro_gesture_position(runtime: &mut PickerRuntime, x: i32, y: i32, now: Instant) {
    if !runtime.active || runtime.purpose != PickerPurpose::MacroCoordinate {
        return;
    }
    let Some(capture) = runtime.macro_gesture.as_mut() else {
        return;
    };

    let elapsed_ms = now.duration_since(capture.started_at).as_millis() as u64;
    let dx = i64::from(x) - i64::from(capture.start_x);
    let dy = i64::from(y) - i64::from(capture.start_y);
    let distance_squared = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
    if distance_squared > capture.max_distance_squared {
        capture.max_distance_squared = distance_squared;
        capture.furthest_point = MacroGesturePoint { x, y, elapsed_ms };
    }

    let last_point = capture
        .points
        .last()
        .map(|point| (point.x, point.y))
        .unwrap_or((capture.start_x, capture.start_y));
    if capture.points.len() < MAX_MACRO_DRAG_POINTS
        && (x, y) != last_point
        && now.duration_since(capture.last_sample_at) >= CURSOR_EMIT_INTERVAL
    {
        capture.points.push(MacroGesturePoint { x, y, elapsed_ms });
        capture.last_sample_at = now;
    }
}

// Returns true when the matching release was captured by the picker.
fn finish_macro_gesture(button: MacroMouseButton, x: i32, y: i32) -> bool {
    let (app, payload) = {
        let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if runtime.passthrough_button == Some(button) {
            runtime.passthrough_button = None;
            return false;
        }
        record_macro_gesture_position(&mut runtime, x, y, Instant::now());
        let Some(capture) = runtime.macro_gesture.as_ref() else {
            return false;
        };
        if capture.button != button {
            return true;
        }
        let mut capture = runtime.macro_gesture.take().expect("gesture was checked");
        let is_drag = capture.max_distance_squared >= MACRO_DRAG_THRESHOLD_SQUARED;
        let mut points = if is_drag {
            if (capture.furthest_point.x, capture.furthest_point.y)
                != (capture.start_x, capture.start_y)
                && !capture.points.iter().any(|point| {
                    (point.x, point.y) == (capture.furthest_point.x, capture.furthest_point.y)
                })
            {
                capture.points.push(capture.furthest_point);
            }
            capture.points.sort_by_key(|point| point.elapsed_ms);
            let elapsed_ms = capture.started_at.elapsed().as_millis() as u64;
            if capture
                .points
                .last()
                .is_none_or(|point| (point.x, point.y) != (x, y))
            {
                capture.points.push(MacroGesturePoint { x, y, elapsed_ms });
            }
            capture
                .points
                .dedup_by(|next, previous| (next.x, next.y) == (previous.x, previous.y));
            capture.points
        } else {
            Vec::new()
        };
        // Keep the payload bounded even if an unusually long drag produced many hook events.
        points.truncate(MAX_MACRO_DRAG_POINTS + 2);
        let payload = MacroGesturePickedPayload {
            kind: if is_drag { "drag" } else { "click" },
            button: button.name(),
            start_x: capture.start_x,
            start_y: capture.start_y,
            end_x: x,
            end_y: y,
            points,
        };
        (runtime.app.clone(), payload)
    };

    if let Some(app) = app {
        let _ = app.emit("macro-gesture-picked", payload);
    }
    true
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }
    let message = wparam as u32;
    let mouse = &*(lparam as *const MSLLHOOKSTRUCT);

    if message == WM_MOUSEMOVE {
        emit_cursor_position(mouse.pt.x, mouse.pt.y);
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }

    let purpose = {
        let runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if !runtime.active {
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }
        runtime.purpose
    };

    if purpose == PickerPurpose::MacroCoordinate {
        let button_down = match message {
            WM_LBUTTONDOWN | WM_LBUTTONDBLCLK => Some(MacroMouseButton::Left),
            WM_RBUTTONDOWN | WM_RBUTTONDBLCLK => Some(MacroMouseButton::Right),
            _ => None,
        };
        if let Some(button) = button_down {
            if begin_macro_gesture(button, mouse.pt.x, mouse.pt.y) {
                return 1;
            }
            return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
        }

        let button_up = match message {
            WM_LBUTTONUP => Some(MacroMouseButton::Left),
            WM_RBUTTONUP => Some(MacroMouseButton::Right),
            _ => None,
        };
        if let Some(button) = button_up {
            if finish_macro_gesture(button, mouse.pt.x, mouse.pt.y) {
                return 1;
            }
        }
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }

    let shift_down = (GetAsyncKeyState(VK_SHIFT as i32) & 0x8000u16 as i16) != 0;
    let ctrl_down = (GetAsyncKeyState(VK_CONTROL as i32) & 0x8000u16 as i16) != 0;

    let decision = classify_mouse_message(message, shift_down, ctrl_down);

    match decision {
        MouseHookDecision::Pass => CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam),
        MouseHookDecision::Swallow => {
            if message == WM_RBUTTONUP {
                let should_stop = {
                    let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
                    let should_stop = runtime.stop_after_right_up;
                    runtime.stop_after_right_up = false;
                    should_stop
                };
                if should_stop {
                    stop_click_point_pick(None, true);
                }
            }
            1
        }
        MouseHookDecision::Delete => {
            emit_delete_request(mouse.pt.x, mouse.pt.y);
            1
        }
        MouseHookDecision::Pick { continue_picking } => {
            emit_pick(mouse.pt.x, mouse.pt.y, continue_picking);
            if !continue_picking {
                let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
                runtime.stop_after_right_up = true;
            }
            1
        }
    }
}
unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code < 0 {
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }
    if !picker().lock().unwrap_or_else(poisoned_inner).active {
        return CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam);
    }

    let message = wparam as u32;
    let keyboard = &*(lparam as *const KBDLLHOOKSTRUCT);

    match classify_keyboard_message(message, keyboard.vkCode) {
        KeyboardHookDecision::Pass => CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam),
        KeyboardHookDecision::Cancel => {
            cancel_click_point_pick_from_hook();
            1
        }
    }
}

fn emit_cursor_position(x: i32, y: i32) {
    let app = {
        let mut runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if !runtime.active {
            return;
        }

        let now = Instant::now();
        record_macro_gesture_position(&mut runtime, x, y, now);
        if runtime
            .last_cursor_emit
            .is_some_and(|last| now.duration_since(last) < CURSOR_EMIT_INTERVAL)
        {
            return;
        }
        runtime.last_cursor_emit = Some(now);
        runtime.app.clone()
    };

    if let Some(app) = app {
        let (overlay_x, overlay_y) = current_virtual_screen_rect()
            .map(|bounds| {
                let offset = VirtualScreenRect::new(x, y, 1, 1).offset_from(bounds);
                (offset.left, offset.top)
            })
            .unwrap_or((x, y));

        let _ = app.emit(
            "click-pick-cursor",
            serde_json::json!({
                "x": overlay_x,
                "y": overlay_y,
            }),
        );
    }
}

fn emit_pick(x: i32, y: i32, continue_picking: bool) {
    let app = {
        let runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if !runtime.active {
            return;
        }
        runtime.app.clone()
    };

    if let Some(app) = app {
        let _ = app.emit(
            "click-point-picked",
            ClickPointPickedPayload {
                x,
                y,
                continue_picking,
            },
        );
    }
}

fn emit_delete_request(x: i32, y: i32) {
    let app = {
        let runtime = picker().lock().unwrap_or_else(poisoned_inner);
        if !runtime.active {
            return;
        }
        runtime.app.clone()
    };

    if let Some(app) = app {
        let _ = app.emit(
            "click-point-delete-requested",
            ClickPointDeleteRequestedPayload { x, y },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        classify_keyboard_message, classify_mouse_message, KeyboardHookDecision, MouseHookDecision,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{VK_ESCAPE, VK_SPACE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    };

    #[test]
    fn right_button_down_picks_and_exits_without_shift() {
        assert_eq!(
            classify_mouse_message(WM_RBUTTONDOWN, false, false),
            MouseHookDecision::Pick {
                continue_picking: false
            }
        );
    }

    #[test]
    fn shift_right_button_down_keeps_pick_mode_active() {
        assert_eq!(
            classify_mouse_message(WM_RBUTTONDOWN, true, false),
            MouseHookDecision::Pick {
                continue_picking: true
            }
        );
    }

    #[test]
    fn right_button_up_is_swallowed() {
        assert_eq!(
            classify_mouse_message(WM_RBUTTONUP, false, false),
            MouseHookDecision::Swallow
        );
    }

    #[test]
    fn non_right_clicks_pass_through() {
        assert_eq!(
            classify_mouse_message(WM_LBUTTONDOWN, false, false),
            MouseHookDecision::Pass
        );
    }

    #[test]
    fn ctrl_right_button_down_deletes_point() {
        assert_eq!(
            classify_mouse_message(WM_RBUTTONDOWN, false, true),
            MouseHookDecision::Delete
        );
    }

    #[test]
    fn ctrl_wins_over_shift_for_right_button_down() {
        assert_eq!(
            classify_mouse_message(WM_RBUTTONDOWN, true, true),
            MouseHookDecision::Delete
        );
    }

    #[test]
    fn escape_key_down_cancels_picker() {
        assert_eq!(
            classify_keyboard_message(WM_KEYDOWN, VK_ESCAPE as u32),
            KeyboardHookDecision::Cancel
        );
    }

    #[test]
    fn escape_sys_key_down_cancels_picker() {
        assert_eq!(
            classify_keyboard_message(WM_SYSKEYDOWN, VK_ESCAPE as u32),
            KeyboardHookDecision::Cancel
        );
    }

    #[test]
    fn escape_key_up_passes_through() {
        assert_eq!(
            classify_keyboard_message(WM_KEYUP, VK_ESCAPE as u32),
            KeyboardHookDecision::Pass
        );
    }

    #[test]
    fn other_keys_pass_through() {
        assert_eq!(
            classify_keyboard_message(WM_KEYDOWN, VK_SPACE as u32),
            KeyboardHookDecision::Pass
        );
    }
}
