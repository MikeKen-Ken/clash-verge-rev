use crate::{constants::files::UI_PREFERENCES, utils::dirs};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UiPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_table_order: Option<Vec<String>>,
}

fn ui_preferences_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(UI_PREFERENCES))
}

async fn read_ui_preferences(path: &Path) -> Result<UiPreferences> {
    if !path.exists() {
        return Ok(UiPreferences::default());
    }
    let text = fs::read_to_string(path).await?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

async fn write_ui_preferences(path: &Path, prefs: &UiPreferences) -> Result<()> {
    if prefs.connection_table_order.as_ref().is_none_or(|o| o.is_empty()) {
        if path.exists() {
            fs::remove_file(path).await.ok();
        }
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let text = serde_json::to_string_pretty(prefs)?;
    fs::write(path, text).await?;
    Ok(())
}

pub async fn save_connection_table_order(order: Vec<String>) -> Result<()> {
    let path = ui_preferences_path()?;
    let mut prefs = read_ui_preferences(&path).await?;
    prefs.connection_table_order = if order.is_empty() {
        None
    } else {
        Some(order)
    };
    write_ui_preferences(&path, &prefs).await
}

pub async fn get_connection_table_order() -> Result<Option<Vec<String>>> {
    let path = ui_preferences_path()?;
    let prefs = read_ui_preferences(&path).await?;
    Ok(prefs
        .connection_table_order
        .filter(|order| !order.is_empty()))
}

pub async fn ui_preferences_backup_path() -> Result<Option<PathBuf>> {
    let path = ui_preferences_path()?;
    if path.exists() {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

pub async fn ensure_ui_preferences_in_backup(zip: &mut zip::ZipWriter<std::fs::File>, options: zip::write::SimpleFileOptions) -> Result<()> {
    use std::io::Write as _;

    let Some(path) = ui_preferences_backup_path().await? else {
        return Ok(());
    };
    zip.start_file(UI_PREFERENCES, options)?;
    zip.write_all(&fs::read(&path).await?)?;
    Ok(())
}
