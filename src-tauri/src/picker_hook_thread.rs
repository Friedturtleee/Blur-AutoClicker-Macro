use std::sync::mpsc;
use std::time::Duration;

use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetMessageW, PeekMessageW, SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, HOOKPROC, MSG,
    WH_KEYBOARD_LL, WH_MOUSE_LL,
};

use crate::error::{AppError, AppResult};

pub fn start_low_level_picker_hooks(
    thread_name: &'static str,
    picker_name: &'static str,
    mouse_proc: HOOKPROC,
    keyboard_proc: HOOKPROC,
    reserve_thread: impl Fn(u32) -> bool + Send + 'static,
    publish_hooks: impl Fn(u32, HHOOK, HHOOK) -> bool + Send + 'static,
    clear_hooks: impl Fn(u32, HHOOK, HHOOK) + Send + 'static,
) -> AppResult<()> {
    let (ready_tx, ready_rx) = mpsc::channel();
    let cancellation_message = format!("{picker_name} was cancelled during startup.");
    let hook_thread = std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || unsafe {
            let mut initial_message = std::mem::zeroed::<MSG>();
            // Create the queue before publishing the thread ID so cancellation
            // can post WM_QUIT even while hooks are still starting.
            PeekMessageW(&mut initial_message, std::ptr::null_mut(), 0, 0, 0);
            let thread_id = GetCurrentThreadId();
            if !reserve_thread(thread_id) {
                let _ = ready_tx.send(Err(AppError::State(cancellation_message.clone())));
                return;
            }

            let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_proc, std::ptr::null_mut(), 0);
            if mouse_hook.is_null() {
                let error_code = GetLastError();
                clear_hooks(thread_id, std::ptr::null_mut(), std::ptr::null_mut());
                let _ = ready_tx.send(Err(AppError::WindowsSystem(error_code)));
                return;
            }

            let keyboard_hook =
                SetWindowsHookExW(WH_KEYBOARD_LL, keyboard_proc, std::ptr::null_mut(), 0);
            if keyboard_hook.is_null() {
                let error_code = GetLastError();
                UnhookWindowsHookEx(mouse_hook);
                clear_hooks(thread_id, std::ptr::null_mut(), std::ptr::null_mut());
                let _ = ready_tx.send(Err(AppError::WindowsSystem(error_code)));
                return;
            }

            if publish_hooks(thread_id, mouse_hook, keyboard_hook) {
                let _ = ready_tx.send(Ok(()));
                let mut message = std::mem::zeroed::<MSG>();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {}
            } else {
                UnhookWindowsHookEx(mouse_hook);
                UnhookWindowsHookEx(keyboard_hook);
                clear_hooks(thread_id, mouse_hook, keyboard_hook);
                let _ = ready_tx.send(Err(AppError::State(cancellation_message)));
                return;
            }

            UnhookWindowsHookEx(mouse_hook);
            UnhookWindowsHookEx(keyboard_hook);
            clear_hooks(thread_id, mouse_hook, keyboard_hook);
        })
        .map_err(|error| {
            AppError::State(format!("Could not start {picker_name} hooks: {error}"))
        })?;

    drop(hook_thread);
    match ready_rx.recv_timeout(Duration::from_secs(1)) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(AppError::ChannelFailure),
    }
}
