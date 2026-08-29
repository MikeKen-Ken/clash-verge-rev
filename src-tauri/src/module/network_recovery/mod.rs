mod fingerprint;

use crate::core::CoreManager;
use crate::process::AsyncHandler;
use crate::utils::mihomo_ipc;
use clash_verge_logging::{Type, logging};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const NETWORK_POLL_INTERVAL: Duration = Duration::from_secs(5);
const NETWORK_SETTLE_DELAY: Duration = Duration::from_millis(750);
const NETWORK_INITIAL_DELAY: Duration = Duration::from_secs(10);
const CORE_RESTART_COOLDOWN: Duration = Duration::from_secs(5 * 60);

static STARTED: AtomicBool = AtomicBool::new(false);

pub fn start() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    AsyncHandler::spawn(run);
}

pub fn recover_after_resume() {
    AsyncHandler::spawn(|| async {
        tokio::time::sleep(NETWORK_SETTLE_DELAY).await;
        recover("desktop resumed").await;
    });
}

async fn run() {
    tokio::time::sleep(NETWORK_INITIAL_DELAY).await;
    let mut previous = capture().await;
    let mut last_sequence = 0;
    let mut last_restart = None;
    loop {
        tokio::time::sleep(NETWORK_POLL_INTERVAL).await;
        check_escalation(&mut last_sequence, &mut last_restart).await;
        let current = capture().await;
        if current == previous {
            continue;
        }

        tokio::time::sleep(NETWORK_SETTLE_DELAY).await;
        previous = capture().await;
        recover("desktop route, interface, or DNS changed").await;
    }
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

async fn capture() -> u64 {
    AsyncHandler::spawn_blocking(fingerprint::capture).await.unwrap_or_default()
}

async fn recover(reason: &str) {
    match mihomo_ipc::post_network_recovery("route-changed", reason).await {
        Ok(report) => logging!(
            info,
            Type::Network,
            "Network recovery action={} coalesced={} closed-connections={} reset-adapters={} restart-recommended={} error={}",
            report.action,
            report.coalesced,
            report.closed_connections,
            report.reset_adapters,
            report.restart_recommended,
            report.error.as_deref().unwrap_or("none")
        ),
        Err(err) => logging!(
            info,
            Type::Network,
            "Network changed, but Mihomo recovery was unavailable: {err}"
        ),
    }
}
