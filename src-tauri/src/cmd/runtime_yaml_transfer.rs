use super::{CmdResult, StringifyErr as _};
use crate::{
    cmd::profile::{finish_profile_switch, patch_profiles_config_locked, try_begin_profile_switch},
    config::{Config, IProfiles, PrfItem, PrfOption, profiles::profiles_append_item_safe},
    module::auto_backup::{AutoBackupManager, AutoBackupTrigger},
    utils::{dirs, help},
};
use anyhow::{Context as _, bail};
use serde_yaml_ng::Mapping;
use smartstring::alias::String;
use std::path::PathBuf;

const MAX_RUNTIME_YAML_BYTES: usize = 10 * 1024 * 1024;

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
    use super::validate_runtime_yaml;

    #[test]
    fn accepts_mapping_runtime_yaml() {
        assert!(validate_runtime_yaml("mixed-port: 7890\nmode: rule\n").is_ok());
    }

    #[test]
    fn rejects_empty_or_non_mapping_yaml() {
        assert!(validate_runtime_yaml("").is_err());
        assert!(validate_runtime_yaml("- DIRECT\n").is_err());
    }
}

async fn remove_candidate_file(file: &String) {
    if let Ok(directory) = dirs::app_profiles_dir() {
        let _ = tokio::fs::remove_file(directory.join(file.as_str())).await;
    }
}

#[tauri::command]
pub async fn import_runtime_yaml_profile(name: String, source: PathBuf) -> CmdResult<String> {
    let extension = source.extension().and_then(|value| value.to_str());
    if !matches!(
        extension,
        Some(value) if value.eq_ignore_ascii_case("yaml") || value.eq_ignore_ascii_case("yml")
    ) {
        return Err("Only YAML files can be imported".into());
    }

    let metadata = tokio::fs::metadata(&source).await.stringify_err()?;
    if metadata.len() > MAX_RUNTIME_YAML_BYTES as u64 {
        return Err("Runtime YAML is larger than 10 MB".into());
    }
    let content = tokio::fs::read_to_string(&source).await.stringify_err()?;
    validate_runtime_yaml(content.as_str()).stringify_err()?;

    if !try_begin_profile_switch() {
        return Err("A profile switch is already in progress".into());
    }

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
        file_data: Some(content),
        ..PrfItem::default()
    };

    if let Err(error) = profiles_append_item_safe(&mut item).await {
        Config::profiles().await.discard();
        remove_candidate_file(&file).await;
        finish_profile_switch();
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
            remove_candidate_file(&file).await;
            Err("Runtime YAML failed validation; the previous profile is still active".into())
        }
        Err(error) => {
            remove_candidate_file(&file).await;
            Err(error)
        }
    }
}
