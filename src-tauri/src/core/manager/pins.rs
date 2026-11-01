//! Re-applies the current profile's saved pins (`PrfItem::selected`) to a
//! running core. A pin is released only by the user's explicit unpin, so every
//! event that gives the core a fresh set of groups (config reload, core start,
//! restart) must put the saved pins back.

use super::CoreManager;
use crate::{config::Config, constants::timing, utils::mihomo_ipc};
use clash_verge_logging::{Type, logging};
use std::time::Duration;
use tokio::time::{sleep, timeout};

/// The core API may not be listening yet right after a start, and a reload can
/// briefly recreate the IPC endpoint, so a failed request is retried.
const PIN_APPLY_ATTEMPTS: u32 = 6;
const PIN_APPLY_RETRY_STEP: Duration = Duration::from_millis(500);

impl CoreManager {
    /// Re-pin every saved pin of the current profile.
    ///
    /// Requests are forced: the core records the pin even if the node is not
    /// in the group yet (a provider may still be loading), so the pin is never
    /// dropped just because the node is temporarily missing.
    pub(super) async fn apply_profile_selected_to_core() {
        let draft = Config::profiles().await;
        let arc = draft.latest_arc();
        let selected = arc
            .get_current()
            .and_then(|uid| arc.get_item(uid).ok())
            .and_then(|item| item.selected.clone());
        drop(arc);
        drop(draft);
        let Some(selected) = selected else {
            return;
        };

        for s in &selected {
            let (name, now) = match (&s.name, &s.now) {
                (Some(n), Some(w)) if !n.is_empty() && !w.is_empty() => (n.as_str(), w.as_str()),
                _ => continue,
            };
            Self::apply_one_pin(name, now).await;
        }
    }

    async fn apply_one_pin(group: &str, node: &str) {
        for attempt in 1..=PIN_APPLY_ATTEMPTS {
            let started = std::time::Instant::now();
            let result = timeout(
                timing::CORE_SELECT_NODE_TIMEOUT,
                mihomo_ipc::put_group_selected_proxy(group, node, true),
            )
            .await;
            match result {
                Ok(Ok(())) => {
                    logging!(
                        info,
                        Type::Core,
                        "[核心切换] 重新固定 {} -> {} 成功（第 {} 次，耗时 {:?}）",
                        group,
                        node,
                        attempt,
                        started.elapsed()
                    );
                    return;
                }
                Ok(Err(err)) => {
                    logging!(
                        warn,
                        Type::Core,
                        "Re-pin {} -> {} failed (attempt {}/{}): {}",
                        group,
                        node,
                        attempt,
                        PIN_APPLY_ATTEMPTS,
                        err
                    );
                }
                Err(_) => {
                    logging!(
                        warn,
                        Type::Core,
                        "Re-pin {} -> {} timed out (attempt {}/{})",
                        group,
                        node,
                        attempt,
                        PIN_APPLY_ATTEMPTS
                    );
                }
            }
            if attempt < PIN_APPLY_ATTEMPTS {
                sleep(PIN_APPLY_RETRY_STEP * attempt).await;
            }
        }
        logging!(
            error,
            Type::Core,
            "Could not re-pin {} -> {}; the saved pin is kept and will be retried on the next reload",
            group,
            node
        );
    }

    /// Re-pin in the background. Used where the caller must not wait, such as
    /// right after the core process starts.
    pub(super) fn schedule_apply_profile_selected_to_core() {
        tokio::spawn(async {
            Self::apply_profile_selected_to_core().await;
        });
    }
}
