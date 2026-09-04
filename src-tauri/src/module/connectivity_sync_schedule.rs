use crate::{
    config::{Config, IVerge},
    feat,
    process::AsyncHandler,
    utils::wall_clock,
};
use anyhow::Result;
use chrono::Utc;
use clash_verge_logging::{Type, logging};
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

const DEFAULT_INTERVAL_HOURS: u32 = 24;
const MIN_INTERVAL_HOURS: u32 = 1;
const MAX_INTERVAL_HOURS: u32 = 168;
const MS_PER_HOUR: i64 = 60 * 60 * 1000;
const BACKOFF_MINUTES: [u64; 4] = [1, 2, 5, 10];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ConnectivitySyncSettings {
    enabled: bool,
    interval_hours: u32,
    webdav_fingerprint: u64,
}

impl ConnectivitySyncSettings {
    fn from_verge(verge: &IVerge) -> Self {
        Self {
            enabled: webdav_ready(verge),
            interval_hours: verge
                .connectivity_sync_interval_hours
                .unwrap_or(DEFAULT_INTERVAL_HOURS)
                .clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS),
            webdav_fingerprint: webdav_fingerprint(verge),
        }
    }
}

impl Default for ConnectivitySyncSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_hours: DEFAULT_INTERVAL_HOURS,
            webdav_fingerprint: 0,
        }
    }
}

fn webdav_ready(verge: &IVerge) -> bool {
    let url = verge
        .webdav_url
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let username = verge.webdav_username.as_deref().unwrap_or("").trim();
    let password = verge.webdav_password.as_deref().unwrap_or("");
    url.starts_with("https://") && !username.is_empty() && !password.is_empty()
}

fn webdav_fingerprint(verge: &IVerge) -> u64 {
    let mut hasher = DefaultHasher::new();
    verge
        .webdav_url
        .as_deref()
        .unwrap_or("")
        .trim()
        .hash(&mut hasher);
    verge
        .webdav_username
        .as_deref()
        .unwrap_or("")
        .trim()
        .hash(&mut hasher);
    verge
        .webdav_password
        .as_deref()
        .unwrap_or("")
        .hash(&mut hasher);
    hasher.finish()
}

fn backoff_delay_ms(failure_streak: u32) -> u64 {
    if failure_streak == 0 {
        return 0;
    }
    let index = (failure_streak as usize - 1).min(BACKOFF_MINUTES.len() - 1);
    BACKOFF_MINUTES[index].saturating_mul(60 * 1000)
}

/// `last_sync_at` and `now` are unix milliseconds, matching the persisted merge clock.
pub fn is_connectivity_auto_merge_due(
    last_sync_at_ms: i64,
    interval_hours: u32,
    now_ms: i64,
) -> bool {
    let hours = interval_hours.clamp(MIN_INTERVAL_HOURS, MAX_INTERVAL_HOURS);
    wall_clock::is_due(last_sync_at_ms, hours as i64 * MS_PER_HOUR, now_ms)
}

pub struct ConnectivitySyncScheduler {
    settings: Arc<RwLock<ConnectivitySyncSettings>>,
    settings_tx: watch::Sender<ConnectivitySyncSettings>,
    runner_started: AtomicBool,
}

impl ConnectivitySyncScheduler {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<ConnectivitySyncScheduler> = OnceCell::new();
        INSTANCE.get_or_init(|| {
            let (tx, _rx) = watch::channel(ConnectivitySyncSettings::default());
            Self {
                settings: Arc::new(RwLock::new(ConnectivitySyncSettings::default())),
                settings_tx: tx,
                runner_started: AtomicBool::new(false),
            }
        })
    }

    pub async fn init(&self) -> Result<()> {
        self.apply_settings(Self::load_settings().await);
        self.maybe_start_runner();
        Ok(())
    }

    pub async fn refresh_settings(&self) -> Result<()> {
        self.apply_settings(Self::load_settings().await);
        self.maybe_start_runner();
        Ok(())
    }

    async fn load_settings() -> ConnectivitySyncSettings {
        ConnectivitySyncSettings::from_verge(&Config::verge().await.data_arc())
    }

    fn apply_settings(&self, settings: ConnectivitySyncSettings) {
        let changed = {
            let mut current = self.settings.write();
            if *current == settings {
                false
            } else {
                *current = settings;
                true
            }
        };
        if changed {
            let _ = self.settings_tx.send(settings);
        }
    }

    fn maybe_start_runner(&self) {
        if self.settings.read().enabled {
            self.ensure_runner();
        }
    }

    fn ensure_runner(&self) {
        if self.runner_started.swap(true, Ordering::SeqCst) {
            return;
        }

        let mut rx = self.settings_tx.subscribe();
        AsyncHandler::spawn(move || async move {
            Self::run_scheduler(&mut rx).await;
        });
    }

    async fn run_scheduler(rx: &mut watch::Receiver<ConnectivitySyncSettings>) {
        let mut current = *rx.borrow();
        let mut just_ran = false;
        let mut failure_streak: u32 = 0;
        loop {
            if !current.enabled {
                just_ran = false;
                failure_streak = 0;
                if rx.changed().await.is_err() {
                    break;
                }
                current = *rx.borrow();
                continue;
            }

            let last = feat::last_connectivity_sync_at().await.unwrap_or(0);
            let now = Utc::now().timestamp_millis();
            let interval_ms = current.interval_hours as i64 * MS_PER_HOUR;
            let delay_ms = if failure_streak > 0 {
                backoff_delay_ms(failure_streak).max(1)
            } else {
                wall_clock::next_unix_timestamp(last, interval_ms, now, just_ran)
                    .saturating_sub(now as u64)
                    .max(1)
            };

            let sleeper = tokio::time::sleep(Duration::from_millis(delay_ms));
            tokio::pin!(sleeper);

            tokio::select! {
                _ = &mut sleeper => {
                    let now = Utc::now().timestamp_millis();
                    let last = feat::last_connectivity_sync_at().await.unwrap_or(0);
                    if !is_connectivity_auto_merge_due(last, current.interval_hours, now) {
                        just_ran = false;
                        failure_streak = 0;
                        continue;
                    }
                    match feat::merge_connectivity_statistics().await {
                        Ok(result) => {
                            just_ran = true;
                            failure_streak = 0;
                            logging!(
                                info,
                                Type::Network,
                                "Automatic connectivity merge finished: devices={}, proxies={}",
                                result.device_count,
                                result.proxy_count
                            );
                        }
                        Err(error) => {
                            just_ran = false;
                            failure_streak = failure_streak.saturating_add(1);
                            logging!(
                                warn,
                                Type::Network,
                                "Automatic connectivity merge failed: {error:#?}"
                            );
                        }
                    }
                }
                changed = rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                    just_ran = false;
                    failure_streak = 0;
                    current = *rx.borrow();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{backoff_delay_ms, is_connectivity_auto_merge_due, MS_PER_HOUR};

    const NOW: i64 = 1_700_000_000_000;
    const MINUTE_MS: u64 = 60 * 1000;

    #[test]
    fn never_synced_is_due_immediately() {
        assert!(is_connectivity_auto_merge_due(0, 24, NOW));
    }

    #[test]
    fn recent_merge_waits_for_the_full_interval() {
        let last = NOW - 23 * MS_PER_HOUR;
        assert!(!is_connectivity_auto_merge_due(last, 24, NOW));
    }

    #[test]
    fn elapsed_interval_is_due() {
        let last = NOW - 24 * MS_PER_HOUR;
        assert!(is_connectivity_auto_merge_due(last, 24, NOW));
    }

    #[test]
    fn interval_uses_milliseconds_not_seconds() {
        let last = NOW - 90_000;
        assert!(
            !is_connectivity_auto_merge_due(last, 1, NOW),
            "90s after a merge must not look due for a 1 hour interval"
        );
    }

    #[test]
    fn failure_backoff_steps_then_caps_at_ten_minutes() {
        assert_eq!(backoff_delay_ms(0), 0);
        assert_eq!(backoff_delay_ms(1), MINUTE_MS);
        assert_eq!(backoff_delay_ms(2), 2 * MINUTE_MS);
        assert_eq!(backoff_delay_ms(3), 5 * MINUTE_MS);
        assert_eq!(backoff_delay_ms(4), 10 * MINUTE_MS);
        assert_eq!(backoff_delay_ms(9), 10 * MINUTE_MS);
    }
}
