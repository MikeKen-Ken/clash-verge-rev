//! Watches the live window and applies the liveness decision.
//! Sleep and wake come from the Windows suspend notification, because Tauri's
//! `RunEvent::Resumed` on Windows is the event-loop poll cause, not power resume.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// A lock, suspend or hide shorter than this is not worth a WebView reload.
const LONG_ABSENCE_MS: u64 = 5 * 60 * 1000;
/// A tick gap this large means the watcher itself did not run for a while.
const TICK_GAP_MS: u64 = 60 * 1000;
/// Never issue two recovery reloads this close together.
const RECOVERY_COOLDOWN_MS: u64 = 10 * 1000;
const SUPPRESS_LOG_INTERVAL_MS: u64 = 60 * 1000;

fn monotonic_ms() -> u64 {
    static BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(Instant::now).elapsed().as_millis() as u64
}

static STATE: Mutex<WindowLiveness> = Mutex::new(WindowLiveness::new());
static STARTED: AtomicBool = AtomicBool::new(false);
static RESUME_PENDING: AtomicBool = AtomicBool::new(false);
/// Monotonic time the session or the window stopped being usable, 0 = present.
static AWAY_SINCE_MS: AtomicU64 = AtomicU64::new(0);
static HIDDEN_SINCE_MS: AtomicU64 = AtomicU64::new(0);
static LAST_TICK_MS: AtomicU64 = AtomicU64::new(0);
static LAST_RECOVERY_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SUPPRESS_LOG_MS: AtomicU64 = AtomicU64::new(0);

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
        // The machine woke up behind the lock screen; keep the flag for the
        // unlock path instead of reloading a WebView nobody can see.
        note_absence(now_ms);
        return;
    }
    let on_screen = window_on_screen();
    logging!(
        info,
        Type::Window,
        "Desktop resumed; checking whether the main window still answers (on_screen={on_screen})"
    );
    // Only a long absence reloads the page (see `resume_from_absence`, which
    // runs right after this in the same tick). A short sleep just arms the
    // heartbeat probe, so a healthy WebView is left alone.
    STATE.lock().note_resume(now_ms, on_screen);
}

pub fn note_window_shown() {
    STATE.lock().note_show(monotonic_ms());
}

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
        note_absence(last_tick_ms);
    }

    if RESUME_PENDING.swap(false, Ordering::AcqRel) {
        note_system_resume(now_ms);
    }

    // Never probe or rebuild the window while the secure desktop is up: the
    // fresh WebView would be created behind the lock screen and only surface as
    // a blank window after the user unlocks.
    if !session_interactive() {
        note_absence(now_ms);
        return;
    }

    let on_screen = window_on_screen();
    resume_from_absence(now_ms, on_screen);
    track_visibility(now_ms, on_screen);

    let gate = LivenessGate {
        window_exists: WindowManager::get_main_window().is_some(),
        window_on_screen: on_screen,
        lightweight: lightweight::is_in_lightweight_mode(),
        exiting: false,
    };
    let skip_ui_probe = STATE.lock().ui_probe_paused();
    if gate.window_on_screen
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

fn window_on_screen() -> bool {
    use crate::utils::window_manager::WindowState;
    matches!(
        WindowManager::get_main_window_state(),
        WindowState::VisibleFocused | WindowState::VisibleUnfocused
    )
}

/// Remember when the session or the window became unusable.
fn note_absence(now_ms: u64) {
    let _ = AWAY_SINCE_MS.compare_exchange(0, now_ms, Ordering::AcqRel, Ordering::Relaxed);
}

/// After a long lock, suspend or hide, reload the page once the window is back
/// on screen instead of waiting for the heartbeat to time out and rebuilding it.
fn resume_from_absence(now_ms: u64, on_screen: bool) {
    if !on_screen {
        return;
    }
    let since = AWAY_SINCE_MS.swap(0, Ordering::AcqRel);
    if since == 0 || now_ms.saturating_sub(since) < LONG_ABSENCE_MS {
        return;
    }
    if !matches!(recover_webview(now_ms, "a long lock or suspend"), Some(true)) {
        STATE.lock().note_resume(now_ms, true);
    }
}

fn track_visibility(now_ms: u64, on_screen: bool) {
    if !on_screen {
        let _ = HIDDEN_SINCE_MS.compare_exchange(0, now_ms, Ordering::AcqRel, Ordering::Relaxed);
        return;
    }
    let hidden_since = HIDDEN_SINCE_MS.swap(0, Ordering::AcqRel);
    if hidden_since != 0
        && now_ms.saturating_sub(hidden_since) >= LONG_ABSENCE_MS
        && !matches!(recover_webview(now_ms, "a long time hidden"), Some(true))
    {
        STATE.lock().note_resume(now_ms, true);
    }
}

/// Reload the main page without touching the proxy core.
/// `None` means the recovery cooldown skipped this call.
fn recover_webview(now_ms: u64, reason: &'static str) -> Option<bool> {
    if now_ms.saturating_sub(LAST_RECOVERY_MS.load(Ordering::Acquire)) < RECOVERY_COOLDOWN_MS {
        return None;
    }
    if WindowManager::get_main_window().is_none() {
        return Some(false);
    }
    LAST_RECOVERY_MS.store(now_ms, Ordering::Release);
    // The reload restarts the page, so give it a fresh heartbeat window before
    // the watchdog treats it as dead. The script is posted from the async
    // handler so a busy UI thread cannot block this watcher.
    STATE.lock().note_heartbeat(now_ms);
    AsyncHandler::spawn(move || async move {
        let Some(window) = WindowManager::get_main_window() else {
            return;
        };
        match window.eval("window.location.reload()") {
            Ok(()) => logging!(warn, Type::Window, "Reloaded the main WebView after {reason}"),
            Err(err) => logging!(
                warn,
                Type::Window,
                "Reloading the main WebView after {reason} failed: {err}"
            ),
        }
    });
    Some(true)
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

    let window = WindowManager::get_main_window()?;
    let hwnd = window.hwnd().ok()?;
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
