use super::CmdResult;
use crate::core::sysopt::Sysopt;
use crate::utils::resolve::ui::{self, UiReadyStage};
use crate::{
    cmd::StringifyErr as _,
    feat,
    utils::dirs::{self, PathBufExec as _},
};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager as _};
use tokio::fs;
use tokio::io::AsyncWriteExt as _;

/// 打开应用程序所在目录
#[tauri::command]
pub async fn open_app_dir() -> CmdResult<()> {
    let app_dir = dirs::app_home_dir().stringify_err()?;
    open::that(app_dir).stringify_err()
}

/// 打开核心所在目录
#[tauri::command]
pub async fn open_core_dir() -> CmdResult<()> {
    let core_dir = tauri::utils::platform::current_exe().stringify_err()?;
    let core_dir = core_dir.parent().ok_or("failed to get core dir")?;
    open::that(core_dir).stringify_err()
}

/// 打开日志目录
#[tauri::command]
pub async fn open_logs_dir() -> CmdResult<()> {
    let log_dir = dirs::app_logs_dir().stringify_err()?;
    open::that(log_dir).stringify_err()
}

/// 将文本内容写入用户选择的路径（日志导出等场景）
#[tauri::command]
pub async fn export_text_file(destination: String, content: String) -> CmdResult<()> {
    let dest_path = PathBuf::from(destination.as_str());
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).await.stringify_err()?;
        }
    }
    fs::write(&dest_path, content.as_bytes())
        .await
        .stringify_err()
}

/// 打开网页链接
#[tauri::command]
pub fn open_web_url(url: String) -> CmdResult<()> {
    let url = crate::utils::web_url::normalize_web_url(url.as_str()).stringify_err()?;
    open::that(url).stringify_err()
}

/// 打开与「允许应用通过防火墙」相关的系统界面
///
/// 说明：`control.exe /name Microsoft.WindowsFirewall /page AllowedPrograms` 在部分 Win11 版本会
/// 解析失败（弹出「找不到文件」且路径中含 `AllowedPrograms`），故不再使用。
/// 优先打开经典 `firewall.cpl`，左侧可进入「允许应用或功能通过 Windows Defender 防火墙」；
/// 若启动失败则降级到「设置」中的防火墙相关页。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn open_windows_firewall_allowed_apps_settings() -> CmdResult<()> {
    let ok = std::process::Command::new("control.exe")
        .arg("firewall.cpl")
        .spawn()
        .is_ok();
    if ok {
        return Ok(());
    }
    match open::that("ms-settings:windowsdefender-firewall") {
        Ok(()) => Ok(()),
        Err(_) => open::that("ms-settings:windowsdefender").stringify_err(),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn open_windows_firewall_allowed_apps_settings() -> CmdResult<()> {
    Err("Only supported on Windows".into())
}

/// 打开 Windows 设置「代理」（系统 HTTP/HTTPS 手动代理等）
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn open_system_network_proxy_settings() -> CmdResult<()> {
    open::that("ms-settings:network-proxy").stringify_err()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn open_system_network_proxy_settings() -> CmdResult<()> {
    Err("Only supported on Windows".into())
}

// TODO 后续可以为前端提供接口，当前作为托盘菜单使用
/// 打开 Verge 最新日志
#[tauri::command]
pub async fn open_app_log() -> CmdResult<()> {
    open::that(dirs::app_latest_log().stringify_err()?).stringify_err()
}

// TODO 后续可以为前端提供接口，当前作为托盘菜单使用
/// 打开 Clash 最新日志
#[tauri::command]
pub async fn open_core_log() -> CmdResult<()> {
    open::that(dirs::clash_latest_log().stringify_err()?).stringify_err()
}

/// 打开/关闭开发者工具
#[tauri::command]
pub fn open_devtools(app_handle: AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        if !window.is_devtools_open() {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
    }
}

/// 退出应用
#[tauri::command]
pub async fn exit_app() {
    feat::quit().await;
}

/// 重启应用
#[tauri::command]
pub async fn restart_app() -> CmdResult<()> {
    feat::restart_app().await;
    Ok(())
}

/// 获取便携版标识
#[tauri::command]
pub fn get_portable_flag() -> bool {
    *dirs::PORTABLE_FLAG.get().unwrap_or(&false)
}

/// 获取应用目录
#[tauri::command]
pub fn get_app_dir() -> CmdResult<String> {
    let app_home_dir = dirs::app_home_dir().stringify_err()?.to_string_lossy().into();
    Ok(app_home_dir)
}

/// 获取当前自启动状态
#[tauri::command]
pub fn get_auto_launch_status() -> CmdResult<bool> {
    Sysopt::global().get_launch_status().stringify_err()
}

/// 下载图标缓存
#[tauri::command]
pub async fn download_icon_cache(url: String, name: String) -> CmdResult<String> {
    let icon_cache_dir = dirs::app_home_dir().stringify_err()?.join("icons").join("cache");
    let icon_path = icon_cache_dir.join(name.as_str());

    if icon_path.exists() {
        return Ok(icon_path.to_string_lossy().into());
    }

    if !icon_cache_dir.exists() {
        let _ = fs::create_dir_all(&icon_cache_dir).await;
    }

    let temp_path = icon_cache_dir.join(format!("{}.downloading", name.as_str()));

    let response = reqwest::get(url.as_str()).await.stringify_err()?;

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    let is_image = content_type.starts_with("image/");

    let content = response.bytes().await.stringify_err()?;

    let is_html = content.len() > 15
        && (content.starts_with(b"<!DOCTYPE html") || content.starts_with(b"<html") || content.starts_with(b"<?xml"));

    if is_image && !is_html {
        {
            let mut file = match fs::File::create(&temp_path).await {
                Ok(file) => file,
                Err(_) => {
                    if icon_path.exists() {
                        return Ok(icon_path.to_string_lossy().into());
                    }
                    return Err("Failed to create temporary file".into());
                }
            };
            file.write_all(content.as_ref()).await.stringify_err()?;
            file.flush().await.stringify_err()?;
        }

        if !icon_path.exists() {
            match fs::rename(&temp_path, &icon_path).await {
                Ok(_) => {}
                Err(_) => {
                    let _ = temp_path.remove_if_exists().await;
                    if icon_path.exists() {
                        return Ok(icon_path.to_string_lossy().into());
                    }
                }
            }
        } else {
            let _ = temp_path.remove_if_exists().await;
        }

        Ok(icon_path.to_string_lossy().into())
    } else {
        let _ = temp_path.remove_if_exists().await;
        Err(format!("下载的内容不是有效图片: {}", url.as_str()).into())
    }
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct IconInfo {
    name: String,
    previous_t: String,
    current_t: String,
}

/// 复制图标文件
#[tauri::command]
pub async fn copy_icon_file(path: String, icon_info: IconInfo) -> CmdResult<String> {
    let file_path = Path::new(path.as_str());

    let icon_dir = dirs::app_home_dir().stringify_err()?.join("icons");
    if !icon_dir.exists() {
        let _ = fs::create_dir_all(&icon_dir).await;
    }
    let ext: String = match file_path.extension() {
        Some(e) => e.to_string_lossy().into(),
        None => "ico".into(),
    };

    let dest_path = icon_dir.join(format!(
        "{0}-{1}.{ext}",
        icon_info.name.as_str(),
        icon_info.current_t.as_str()
    ));
    if file_path.exists() {
        if icon_info.previous_t.trim() != "" {
            icon_dir
                .join(format!(
                    "{0}-{1}.png",
                    icon_info.name.as_str(),
                    icon_info.previous_t.as_str()
                ))
                .remove_if_exists()
                .await
                .unwrap_or_default();
            icon_dir
                .join(format!(
                    "{0}-{1}.ico",
                    icon_info.name.as_str(),
                    icon_info.previous_t.as_str()
                ))
                .remove_if_exists()
                .await
                .unwrap_or_default();
        }
        logging!(
            info,
            Type::Cmd,
            "Copying icon file path: {:?} -> file dist: {:?}",
            path,
            dest_path
        );
        match fs::copy(file_path, &dest_path).await {
            Ok(_) => Ok(dest_path.to_string_lossy().into()),
            Err(err) => Err(err.to_string().into()),
        }
    } else {
        Err("file not found".into())
    }
}

const UI_BACKGROUND_PREFIX: &str = "ui_background-";
const UI_BACKGROUND_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

async fn remove_ui_background_files(home: &Path) -> CmdResult<()> {
    let mut entries = fs::read_dir(home).await.stringify_err()?;
    while let Some(entry) = entries.next_entry().await.stringify_err()? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(UI_BACKGROUND_PREFIX) {
            entry.path().remove_if_exists().await.unwrap_or_default();
        }
    }
    Ok(())
}

/// Copy a wallpaper into the app home dir for the desktop liquid-glass chrome.
#[tauri::command]
pub async fn copy_ui_background(path: String) -> CmdResult<String> {
    let src = Path::new(path.as_str());
    if !src.exists() {
        return Err("file not found".into());
    }
    let ext = src
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !UI_BACKGROUND_EXTS.iter().any(|allowed| *allowed == ext) {
        return Err("unsupported image type".into());
    }

    let home = dirs::app_home_dir().stringify_err()?;
    // Keep previously copied wallpapers so the library can hold multiple images.

    let dest = home.join(format!(
        "{UI_BACKGROUND_PREFIX}{}.{ext}",
        chrono::Utc::now().timestamp_millis()
    ));
    fs::copy(src, &dest).await.stringify_err()?;
    Ok(dest.to_string_lossy().into())
}

/// Remove one copied wallpaper file from the desktop liquid-glass chrome.
#[tauri::command]
pub async fn remove_ui_background(path: String) -> CmdResult<()> {
    let target = PathBuf::from(path.as_str());
    let home = dirs::app_home_dir().stringify_err()?;
    if target.starts_with(&home)
        && target
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(UI_BACKGROUND_PREFIX))
    {
        target.remove_if_exists().await.unwrap_or_default();
    }
    Ok(())
}

/// Remove copied wallpaper files used by the desktop liquid-glass chrome.
#[tauri::command]
pub async fn clear_ui_background() -> CmdResult<()> {
    let home = dirs::app_home_dir().stringify_err()?;
    remove_ui_background_files(&home).await
}

/// 通知UI已准备就绪
#[tauri::command]
pub fn notify_ui_ready() {
    logging!(info, Type::Cmd, "前端UI已准备就绪");
    ui::mark_ui_ready();
}

/// 发送关闭所有连接完成的通知
#[tauri::command]
pub async fn notify_close_all_completed() {
    use crate::utils::notification::{NotificationEvent, notify_event};
    notify_event(NotificationEvent::CloseAllConnectionsCompleted).await;
}

/// 发送 Fallback 节点切换通知
#[tauri::command]
pub async fn notify_fallback_proxy_switched(group: String, from: String, to: String) {
    use crate::utils::notification::{NotificationEvent, notify_event};
    notify_event(NotificationEvent::FallbackProxySwitched {
        group: group.as_str(),
        from: from.as_str(),
        to: to.as_str(),
    }).await;
}

/// UI加载阶段
#[tauri::command]
pub fn update_ui_stage(stage: UiReadyStage) {
    logging!(info, Type::Cmd, "UI加载阶段更新: {:?}", &stage);
    ui::update_ui_ready_stage(stage);
}

/// 获取进程图标。Windows 上按可执行文件路径取 Explorer 图标。
#[tauri::command]
pub async fn get_process_icon(process_path: String) -> CmdResult<Option<String>> {
    super::process_icon::load_process_icon(process_path.as_str()).await
}

/// 通过进程名获取进程图标。Windows 上先解析到实际 exe 路径。
#[tauri::command]
pub async fn get_process_icon_by_name(process_name: String) -> CmdResult<Option<String>> {
    super::process_icon::load_process_icon_by_name(process_name.as_str()).await
}
