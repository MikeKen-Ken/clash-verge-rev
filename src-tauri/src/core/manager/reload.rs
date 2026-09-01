use std::future::Future;
use std::time::Duration;

use anyhow::{Result, anyhow};
use clash_verge_logging::{Type, logging};
use tokio::time::{sleep, timeout};

use crate::constants::timing;
use crate::utils::mihomo_ipc;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum TimeoutRetryError<E> {
    Operation(E),
    TimedOut { attempts: u32, timeout: Duration },
}

/// Run `op` with a timeout. If the future is dropped by timeout, retry after
/// `retry_delay` up to `max_attempts` times.
///
/// The first PUT /configs over LocalSocket often hangs: Mihomo ApplyConfig
/// recreates the named pipe / unix socket before writing the HTTP response.
/// The core may already have the new file; a second attempt on a fresh
/// connection then returns immediately.
pub(crate) async fn with_timeout_retry<T, E, F, Fut>(
    timeout_dur: Duration,
    retry_delay: Duration,
    max_attempts: u32,
    mut op: F,
) -> Result<T, TimeoutRetryError<E>>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, E>>,
{
    let attempts = max_attempts.max(1);
    let mut attempt = 1;
    loop {
        match timeout(timeout_dur, op()).await {
            Ok(Ok(value)) => return Ok(value),
            Ok(Err(err)) => return Err(TimeoutRetryError::Operation(err)),
            Err(_) if attempt < attempts => {
                logging!(
                    info,
                    Type::Core,
                    "core reload timed out after {:?} (attempt {attempt}/{attempts}); retrying",
                    timeout_dur
                );
                sleep(retry_delay).await;
                attempt += 1;
            }
            Err(_) => {
                return Err(TimeoutRetryError::TimedOut {
                    attempts,
                    timeout: timeout_dur,
                });
            }
        }
    }
}

pub(super) async fn reload_config_resilient(path: &str) -> Result<()> {
    match with_timeout_retry(
        timing::CORE_RELOAD_TIMEOUT,
        timing::CORE_RELOAD_RETRY_DELAY,
        timing::CORE_RELOAD_ATTEMPTS,
        || mihomo_ipc::put_configs_reload(path),
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(TimeoutRetryError::Operation(err)) => Err(err),
        Err(TimeoutRetryError::TimedOut { timeout, .. }) => {
            Err(anyhow!("reload timed out after {:?}", timeout))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[tokio::test]
    async fn first_timeout_then_success_matches_mode_switch_symptom() {
        let attempts = AtomicU32::new(0);
        let result = with_timeout_retry(
            Duration::from_millis(20),
            Duration::from_millis(1),
            2,
            || {
                let n = attempts.fetch_add(1, Ordering::SeqCst);
                async move {
                    if n == 0 {
                        tokio::time::sleep(Duration::from_millis(80)).await;
                    }
                    Ok::<(), &'static str>(())
                }
            },
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn immediate_success_does_not_retry() {
        let attempts = AtomicU32::new(0);
        let result = with_timeout_retry(
            Duration::from_millis(50),
            Duration::from_millis(1),
            2,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Ok::<(), &'static str>(()) }
            },
        )
        .await;

        assert_eq!(result, Ok(()));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn operation_error_is_not_retried() {
        let attempts = AtomicU32::new(0);
        let result = with_timeout_retry(
            Duration::from_millis(50),
            Duration::from_millis(1),
            2,
            || {
                attempts.fetch_add(1, Ordering::SeqCst);
                async { Err::<(), _>("invalid config") }
            },
        )
        .await;

        assert_eq!(result, Err(TimeoutRetryError::Operation("invalid config")));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn both_attempts_timing_out_returns_timed_out() {
        let attempts = AtomicU32::new(0);
        let timeout_dur = Duration::from_millis(15);
        let result = with_timeout_retry(timeout_dur, Duration::from_millis(1), 2, || {
            attempts.fetch_add(1, Ordering::SeqCst);
            async {
                tokio::time::sleep(Duration::from_millis(60)).await;
                Ok::<(), &'static str>(())
            }
        })
        .await;

        assert_eq!(
            result,
            Err(TimeoutRetryError::TimedOut {
                attempts: 2,
                timeout: timeout_dur,
            })
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }
}
