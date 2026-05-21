use crate::{constants::files::UI_PREFERENCES, utils::dirs};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::{Path, PathBuf}};
use tokio::fs;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct UiPreferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_table_order: Option<Vec<String>>,
    /// 仅记录隐藏列（field -> false），与前端 VisibilityState 一致
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_table_visibility: Option<HashMap<String, bool>>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ConnectionTableUiState {
    pub order: Option<Vec<String>>,
    pub visibility: Option<HashMap<String, bool>>,
}

fn ui_preferences_path() -> Result<PathBuf> {
    Ok(dirs::app_home_dir()?.join(UI_PREFERENCES))
}

fn prefs_has_data(prefs: &UiPreferences) -> bool {
    prefs
        .connection_table_order
        .as_ref()
        .is_some_and(|o| !o.is_empty())
        || prefs
            .connection_table_visibility
            .as_ref()
            .is_some_and(|v| !v.is_empty())
}

async fn read_ui_preferences(path: &Path) -> Result<UiPreferences> {
    if !path.exists() {
        return Ok(UiPreferences::default());
    }
    let text = fs::read_to_string(path).await?;
    Ok(serde_json::from_str(&text).unwrap_or_default())
}

async fn write_ui_preferences(path: &Path, prefs: &UiPreferences) -> Result<()> {
    if !prefs_has_data(prefs) {
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

pub async fn save_connection_table_ui(
    order: Vec<String>,
    visibility: HashMap<String, bool>,
) -> Result<()> {
    let path = ui_preferences_path()?;
    let mut prefs = read_ui_preferences(&path).await?;
    prefs.connection_table_order = if order.is_empty() {
        None
    } else {
        Some(order)
    };
    prefs.connection_table_visibility = if visibility.is_empty() {
        None
    } else {
        Some(visibility)
    };
    write_ui_preferences(&path, &prefs).await
}

pub async fn get_connection_table_ui() -> Result<ConnectionTableUiState> {
    let path = ui_preferences_path()?;
    let prefs = read_ui_preferences(&path).await?;
    Ok(ConnectionTableUiState {
        order: prefs
            .connection_table_order
            .filter(|order| !order.is_empty()),
        visibility: prefs.connection_table_visibility,
    })
}

pub async fn ui_preferences_backup_path() -> Result<Option<PathBuf>> {
    let path = ui_preferences_path()?;
    if path.exists() {
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

pub async fn ensure_ui_preferences_in_backup(
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: zip::write::SimpleFileOptions,
) -> Result<()> {
    use std::io::Write as _;

    let Some(path) = ui_preferences_backup_path().await? else {
        return Ok(());
    };
    zip.start_file(UI_PREFERENCES, options)?;
    zip.write_all(&fs::read(&path).await?)?;
    Ok(())
}
