use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;

const EVENT_BUFFER: usize = 4096;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecordedKind {
    Move { x: i32, y: i32 },
    MouseDown { button: String },
    MouseUp { button: String },
    Scroll { delta: i32, x: i32, y: i32 },
    KeyDown { key: String },
    KeyUp { key: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    at_ms: u64,
    #[serde(flatten)]
    kind: RecordedKind,
}

struct RecorderControl {
    id: String,
    active: AtomicBool,
    hook_thread_id: AtomicU32,
    sender: SyncSender<Option<RecordedEvent>>,
    done: Mutex<Option<std::sync::mpsc::Receiver<(usize, String)>>>,
    app: tauri::AppHandle,
    record_cursor_movement: bool,
    excluded_hotkeys: Vec<String>,
}

static ACTIVE_RECORDER: OnceLock<Mutex<Option<Arc<RecorderControl>>>> = OnceLock::new();
static HOOK_SENDER: OnceLock<Mutex<Option<SyncSender<Option<RecordedEvent>>>>> = OnceLock::new();
static HOOK_STARTED: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
static RECORDER_HOOK_STOPPING: AtomicBool = AtomicBool::new(false);
static RECORDER_DRAGGING: AtomicBool = AtomicBool::new(false);
static RECORDER_LAST_MOVE_MS: AtomicU32 = AtomicU32::new(0);

fn active_recorder() -> &'static Mutex<Option<Arc<RecorderControl>>> {
    ACTIVE_RECORDER.get_or_init(|| Mutex::new(None))
}

fn hook_sender() -> &'static Mutex<Option<SyncSender<Option<RecordedEvent>>>> {
    HOOK_SENDER.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn recorder_start(
    app: tauri::AppHandle,
    record_cursor_movement: bool,
) -> crate::error::AppResult<String> {
    use tauri::Manager;
    let state = app.state::<crate::ClickerState>();
    if state.running.load(Ordering::SeqCst) {
        return Err(crate::error::AppError::State(
            "Stop the current automation job before recording.".into(),
        ));
    }
    if state
        .recording_active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(crate::error::AppError::State(
            "A recording session is already active.".into(),
        ));
    }
    if state.running.load(Ordering::SeqCst) {
        state.recording_active.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::AlreadyRunning);
    }
    if active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .is_some()
    {
        state.recording_active.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::State(
            "A recording session is already active.".into(),
        ));
    }

    let id = format!(
        "recording-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<RecordedEvent>>(EVENT_BUFFER);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let excluded_hotkeys = {
        let settings = state
            .settings
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner);
        vec![
            settings.hotkey.clone(),
            settings.recording_hotkey.clone(),
            settings.emergency_stop_hotkey.clone(),
        ]
    };
    let control = Arc::new(RecorderControl {
        id: id.clone(),
        active: AtomicBool::new(true),
        hook_thread_id: AtomicU32::new(0),
        sender: tx.clone(),
        done: Mutex::new(Some(done_rx)),
        app: app.clone(),
        record_cursor_movement,
        excluded_hotkeys,
    });
    *hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = Some(tx);
    *active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = Some(control.clone());

    #[cfg(windows)]
    {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let hook_control = control.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("blur-recorder-hooks".into())
            .spawn(move || run_hooks(hook_control, ready_tx))
        {
            *active_recorder()
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            *hook_sender()
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            state.recording_active.store(false, Ordering::SeqCst);
            return Err(crate::error::AppError::State(format!(
                "Could not start recorder hooks: {error}"
            )));
        }
        let startup = ready_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap_or_else(|_| Err("Recording hooks did not start in time.".into()));
        if let Err(reason) = startup {
            stop_control(&control);
            *active_recorder()
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            *hook_sender()
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            state.recording_active.store(false, Ordering::SeqCst);
            return Err(crate::error::AppError::State(reason));
        }
    }
    #[cfg(not(windows))]
    {
        *active_recorder()
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner) = None;
        *hook_sender()
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner) = None;
        state.recording_active.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::State(
            "Action recording is only available on Windows.".into(),
        ));
    }

    let worker_control = control.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("blur-recorder-events".into())
        .spawn(move || {
            let started = Instant::now();
            let mut events = Vec::new();
            let mut password_warning_active = false;
            while let Ok(message) = rx.recv() {
                let Some(mut event) = message else { break };
                if is_sensitive_edit_focused() && matches!(event.kind, RecordedKind::KeyDown { .. } | RecordedKind::KeyUp { .. }) {
                    if !password_warning_active {
                        password_warning_active = true;
                        let _ = worker_control.app.emit(
                            "recorder:warning",
                        "Keyboard recording paused while a detectable password field has focus. Detection is best-effort.",
                        );
                    }
                    continue;
                }
                if password_warning_active {
                    password_warning_active = false;
                }
                // Hook time is monotonic and captured before the record entered the queue.
                // Clamp any malformed timestamp rather than allowing negative waits.
                event.at_ms = event.at_ms.min(started.elapsed().as_millis() as u64 + 1);
                if should_keep_event(&events, &event, record_cursor_movement) {
                    events.push(event.clone());
                    let _ = worker_control.app.emit("recorder:event", event);
                }
            }
            let source = events_to_script(&events, &worker_control.excluded_hotkeys);
            worker_control.active.store(false, Ordering::SeqCst);
            *active_recorder()
                .lock()
                .unwrap_or_else(crate::error::poisoned_inner) = None;
            if let Some(state) = worker_control.app.try_state::<crate::ClickerState>() {
                state.recording_active.store(false, Ordering::SeqCst);
            }
            let _ = worker_control.app.emit(
                "recorder:state",
                serde_json::json!({ "state": "Stopped", "eventCount": events.len() }),
            );
            let _ = done_tx.send((events.len(), source));
        })
    {
        stop_control(&control);
        *active_recorder()
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner) = None;
        state.recording_active.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::State(format!(
            "Could not start recorder event worker: {error}"
        )));
    }

    let _ = app.emit(
        "recorder:state",
        serde_json::json!({
            "state": "Recording",
            "sessionId": id,
            "recordCursorMovement": record_cursor_movement,
            "privacyWarning": "Raw key names are captured locally. Password-field detection is best-effort; avoid recording sensitive input.",
        }),
    );
    Ok(id)
}

#[tauri::command]
pub fn recorder_stop(session_id: String) -> crate::error::AppResult<serde_json::Value> {
    let control = active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .clone()
        .ok_or_else(|| crate::error::AppError::State("No recording session is active.".into()))?;
    if control.id != session_id {
        return Err(crate::error::AppError::State(
            "Recording session ID does not match the active session.".into(),
        ));
    }
    let (event_count, source) = finish_session(&control, true)?;
    Ok(serde_json::json!({
        "eventCount": event_count,
        "source": source,
        "sessionId": session_id,
    }))
}

#[tauri::command]
pub fn recorder_events_to_script(
    app: tauri::AppHandle,
    events: Vec<RecordedEvent>,
) -> crate::error::AppResult<String> {
    use tauri::Manager;
    if active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .is_some()
    {
        return Err(crate::error::AppError::State(
            "Stop recording before applying timeline edits.".into(),
        ));
    }
    let state = app.state::<crate::ClickerState>();
    let settings = state
        .settings
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    let excluded_hotkeys = vec![
        settings.hotkey.clone(),
        settings.recording_hotkey.clone(),
        settings.emergency_stop_hotkey.clone(),
    ];
    Ok(events_to_script(&events, &excluded_hotkeys))
}

fn finish_session(
    control: &Arc<RecorderControl>,
    emit_result: bool,
) -> crate::error::AppResult<(usize, String)> {
    use tauri::Manager;
    stop_control(control);
    let done = control
        .done
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .take()
        .ok_or_else(|| crate::error::AppError::State("Recorder result is unavailable.".into()))?;
    let (event_count, source) = done
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| {
            crate::error::AppError::State(
                "Recorder did not stop in time; restart the app if hooks remain active.".into(),
            )
        })?;
    *active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = None;
    if let Some(state) = control.app.try_state::<crate::ClickerState>() {
        state.recording_active.store(false, Ordering::SeqCst);
    }
    if emit_result {
        let _ = control.app.emit(
            "recorder:stopped",
            serde_json::json!({
                "sessionId": control.id,
                "eventCount": event_count,
                "source": source.clone(),
            }),
        );
    }
    Ok((event_count, source))
}

pub fn stop_active_recording() {
    use tauri::Manager;
    if let Some(control) = active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .clone()
    {
        stop_control(&control);
        if let Some(done) = control
            .done
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner)
            .take()
        {
            let _ = done.recv_timeout(std::time::Duration::from_secs(2));
        }
        *active_recorder()
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner) = None;
        if let Some(state) = control.app.try_state::<crate::ClickerState>() {
            state.recording_active.store(false, Ordering::SeqCst);
        }
    }
}

pub fn stop_recording_from_hotkey() {
    let Some(control) = active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .clone()
    else {
        return;
    };
    std::thread::spawn(move || {
        if let Err(error) = finish_session(&control, true) {
            log::warn!("[Recorder] Could not finish recording from hotkey: {error}");
        }
    });
}

pub fn toggle_recording_from_hotkey(app: &tauri::AppHandle, record_cursor_movement: bool) {
    if active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .is_some()
    {
        stop_recording_from_hotkey();
        return;
    }
    use tauri::Manager;
    let state = app.state::<crate::ClickerState>();
    if !state
        .macro_mode_active
        .load(std::sync::atomic::Ordering::SeqCst)
        || state.running.load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    if let Err(error) = recorder_start(app.clone(), record_cursor_movement) {
        log::warn!("[Recorder] Could not start recording from hotkey: {error}");
    }
}

fn stop_control(control: &RecorderControl) {
    if !control.active.swap(false, Ordering::SeqCst) {
        return;
    }
    *hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = None;
    #[cfg(windows)]
    {
        let thread_id = control.hook_thread_id.load(Ordering::SeqCst);
        if thread_id != 0 {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                    thread_id,
                    windows_sys::Win32::UI::WindowsAndMessaging::WM_QUIT,
                    0,
                    0,
                );
            }
        }
    }
}

fn should_keep_event(
    events: &[RecordedEvent],
    event: &RecordedEvent,
    record_cursor_movement: bool,
) -> bool {
    if let RecordedKind::Move { x, y } = &event.kind {
        let dragging = events
            .iter()
            .rev()
            .find_map(|previous| match previous.kind {
                RecordedKind::MouseDown { .. } => Some(true),
                RecordedKind::MouseUp { .. } => Some(false),
                _ => None,
            })
            .unwrap_or(false);
        if !record_cursor_movement && !dragging {
            return false;
        }
        if !dragging {
            if let Some(RecordedEvent {
                at_ms,
                kind:
                    RecordedKind::Move {
                        x: prev_x,
                        y: prev_y,
                    },
            }) = events
                .iter()
                .rev()
                .find(|e| matches!(e.kind, RecordedKind::Move { .. }))
            {
                let dx = i64::from(*x) - i64::from(*prev_x);
                let dy = i64::from(*y) - i64::from(*prev_y);
                if dx * dx + dy * dy < 16 && event.at_ms.saturating_sub(*at_ms) < 25 {
                    return false;
                }
            }
        }
    }
    true
}

fn events_to_script(events: &[RecordedEvent], excluded_hotkeys: &[String]) -> String {
    let filtered = filter_shortcut_events(events, excluded_hotkeys);
    let mut lines = vec![
        "mode foreground".to_string(),
        "# Recorded locally. Review and validate before replay.".to_string(),
    ];
    let mut last_at = 0u64;
    for event in &filtered {
        let delay = event.at_ms.saturating_sub(last_at);
        if delay > 0 {
            lines.push(format!("wait {delay}ms"));
        }
        let line = match &event.kind {
            RecordedKind::Move { x, y } => format!("move x={x} y={y} space=screen"),
            RecordedKind::MouseDown { button } => format!("mouse_down button={button}"),
            RecordedKind::MouseUp { button } => format!("mouse_up button={button}"),
            RecordedKind::Scroll { delta, x, y } => {
                format!("scroll delta={delta} x={x} y={y} space=screen")
            }
            RecordedKind::KeyDown { key } => format!("key_down {key:?}"),
            RecordedKind::KeyUp { key } => format!("key_up {key:?}"),
        };
        lines.push(line);
        last_at = event.at_ms;
    }
    lines.join("\n")
}

fn filter_shortcut_events(events: &[RecordedEvent], hotkeys: &[String]) -> Vec<RecordedEvent> {
    use std::collections::{HashMap, HashSet};

    let shortcuts = hotkeys
        .iter()
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            value
                .split('+')
                .map(|part| match part.trim().to_ascii_uppercase().as_str() {
                    "CONTROL" | "LEFTCTRL" | "RIGHTCTRL" | "LCTRL" | "RCTRL" => "CTRL".into(),
                    "LEFTSHIFT" | "RIGHTSHIFT" | "LSHIFT" | "RSHIFT" => "SHIFT".into(),
                    "LEFTALT" | "RIGHTALT" | "LALT" | "RALT" => "ALT".into(),
                    "META" | "SUPER" | "LEFTWIN" | "RIGHTWIN" => "WIN".into(),
                    "RETURN" => "ENTER".into(),
                    "ESCAPE" => "ESC".into(),
                    value => value.to_string(),
                })
                .collect::<HashSet<_>>()
        })
        .filter(|keys| !keys.is_empty())
        .collect::<Vec<_>>();
    if shortcuts.is_empty() {
        return events.to_vec();
    }

    let all_shortcut_keys = shortcuts.iter().flatten().cloned().collect::<HashSet<_>>();
    let mut suppressed = vec![false; events.len()];
    let mut down = HashSet::<String>::new();
    let mut down_indices = HashMap::<String, usize>::new();
    let mut active_shortcut: Option<HashSet<String>> = None;

    for (index, event) in events.iter().enumerate() {
        match &event.kind {
            RecordedKind::KeyDown { key } => {
                let key = key.to_ascii_uppercase();
                down.insert(key.clone());
                down_indices.entry(key.clone()).or_insert(index);
                if active_shortcut.is_none() {
                    if let Some(shortcut) = shortcuts
                        .iter()
                        .find(|keys| keys.iter().all(|required| down.contains(required)))
                    {
                        let start = shortcut
                            .iter()
                            .filter_map(|required| down_indices.get(required))
                            .copied()
                            .min()
                            .unwrap_or(index);
                        for (candidate, prior) in
                            events.iter().enumerate().take(index + 1).skip(start)
                        {
                            if matches!(
                                prior.kind,
                                RecordedKind::KeyDown { .. } | RecordedKind::KeyUp { .. }
                            ) {
                                suppressed[candidate] = true;
                            }
                        }
                        active_shortcut = Some(shortcut.clone());
                    }
                }
                if active_shortcut
                    .as_ref()
                    .is_some_and(|keys| keys.contains(&key))
                {
                    suppressed[index] = true;
                }
            }
            RecordedKind::KeyUp { key } => {
                let key = key.to_ascii_uppercase();
                let was_down = down.remove(&key);
                down_indices.remove(&key);
                if let Some(keys) = &active_shortcut {
                    if keys.contains(&key) {
                        suppressed[index] = true;
                    }
                } else if !was_down && event.at_ms <= 250 && all_shortcut_keys.contains(&key) {
                    // The recording hotkey may have been pressed before hook startup.
                    suppressed[index] = true;
                }
                if active_shortcut
                    .as_ref()
                    .is_some_and(|keys| keys.iter().all(|part| !down.contains(part)))
                {
                    active_shortcut = None;
                }
            }
            _ => {}
        }
    }

    events
        .iter()
        .zip(suppressed)
        .filter_map(|(event, is_suppressed)| (!is_suppressed).then(|| event.clone()))
        .collect()
}

fn elapsed_hook_ms() -> u64 {
    HOOK_STARTED
        .get()
        .and_then(|started| started.lock().ok())
        .and_then(|started| {
            started
                .as_ref()
                .map(|instant| instant.elapsed().as_millis() as u64)
        })
        .unwrap_or(0)
}

#[cfg(windows)]
fn is_sensitive_edit_focused() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetGUIThreadInfo, GetWindowLongW,
        GetWindowThreadProcessId, GUITHREADINFO, GWL_STYLE,
    };
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.is_null() {
            return false;
        }
        let thread_id = GetWindowThreadProcessId(foreground, std::ptr::null_mut());
        if thread_id == 0 {
            return false;
        }
        let mut info: GUITHREADINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<GUITHREADINFO>() as u32;
        if GetGUIThreadInfo(thread_id, &mut info) == 0 || info.hwndFocus.is_null() {
            return false;
        }
        let mut class = [0u16; 128];
        let len = GetClassNameW(info.hwndFocus, class.as_mut_ptr(), class.len() as i32);
        if len <= 0 || String::from_utf16_lossy(&class[..len as usize]) != "Edit" {
            return false;
        }
        (GetWindowLongW(info.hwndFocus, GWL_STYLE) as u32 & 0x20) != 0
    }
}

#[cfg(not(windows))]
fn is_sensitive_edit_focused() -> bool {
    false
}

#[cfg(windows)]
fn run_hooks(control: Arc<RecorderControl>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN,
        WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    unsafe extern "system" fn keyboard_hook(
        code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if code >= 0 && !RECORDER_HOOK_STOPPING.load(Ordering::Relaxed) {
            let data = &*(l_param as *const KBDLLHOOKSTRUCT);
            if data.flags & 0x10 == 0 && data.dwExtraInfo != crate::engine::AUTOCLICKER_EXTRA_INFO {
                let sender = hook_sender()
                    .lock()
                    .unwrap_or_else(crate::error::poisoned_inner)
                    .clone();
                if let Some(sender) = sender {
                    let vk = data.vkCode as u16;
                    let key = key_name(vk);
                    if let Some(key) = key {
                        let kind = if w_param as u32 == WM_KEYUP || w_param as u32 == 0x0105 {
                            RecordedKind::KeyUp { key }
                        } else {
                            RecordedKind::KeyDown { key }
                        };
                        let event = RecordedEvent {
                            at_ms: elapsed_hook_ms(),
                            kind,
                        };
                        let _ = sender.try_send(Some(event));
                    }
                }
            }
        }
        CallNextHookEx(
            std::ptr::null_mut::<c_void>() as HHOOK,
            code,
            w_param,
            l_param,
        )
    }

    unsafe extern "system" fn mouse_hook(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if code >= 0 && !RECORDER_HOOK_STOPPING.load(Ordering::Relaxed) {
            let data = &*(l_param as *const MSLLHOOKSTRUCT);
            if data.flags & 0x01 == 0 && data.dwExtraInfo != crate::engine::AUTOCLICKER_EXTRA_INFO {
                let sender = hook_sender()
                    .lock()
                    .unwrap_or_else(crate::error::poisoned_inner)
                    .clone();
                if let Some(sender) = sender {
                    let kind = match w_param as u32 {
                        WM_MOUSEMOVE => {
                            if !control_record_cursor()
                                && !RECORDER_DRAGGING.load(Ordering::Relaxed)
                            {
                                return CallNextHookEx(
                                    std::ptr::null_mut::<c_void>() as HHOOK,
                                    code,
                                    w_param,
                                    l_param,
                                );
                            }
                            let now = elapsed_hook_ms() as u32;
                            let previous = RECORDER_LAST_MOVE_MS.swap(now, Ordering::Relaxed);
                            if !RECORDER_DRAGGING.load(Ordering::Relaxed)
                                && now.saturating_sub(previous) < 25
                            {
                                return CallNextHookEx(
                                    std::ptr::null_mut::<c_void>() as HHOOK,
                                    code,
                                    w_param,
                                    l_param,
                                );
                            }
                            RecordedKind::Move {
                                x: data.pt.x,
                                y: data.pt.y,
                            }
                        }
                        WM_LBUTTONDOWN => {
                            RECORDER_DRAGGING.store(true, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "left".into(),
                            }
                        }
                        WM_LBUTTONUP => {
                            RECORDER_DRAGGING.store(false, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "left".into(),
                            }
                        }
                        WM_RBUTTONDOWN => {
                            RECORDER_DRAGGING.store(true, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "right".into(),
                            }
                        }
                        WM_RBUTTONUP => {
                            RECORDER_DRAGGING.store(false, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "right".into(),
                            }
                        }
                        WM_MBUTTONDOWN => {
                            RECORDER_DRAGGING.store(true, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "middle".into(),
                            }
                        }
                        WM_MBUTTONUP => {
                            RECORDER_DRAGGING.store(false, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "middle".into(),
                            }
                        }
                        WM_MOUSEWHEEL => {
                            let delta = ((data.mouseData >> 16) as u16 as i16) as i32;
                            RecordedKind::Scroll {
                                delta,
                                x: data.pt.x,
                                y: data.pt.y,
                            }
                        }
                        _ => {
                            return CallNextHookEx(
                                std::ptr::null_mut::<c_void>() as HHOOK,
                                code,
                                w_param,
                                l_param,
                            );
                        }
                    };
                    let event = RecordedEvent {
                        at_ms: elapsed_hook_ms(),
                        kind,
                    };
                    let _ = sender.try_send(Some(event));
                }
            }
        }
        CallNextHookEx(
            std::ptr::null_mut::<c_void>() as HHOOK,
            code,
            w_param,
            l_param,
        )
    }

    fn control_record_cursor() -> bool {
        ACTIVE_RECORDER
            .get()
            .and_then(|recorder| recorder.lock().ok())
            .and_then(|recorder| {
                recorder
                    .as_ref()
                    .map(|r| r.active.load(Ordering::Relaxed) && r.record_cursor_movement)
            })
            .unwrap_or(false)
    }

    RECORDER_HOOK_STOPPING.store(false, Ordering::SeqCst);
    RECORDER_DRAGGING.store(false, Ordering::SeqCst);
    RECORDER_LAST_MOVE_MS.store(0, Ordering::SeqCst);
    if let Some(started) = HOOK_STARTED.get() {
        *started.lock().unwrap_or_else(crate::error::poisoned_inner) = Some(Instant::now());
    } else {
        let _ = HOOK_STARTED.set(Mutex::new(Some(Instant::now())));
    }
    let mut message: MSG = unsafe { std::mem::zeroed() };
    unsafe {
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 0);
    }
    let thread_id = unsafe { GetCurrentThreadId() };
    control.hook_thread_id.store(thread_id, Ordering::SeqCst);

    let keyboard: HHOOK =
        unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), std::ptr::null_mut(), 0) };
    let mouse: HHOOK =
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), std::ptr::null_mut(), 0) };
    if keyboard.is_null() || mouse.is_null() {
        RECORDER_HOOK_STOPPING.store(true, Ordering::SeqCst);
        if !keyboard.is_null() {
            unsafe { UnhookWindowsHookEx(keyboard) };
        }
        if !mouse.is_null() {
            unsafe { UnhookWindowsHookEx(mouse) };
        }
        let _ = control.app.emit(
            "recorder:error",
            "Windows could not install the low-level recording hooks.",
        );
        let _ = ready.send(Err(
            "Windows could not install the low-level recording hooks.".into(),
        ));
    } else {
        let _ = ready.send(Ok(()));
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if !control.active.load(Ordering::SeqCst) {
                break;
            }
        }
        RECORDER_HOOK_STOPPING.store(true, Ordering::SeqCst);
        unsafe {
            UnhookWindowsHookEx(keyboard);
            UnhookWindowsHookEx(mouse);
        }
    }
    *hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = None;
    let _ = control.sender.send(None);
}

#[cfg(windows)]
fn key_name(vk: u16) -> Option<String> {
    let name = match vk {
        0x08 => "BACKSPACE",
        0x09 => "TAB",
        0x0D => "ENTER",
        0x10 | 0xA0 | 0xA1 => "SHIFT",
        0x11 | 0xA2 | 0xA3 => "CTRL",
        0x12 | 0xA4 | 0xA5 => "ALT",
        0x13 => "PAUSE",
        0x14 => "CAPSLOCK",
        0x1B => "ESC",
        0x20 => "SPACE",
        0x21 => "PAGEUP",
        0x22 => "PAGEDOWN",
        0x23 => "END",
        0x24 => "HOME",
        0x25 => "LEFT",
        0x26 => "UP",
        0x27 => "RIGHT",
        0x28 => "DOWN",
        0x2D => "INSERT",
        0x2E => "DELETE",
        0x5B | 0x5C => "WIN",
        0xBA => ";",
        0xBB => "=",
        0xBC => ",",
        0xBD => "-",
        0xBE => ".",
        0xBF => "/",
        0xDB => "[",
        0xDC => "\\",
        0xDD => "]",
        0xDE => "'",
        _ => "",
    };
    if !name.is_empty() {
        return Some(name.to_string());
    }
    if (b'A' as u16..=b'Z' as u16).contains(&vk) || (b'0' as u16..=b'9' as u16).contains(&vk) {
        return char::from_u32(vk as u32).map(|c| c.to_string());
    }
    if (0x70..=0x87).contains(&vk) {
        return Some(format!("F{}", vk - 0x70 + 1));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_timeline_events_deserialize_for_source_conversion() {
        let event: RecordedEvent = serde_json::from_value(serde_json::json!({
            "atMs": 12,
            "kind": "mouseDown",
            "button": "left"
        }))
        .unwrap();
        assert!(matches!(
            event.kind,
            RecordedKind::MouseDown { ref button } if button == "left"
        ));
    }

    #[test]
    fn recorder_source_roundtrips_through_the_macro_parser() {
        let events = vec![
            RecordedEvent {
                at_ms: 0,
                kind: RecordedKind::Move { x: -250, y: 300 },
            },
            RecordedEvent {
                at_ms: 170,
                kind: RecordedKind::MouseDown {
                    button: "left".into(),
                },
            },
            RecordedEvent {
                at_ms: 245,
                kind: RecordedKind::MouseUp {
                    button: "left".into(),
                },
            },
            RecordedEvent {
                at_ms: 540,
                kind: RecordedKind::KeyDown { key: "CTRL".into() },
            },
            RecordedEvent {
                at_ms: 555,
                kind: RecordedKind::KeyDown { key: "A".into() },
            },
            RecordedEvent {
                at_ms: 590,
                kind: RecordedKind::KeyUp { key: "A".into() },
            },
            RecordedEvent {
                at_ms: 620,
                kind: RecordedKind::KeyUp { key: "CTRL".into() },
            },
        ];
        let source = events_to_script(&events, &[]);
        assert!(crate::macro_engine::validate_source(&source).ok);
        assert!(source.contains("move x=-250 y=300"));
        assert!(source.contains("wait 75ms"));
    }

    #[test]
    fn generated_source_excludes_activation_recording_and_emergency_shortcuts() {
        let events = vec![
            RecordedEvent {
                at_ms: 0,
                kind: RecordedKind::KeyUp { key: "CTRL".into() },
            },
            RecordedEvent {
                at_ms: 10,
                kind: RecordedKind::KeyDown { key: "CTRL".into() },
            },
            RecordedEvent {
                at_ms: 12,
                kind: RecordedKind::KeyDown {
                    key: "SHIFT".into(),
                },
            },
            RecordedEvent {
                at_ms: 15,
                kind: RecordedKind::KeyDown { key: "R".into() },
            },
            RecordedEvent {
                at_ms: 25,
                kind: RecordedKind::KeyUp { key: "R".into() },
            },
            RecordedEvent {
                at_ms: 28,
                kind: RecordedKind::KeyUp {
                    key: "SHIFT".into(),
                },
            },
            RecordedEvent {
                at_ms: 30,
                kind: RecordedKind::KeyUp { key: "CTRL".into() },
            },
            RecordedEvent {
                at_ms: 100,
                kind: RecordedKind::KeyDown { key: "A".into() },
            },
            RecordedEvent {
                at_ms: 140,
                kind: RecordedKind::KeyUp { key: "A".into() },
            },
        ];
        let source = events_to_script(
            &events,
            &[
                "ctrl+shift+r".into(),
                "ctrl+y".into(),
                "ctrl+shift+f12".into(),
            ],
        );
        assert!(!source.contains("\"CTRL\""));
        assert!(!source.contains("\"SHIFT\""));
        assert!(!source.contains("\"R\""));
        assert!(source.contains("key_down \"A\""));
        assert!(crate::macro_engine::validate_source(&source).ok);
    }
}
