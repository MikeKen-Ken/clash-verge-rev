use crate::{
    config::{Config, IVergeTheme},
    core,
    utils::dirs,
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::{
    io::{Cursor, Read as _, Write as _},
    path::{Path, PathBuf},
};
use tokio::fs;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const UI_WALLPAPERS_PACK: &str = "clash-ui-wallpapers.zip";
const UI_BACKGROUND_PREFIX: &str = "ui_background-";
const MANIFEST_PATH: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WallpaperItem {
    id: String,
    #[serde(rename = "fileName")]
    file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WallpaperManifest {
    version: u32,
    playback: String,
    #[serde(rename = "intervalSeconds", alias = "interval_seconds")]
    interval_seconds: u32,
    items: Vec<WallpaperItem>,
}

async fn wallpaper_files_on_disk() -> Result<Vec<PathBuf>> {
    let home = dirs::app_home_dir()?;
    let mut paths = Vec::new();
    if let Ok(mut entries) = fs::read_dir(&home).await {
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if path.is_file() && name.starts_with(UI_BACKGROUND_PREFIX) {
                paths.push(path);
            }
        }
    }
    paths.sort();
    Ok(paths)
}

fn theme_paths(theme: &IVergeTheme) -> Vec<std::string::String> {
    let mut paths: Vec<std::string::String> = theme
        .background_images
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.to_string())
        .collect();
    if paths.is_empty() {
        if let Some(image) = theme
            .background_image
            .clone()
            .filter(|value| !value.is_empty())
        {
            paths.push(image.to_string());
        }
    }
    paths
        .into_iter()
        .filter(|path| Path::new(path).is_file())
        .collect()
}

pub async fn encode_wallpaper_pack() -> Result<PathBuf> {
    let verge = Config::verge().await.data_arc();
    let theme = verge.theme_setting.clone().unwrap_or_default();
    let mut paths: Vec<PathBuf> = theme_paths(&theme).into_iter().map(PathBuf::from).collect();
    if paths.is_empty() {
        paths = wallpaper_files_on_disk().await?;
    }
    if paths.is_empty() {
        return Err(anyhow!("Add at least one background image first"));
    }

    let playback = theme
        .background_playback
        .as_deref()
        .unwrap_or("fixed")
        .to_string();
    let interval = theme.background_interval_seconds.unwrap_or(300);
    let mut items = Vec::new();
    let tmp = std::env::temp_dir().join(UI_WALLPAPERS_PACK);
    let file = std::fs::File::create(&tmp)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);

    for path in &paths {
        let src = Path::new(path);
        let ext = src
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase();
        let id = src
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("wallpaper")
            .trim_start_matches(UI_BACKGROUND_PREFIX)
            .to_string();
        let file_name = format!("{id}.{ext}");
        zip.start_file(format!("images/{file_name}"), options)?;
        zip.write_all(&fs::read(src).await?)?;
        items.push(WallpaperItem { id, file_name });
    }

    let manifest = WallpaperManifest {
        version: 1,
        playback,
        interval_seconds: interval,
        items,
    };
    zip.start_file(MANIFEST_PATH, options)?;
    zip.write_all(serde_json::to_vec(&manifest)?.as_slice())?;
    zip.finish()?;
    Ok(tmp)
}

pub async fn apply_wallpaper_pack(bytes: &[u8]) -> Result<Vec<std::string::String>> {
    let home = dirs::app_home_dir()?;
    let cursor = Cursor::new(bytes.to_vec());
    let mut zip = ZipArchive::new(cursor)?;
    let mut files = std::collections::HashMap::<String, Vec<u8>>::new();
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry
            .name()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        if name.contains("..") {
            continue;
        }
        let mut buf = Vec::new();
        entry.read_to_end(&mut buf)?;
        files.insert(name, buf);
    }

    let manifest_bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| anyhow!("wallpaper pack missing manifest"))?;
    let manifest: WallpaperManifest = serde_json::from_slice(manifest_bytes)?;
    if manifest.items.is_empty() {
        return Err(anyhow!("wallpaper pack is empty"));
    }

    let mut paths = Vec::new();
    for item in &manifest.items {
        let key = format!("images/{}", item.file_name);
        let Some(content) = files.get(&key) else {
            continue;
        };
        let dest = home.join(format!("{}{}", UI_BACKGROUND_PREFIX, item.file_name));
        fs::write(&dest, content).await?;
        paths.push(dest.to_string_lossy().into_owned());
    }
    if paths.is_empty() {
        return Err(anyhow!("wallpaper pack contained no images"));
    }

    let playback = if manifest.playback.eq_ignore_ascii_case("random") {
        "random"
    } else {
        "fixed"
    };
    let saved_paths = paths.clone();
    Config::verge().await.edit_draft(|verge| {
        let mut theme = verge.theme_setting.clone().unwrap_or_default();
        theme.background_images = Some(paths.iter().map(|path| path.as_str().into()).collect());
        theme.background_image = paths.first().map(|path| path.as_str().into());
        theme.background_playback = Some(playback.into());
        theme.background_interval_seconds = Some(manifest.interval_seconds.max(30));
        verge.theme_setting = Some(theme);
    });
    Config::verge().await.apply();
    Config::verge().await.data_arc().save_file().await?;
    Ok(saved_paths)
}

pub async fn upload_wallpaper_pack() -> Result<()> {
    let pack = encode_wallpaper_pack().await?;
    core::backup::WebDavClient::global()
        .upload(pack.clone(), UI_WALLPAPERS_PACK.into())
        .await?;
    let _ = fs::remove_file(pack).await;
    Ok(())
}

pub async fn download_wallpaper_pack() -> Result<()> {
    let dest = std::env::temp_dir().join(UI_WALLPAPERS_PACK);
    core::backup::WebDavClient::global()
        .download(UI_WALLPAPERS_PACK.into(), dest.clone())
        .await?;
    let bytes = fs::read(&dest).await?;
    let _ = fs::remove_file(&dest).await;
    apply_wallpaper_pack(&bytes).await?;
    Ok(())
}
