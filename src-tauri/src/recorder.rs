use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Emitter;

const EVENT_BUFFER: usize = 4096;
const MAX_RECORDED_EVENTS: usize = 10_000;
static NEXT_RECORDER_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RecordedKind {
    Move {
        x: i32,
        y: i32,
    },
    MouseDown {
        button: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<i32>,
    },
    MouseUp {
        button: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<i32>,
    },
    Scroll {
        delta: i32,
        x: i32,
        y: i32,
    },
    KeyDown {
        key: String,
    },
    KeyUp {
        key: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedEvent {
    at_ms: u64,
    #[serde(flatten)]
    kind: RecordedKind,
}

type RecorderResult = (usize, String, Vec<RecordedEvent>);

struct RecorderControl {
    id: String,
    active: Arc<AtomicBool>,
    hook_thread_id: AtomicU32,
    sender: SyncSender<Option<RecordedEvent>>,
    dropped_events: Arc<AtomicU32>,
    done: Mutex<Option<std::sync::mpsc::Receiver<RecorderResult>>>,
    result: Mutex<Option<RecorderResult>>,
    app: tauri::AppHandle,
    excluded_hotkeys: Vec<String>,
}

struct HookRoute {
    session_id: String,
    active: Arc<AtomicBool>,
    sender: SyncSender<Option<RecordedEvent>>,
    dropped_events: Arc<AtomicU32>,
    record_cursor_movement: bool,
    buttons_down: Arc<AtomicU32>,
    last_move_ms: Arc<AtomicU64>,
    started_at: Instant,
}

static ACTIVE_RECORDER: OnceLock<Mutex<Option<Arc<RecorderControl>>>> = OnceLock::new();
static HOOK_SENDER: OnceLock<Mutex<Option<Arc<HookRoute>>>> = OnceLock::new();

// Low-level callbacks use the route installed by their own hook thread, so the
// per-event path avoids the shared recorder lock and session-string cloning.
thread_local! {
    static RECORDER_HOOK_CONTEXT: std::cell::RefCell<Option<Arc<HookRoute>>> = const {
        std::cell::RefCell::new(None)
    };
}

const LEFT_BUTTON_DOWN: u32 = 1;
const RIGHT_BUTTON_DOWN: u32 = 2;
const MIDDLE_BUTTON_DOWN: u32 = 4;

fn active_recorder() -> &'static Mutex<Option<Arc<RecorderControl>>> {
    ACTIVE_RECORDER.get_or_init(|| Mutex::new(None))
}

fn hook_sender() -> &'static Mutex<Option<Arc<HookRoute>>> {
    HOOK_SENDER.get_or_init(|| Mutex::new(None))
}

fn clear_hook_sender_for(session_id: &str) {
    let mut route = hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    if route
        .as_ref()
        .is_some_and(|current| current.session_id == session_id)
    {
        *route = None;
    }
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
        "recording-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        NEXT_RECORDER_SESSION.fetch_add(1, Ordering::Relaxed)
    );
    let (tx, rx) = std::sync::mpsc::sync_channel::<Option<RecordedEvent>>(EVENT_BUFFER);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let active = Arc::new(AtomicBool::new(true));
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
    let dropped_events = Arc::new(AtomicU32::new(0));
    let control = Arc::new(RecorderControl {
        id: id.clone(),
        active: active.clone(),
        hook_thread_id: AtomicU32::new(0),
        sender: tx.clone(),
        dropped_events: dropped_events.clone(),
        done: Mutex::new(Some(done_rx)),
        result: Mutex::new(None),
        app: app.clone(),
        excluded_hotkeys,
    });
    *hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner) = Some(Arc::new(HookRoute {
        session_id: id.clone(),
        active,
        sender: tx,
        dropped_events,
        record_cursor_movement,
        buttons_down: Arc::new(AtomicU32::new(0)),
        last_move_ms: Arc::new(AtomicU64::new(0)),
        started_at: Instant::now(),
    }));
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
            clear_hook_sender_for(&control.id);
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
            clear_hook_sender_for(&control.id);
            state.recording_active.store(false, Ordering::SeqCst);
            return Err(crate::error::AppError::State(reason));
        }
    }
    #[cfg(not(windows))]
    {
        *active_recorder()
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner) = None;
        clear_hook_sender_for(&control.id);
        state.recording_active.store(false, Ordering::SeqCst);
        return Err(crate::error::AppError::State(
            "Action recording is only available on Windows.".into(),
        ));
    }

    let worker_control = control.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("blur-recorder-events".into())
        .spawn(move || {
            let mut events = Vec::new();
            let mut pending_ui_events = Vec::with_capacity(64);
            let mut last_ui_flush = Instant::now();
            let mut event_limit_warning_active = false;
            let mut queue_warning_active = false;
            let mut mouse_buttons_down = 0u32;
            let mut last_kept_move = None;
            loop {
                let message = match rx.recv_timeout(std::time::Duration::from_millis(50)) {
                    Ok(message) => message,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if !pending_ui_events.is_empty() {
                            let batch = std::mem::take(&mut pending_ui_events);
                            let _ = worker_control.app.emit(
                                "recorder:events",
                                serde_json::json!({
                                    "sessionId": worker_control.id,
                                    "events": batch,
                                }),
                            );
                            last_ui_flush = Instant::now();
                        }
                        continue;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                let dropped = worker_control
                    .dropped_events
                    .swap(0, Ordering::SeqCst);
                if dropped > 0 && !queue_warning_active {
                    queue_warning_active = true;
                    let _ = worker_control.app.emit(
                        "recorder:warning",
                        format!("The recorder event queue filled and at least {dropped} input event(s) were dropped. This recording may omit actions."),
                    );
                }
                let Some(event) = message else { break };
                // Preserve the hook's monotonic timestamp. The event worker starts
                // slightly later, so comparing these clocks would clip early actions.
                if should_keep_event(
                    &event,
                    record_cursor_movement,
                    &mut mouse_buttons_down,
                    &mut last_kept_move,
                ) {
                    if events.len() >= MAX_RECORDED_EVENTS {
                        if !event_limit_warning_active {
                            event_limit_warning_active = true;
                            stop_control(&worker_control);
                            let _ = worker_control.app.emit(
                                "recorder:warning",
                                format!("Recording stopped at the {MAX_RECORDED_EVENTS}-event safety limit. Apply or edit the captured script, then start a new recording."),
                            );
                        }
                        continue;
                    }
                    events.push(event.clone());
                    pending_ui_events.push(event);
                    if pending_ui_events.len() >= 64
                        || last_ui_flush.elapsed() >= std::time::Duration::from_millis(50)
                    {
                        let batch = std::mem::take(&mut pending_ui_events);
                        let _ = worker_control.app.emit(
                            "recorder:events",
                            serde_json::json!({
                                "sessionId": worker_control.id,
                                "events": batch,
                            }),
                        );
                        last_ui_flush = Instant::now();
                    }
                }
            }
            if !pending_ui_events.is_empty() {
                let _ = worker_control.app.emit(
                    "recorder:events",
                    serde_json::json!({
                        "sessionId": worker_control.id,
                        "events": pending_ui_events,
                    }),
                );
            }
            let source = events_to_script(&events, &worker_control.excluded_hotkeys);
            let event_count = events.len();
            let _ = worker_control.app.emit(
                "recorder:stopped",
                serde_json::json!({
                    "sessionId": worker_control.id,
                    "eventCount": event_count,
                    "source": source.clone(),
                    "events": events.clone(),
                }),
            );
            worker_control.active.store(false, Ordering::SeqCst);
            if clear_active_recorder_if(&worker_control) {
                if let Some(state) = worker_control.app.try_state::<crate::ClickerState>() {
                    state.recording_active.store(false, Ordering::SeqCst);
                }
            }
            let _ = worker_control.app.emit(
                "recorder:state",
                serde_json::json!({
                    "state": "Stopped",
                    "sessionId": worker_control.id,
                    "eventCount": event_count,
                }),
            );
            let _ = done_tx.send((event_count, source, events));
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
    let (event_count, source, events) = finish_session(&control)?;
    Ok(serde_json::json!({
        "eventCount": event_count,
        "source": source,
        "events": events,
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

fn finish_session(control: &Arc<RecorderControl>) -> crate::error::AppResult<RecorderResult> {
    use tauri::Manager;
    let mut result_guard = control
        .result
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    if let Some(result) = result_guard.as_ref() {
        return Ok(result.clone());
    }
    stop_control(control);
    let (event_count, source, events) = {
        let mut done_guard = control
            .done
            .lock()
            .unwrap_or_else(crate::error::poisoned_inner);
        let Some(done) = done_guard.as_ref() else {
            return Err(crate::error::AppError::State(
                "Recorder result is unavailable.".into(),
            ));
        };
        match done.recv_timeout(std::time::Duration::from_secs(3)) {
            Ok(result) => {
                done_guard.take();
                result
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(crate::error::AppError::State(
                    "Recorder did not stop in time; try stopping again, or restart the app if hooks remain active.".into(),
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                done_guard.take();
                if clear_active_recorder_if(control) {
                    if let Some(state) = control.app.try_state::<crate::ClickerState>() {
                        state.recording_active.store(false, Ordering::SeqCst);
                    }
                }
                return Err(crate::error::AppError::State(
                    "Recorder worker exited without producing a result.".into(),
                ));
            }
        }
    };
    *result_guard = Some((event_count, source.clone(), events.clone()));
    if clear_active_recorder_if(control) {
        if let Some(state) = control.app.try_state::<crate::ClickerState>() {
            state.recording_active.store(false, Ordering::SeqCst);
        }
    }
    Ok((event_count, source, events))
}

fn clear_active_recorder_if(control: &Arc<RecorderControl>) -> bool {
    let mut active = active_recorder()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner);
    if active
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, control))
    {
        *active = None;
        true
    } else {
        false
    }
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
        if clear_active_recorder_if(&control) {
            if let Some(state) = control.app.try_state::<crate::ClickerState>() {
                state.recording_active.store(false, Ordering::SeqCst);
            }
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
        if let Err(error) = finish_session(&control) {
            let message = format!("Could not stop recording from the hotkey: {error}");
            log::warn!("[Recorder] {message}");
            let _ = control.app.emit("recorder:error", message);
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
        || !state
            .macro_recorder_panel_active
            .load(std::sync::atomic::Ordering::SeqCst)
        || state.running.load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    // The event worker may have finished and cleared its session while the
    // application state flag is still being reset. Ignore a repeat key during
    // that short finalization window instead of reporting a false start error.
    if state
        .recording_active
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }
    if let Err(error) = recorder_start(app.clone(), record_cursor_movement) {
        let message = format!("Could not start recording from the hotkey: {error}");
        log::warn!("[Recorder] {message}");
        let _ = app.emit("recorder:error", message);
    } else if !state
        .macro_mode_active
        .load(std::sync::atomic::Ordering::SeqCst)
        || !state
            .macro_recorder_panel_active
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        // The panel may have closed while Windows was installing its hooks.
        stop_recording_from_hotkey();
    }
}

fn stop_control(control: &RecorderControl) {
    if !control.active.swap(false, Ordering::SeqCst) {
        return;
    }
    clear_hook_sender_for(&control.id);
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
    event: &RecordedEvent,
    record_cursor_movement: bool,
    buttons_down: &mut u32,
    last_kept_move: &mut Option<(u64, i32, i32)>,
) -> bool {
    match &event.kind {
        RecordedKind::MouseDown { button, .. } => {
            *buttons_down |= mouse_button_mask(button);
            *last_kept_move = None;
            true
        }
        RecordedKind::MouseUp { button, .. } => {
            *buttons_down &= !mouse_button_mask(button);
            *last_kept_move = None;
            true
        }
        RecordedKind::Move { x, y } => {
            let dragging = *buttons_down != 0;
            if !record_cursor_movement && !dragging {
                return false;
            }
            if !dragging {
                if let Some((at_ms, prev_x, prev_y)) = last_kept_move {
                    let dx = i64::from(*x) - i64::from(*prev_x);
                    let dy = i64::from(*y) - i64::from(*prev_y);
                    if dx * dx + dy * dy < 16 && event.at_ms.saturating_sub(*at_ms) < 25 {
                        return false;
                    }
                }
                *last_kept_move = Some((event.at_ms, *x, *y));
            } else {
                // Preserve every sampled point along a drag path.
                *last_kept_move = Some((event.at_ms, *x, *y));
            }
            true
        }
        RecordedKind::KeyDown { .. } | RecordedKind::KeyUp { .. } => false,
        _ => true,
    }
}

fn mouse_button_mask(button: &str) -> u32 {
    match button {
        "left" => LEFT_BUTTON_DOWN,
        "right" => RIGHT_BUTTON_DOWN,
        "middle" => MIDDLE_BUTTON_DOWN,
        _ => 0,
    }
}

fn enqueue_recorded_event(route: &HookRoute, event: RecordedEvent) {
    if let Err(std::sync::mpsc::TrySendError::Full(_)) = route.sender.try_send(Some(event)) {
        route.dropped_events.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
fn route_for_session(route: Option<&Arc<HookRoute>>, session_id: &str) -> Option<Arc<HookRoute>> {
    route
        .filter(|route| route.session_id == session_id)
        .cloned()
}

fn hook_sender_for_callback() -> Option<Arc<HookRoute>> {
    RECORDER_HOOK_CONTEXT.with(|context| {
        context
            .borrow()
            .as_ref()
            .filter(|route| route.active.load(Ordering::SeqCst))
            .cloned()
    })
}

fn events_to_script(events: &[RecordedEvent], excluded_hotkeys: &[String]) -> String {
    let filtered = filter_shortcut_events(events, excluded_hotkeys);
    let mut lines = vec![
        "mode foreground".to_string(),
        "# Recorded locally. Review and validate before replay.".to_string(),
    ];
    let mut last_at = 0u64;
    let mut cursor_position = None;
    for event in &filtered {
        let delay = event.at_ms.saturating_sub(last_at);
        if delay > 0 {
            lines.push(format!("wait {delay}ms"));
        }
        let event_position = match &event.kind {
            RecordedKind::Move { x, y } => Some((*x, *y)),
            RecordedKind::Scroll { x, y, .. } => Some((*x, *y)),
            RecordedKind::MouseDown {
                x: Some(x),
                y: Some(y),
                ..
            }
            | RecordedKind::MouseUp {
                x: Some(x),
                y: Some(y),
                ..
            } => Some((*x, *y)),
            _ => None,
        };
        if let Some((x, y)) = event_position {
            if cursor_position != Some((x, y))
                && matches!(
                    &event.kind,
                    RecordedKind::MouseDown { .. } | RecordedKind::MouseUp { .. }
                )
            {
                lines.push(format!("move x={x} y={y} space=screen"));
            }
            cursor_position = Some((x, y));
        }
        let line = match &event.kind {
            RecordedKind::Move { x, y } => {
                cursor_position = Some((*x, *y));
                format!("move x={x} y={y} space=screen")
            }
            RecordedKind::MouseDown { button, .. } => format!("mouse_down button={button}"),
            RecordedKind::MouseUp { button, .. } => format!("mouse_up button={button}"),
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
                .map(canonical_hotkey_key)
                .collect::<HashSet<_>>()
        })
        .filter(|keys| !keys.is_empty())
        .collect::<Vec<_>>();
    if shortcuts.is_empty() {
        return events.to_vec();
    }

    let all_shortcut_keys = shortcuts.iter().flatten().cloned().collect::<HashSet<_>>();
    let mut suppressed = vec![false; events.len()];
    let mut down_indices = HashMap::<String, usize>::new();
    let mut canonical_down = HashMap::<String, usize>::new();
    let mut active_shortcut: Option<HashSet<String>> = None;

    for (index, event) in events.iter().enumerate() {
        match &event.kind {
            RecordedKind::KeyDown { key } => {
                let physical_key = key.to_ascii_uppercase();
                let key = canonical_hotkey_key(&physical_key);
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    down_indices.entry(physical_key)
                {
                    *canonical_down.entry(key.clone()).or_default() += 1;
                    entry.insert(index);
                }
                if active_shortcut.is_none() {
                    if let Some(shortcut) = shortcuts.iter().find(|keys| {
                        keys.iter()
                            .all(|required| canonical_down.contains_key(required))
                    }) {
                        let start = shortcut
                            .iter()
                            .flat_map(|required| {
                                down_indices
                                    .iter()
                                    .filter_map(move |(pressed, event_index)| {
                                        (canonical_hotkey_key(pressed) == *required)
                                            .then_some(event_index)
                                    })
                            })
                            .copied()
                            .min()
                            .unwrap_or(index);
                        for event_index in down_indices.values().copied() {
                            if event_index >= start && event_index <= index {
                                let prior_key = match &events[event_index].kind {
                                    RecordedKind::KeyDown { key } => canonical_hotkey_key(key),
                                    _ => continue,
                                };
                                if shortcut.contains(&prior_key) {
                                    suppressed[event_index] = true;
                                }
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
                let physical_key = key.to_ascii_uppercase();
                let key = canonical_hotkey_key(&physical_key);
                let was_down = down_indices.remove(&physical_key).is_some();
                if was_down {
                    let remove_canonical = canonical_down.get_mut(&key).is_some_and(|count| {
                        *count -= 1;
                        *count == 0
                    });
                    if remove_canonical {
                        canonical_down.remove(&key);
                    }
                }
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
                    .is_some_and(|keys| keys.iter().all(|part| !canonical_down.contains_key(part)))
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
        .filter(|&(_, is_suppressed)| !is_suppressed)
        .map(|(event, _)| event.clone())
        .collect()
}

fn canonical_hotkey_key(value: &str) -> String {
    match value.trim().to_ascii_uppercase().as_str() {
        "CTRL" | "CONTROL" | "LEFTCTRL" | "RIGHTCTRL" | "LCTRL" | "RCTRL" => "CTRL".into(),
        "SHIFT" | "LEFTSHIFT" | "RIGHTSHIFT" | "LSHIFT" | "RSHIFT" => "SHIFT".into(),
        "ALT" | "LEFTALT" | "RIGHTALT" | "LALT" | "RALT" => "ALT".into(),
        "WIN" | "META" | "SUPER" | "LEFTWIN" | "RIGHTWIN" => "WIN".into(),
        "RETURN" => "ENTER".into(),
        "ESCAPE" => "ESC".into(),
        normalized => normalized.to_string(),
    }
}

fn elapsed_hook_ms(route: &HookRoute) -> u64 {
    route.started_at.elapsed().as_millis() as u64
}

#[cfg(windows)]
fn run_hooks(control: Arc<RecorderControl>, ready: std::sync::mpsc::Sender<Result<(), String>>) {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{GetLastError, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL,
        WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
        WM_QUIT, WM_RBUTTONDOWN, WM_RBUTTONUP,
    };

    unsafe extern "system" fn mouse_hook(code: i32, w_param: WPARAM, l_param: LPARAM) -> LRESULT {
        if code >= 0 {
            let data = &*(l_param as *const MSLLHOOKSTRUCT);
            if data.flags & 0x01 == 0 && data.dwExtraInfo != crate::engine::AUTOCLICKER_EXTRA_INFO {
                let sender = hook_sender_for_callback();
                if let Some(sender) = sender {
                    let kind = match w_param as u32 {
                        WM_MOUSEMOVE => {
                            if !sender.record_cursor_movement
                                && sender.buttons_down.load(Ordering::Relaxed) == 0
                            {
                                return CallNextHookEx(
                                    std::ptr::null_mut::<c_void>() as HHOOK,
                                    code,
                                    w_param,
                                    l_param,
                                );
                            }
                            let now = elapsed_hook_ms(&sender);
                            let dragging = sender.buttons_down.load(Ordering::Relaxed) != 0;
                            let minimum_interval_ms = if dragging { 8 } else { 25 };
                            let previous = sender.last_move_ms.load(Ordering::Relaxed);
                            if now.saturating_sub(previous) < minimum_interval_ms {
                                return CallNextHookEx(
                                    std::ptr::null_mut::<c_void>() as HHOOK,
                                    code,
                                    w_param,
                                    l_param,
                                );
                            }
                            sender.last_move_ms.store(now, Ordering::Relaxed);
                            RecordedKind::Move {
                                x: data.pt.x,
                                y: data.pt.y,
                            }
                        }
                        WM_LBUTTONDOWN => {
                            sender
                                .buttons_down
                                .fetch_or(LEFT_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "left".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
                            }
                        }
                        WM_LBUTTONUP => {
                            sender
                                .buttons_down
                                .fetch_and(!LEFT_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "left".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
                            }
                        }
                        WM_RBUTTONDOWN => {
                            sender
                                .buttons_down
                                .fetch_or(RIGHT_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "right".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
                            }
                        }
                        WM_RBUTTONUP => {
                            sender
                                .buttons_down
                                .fetch_and(!RIGHT_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "right".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
                            }
                        }
                        WM_MBUTTONDOWN => {
                            sender
                                .buttons_down
                                .fetch_or(MIDDLE_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseDown {
                                button: "middle".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
                            }
                        }
                        WM_MBUTTONUP => {
                            sender
                                .buttons_down
                                .fetch_and(!MIDDLE_BUTTON_DOWN, Ordering::Relaxed);
                            RecordedKind::MouseUp {
                                button: "middle".into(),
                                x: Some(data.pt.x),
                                y: Some(data.pt.y),
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
                        at_ms: elapsed_hook_ms(&sender),
                        kind,
                    };
                    enqueue_recorded_event(&sender, event);
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

    let route = hook_sender()
        .lock()
        .unwrap_or_else(crate::error::poisoned_inner)
        .as_ref()
        .filter(|route| route.session_id == control.id)
        .cloned();
    let Some(route) = route else {
        let _ = ready.send(Err(
            "The recording session ended before hooks started.".into()
        ));
        let _ = control.sender.send(None);
        return;
    };
    RECORDER_HOOK_CONTEXT.with(|context| {
        *context.borrow_mut() = Some(route.clone());
    });
    route.buttons_down.store(0, Ordering::Relaxed);
    route.last_move_ms.store(0, Ordering::Relaxed);
    let mut message: MSG = unsafe { std::mem::zeroed() };
    unsafe {
        PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, 0);
    }
    let thread_id = unsafe { GetCurrentThreadId() };
    control.hook_thread_id.store(thread_id, Ordering::SeqCst);
    if !control.active.load(Ordering::SeqCst) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                thread_id, WM_QUIT, 0, 0,
            );
        }
    }

    let mouse: HHOOK =
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), std::ptr::null_mut(), 0) };
    let mouse_error = if mouse.is_null() {
        unsafe { GetLastError() }
    } else {
        0
    };
    if mouse.is_null() {
        let _ = ready.send(Err(format!(
            "Windows could not install the low-level mouse recording hook (system error {mouse_error})."
        )));
    } else {
        let _ = ready.send(Ok(()));
        let mut message: MSG = unsafe { std::mem::zeroed() };
        while control.active.load(Ordering::SeqCst)
            && unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0
        {
            unsafe {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if !control.active.load(Ordering::SeqCst) {
                break;
            }
        }
        unsafe {
            UnhookWindowsHookEx(mouse);
        }
    }
    RECORDER_HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
    clear_hook_sender_for(&control.id);
    let _ = control.sender.send(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_route_is_scoped_to_its_recording_session() {
        let (sender, _receiver) = std::sync::mpsc::sync_channel(EVENT_BUFFER);
        let route = Arc::new(HookRoute {
            session_id: "new-session".into(),
            active: Arc::new(AtomicBool::new(true)),
            sender,
            dropped_events: Arc::new(AtomicU32::new(0)),
            record_cursor_movement: false,
            buttons_down: Arc::new(AtomicU32::new(0)),
            last_move_ms: Arc::new(AtomicU64::new(0)),
            started_at: Instant::now(),
        });

        assert!(route_for_session(Some(&route), "old-session").is_none());
        assert!(route_for_session(Some(&route), "new-session").is_some());
        assert!(route_for_session(None, "new-session").is_none());
        RECORDER_HOOK_CONTEXT.with(|context| *context.borrow_mut() = Some(route.clone()));
        assert!(hook_sender_for_callback().is_some());
        route.active.store(false, Ordering::SeqCst);
        assert!(hook_sender_for_callback().is_none());
        RECORDER_HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
    }

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
            RecordedKind::MouseDown { ref button, x: None, y: None } if button == "left"
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
                    x: Some(10),
                    y: Some(20),
                },
            },
            RecordedEvent {
                at_ms: 245,
                kind: RecordedKind::MouseUp {
                    button: "left".into(),
                    x: Some(10),
                    y: Some(20),
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
        assert!(source.contains("move x=10 y=20 space=screen\nmouse_down button=left"));
        assert!(source.contains("wait 75ms"));
    }

    #[test]
    fn recorder_replays_click_coordinates_when_cursor_movement_is_disabled() {
        let events = vec![
            RecordedEvent {
                at_ms: 0,
                kind: RecordedKind::MouseDown {
                    button: "left".into(),
                    x: Some(640),
                    y: Some(360),
                },
            },
            RecordedEvent {
                at_ms: 60,
                kind: RecordedKind::MouseUp {
                    button: "left".into(),
                    x: Some(640),
                    y: Some(360),
                },
            },
        ];
        let source = events_to_script(&events, &[]);

        assert!(source.contains("move x=640 y=360 space=screen\nmouse_down button=left"));
        assert!(source.contains("wait 60ms\nmouse_up button=left"));
        assert!(crate::macro_engine::validate_source(&source).ok);
    }

    #[test]
    fn recorder_drops_keyboard_events() {
        let mut buttons_down = 0;
        let mut last_kept_move = None;

        for kind in [
            RecordedKind::KeyDown { key: "A".into() },
            RecordedKind::KeyUp { key: "A".into() },
        ] {
            let keyboard_event = RecordedEvent { at_ms: 0, kind };
            assert!(!should_keep_event(
                &keyboard_event,
                false,
                &mut buttons_down,
                &mut last_kept_move,
            ));
        }

        let scroll_event = RecordedEvent {
            at_ms: 25,
            kind: RecordedKind::Scroll {
                delta: -120,
                x: 100,
                y: 200,
            },
        };
        assert!(should_keep_event(
            &scroll_event,
            false,
            &mut buttons_down,
            &mut last_kept_move,
        ));
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

    #[test]
    fn shortcut_filter_tracks_left_and_right_modifier_aliases_independently() {
        let events = vec![
            RecordedEvent {
                at_ms: 0,
                kind: RecordedKind::KeyDown {
                    key: "LEFTCTRL".into(),
                },
            },
            RecordedEvent {
                at_ms: 1,
                kind: RecordedKind::KeyDown {
                    key: "RIGHTCTRL".into(),
                },
            },
            RecordedEvent {
                at_ms: 2,
                kind: RecordedKind::KeyDown { key: "A".into() },
            },
            RecordedEvent {
                at_ms: 3,
                kind: RecordedKind::KeyUp {
                    key: "LEFTCTRL".into(),
                },
            },
            RecordedEvent {
                at_ms: 4,
                kind: RecordedKind::KeyUp { key: "A".into() },
            },
            RecordedEvent {
                at_ms: 5,
                kind: RecordedKind::KeyDown { key: "B".into() },
            },
            RecordedEvent {
                at_ms: 6,
                kind: RecordedKind::KeyUp {
                    key: "RIGHTCTRL".into(),
                },
            },
            RecordedEvent {
                at_ms: 7,
                kind: RecordedKind::KeyUp { key: "B".into() },
            },
        ];

        let filtered = filter_shortcut_events(&events, &["CTRL+A".into()]);
        assert_eq!(filtered.len(), 2);
        assert!(matches!(
            &filtered[0].kind,
            RecordedKind::KeyDown { key } if key.as_str() == "B"
        ));
        assert!(matches!(
            &filtered[1].kind,
            RecordedKind::KeyUp { key } if key.as_str() == "B"
        ));
    }
}
