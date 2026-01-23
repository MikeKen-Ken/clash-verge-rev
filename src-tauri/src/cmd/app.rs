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
use std::path::Path;
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

/// 打开网页链接
#[tauri::command]
pub fn open_web_url(url: String) -> CmdResult<()> {
    open::that(url.as_str()).stringify_err()
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

/// 发送关闭所有连接完成的通知
#[tauri::command]
pub async fn notify_close_all_completed() {
    use crate::utils::notification::{NotificationEvent, notify_event};
    notify_event(NotificationEvent::CloseAllConnectionsCompleted).await;
}

/// UI加载阶段
#[tauri::command]
pub fn update_ui_stage(stage: UiReadyStage) {
    logging!(info, Type::Cmd, "UI加载阶段更新: {:?}", &stage);
    ui::update_ui_ready_stage(stage);
}

/// 获取进程图标 (Windows only)
/// 返回 base64 编码的 PNG 图标
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn get_process_icon(process_path: String) -> CmdResult<Option<String>> {
    use base64::Engine;
    use std::path::Path as StdPath;

    let process_path_str: std::string::String = process_path.into();

    // 检查缓存目录
    let icon_cache_dir = dirs::app_home_dir()
        .stringify_err()?
        .join("icons")
        .join("process_cache");

    if !icon_cache_dir.exists() {
        let _ = fs::create_dir_all(&icon_cache_dir).await;
    }

    // 使用进程路径的 hash 作为缓存文件名
    let path_hash = format!("{:x}", md5_hash(&process_path_str));
    let cache_path = icon_cache_dir.join(format!("{}.png", path_hash));

    // 如果缓存存在，直接返回
    if cache_path.exists() {
        if let Ok(data) = fs::read(&cache_path).await {
            let base64_str = base64::engine::general_purpose::STANDARD.encode(&data);
            return Ok(Some(format!("data:image/png;base64,{}", base64_str).into()));
        }
    }

    // 提取图标
    let exe_path = StdPath::new(&process_path_str);
    if !exe_path.exists() {
        return Ok(None);
    }

    // 在阻塞线程中提取图标
    let process_path_clone = process_path_str.clone();
    let icon_data = tokio::task::spawn_blocking(move || {
        extract_icon_from_exe(&process_path_clone)
    })
    .await
    .stringify_err()?;

    match icon_data {
        Some(png_data) => {
            // 保存到缓存
            let _ = fs::write(&cache_path, &png_data).await;

            let base64_str = base64::engine::general_purpose::STANDARD.encode(&png_data);
            Ok(Some(format!("data:image/png;base64,{}", base64_str).into()))
        }
        None => Ok(None),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn get_process_icon(_process_path: String) -> CmdResult<Option<String>> {
    Ok(None)
}

/// 简单的字符串 hash 函数
fn md5_hash(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// 从 exe 文件提取图标 (Windows)
#[cfg(target_os = "windows")]
fn extract_icon_from_exe(exe_path: &str) -> Option<Vec<u8>> {
    use std::io::Cursor;
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{
        BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, DeleteDC, DeleteObject,
        GetDIBits, GetObjectW, SelectObject, BITMAP, BITMAPINFO, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    let wide_path: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        let mut large_icon: HICON = HICON::default();
        let mut small_icon: HICON = HICON::default();

        let count = ExtractIconExW(
            PCWSTR::from_raw(wide_path.as_ptr()),
            0,
            Some(&mut large_icon),
            Some(&mut small_icon),
            1,
        );

        if count == 0 || large_icon.is_invalid() {
            return None;
        }

        // 获取图标信息
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(large_icon, &mut icon_info).is_err() {
            DestroyIcon(large_icon).ok();
            if !small_icon.is_invalid() {
                DestroyIcon(small_icon).ok();
            }
            return None;
        }

        // 获取位图信息
        let mut bmp = BITMAP::default();
        let hbm_color_gdi: HGDIOBJ = icon_info.hbmColor.into();
        if GetObjectW(
            hbm_color_gdi,
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        ) == 0
        {
            cleanup_icon_resources(large_icon, small_icon, &icon_info);
            return None;
        }

        let width = bmp.bmWidth;
        let height = bmp.bmHeight;

        if width <= 0 || height <= 0 {
            cleanup_icon_resources(large_icon, small_icon, &icon_info);
            return None;
        }

        // 创建 DC
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() {
            cleanup_icon_resources(large_icon, small_icon, &icon_info);
            return None;
        }

        let old_bmp = SelectObject(hdc, hbm_color_gdi);

        // 设置位图信息头
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负值表示从上到下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [Default::default()],
        };

        // 分配像素缓冲区
        let pixel_count = (width * height) as usize;
        let mut pixels: Vec<u32> = vec![0; pixel_count];

        let result = GetDIBits(
            hdc,
            icon_info.hbmColor,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        SelectObject(hdc, old_bmp);
        DeleteDC(hdc).ok();

        if result == 0 {
            cleanup_icon_resources(large_icon, small_icon, &icon_info);
            return None;
        }

        // 转换 BGRA 到 RGBA
        let mut rgba_pixels: Vec<u8> = Vec::with_capacity(pixel_count * 4);
        for pixel in pixels.iter() {
            let b = (*pixel & 0xFF) as u8;
            let g = ((*pixel >> 8) & 0xFF) as u8;
            let r = ((*pixel >> 16) & 0xFF) as u8;
            let a = ((*pixel >> 24) & 0xFF) as u8;
            rgba_pixels.push(r);
            rgba_pixels.push(g);
            rgba_pixels.push(b);
            rgba_pixels.push(a);
        }

        cleanup_icon_resources(large_icon, small_icon, &icon_info);

        // 使用 image crate 创建 PNG
        let img = image::RgbaImage::from_raw(width as u32, height as u32, rgba_pixels)?;

        // 缩放到 20x20
        let resized = image::imageops::resize(&img, 20, 20, image::imageops::FilterType::Lanczos3);

        let mut png_data = Cursor::new(Vec::new());
        if resized
            .write_to(&mut png_data, image::ImageFormat::Png)
            .is_err()
        {
            return None;
        }

        Some(png_data.into_inner())
    }
}

#[cfg(target_os = "windows")]
unsafe fn cleanup_icon_resources(
    large_icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    small_icon: windows::Win32::UI::WindowsAndMessaging::HICON,
    icon_info: &windows::Win32::UI::WindowsAndMessaging::ICONINFO,
) {
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    DestroyIcon(large_icon).ok();
    if !small_icon.is_invalid() {
        DestroyIcon(small_icon).ok();
    }
    if !icon_info.hbmColor.is_invalid() {
        let hbm_color: HGDIOBJ = icon_info.hbmColor.into();
        DeleteObject(hbm_color).ok();
    }
    if !icon_info.hbmMask.is_invalid() {
        let hbm_mask: HGDIOBJ = icon_info.hbmMask.into();
        DeleteObject(hbm_mask).ok();
    }
}
