use super::{CmdResult, StringifyErr as _};
use crate::{
    cmd::profile::{finish_profile_switch, patch_profiles_config_locked, try_begin_profile_switch},
    config::{
        Config, IProfiles, PrfItem, PrfOption,
        profiles::{profiles_append_item_safe, profiles_delete_item_safe, profiles_draft_update_item_safe},
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
const SLOT_UID: &str = "LRuntimeYaml";
const SLOT_NAME: &str = "Imported runtime YAML";
const SLOT_DESC: &str = "Managed WebDAV runtime YAML slot";

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
    use super::{
        MAX_RUNTIME_YAML_BYTES, SLOT_DESC, SLOT_NAME, SLOT_UID, find_runtime_yaml_slot,
        new_runtime_yaml_slot_uid, validate_runtime_yaml,
    };
    use crate::config::PrfItem;
    use smartstring::alias::String;

    fn local_item(uid: &str, name: &str, desc: Option<&str>) -> PrfItem {
        PrfItem {
            uid: Some(uid.into()),
            itype: Some("local".into()),
            name: Some(name.into()),
            file: Some(format!("{uid}.yaml").into()),
            desc: desc.map(String::from),
            ..PrfItem::default()
        }
    }

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

    #[test]
    fn prefers_well_known_slot_uid() {
        let items = vec![
            local_item("Lother", SLOT_NAME, Some(SLOT_DESC)),
            local_item(SLOT_UID, "Renamed", Some(SLOT_DESC)),
        ];
        assert_eq!(
            find_runtime_yaml_slot(&items, None).as_deref(),
            Some(SLOT_UID)
        );
    }

    #[test]
    fn reuses_managed_local_profile_and_prefers_current() {
        let items = vec![
            local_item("Lold", SLOT_NAME, None),
            local_item("LRuntimeYamlActive", SLOT_NAME, Some(SLOT_DESC)),
        ];
        let current: String = "LRuntimeYamlActive".into();
        assert_eq!(
            find_runtime_yaml_slot(&items, Some(&current)).as_deref(),
            Some("LRuntimeYamlActive")
        );
    }

    #[test]
    fn ignores_remote_profiles_with_the_managed_uid_and_marker() {
        let items = vec![PrfItem {
            uid: Some(SLOT_UID.into()),
            itype: Some("remote".into()),
            name: Some(SLOT_NAME.into()),
            desc: Some(SLOT_DESC.into()),
            ..PrfItem::default()
        }];
        assert!(find_runtime_yaml_slot(&items, None).is_none());
    }

    #[test]
    fn ignores_local_profiles_that_only_match_the_display_name() {
        let items = vec![local_item("Luser", SLOT_NAME, None)];
        assert!(find_runtime_yaml_slot(&items, None).is_none());
    }

    #[test]
    fn allocates_a_collision_free_uid_when_the_well_known_uid_is_unowned() {
        let items = vec![local_item(SLOT_UID, "User profile", None)];
        assert!(find_runtime_yaml_slot(&items, None).is_none());
        let uid = new_runtime_yaml_slot_uid(&items);
        assert_ne!(uid.as_str(), SLOT_UID);
        assert!(uid.starts_with(SLOT_UID));
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

fn is_local_runtime_yaml_slot(item: &PrfItem) -> bool {
    let Some(uid) = item.uid.as_deref() else {
        return false;
    };
    let expected_file = format!("{uid}.yaml");
    item.itype.as_deref() == Some("local")
        && uid.starts_with(SLOT_UID)
        && item.file.as_deref() == Some(expected_file.as_str())
        && item.desc.as_deref() == Some(SLOT_DESC)
}

fn find_runtime_yaml_slot(items: &[PrfItem], current: Option<&String>) -> Option<String> {
    if let Some(current) = current
        && let Some(item) = items.iter().find(|item| item.uid.as_ref() == Some(current))
        && is_local_runtime_yaml_slot(item)
    {
        return item.uid.clone();
    }
    items
        .iter()
        .find(|item| item.uid.as_deref() == Some(SLOT_UID) && is_local_runtime_yaml_slot(item))
        .or_else(|| items.iter().find(|item| is_local_runtime_yaml_slot(item)))
        .and_then(|item| item.uid.clone())
}

fn new_runtime_yaml_slot_uid(items: &[PrfItem]) -> String {
    if items.iter().any(|item| item.uid.as_deref() == Some(SLOT_UID)) {
        help::get_uid(SLOT_UID).into()
    } else {
        SLOT_UID.into()
    }
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

async fn restore_runtime_yaml_slot(
    uid: &String,
    previous: &PrfItem,
    content: std::string::String,
) -> anyhow::Result<()> {
    let mut previous = previous.clone();
    previous.file_data = Some(content.into());
    profiles_draft_update_item_safe(uid, &mut previous).await
}

fn rollback_error(error: impl std::fmt::Display, rollback: impl std::fmt::Display) -> String {
    format!("{error}; rollback also failed: {rollback}").into()
}

async fn activate_runtime_yaml_profile(
    switch_lock: &mut ProfileSwitchLock,
    uid: String,
) -> CmdResult<String> {
    switch_lock.hand_off();
    match patch_profiles_config_locked(
        IProfiles {
            current: Some(uid.clone()),
            items: None,
        },
        true,
    )
    .await
    {
        Ok(true) => {
            AutoBackupManager::trigger_backup(AutoBackupTrigger::ProfileChange);
            Ok(uid)
        }
        Ok(false) => Err("Runtime YAML failed validation; the previous profile is still active".into()),
        Err(error) => Err(error),
    }
}

async fn overwrite_runtime_yaml_slot(
    switch_lock: &mut ProfileSwitchLock,
    existing: &PrfItem,
    content: std::string::String,
) -> CmdResult<String> {
    let uid = existing
        .uid
        .clone()
        .ok_or_else(|| String::from("Runtime YAML profile is missing a uid"))?;
    let file = existing
        .file
        .clone()
        .unwrap_or_else(|| format!("{uid}.yaml").into());
    let profile_path = dirs::app_profiles_dir()
        .stringify_err()?
        .join(file.as_str());
    let previous_content = tokio::fs::read_to_string(&profile_path)
        .await
        .with_context(|| format!("failed to back up runtime YAML profile file \"{file}\""))
        .stringify_err()?;

    let mut item = existing.clone();
    item.updated = Some(chrono::Local::now().timestamp() as usize);
    item.file_data = Some(content.into());

    if let Err(error) = profiles_draft_update_item_safe(&uid, &mut item).await {
        return match restore_runtime_yaml_slot(&uid, existing, previous_content).await {
            Ok(()) => Err(error.to_string().into()),
            Err(rollback) => Err(rollback_error(error, rollback)),
        };
    }

    match activate_runtime_yaml_profile(switch_lock, uid.clone()).await {
        Ok(uid) => Ok(uid),
        Err(error) => {
            match restore_runtime_yaml_slot(&uid, existing, previous_content).await {
                Ok(()) => Err(error),
                Err(rollback) => Err(rollback_error(error, rollback)),
            }
        }
    }
}

async fn create_runtime_yaml_slot(
    switch_lock: &mut ProfileSwitchLock,
    name: String,
    content: std::string::String,
    previous_items: Vec<PrfItem>,
) -> CmdResult<String> {
    let uid = new_runtime_yaml_slot_uid(&previous_items);
    let file: String = format!("{uid}.yaml").into();
    let first_local_uid = previous_items
        .iter()
        .find(|item| item.itype.as_deref() == Some("local"))
        .and_then(|item| item.uid.clone());
    let display_name = if name.trim().is_empty() {
        SLOT_NAME.into()
    } else {
        name.trim().into()
    };

    let mut item = PrfItem {
        uid: Some(uid.clone()),
        itype: Some("local".into()),
        name: Some(display_name),
        file: Some(file.clone()),
        desc: Some(SLOT_DESC.into()),
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

    match activate_runtime_yaml_profile(switch_lock, uid.clone()).await {
        Ok(uid) => Ok(uid),
        Err(error) => {
            rollback_imported_profile(&uid, &file).await;
            Err(error)
        }
    }
}

async fn import_runtime_yaml_content(
    name: String,
    content: std::string::String,
) -> CmdResult<String> {
    validate_runtime_yaml(content.as_str()).stringify_err()?;

    let mut switch_lock = ProfileSwitchLock::acquire()
        .ok_or_else(|| String::from("A profile switch is already in progress"))?;

    let profiles = Config::profiles().await.data_arc();
    let previous_items = profiles.items.clone().unwrap_or_default();
    let existing = find_runtime_yaml_slot(&previous_items, profiles.current.as_ref()).and_then(|uid| {
        previous_items
            .iter()
            .find(|item| item.uid.as_ref() == Some(&uid))
            .cloned()
    });

    if let Some(existing) = existing {
        overwrite_runtime_yaml_slot(&mut switch_lock, &existing, content).await
    } else {
        create_runtime_yaml_slot(&mut switch_lock, name, content, previous_items).await
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

/// Download the shared WebDAV runtime YAML and reuse a dedicated local profile.
#[tauri::command]
pub async fn import_runtime_yaml_from_webdav() -> CmdResult<String> {
    require_https_webdav().await.stringify_err()?;
    let bytes = get_remote_runtime_yaml_bytes().await.stringify_err()?;
    let content = std::string::String::from_utf8(bytes)
        .context("Runtime YAML is not valid UTF-8")
        .stringify_err()?;
    import_runtime_yaml_content("Imported runtime YAML".into(), content).await
}
