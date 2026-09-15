use crate::{
    config::Config,
    core::{CoreManager, handle},
};
use smartstring::alias::String;
use std::sync::Mutex;

pub use super::profile_update_outcome::ProfileUpdateResult;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActivationStatus {
    pub uid: String,
    pub outcome: ProfileUpdateResult,
    pub last_applied_at: Option<u64>,
}

// One current-profile observation; no unbounded per-subscription history.
static STATUS: Mutex<Option<ProfileActivationStatus>> = Mutex::new(None);
pub static UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn record_activation(uid: &String, outcome: ProfileUpdateResult) {
    let mut status = STATUS.lock().unwrap_or_else(|e| e.into_inner());
    let previous_applied = status
        .as_ref()
        .filter(|s| s.uid == *uid)
        .and_then(|s| s.last_applied_at);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|time| time.as_millis() as u64);
    *status = Some(ProfileActivationStatus {
        uid: uid.clone(),
        outcome,
        last_applied_at: if outcome == ProfileUpdateResult::Applied {
            now
        } else {
            previous_applied
        },
    });
}

pub async fn activation_status() -> Option<ProfileActivationStatus> {
    let current = Config::profiles().await.latest_arc().get_current().cloned();
    STATUS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .filter(|status| current.as_ref() == Some(&status.uid))
}

pub async fn activate_downloaded_profile(uid: &String) -> anyhow::Result<ProfileUpdateResult> {
    if !crate::cmd::profile::try_begin_profile_switch() {
        record_activation(uid, ProfileUpdateResult::ActivationFailed);
        return Ok(ProfileUpdateResult::ActivationFailed);
    }
    scopeguard::defer! { crate::cmd::profile::finish_profile_switch(); }
    if !Config::profiles().await.latest_arc().is_current_profile_index(uid) {
        return Ok(ProfileUpdateResult::DownloadSucceeded);
    }
    record_activation(uid, ProfileUpdateResult::DownloadSucceeded);
    if handle::Handle::global().is_exiting() {
        anyhow::bail!("Application is exiting");
    }
    // Explicit activation must not be skipped by the normal update debounce.
    let result = CoreManager::global().force_update_config().await;
    let outcome = ProfileUpdateResult::from_activation(&result);
    if outcome == ProfileUpdateResult::Applied {
        handle::Handle::refresh_clash();
    } else {
        let detail = match result {
            Ok((_, message)) => message.to_string(),
            Err(error) => error.to_string(),
        };
        handle::Handle::notice_message("update_failed", detail);
    }
    record_activation(uid, outcome);
    Ok(outcome)
}
