use crate::{
    config::{Config, IVergeTheme},
    core,
    utils::dirs,
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Cursor, Read as _, Write as _},
    path::{Path, PathBuf},
};
use tokio::fs;
use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const UI_WALLPAPERS_PACK: &str = "clash-ui-wallpapers.zip";
const UI_BACKGROUND_PREFIX: &str = "ui_background-";
const MANIFEST_PATH: &str = "manifest.json";
const MAX_PACK_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
const MAX_PACK_FILES: usize = 40;

fn safe_wallpaper_file_name(name: &str) -> Option<String> {
    let base = Path::new(name).file_name()?.to_str()?;
    if base.is_empty() || base.contains("..") {
        return None;
    }
    if !base
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(base.to_string())
}

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

struct WallpaperPackSource {
    path: PathBuf,
    item: WallpaperItem,
    size: usize,
}

#[derive(Debug)]
struct DecodedWallpaperPack {
    manifest: WallpaperManifest,
    files: HashMap<String, Vec<u8>>,
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
    if paths.len() > MAX_PACK_FILES {
        return Err(anyhow!("Wallpaper library has too many images"));
    }

    let playback = theme
        .background_playback
        .as_deref()
        .unwrap_or("fixed")
        .to_string();
    let interval = theme.background_interval_seconds.unwrap_or(300);
    let mut sources = Vec::with_capacity(paths.len());
    let mut seen_ids = HashSet::new();
    let mut seen_file_names = HashSet::new();
    let mut declared_payload_bytes = 0usize;
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
        if id.is_empty() || !seen_ids.insert(id.clone()) {
            return Err(anyhow!("Wallpaper library contains a blank or duplicate image ID"));
        }
        let file_name = format!("{id}.{ext}");
        let file_name = safe_wallpaper_file_name(&file_name)
            .ok_or_else(|| anyhow!("Wallpaper library contains an invalid file name"))?;
        if !seen_file_names.insert(file_name.clone()) {
            return Err(anyhow!("Wallpaper library contains duplicate file names"));
        }
        let metadata = fs::metadata(src).await?;
        let size = usize::try_from(metadata.len())
            .map_err(|_| anyhow!("Wallpaper image size is not supported"))?;
        if size == 0 {
            return Err(anyhow!("Wallpaper image is empty: {file_name}"));
        }
        if size > MAX_ENTRY_BYTES {
            return Err(anyhow!("Wallpaper image exceeds the per-file limit: {file_name}"));
        }
        declared_payload_bytes = declared_payload_bytes
            .checked_add(size)
            .ok_or_else(|| anyhow!("Wallpaper pack size overflow"))?;
        sources.push(WallpaperPackSource {
            path: src.to_path_buf(),
            item: WallpaperItem { id, file_name },
            size,
        });
    }

    let manifest = WallpaperManifest {
        version: 1,
        playback,
        interval_seconds: interval,
        items: sources.iter().map(|source| source.item.clone()).collect(),
    };
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() > MAX_ENTRY_BYTES {
        return Err(anyhow!("Wallpaper manifest exceeds the per-entry limit"));
    }
    declared_payload_bytes = declared_payload_bytes
        .checked_add(manifest_bytes.len())
        .ok_or_else(|| anyhow!("Wallpaper pack size overflow"))?;
    if declared_payload_bytes > MAX_PACK_BYTES {
        return Err(anyhow!("Wallpaper pack exceeds the total size limit"));
    }

    let tmp = std::env::temp_dir().join(UI_WALLPAPERS_PACK);
    let encode_result: Result<()> = async {
        let file = std::fs::File::create(&tmp)?;
        let mut zip = ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let mut actual_payload_bytes = manifest_bytes.len();

        for source in &sources {
            let content = fs::read(&source.path).await?;
            if content.len() > MAX_ENTRY_BYTES || content.len() != source.size {
                return Err(anyhow!("Wallpaper image changed while creating the pack"));
            }
            actual_payload_bytes = actual_payload_bytes
                .checked_add(content.len())
                .ok_or_else(|| anyhow!("Wallpaper pack size overflow"))?;
            if actual_payload_bytes > MAX_PACK_BYTES {
                return Err(anyhow!("Wallpaper pack exceeds the total size limit"));
            }
            zip.start_file(format!("images/{}", source.item.file_name), options)?;
            zip.write_all(&content)?;
        }

        zip.start_file(MANIFEST_PATH, options)?;
        zip.write_all(&manifest_bytes)?;
        zip.finish()?;
        Ok(())
    }
    .await;
    if let Err(error) = encode_result {
        let _ = fs::remove_file(&tmp).await;
        return Err(error);
    }

    let encoded_size = fs::metadata(&tmp).await?.len();
    if encoded_size > MAX_PACK_BYTES as u64 {
        let _ = fs::remove_file(&tmp).await;
        return Err(anyhow!("Compressed wallpaper pack exceeds the upload limit"));
    }
    Ok(tmp)
}

fn decode_wallpaper_pack(bytes: &[u8]) -> Result<DecodedWallpaperPack> {
    if bytes.len() > MAX_PACK_BYTES {
        return Err(anyhow!("Compressed wallpaper pack exceeds the download limit"));
    }
    let cursor = Cursor::new(bytes);
    let mut zip = ZipArchive::new(cursor)?;
    let mut files = HashMap::<String, Vec<u8>>::new();
    let mut total = 0usize;
    if zip.len() > MAX_PACK_FILES + 4 {
        return Err(anyhow!("wallpaper pack has too many entries"));
    }
    for i in 0..zip.len() {
        let entry = zip.by_index(i)?;
        let raw_name = entry.name().replace('\\', "/");
        if raw_name.starts_with('/') {
            return Err(anyhow!("wallpaper pack contains an absolute path"));
        }
        let name = raw_name.to_string();
        if name.contains("..") {
            return Err(anyhow!("wallpaper pack contains path traversal"));
        }
        let declared_size = usize::try_from(entry.size())
            .map_err(|_| anyhow!("wallpaper pack entry size is not supported"))?;
        if declared_size > MAX_ENTRY_BYTES {
            return Err(anyhow!("wallpaper pack entry too large"));
        }
        let remaining = MAX_PACK_BYTES.saturating_sub(total);
        let allowed = MAX_ENTRY_BYTES.min(remaining);
        let mut buf = Vec::with_capacity(declared_size.min(allowed));
        entry
            .take((allowed + 1) as u64)
            .read_to_end(&mut buf)?;
        if buf.len() > MAX_ENTRY_BYTES {
            return Err(anyhow!("wallpaper pack entry too large"));
        }
        if buf.len() > remaining {
            return Err(anyhow!("wallpaper pack too large"));
        }
        total += buf.len();
        if files.insert(name, buf).is_some() {
            return Err(anyhow!("wallpaper pack contains duplicate entries"));
        }
    }

    let manifest_bytes = files
        .get(MANIFEST_PATH)
        .ok_or_else(|| anyhow!("wallpaper pack missing manifest"))?;
    let manifest: WallpaperManifest = serde_json::from_slice(manifest_bytes)?;
    if manifest.version != 1 {
        return Err(anyhow!("unsupported wallpaper pack version"));
    }
    if manifest.items.is_empty() {
        return Err(anyhow!("wallpaper pack is empty"));
    }
    if manifest.items.len() > MAX_PACK_FILES {
        return Err(anyhow!("wallpaper manifest has too many images"));
    }
    let mut referenced_ids = HashSet::new();
    let mut referenced_file_names = HashSet::new();
    for item in &manifest.items {
        if item.id.is_empty() || !referenced_ids.insert(item.id.clone()) {
            return Err(anyhow!(
                "wallpaper manifest contains a blank or duplicate image ID"
            ));
        }
        let file_name = safe_wallpaper_file_name(&item.file_name)
            .ok_or_else(|| anyhow!("wallpaper manifest contains an invalid file name"))?;
        if item.file_name != file_name {
            return Err(anyhow!("wallpaper manifest contains a path-like image name"));
        }
        if !referenced_file_names.insert(file_name.clone()) {
            return Err(anyhow!("wallpaper manifest contains duplicate image names"));
        }
        let key = format!("images/{file_name}");
        if !files.contains_key(&key) {
            return Err(anyhow!("wallpaper pack is missing image: {file_name}"));
        }
    }
    Ok(DecodedWallpaperPack { manifest, files })
}

pub async fn apply_wallpaper_pack(bytes: &[u8]) -> Result<Vec<std::string::String>> {
    let home = dirs::app_home_dir()?;
    let DecodedWallpaperPack { manifest, files } = decode_wallpaper_pack(bytes)?;

    let mut paths = Vec::new();
    for item in &manifest.items {
        let file_name = safe_wallpaper_file_name(&item.file_name)
            .ok_or_else(|| anyhow!("wallpaper manifest contains an invalid file name"))?;
        let key = format!("images/{file_name}");
        let content = files
            .get(&key)
            .ok_or_else(|| anyhow!("wallpaper pack is missing image: {file_name}"))?;
        let dest = home.join(format!("{UI_BACKGROUND_PREFIX}{file_name}"));
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
    let result = core::backup::WebDavClient::global()
        .upload(pack.clone(), UI_WALLPAPERS_PACK.into())
        .await;
    let _ = fs::remove_file(pack).await;
    result
}

pub async fn download_wallpaper_pack() -> Result<()> {
    let dest = std::env::temp_dir().join(UI_WALLPAPERS_PACK);
    let download_result = core::backup::WebDavClient::global()
        .download(UI_WALLPAPERS_PACK.into(), dest.clone())
        .await;
    if let Err(error) = download_result {
        let _ = fs::remove_file(&dest).await;
        return Err(error);
    }
    let read_result: Result<Vec<u8>> = async {
        let size = fs::metadata(&dest).await?.len();
        if size > MAX_PACK_BYTES as u64 {
            return Err(anyhow!("Compressed wallpaper pack exceeds the download limit"));
        }
        Ok(fs::read(&dest).await?)
    }
    .await;
    let _ = fs::remove_file(&dest).await;
    let bytes = read_result?;
    apply_wallpaper_pack(&bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_with_entry(name: &str, content: &[u8]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file(name, options).unwrap();
        zip.write_all(content).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn rejects_entry_that_expands_past_limit() {
        let content = vec![0_u8; MAX_ENTRY_BYTES + 1];
        let bytes = zip_with_entry("images/large.jpg", &content);

        let error = decode_wallpaper_pack(&bytes).unwrap_err();

        assert!(error.to_string().contains("entry too large"));
    }

    #[test]
    fn rejects_manifest_with_missing_image() {
        let manifest = WallpaperManifest {
            version: 1,
            playback: "fixed".into(),
            interval_seconds: 300,
            items: vec![WallpaperItem {
                id: "missing".into(),
                file_name: "missing.jpg".into(),
            }],
        };
        let bytes = zip_with_entry(MANIFEST_PATH, &serde_json::to_vec(&manifest).unwrap());

        let error = decode_wallpaper_pack(&bytes).unwrap_err();

        assert!(error.to_string().contains("missing image"));
    }
}
