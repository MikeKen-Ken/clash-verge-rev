use super::{CmdResult, StringifyErr as _};
use crate::{
    cmd::profile::{finish_profile_switch, patch_profiles_config_locked, try_begin_profile_switch},
    config::{
        Config, IProfiles, PrfItem, PrfOption,
        profiles::{profiles_append_item_safe, profiles_delete_item_safe},
    },
    core::backup::WebDavClient,
    module::auto_backup::{AutoBackupManager, AutoBackupTrigger},
    utils::{dirs, help},
};
use anyhow::{Context as _, bail};
use serde_yaml_ng::Mapping;
use smartstring::alias::String;

struct ProfileSwitchLock {
    active: bool,
}

impl ProfileSwitchLock {
    fn acquire() -> Option<Self> {
        if try_begin_profile_switch() {
            Some(Self { active: true })
        } else {
            None
        }
    }

    fn hand_off(&mut self) {
        self.active = false;
    }
}

impl Drop for ProfileSwitchLock {
    fn drop(&mut self) {
        if self.active {
            finish_profile_switch();
        }
    }
}

const MAX_RUNTIME_YAML_BYTES: usize = 10 * 1024 * 1024;
const REMOTE_OBJECT: &str = "clash-runtime.yaml";
const LEGACY_REMOTE_OBJECT: &str = "clash-runtime-yaml/runtime.yaml";

fn validate_runtime_yaml(content: &str) -> anyhow::Result<()> {
    if content.is_empty() {
        bail!("Runtime YAML is empty");
    }
    if content.len() > MAX_RUNTIME_YAML_BYTES {
        bail!("Runtime YAML is larger than 10 MB");
    }

    let mapping = serde_yaml_ng::from_str::<Mapping>(content)
        .context("Runtime YAML must contain a top-level mapping")?;
    if mapping.is_empty() {
        bail!("Runtime YAML is empty");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MAX_RUNTIME_YAML_BYTES, validate_runtime_yaml};

    #[test]
    fn accepts_mapping_runtime_yaml() {
        assert!(validate_runtime_yaml("mixed-port: 7890\nmode: rule\n").is_ok());
    }

    #[test]
    fn rejects_empty_or_non_mapping_yaml() {
        assert!(validate_runtime_yaml("").is_err());
        assert!(validate_runtime_yaml("{}\n").is_err());
        assert!(validate_runtime_yaml("- DIRECT\n").is_err());
    }

    #[test]
    fn rejects_oversized_runtime_yaml() {
        let content = format!("mixed-port: 7890\n# {}\n", "x".repeat(MAX_RUNTIME_YAML_BYTES));
        assert!(validate_runtime_yaml(&content).is_err());
    }
}

async fn require_https_webdav() -> anyhow::Result<()> {
    let url = Config::verge()
        .await
        .data_arc()
        .webdav_url
        .clone()
        .unwrap_or_default();
    if !url.trim().to_ascii_lowercase().starts_with("https://") {
        bail!("WebDAV URL must be https");
    }
    Ok(())
}

async fn current_runtime_yaml() -> anyhow::Result<std::string::String> {
    let runtime = Config::runtime().await.latest_arc();
    let config = runtime
        .config
        .as_ref()
        .context("Runtime YAML is not available")?;
    serde_yaml_ng::to_string(config).context("failed to convert config to yaml")
}

async fn remove_candidate_file(file: &String) {
    if let Ok(directory) = dirs::app_profiles_dir() {
        let _ = tokio::fs::remove_file(directory.join(file.as_str())).await;
    }
}

async fn rollback_imported_profile(uid: &String, file: &String) {
    Config::profiles().await.discard();
    if profiles_delete_item_safe(uid).await.is_err() {
        remove_candidate_file(file).await;
    }
}

async fn import_runtime_yaml_content(
    name: String,
    content: std::string::String,
) -> CmdResult<String> {
    validate_runtime_yaml(content.as_str()).stringify_err()?;

    let mut switch_lock = ProfileSwitchLock::acquire()
        .ok_or_else(|| String::from("A profile switch is already in progress"))?;

    let uid: String = help::get_uid("L").into();
    let file: String = format!("{uid}.yaml").into();
    let previous_items = Config::profiles()
        .await
        .data_arc()
        .items
        .clone()
        .unwrap_or_default();
    let first_local_uid = previous_items
        .iter()
        .find(|item| item.itype.as_deref() == Some("local"))
        .and_then(|item| item.uid.clone());

    let mut item = PrfItem {
        uid: Some(uid.clone()),
        itype: Some("local".into()),
        name: Some(if name.trim().is_empty() {
            "Imported runtime YAML".into()
        } else {
            name.trim().into()
        }),
        file: Some(file.clone()),
        desc: Some("Imported runtime YAML".into()),
        updated: Some(chrono::Local::now().timestamp() as usize),
        option: Some(PrfOption::default()),
        file_data: Some(content.into()),
        ..PrfItem::default()
    };

    if let Err(error) = profiles_append_item_safe(&mut item).await {
        Config::profiles().await.discard();
        remove_candidate_file(&file).await;
        return Err(error.to_string().into());
    }

    if let Some(first_uid) = first_local_uid {
        Config::profiles().await.edit_draft(|profiles| {
            let Some(items) = profiles.items.as_mut() else {
                return;
            };
            let Some(source_index) = items
                .iter()
                .position(|item| item.uid.as_ref() == Some(&uid))
            else {
                return;
            };
            let candidate = items.remove(source_index);
            let target_index = items
                .iter()
                .position(|item| item.uid.as_ref() == Some(&first_uid))
                .unwrap_or(0);
            items.insert(target_index, candidate);
        });
    }

    switch_lock.hand_off();
    let switch_result = patch_profiles_config_locked(
        IProfiles {
            current: Some(uid.clone()),
            items: None,
        },
        true,
    )
    .await;

    match switch_result {
        Ok(true) => {
            AutoBackupManager::trigger_backup(AutoBackupTrigger::ProfileChange);
            Ok(uid)
        }
        Ok(false) => {
            rollback_imported_profile(&uid, &file).await;
            Err("Runtime YAML failed validation; the previous profile is still active".into())
        }
        Err(error) => {
            rollback_imported_profile(&uid, &file).await;
            Err(error)
        }
    }
}

fn webdav_object_missing(error: &impl std::fmt::Display) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("404") || message.contains("not found")
}

async fn get_remote_runtime_yaml_bytes() -> anyhow::Result<Vec<u8>> {
    let client = WebDavClient::global();
    match client.get_bytes(REMOTE_OBJECT, MAX_RUNTIME_YAML_BYTES).await {
        Ok(bytes) => Ok(bytes),
        Err(error) if webdav_object_missing(&error) => client
            .get_bytes(LEGACY_REMOTE_OBJECT, MAX_RUNTIME_YAML_BYTES)
            .await
            .map_err(|legacy| {
                if webdav_object_missing(&legacy) {
                    anyhow::anyhow!(
                        "No runtime YAML on WebDAV yet. Upload from a running client first."
                    )
                } else {
                    anyhow::anyhow!("Failed to download runtime YAML from WebDAV: {legacy}")
                }
            }),
        Err(error) => Err(anyhow::anyhow!(
            "Failed to download runtime YAML from WebDAV: {error}"
        )),
    }
}

async fn put_remote_runtime_yaml(content: Vec<u8>) -> anyhow::Result<()> {
    let client = WebDavClient::global();
    match client.put_bytes(REMOTE_OBJECT, content.clone()).await {
        Ok(()) => Ok(()),
        Err(error) if webdav_object_missing(&error) => {
            let _ = client.ensure_collection("clash-runtime-yaml").await;
            client
                .put_bytes(LEGACY_REMOTE_OBJECT, content)
                .await
                .context("Failed to upload runtime YAML to WebDAV")
        }
        Err(error) => Err(error).context("Failed to upload runtime YAML to WebDAV"),
    }
}

/// Upload the currently generated runtime YAML to the shared WebDAV object.
#[tauri::command]
pub async fn export_runtime_yaml_webdav() -> CmdResult<()> {
    require_https_webdav().await.stringify_err()?;
    let content = current_runtime_yaml().await.stringify_err()?;
    validate_runtime_yaml(content.as_str()).stringify_err()?;
    put_remote_runtime_yaml(content.into_bytes()).await.stringify_err()
}

/// Download the shared WebDAV runtime YAML and import it as a local profile.
#[tauri::command]
pub async fn import_runtime_yaml_from_webdav() -> CmdResult<String> {
    require_https_webdav().await.stringify_err()?;
    let bytes = get_remote_runtime_yaml_bytes().await.stringify_err()?;
    let content = std::string::String::from_utf8(bytes)
        .context("Runtime YAML is not valid UTF-8")
        .stringify_err()?;
    import_runtime_yaml_content("Imported runtime YAML".into(), content).await
}
