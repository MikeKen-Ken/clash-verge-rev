mod coordinator;
mod fingerprint;

use crate::core::CoreManager;
use crate::process::AsyncHandler;
use crate::utils::mihomo_ipc;
use anyhow::{Context as _, Result};
use clash_verge_logging::{Type, logging};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

use coordinator::RecoveryGate;

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
    tokio::time::sleep(NETWORK_INITIAL_DELAY).await;
    let mut previous = capture_or_log("initial network fingerprint").await;
    let mut recovery_gate = RecoveryGate::new(DUPLICATE_RECOVERY_WINDOW);
    let mut last_sequence = 0;
    let mut last_restart = None;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(NETWORK_POLL_INTERVAL) => {
                check_escalation(&mut last_sequence, &mut last_restart).await;
                observe_network_change(&mut previous, &mut recovery_gate).await;
            }
            event = events.recv() => {
                let Some(event) = event else {
                    return;
                };
                match event {
                    NetworkEvent::Resume => {
                        recover_from_resume(&mut previous, &mut recovery_gate).await;
                    }
                }
            }
        }
    }
}

async fn observe_network_change(
    previous: &mut Option<u64>,
    recovery_gate: &mut RecoveryGate,
) {
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
    if settled == old {
        return;
    }
    *previous = Some(settled);
    recover_once(
        recovery_gate,
        Some(settled),
        "desktop route, interface, or DNS changed",
    )
    .await;
}

async fn recover_from_resume(previous: &mut Option<u64>, recovery_gate: &mut RecoveryGate) {
    tokio::time::sleep(NETWORK_SETTLE_DELAY).await;
    let fingerprint = capture_or_log("resume network fingerprint").await.or(*previous);
    if let Some(current) = fingerprint {
        *previous = Some(current);
    }
    recover_once(recovery_gate, fingerprint, "desktop resumed").await;
}

async fn check_escalation(last_sequence: &mut u64, last_restart: &mut Option<Instant>) {
    let Ok(report) = mihomo_ipc::get_network_recovery_status().await else {
        return;
    };
    if report.sequence == 0 || report.sequence == *last_sequence {
        return;
    }
    *last_sequence = report.sequence;
    if !report.restart_recommended {
        return;
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
        return;
    }

    logging!(
        warn,
        Type::Network,
        "Persistent DNS failure remained after full recovery; restarting Mihomo once"
    );
    if let Err(err) = CoreManager::global().restart_core().await {
        logging!(error, Type::Network, "Mihomo network-recovery restart failed: {err}");
        return;
    }
    *last_restart = Some(Instant::now());
    *last_sequence = 0;
}

async fn capture() -> Result<u64> {
    AsyncHandler::spawn_blocking(fingerprint::capture)
        .await
        .context("network fingerprint task failed")?
}

async fn capture_or_log(operation: &str) -> Option<u64> {
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
    fingerprint: Option<u64>,
    reason: &str,
) {
    let now = Instant::now();
    if recovery_gate.is_duplicate(fingerprint, now) {
        logging!(
            info,
            Type::Network,
            "Coalesced duplicate network recovery: {reason}"
        );
        return;
    }

    match mihomo_ipc::post_network_recovery("route-changed", reason).await {
        Ok(report) => {
            recovery_gate.record_success(fingerprint, Instant::now());
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
        }
        Err(err) => logging!(
            info,
            Type::Network,
            "Network changed, but Mihomo recovery was unavailable: {err}"
        ),
    }
}
