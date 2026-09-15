use super::{CmdResult, StringifyErr as _};
use crate::feat::profile_activation::{self, ProfileActivationStatus, ProfileUpdateResult};
use smartstring::alias::String;

#[tauri::command]
pub async fn get_profile_activation() -> Option<ProfileActivationStatus> {
    profile_activation::activation_status().await
}

#[tauri::command]
pub async fn retry_profile_activation(index: String) -> CmdResult<ProfileUpdateResult> {
    let _guard = profile_activation::UPDATE_LOCK.lock().await;
    let status = profile_activation::activation_status().await;
    if !status.is_some_and(|s| {
        s.uid == index
            && matches!(
                s.outcome,
                ProfileUpdateResult::ActivationFailed | ProfileUpdateResult::DownloadSucceeded
            )
    }) {
        return Err("This profile no longer has a pending activation".into());
    }
    profile_activation::activate_downloaded_profile(&index)
        .await
        .stringify_err()
}
