//! Decides when a desktop window that stopped painting should be rebuilt.
//! The proxy core is a different process and is left alone.
//!
//! The page posts a heartbeat from `requestAnimationFrame`. A dead WebView
//! stops painting, so the heartbeat stops even if the Rust process is fine.
//! A stuck native UI thread is reported separately and restarts the UI process,
//! because that thread cannot rebuild the window.

mod runtime;

pub use runtime::{note_heartbeat, note_window_shown, should_yield_to_next_instance, start};

/// What a second launch should do with the process that already holds the singleton port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExistingInstance {
    /// The running app answered, so this launch only asks it to show the window.
    Keep,
    /// The running app is stuck or silent, so this launch replaces it.
    Replace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthReply {
    Ok,
    Stuck,
    Other,
    Unreachable,
}

pub fn classify_health(reached: bool, body: &str) -> HealthReply {
    if !reached {
        return HealthReply::Unreachable;
    }
    match body.trim() {
        "ok" => HealthReply::Ok,
        "stuck" => HealthReply::Stuck,
        _ => HealthReply::Other,
    }
}

/// `visible_ok` matters only when the listener replied with something other than ok/stuck.
pub fn handoff(health: HealthReply, visible_ok: bool) -> ExistingInstance {
    match health {
        HealthReply::Ok => ExistingInstance::Keep,
        HealthReply::Stuck | HealthReply::Unreachable => ExistingInstance::Replace,
        HealthReply::Other => {
            if visible_ok {
                ExistingInstance::Keep
            } else {
                ExistingInstance::Replace
            }
        }
    }
}

const PROBE_GRACE_MS: u64 = 20_000;
const STALE_MS: u64 = 30_000;
const RECREATE_COOLDOWN_MS: u64 = 45_000;
const GENERATION_GRACE_MS: u64 = 45_000;
const UI_FAILURES_BEFORE_RESTART: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LivenessAction {
    None,
    RecreateWindow,
    HardRestart,
}

#[derive(Debug, Clone, Copy)]
pub struct LivenessGate {
    pub window_exists: bool,
    pub window_on_screen: bool,
    pub lightweight: bool,
    pub exiting: bool,
}

#[derive(Debug)]
pub struct WindowLiveness {
    ever_alive: bool,
    last_heartbeat_ms: Option<u64>,
    fresh_after_ms: Option<u64>,
    probe_deadline_ms: Option<u64>,
    probe_on_show: bool,
    on_screen_since_ms: Option<u64>,
    last_recreate_ms: Option<u64>,
    awaiting_generation: bool,
    generation_deadline_ms: Option<u64>,
    hard_restart_sent: bool,
    ui_failures: u8,
}

impl WindowLiveness {
    pub const fn new() -> Self {
        Self {
            ever_alive: false,
            last_heartbeat_ms: None,
            fresh_after_ms: None,
            probe_deadline_ms: None,
            probe_on_show: false,
            on_screen_since_ms: None,
            last_recreate_ms: None,
            awaiting_generation: false,
            generation_deadline_ms: None,
            hard_restart_sent: false,
            ui_failures: 0,
        }
    }

    pub const fn ui_probe_paused(&self) -> bool {
        self.awaiting_generation || self.hard_restart_sent
    }

    pub fn note_heartbeat(&mut self, now_ms: u64) {
        self.ever_alive = true;
        self.last_heartbeat_ms = Some(now_ms);
        self.awaiting_generation = false;
        self.generation_deadline_ms = None;
        self.ui_failures = 0;
        if self.fresh_after_ms.is_some_and(|fresh| now_ms >= fresh) {
            self.fresh_after_ms = None;
            self.probe_deadline_ms = None;
            self.probe_on_show = false;
        }
    }

    pub fn note_resume(&mut self, now_ms: u64, window_on_screen: bool) {
        if !self.ever_alive || self.hard_restart_sent {
            return;
        }
        self.on_screen_since_ms = None;
        if window_on_screen {
            self.on_screen_since_ms = Some(now_ms);
            self.arm_probe(now_ms);
        } else {
            self.probe_on_show = true;
            self.fresh_after_ms = None;
            self.probe_deadline_ms = None;
        }
    }

    pub fn note_show(&mut self, now_ms: u64) {
        if self.probe_on_show {
            self.arm_probe(now_ms);
        }
    }

    pub fn note_ui_probe(&mut self, now_ms: u64, responsive: bool) -> LivenessAction {
        if responsive {
            self.ui_failures = 0;
            return LivenessAction::None;
        }
        let blocked =
            !self.ever_alive || self.hard_restart_sent || self.awaiting_generation || !self.cooldown_ok(now_ms);
        if blocked {
            return LivenessAction::None;
        }
        self.ui_failures = self.ui_failures.saturating_add(1);
        if self.ui_failures < UI_FAILURES_BEFORE_RESTART {
            return LivenessAction::None;
        }
        self.hard_restart_sent = true;
        LivenessAction::HardRestart
    }

    pub fn clear_hard_restart(&mut self) {
        self.hard_restart_sent = false;
        self.ui_failures = 0;
    }

    /// The window is trapped: closing it only hides the process, and a new launch must replace it.
    pub fn should_yield_to_next_instance(&self, now_ms: u64, window_on_screen: bool) -> bool {
        if self.hard_restart_sent || self.ui_failures >= UI_FAILURES_BEFORE_RESTART {
            return true;
        }
        if self.probe_deadline_ms.is_some_and(|deadline| now_ms >= deadline) {
            return true;
        }
        if !self.ever_alive || !window_on_screen {
            return false;
        }
        let heartbeat_age = self
            .last_heartbeat_ms
            .map(|last| now_ms.saturating_sub(last))
            .unwrap_or(0);
        let visible_for = self
            .on_screen_since_ms
            .map(|since| now_ms.saturating_sub(since))
            .unwrap_or(0);
        heartbeat_age >= STALE_MS && visible_for >= STALE_MS
    }

    pub fn poll(&mut self, now_ms: u64, gate: LivenessGate) -> LivenessAction {
        if let Some(action) = self.pending_restart(now_ms) {
            return action;
        }
        if self.gate_blocks(gate) {
            return LivenessAction::None;
        }
        if self.on_screen_since_ms.is_none() {
            self.on_screen_since_ms = Some(now_ms);
        }
        if !self.cooldown_ok(now_ms) {
            return LivenessAction::None;
        }
        self.due_action(now_ms)
    }

    fn pending_restart(&mut self, now_ms: u64) -> Option<LivenessAction> {
        if self.hard_restart_sent {
            return Some(LivenessAction::None);
        }
        if self.awaiting_generation && self.generation_deadline_ms.is_some_and(|deadline| now_ms >= deadline) {
            self.hard_restart_sent = true;
            return Some(LivenessAction::HardRestart);
        }
        None
    }

    fn gate_blocks(&mut self, gate: LivenessGate) -> bool {
        if gate.exiting || gate.lightweight {
            self.probe_on_show = false;
            self.probe_deadline_ms = None;
            self.fresh_after_ms = None;
            self.on_screen_since_ms = None;
            return true;
        }
        if !gate.window_exists || !gate.window_on_screen {
            self.on_screen_since_ms = None;
            return true;
        }
        false
    }

    fn due_action(&mut self, now_ms: u64) -> LivenessAction {
        if let Some(deadline) = self.probe_deadline_ms
            && now_ms >= deadline
        {
            self.begin_generation(now_ms);
            return LivenessAction::RecreateWindow;
        }
        if self.probe_deadline_ms.is_some() || self.awaiting_generation || !self.ever_alive {
            return LivenessAction::None;
        }
        let heartbeat_age = self
            .last_heartbeat_ms
            .map(|last| now_ms.saturating_sub(last))
            .unwrap_or(0);
        let visible_for = self
            .on_screen_since_ms
            .map(|since| now_ms.saturating_sub(since))
            .unwrap_or(0);
        if heartbeat_age >= STALE_MS && visible_for >= STALE_MS {
            self.begin_generation(now_ms);
            return LivenessAction::RecreateWindow;
        }
        LivenessAction::None
    }

    fn arm_probe(&mut self, now_ms: u64) {
        self.fresh_after_ms = Some(now_ms);
        self.probe_deadline_ms = Some(now_ms.saturating_add(PROBE_GRACE_MS));
        self.probe_on_show = false;
    }

    fn begin_generation(&mut self, now_ms: u64) {
        self.last_recreate_ms = Some(now_ms);
        self.awaiting_generation = true;
        self.generation_deadline_ms = Some(now_ms.saturating_add(GENERATION_GRACE_MS));
        self.probe_deadline_ms = None;
        self.fresh_after_ms = None;
        self.probe_on_show = false;
        self.on_screen_since_ms = Some(now_ms);
        self.ui_failures = 0;
    }

    fn cooldown_ok(&self, now_ms: u64) -> bool {
        self.last_recreate_ms
            .is_none_or(|last| now_ms.saturating_sub(last) >= RECREATE_COOLDOWN_MS)
    }
}

impl Default for WindowLiveness {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown() -> LivenessGate {
        LivenessGate {
            window_exists: true,
            window_on_screen: true,
            lightweight: false,
            exiting: false,
        }
    }

    fn hidden() -> LivenessGate {
        LivenessGate {
            window_on_screen: false,
            ..shown()
        }
    }

    #[test]
    fn resume_recreates_a_visible_window_that_never_answers() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        life.note_resume(1_000, true);
        assert_eq!(life.poll(1_000 + 5_000, shown()), LivenessAction::None);
        assert_eq!(
            life.poll(1_000 + PROBE_GRACE_MS, shown()),
            LivenessAction::RecreateWindow
        );
    }

    #[test]
    fn heartbeat_after_resume_keeps_the_window() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        life.note_resume(1_000, true);
        life.note_heartbeat(1_500);
        assert_eq!(life.poll(1_000 + PROBE_GRACE_MS, shown()), LivenessAction::None);
    }

    #[test]
    fn hidden_resume_waits_until_the_window_is_shown() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        life.note_resume(1_000, false);
        assert_eq!(life.poll(1_000 + PROBE_GRACE_MS, hidden()), LivenessAction::None);
        life.note_show(5_000);
        assert_eq!(life.poll(5_000 + 1_000, shown()), LivenessAction::None);
        assert_eq!(
            life.poll(5_000 + PROBE_GRACE_MS, shown()),
            LivenessAction::RecreateWindow
        );
    }

    #[test]
    fn opening_a_healthy_hidden_window_does_not_recreate_it() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(1_000, hidden()), LivenessAction::None);
        life.note_show(60_000);
        life.note_heartbeat(60_100);
        assert_eq!(life.poll(60_100, shown()), LivenessAction::None);
        assert_eq!(life.poll(90_000, shown()), LivenessAction::None);
    }

    #[test]
    fn visible_window_is_recreated_after_heartbeats_stop() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(0, shown()), LivenessAction::None);
        assert_eq!(life.poll(STALE_MS, shown()), LivenessAction::RecreateWindow);
    }

    #[test]
    fn hidden_window_is_not_treated_as_frozen() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(STALE_MS * 4, hidden()), LivenessAction::None);
    }

    #[test]
    fn startup_resume_does_not_rebuild_a_window_that_has_not_loaded() {
        let mut life = WindowLiveness::new();
        life.note_resume(0, true);
        assert_eq!(life.poll(PROBE_GRACE_MS, shown()), LivenessAction::None);
    }

    #[test]
    fn recreate_is_not_repeated_inside_the_cooldown() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(0, shown()), LivenessAction::None);
        assert_eq!(life.poll(STALE_MS, shown()), LivenessAction::RecreateWindow);
        assert_eq!(life.poll(STALE_MS + 1_000, shown()), LivenessAction::None);
    }

    #[test]
    fn failed_recreate_restarts_the_process() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(0, shown()), LivenessAction::None);
        assert_eq!(life.poll(STALE_MS, shown()), LivenessAction::RecreateWindow);
        assert_eq!(
            life.poll(STALE_MS + GENERATION_GRACE_MS, shown()),
            LivenessAction::HardRestart
        );
        assert_eq!(
            life.poll(STALE_MS + GENERATION_GRACE_MS + 1, shown()),
            LivenessAction::None
        );
    }

    #[test]
    fn lightweight_mode_drops_a_pending_resume_probe() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        life.note_resume(1_000, false);
        let lightweight = LivenessGate {
            lightweight: true,
            ..hidden()
        };
        assert_eq!(life.poll(1_500, lightweight), LivenessAction::None);
        assert_eq!(life.poll(1_500 + PROBE_GRACE_MS, shown()), LivenessAction::None);
    }

    #[test]
    fn stuck_ui_thread_restarts_without_recreating() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.note_ui_probe(1_000, false), LivenessAction::None);
        assert_eq!(life.note_ui_probe(2_000, false), LivenessAction::HardRestart);
    }

    #[test]
    fn ui_thread_probe_ignores_a_window_that_has_never_answered() {
        let mut life = WindowLiveness::new();
        assert_eq!(life.note_ui_probe(1_000, false), LivenessAction::None);
        assert_eq!(life.note_ui_probe(2_000, false), LivenessAction::None);
    }

    #[test]
    fn hidden_window_does_not_yield_the_singleton() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert!(!life.should_yield_to_next_instance(STALE_MS * 4, false));
    }

    #[test]
    fn visible_window_yields_after_heartbeats_stop() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.poll(0, shown()), LivenessAction::None);
        assert!(life.should_yield_to_next_instance(STALE_MS, true));
    }

    #[test]
    fn stuck_ui_thread_yields_even_when_a_heartbeat_just_arrived() {
        let mut life = WindowLiveness::new();
        life.note_heartbeat(0);
        assert_eq!(life.note_ui_probe(1_000, false), LivenessAction::None);
        assert!(!life.should_yield_to_next_instance(1_000, true));
        assert_eq!(life.note_ui_probe(2_000, false), LivenessAction::HardRestart);
        life.note_heartbeat(2_000);
        assert!(life.should_yield_to_next_instance(2_000, true));
    }

    #[test]
    fn second_launch_keeps_a_live_app_and_replaces_a_silent_one() {
        assert_eq!(handoff(HealthReply::Ok, false), ExistingInstance::Keep);
        assert_eq!(handoff(HealthReply::Stuck, true), ExistingInstance::Replace);
        assert_eq!(handoff(HealthReply::Unreachable, false), ExistingInstance::Replace);
        assert_eq!(handoff(HealthReply::Other, true), ExistingInstance::Keep);
        assert_eq!(handoff(HealthReply::Other, false), ExistingInstance::Replace);
        assert_eq!(classify_health(false, "ok"), HealthReply::Unreachable);
        assert_eq!(classify_health(true, " stuck "), HealthReply::Stuck);
    }
}
