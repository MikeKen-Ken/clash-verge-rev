mod coordinator;
mod fingerprint;
mod notifications;

use crate::core::CoreManager;
use crate::process::AsyncHandler;
use crate::utils::mihomo_ipc::{self, NetworkRecoveryStatus};
use anyhow::{Context as _, Result};
use clash_verge_logging::{Type, logging};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use coordinator::RecoveryGate;
use fingerprint::NetworkFingerprint;

const NETWORK_POLL_INTERVAL: Duration = Duration::from_secs(5);
const NETWORK_SETTLE_DELAY: Duration = Duration::from_millis(750);
const NETWORK_INITIAL_DELAY: Duration = Duration::from_secs(10);
const DUPLICATE_RECOVERY_WINDOW: Duration = Duration::from_secs(12);
const CORE_RESTART_COOLDOWN: Duration = Duration::from_secs(5 * 60);

static STARTED: AtomicBool = AtomicBool::new(false);
static EVENTS: OnceLock<mpsc::Sender<NetworkEvent>> = OnceLock::new();

enum NetworkEvent {
    Resume,
}

enum MonitorAction {
    Observe,
    RetryLater,
    Stop,
}

pub fn start() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let (sender, receiver) = mpsc::channel(1);
    if EVENTS.set(sender).is_err() {
        return;
    }
    AsyncHandler::spawn(move || run(receiver));
}

pub fn recover_after_resume() {
    if let Some(sender) = EVENTS.get() {
        let _ = sender.try_send(NetworkEvent::Resume);
    }
}

async fn run(mut events: mpsc::Receiver<NetworkEvent>) {
    let _route_notifications = notifications::register().map_err(|error| {
        logging!(
            info,
            Type::Network,
            "Route notifications unavailable ({error}); retaining polling"
        );
    });
    tokio::time::sleep(NETWORK_INITIAL_DELAY).await;
    if !wait_for_typed_recovery_support().await {
        return;
    }
    let mut previous = capture_or_log("initial network fingerprint").await;
    let mut recovery_gate = RecoveryGate::new(DUPLICATE_RECOVERY_WINDOW);
    let mut last_sequence = 0;
    let mut last_restart = None;
    let mut poll = tokio::time::interval(NETWORK_POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    poll.tick().await;
    loop {
        tokio::select! {
            _ = poll.tick() => {
                match check_escalation(&mut last_sequence, &mut last_restart).await {
                    MonitorAction::Observe => {
                        observe_network_change(&mut previous, &mut recovery_gate).await;
                    }
                    MonitorAction::RetryLater => {}
                    MonitorAction::Stop => return,
                }
            }
            _ = notifications::changed() => {
                // Bursts collapse into one pending wake; never force a reset
                // solely because an unrelated interface generated a callback.
                observe_network_change(&mut previous, &mut recovery_gate).await;
            }
            event = events.recv() => {
                let Some(event) = event else {
                    return;
                };
                match event {
                    NetworkEvent::Resume => {
                        match check_escalation(&mut last_sequence, &mut last_restart).await {
                            MonitorAction::Observe => {
                                recover_from_resume(&mut previous, &mut recovery_gate).await;
                            }
                            MonitorAction::RetryLater => {}
                            MonitorAction::Stop => return,
                        }
                    }
                }
            }
        }
    }
}

async fn wait_for_typed_recovery_support() -> bool {
    loop {
        match mihomo_ipc::get_network_recovery_status().await {
            Ok(NetworkRecoveryStatus::Supported(_)) => return true,
            Ok(NetworkRecoveryStatus::Unsupported) => {
                logging!(
                    info,
                    Type::Network,
                    "Mihomo does not support typed network recovery; disabling the desktop recovery monitor"
                );
                return false;
            }
            Err(err) => {
                logging!(
                    info,
                    Type::Network,
                    "Mihomo network-recovery capability check is temporarily unavailable: {err}"
                );
                tokio::time::sleep(NETWORK_POLL_INTERVAL).await;
            }
        }
    }
}

async fn observe_network_change(previous: &mut Option<NetworkFingerprint>, recovery_gate: &mut RecoveryGate) {
    let detected = Instant::now();
    let Some(current) = capture_or_log("poll network fingerprint").await else {
        return;
    };
    let Some(old) = *previous else {
        *previous = Some(current);
        return;
    };
    if current == old {
        return;
    }

    tokio::time::sleep(NETWORK_SETTLE_DELAY).await;
    let Some(settled) = capture_or_log("settled network fingerprint").await else {
        return;
    };
    if settled == old || settled != current {
        return;
    }
    let Some(kind) = settled.change_from(old) else {
        return;
    };
    if recover_once(
        recovery_gate,
        Some(settled),
        kind,
        "desktop route, interface, or DNS changed",
    )
    .await
    {
        *previous = Some(settled);
        logging!(
            info,
            Type::Network,
            "Network change detection-to-reset={}ms kind={kind}",
            detected.elapsed().as_millis()
        );
    }
}

async fn recover_from_resume(previous: &mut Option<NetworkFingerprint>, recovery_gate: &mut RecoveryGate) {
    tokio::time::sleep(NETWORK_SETTLE_DELAY).await;
    let fingerprint = capture_or_log("resume network fingerprint").await.or(*previous);
    if recover_once(recovery_gate, fingerprint, "route-changed", "desktop resumed").await {
        *previous = fingerprint;
    }
}

async fn check_escalation(last_sequence: &mut u64, last_restart: &mut Option<Instant>) -> MonitorAction {
    let report = match mihomo_ipc::get_network_recovery_status().await {
        Ok(NetworkRecoveryStatus::Supported(report)) => report,
        Ok(NetworkRecoveryStatus::Unsupported) => {
            logging!(
                info,
                Type::Network,
                "Mihomo no longer exposes typed network recovery; stopping the desktop recovery monitor"
            );
            return MonitorAction::Stop;
        }
        Err(err) => {
            logging!(
                info,
                Type::Network,
                "Skipping desktop network recovery while the typed status endpoint is unavailable: {err}"
            );
            return MonitorAction::RetryLater;
        }
    };
    if report.sequence == 0 || report.sequence == *last_sequence {
        return MonitorAction::Observe;
    }
    *last_sequence = report.sequence;
    if !report.restart_recommended {
        return MonitorAction::Observe;
    }
    if last_restart
        .as_ref()
        .is_some_and(|instant| instant.elapsed() < CORE_RESTART_COOLDOWN)
    {
        logging!(
            info,
            Type::Network,
            "Persistent network failure requested a core restart, but the restart cooldown is active"
        );
        return MonitorAction::Observe;
    }

    logging!(
        warn,
        Type::Network,
        "Persistent DNS failure remained after full recovery; restarting Mihomo once"
    );
    if let Err(err) = CoreManager::global().restart_core().await {
        logging!(error, Type::Network, "Mihomo network-recovery restart failed: {err}");
        return MonitorAction::RetryLater;
    }
    *last_restart = Some(Instant::now());
    *last_sequence = 0;
    MonitorAction::RetryLater
}

async fn capture() -> Result<NetworkFingerprint> {
    AsyncHandler::spawn_blocking(fingerprint::capture)
        .await
        .context("network fingerprint task failed")?
}

async fn capture_or_log(operation: &str) -> Option<NetworkFingerprint> {
    match capture().await {
        Ok(fingerprint) => Some(fingerprint),
        Err(err) => {
            logging!(info, Type::Network, "Failed to {operation}: {err}");
            None
        }
    }
}

async fn recover_once(
    recovery_gate: &mut RecoveryGate,
    fingerprint: Option<NetworkFingerprint>,
    kind: &str,
    reason: &str,
) -> bool {
    let now = Instant::now();
    if recovery_gate.is_duplicate(fingerprint, kind, now) {
        logging!(info, Type::Network, "Coalesced duplicate network recovery: {reason}");
        return true;
    }

    match mihomo_ipc::post_typed_network_recovery(kind, reason).await {
        Ok(NetworkRecoveryStatus::Supported(report)) => {
            if report.error.is_some() || report.coalesced {
                return false;
            }
            recovery_gate.record_success(fingerprint, kind, Instant::now());
            logging!(
                info,
                Type::Network,
                "Network recovery action={} coalesced={} closed-connections={} reset-adapters={} restart-recommended={} error={}",
                report.action,
                report.coalesced,
                report.closed_connections,
                report.reset_adapters,
                report.restart_recommended,
                report.error.as_deref().unwrap_or("none")
            );
            return true;
        }
        Ok(NetworkRecoveryStatus::Unsupported) => logging!(
            info,
            Type::Network,
            "Network changed, but the running Mihomo no longer supports typed recovery"
        ),
        Err(err) => logging!(
            info,
            Type::Network,
            "Network changed, but Mihomo recovery was unavailable: {err}"
        ),
    }
    false
}
