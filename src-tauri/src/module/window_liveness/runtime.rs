//! Watches the live window and applies the liveness decision.
//! Sleep and wake come from the Windows suspend notification, because Tauri's
//! `RunEvent::Resumed` on Windows is the event-loop poll cause, not power resume.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use clash_verge_logging::{Type, logging};
use parking_lot::Mutex;

use super::{LivenessAction, LivenessGate, WindowLiveness};
use crate::{
    core::handle,
    module::lightweight,
    process::AsyncHandler,
    utils::{server, window_manager::WindowManager},
};

const HARD_RESTART_COOLDOWN: Duration = Duration::from_secs(10 * 60);
const WATCH_INTERVAL: Duration = Duration::from_secs(2);

/// A tick gap this large means the watcher itself did not run for a while.
const TICK_GAP_MS: u64 = 60 * 1000;
const SUPPRESS_LOG_INTERVAL_MS: u64 = 60 * 1000;

fn monotonic_ms() -> u64 {
    static BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

static STATE: Mutex<WindowLiveness> = Mutex::new(WindowLiveness::new());
static STARTED: AtomicBool = AtomicBool::new(false);
static RESUME_PENDING: AtomicBool = AtomicBool::new(false);
/// The session was locked, or the watcher missed a stretch of time.
static AWAY_PENDING: AtomicBool = AtomicBool::new(false);
static LAST_TICK_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SUPPRESS_LOG_MS: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static MAIN_WINDOW_HWND: AtomicIsize = AtomicIsize::new(0);

pub fn start() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    register_resume_notifications();
    std::thread::Builder::new()
        .name("window-liveness".into())
        .spawn(|| {
            loop {
                std::thread::sleep(WATCH_INTERVAL);
                tick();
            }
        })
        .ok();
}

pub fn note_heartbeat() {
    STATE.lock().note_heartbeat(monotonic_ms());
}

fn note_system_resume(now_ms: u64) {
    if handle::Handle::global().is_exiting() {
        return;
    }
    if !session_interactive() {
        // The machine woke up behind the lock screen. Wait until unlock
        // before probing a window nobody can see.
        AWAY_PENDING.store(true, Ordering::Release);
        return;
    }
    let on_screen = window_on_screen();
    logging!(
        info,
        Type::Window,
        "Desktop resumed; checking whether the main window still answers (on_screen={on_screen})"
    );
    // Arm the heartbeat probe only. A healthy page keeps running.
    STATE.lock().note_resume(now_ms, on_screen);
}

pub fn note_window_shown() {
    STATE.lock().note_show(monotonic_ms());
}

#[cfg(windows)]
pub fn note_window_created(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        MAIN_WINDOW_HWND.store(hwnd.0 as isize, Ordering::Release);
    }
}

#[cfg(not(windows))]
pub fn note_window_created(_window: &tauri::WebviewWindow) {}

#[cfg(windows)]
pub fn note_window_destroyed() {
    MAIN_WINDOW_HWND.store(0, Ordering::Release);
}

#[cfg(not(windows))]
pub fn note_window_destroyed() {}

pub fn should_yield_to_next_instance() -> bool {
    let on_screen = window_on_screen();
    STATE.lock().should_yield_to_next_instance(monotonic_ms(), on_screen)
}

fn tick() {
    if handle::Handle::global().is_exiting() {
        return;
    }
    let now_ms = monotonic_ms();

    // A long gap between two ticks means this thread (and the machine) was
    // suspended, even if no power notification reached us.
    let last_tick_ms = LAST_TICK_MS.swap(now_ms, Ordering::AcqRel);
    if last_tick_ms != 0 && now_ms.saturating_sub(last_tick_ms) >= TICK_GAP_MS {
        AWAY_PENDING.store(true, Ordering::Release);
    }

    let resume_pending = RESUME_PENDING.swap(false, Ordering::AcqRel);

    // Never probe or rebuild the window while the secure desktop is up: the
    // fresh WebView would be created behind the lock screen and only surface as
    // a blank window after the user unlocks.
    if !session_interactive() {
        AWAY_PENDING.store(true, Ordering::Release);
        return;
    }

    let on_screen = window_on_screen();
    if resume_pending {
        AWAY_PENDING.store(false, Ordering::Release);
        note_system_resume(now_ms);
    } else if AWAY_PENDING.swap(false, Ordering::AcqRel) {
        STATE.lock().note_resume(now_ms, on_screen);
    }

    let gate = LivenessGate {
        window_exists: window_exists(),
        window_on_screen: on_screen,
        lightweight: lightweight::is_in_lightweight_mode(),
        exiting: false,
    };
    let skip_ui_probe = STATE.lock().ui_probe_paused();
    if gate.window_exists
        && !gate.lightweight
        && !skip_ui_probe
        && let Some(responsive) = ui_thread_responsive()
    {
        let action = STATE.lock().note_ui_probe(now_ms, responsive);
        if action != LivenessAction::None {
            execute(action);
            return;
        }
    }
    let action = STATE.lock().poll(now_ms, gate);
    execute(action);
}

#[cfg(windows)]
fn cached_valid_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    let raw = MAIN_WINDOW_HWND.load(Ordering::Acquire);
    if raw == 0 {
        return None;
    }
    let hwnd = HWND(raw as *mut std::ffi::c_void);
    if unsafe { IsWindow(Some(hwnd)).as_bool() } {
        return Some(hwnd);
    }
    let _ = MAIN_WINDOW_HWND.compare_exchange(raw, 0, Ordering::AcqRel, Ordering::Acquire);
    None
}

#[cfg(windows)]
fn window_exists() -> bool {
    cached_valid_hwnd().is_some()
}

#[cfg(not(windows))]
fn window_exists() -> bool {
    WindowManager::get_main_window().is_some()
}

#[cfg(windows)]
fn window_on_screen() -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};

    cached_valid_hwnd().is_some_and(|hwnd| unsafe { IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() })
}

#[cfg(not(windows))]
fn window_on_screen() -> bool {
    use crate::utils::window_manager::WindowState;
    matches!(
        WindowManager::get_main_window_state(),
        WindowState::VisibleFocused | WindowState::VisibleUnfocused
    )
}

fn execute(action: LivenessAction) {
    match action {
        LivenessAction::None => {}
        LivenessAction::RecreateWindow => {
            logging!(
                warn,
                Type::Window,
                "Main window stopped answering; recreating the WebView"
            );
            AsyncHandler::spawn(|| async {
                WindowManager::destroy_main_window();
                if !WindowManager::create_window(true).await {
                    logging!(error, Type::Window, "Recreating the main window failed");
                }
            });
        }
        LivenessAction::HardRestart => hard_restart(),
    }
}

fn hard_restart() {
    if !hard_restart_cooldown_elapsed() {
        let now_ms = monotonic_ms();
        if now_ms.saturating_sub(LAST_SUPPRESS_LOG_MS.load(Ordering::Acquire)) >= SUPPRESS_LOG_INTERVAL_MS {
            LAST_SUPPRESS_LOG_MS.store(now_ms, Ordering::Release);
            logging!(
                warn,
                Type::Window,
                "Main window is stuck, but a UI restart already happened recently"
            );
        }
        // Leaving `hard_restart_sent` set here would disable the watchdog
        // forever: no heartbeat arrives while the UI is dead, and every later
        // action is gated by that flag.
        STATE.lock().clear_hard_restart();
        return;
    }
    logging!(
        error,
        Type::Window,
        "Main window cannot be rebuilt; restarting the UI process"
    );
    if let Err(error) = spawn_delayed_relaunch() {
        logging!(error, Type::Window, "Failed to schedule a UI relaunch: {error}");
        STATE.lock().clear_hard_restart();
        return;
    }
    record_hard_restart();
    handle::Handle::global().set_is_exiting();
    server::shutdown_embedded_server();
    std::process::exit(0);
}

fn restart_stamp_path() -> std::path::PathBuf {
    std::env::temp_dir().join("clash-verge-window-liveness-restart")
}

fn hard_restart_cooldown_elapsed() -> bool {
    let Ok(text) = std::fs::read_to_string(restart_stamp_path()) else {
        return true;
    };
    let Ok(then) = text.trim().parse::<u64>() else {
        return true;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now.saturating_sub(then) >= HARD_RESTART_COOLDOWN.as_secs()
}

fn record_hard_restart() {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let _ = std::fs::write(restart_stamp_path(), now.to_string());
}

fn spawn_delayed_relaunch() -> std::io::Result<()> {
    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!("ping -n 3 127.0.0.1 >nul & start \"\" \"{}\"", exe.replace('"', ""));
        std::process::Command::new("cmd")
            .args(["/C", script.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("sh")
            .args(["-c", "sleep 2; exec \"$1\"", "sh", exe.as_str()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
    }
    Ok(())
}

#[cfg(windows)]
fn register_resume_notifications() {
    use std::ffi::c_void;

    const DEVICE_NOTIFY_CALLBACK: u32 = 2;

    #[repr(C)]
    struct Subscribe {
        callback: unsafe extern "system" fn(*const c_void, u32, *const c_void) -> u32,
        context: *const c_void,
    }

    unsafe extern "system" fn on_resume(_: *const c_void, kind: u32, _: *const c_void) -> u32 {
        const PBT_APMRESUMESUSPEND: u32 = 7;
        const PBT_APMRESUMEAUTOMATIC: u32 = 18;
        if kind == PBT_APMRESUMESUSPEND || kind == PBT_APMRESUMEAUTOMATIC {
            RESUME_PENDING.store(true, Ordering::Release);
        }
        0
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn RegisterSuspendResumeNotification(recipient: *mut c_void, flags: u32) -> *mut c_void;
    }

    // Leaked for the process lifetime. The OS calls back into this registration.
    let params = Box::leak(Box::new(Subscribe {
        callback: on_resume,
        context: std::ptr::null(),
    }));
    let handle = unsafe {
        RegisterSuspendResumeNotification(std::ptr::from_mut(params).cast::<c_void>(), DEVICE_NOTIFY_CALLBACK)
    };
    if handle.is_null() {
        logging!(
            warn,
            Type::Window,
            "Suspend/resume notifications were not registered; window recovery falls back to the heartbeat"
        );
    }
}

#[cfg(not(windows))]
const fn register_resume_notifications() {}

#[cfg(windows)]
fn session_interactive() -> bool {
    use std::ffi::c_void;

    const UOI_NAME: i32 = 2;
    const DESKTOP_READOBJECTS: u32 = 0x0001;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> *mut c_void;
        fn CloseDesktop(desktop: *mut c_void) -> i32;
        fn GetUserObjectInformationW(
            object: *mut c_void,
            index: i32,
            info: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }

    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            // The secure desktop (lock screen, UAC) refuses this session.
            return false;
        }
        let mut name = [0u16; 128];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            name.as_mut_ptr().cast(),
            (name.len() * std::mem::size_of::<u16>()) as u32,
            &mut needed,
        );
        let _ = CloseDesktop(desktop);
        if ok == 0 {
            return false;
        }
        let end = name.iter().position(|&unit| unit == 0).unwrap_or(name.len());
        String::from_utf16_lossy(&name[..end]).eq_ignore_ascii_case("Default")
    }
}

#[cfg(not(windows))]
const fn session_interactive() -> bool {
    true
}

#[cfg(windows)]
fn ui_thread_responsive() -> Option<bool> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_NULL};

    let hwnd = cached_valid_hwnd()?;
    let mut result = 0usize;
    // Nonzero means the UI thread handled the message. WM_NULL's own result is written to `result`.
    let answered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_NULL,
            WPARAM(0),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            1_000,
            Some(&mut result),
        )
    };
    let _ = result;
    Some(answered.0 != 0)
}

#[cfg(not(windows))]
fn ui_thread_responsive() -> Option<bool> {
    None
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn unset_and_invalid_cached_hwnd_are_ignored_without_touching_webview_lock() {
        MAIN_WINDOW_HWND.store(0, Ordering::Release);
        assert!(cached_valid_hwnd().is_none());
        assert!(!window_exists());
        assert!(!window_on_screen());
        assert_eq!(ui_thread_responsive(), None);

        MAIN_WINDOW_HWND.store(0x7fff_dead, Ordering::Release);
        assert!(cached_valid_hwnd().is_none());
        assert_eq!(MAIN_WINDOW_HWND.load(Ordering::Acquire), 0);
        assert!(!window_on_screen());
        assert_eq!(ui_thread_responsive(), None);
    }
}
