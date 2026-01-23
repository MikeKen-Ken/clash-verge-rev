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
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
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

/// UI加载阶段
#[tauri::command]
pub fn update_ui_stage(stage: UiReadyStage) {
    logging!(info, Type::Cmd, "UI加载阶段更新: {:?}", &stage);
    ui::update_ui_ready_stage(stage);
}

/// 提取进程图标
#[tauri::command]
pub async fn extract_process_icon(process_path: String) -> CmdResult<String> {
    #[cfg(windows)]
    {
        extract_process_icon_windows(process_path).await
    }
    #[cfg(not(windows))]
    {
        // For non-Windows platforms, return empty string for now
        // Can be extended with platform-specific implementations
        Ok(String::new())
    }
}

#[cfg(windows)]
async fn extract_process_icon_windows(process_path: String) -> CmdResult<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use winapi::um::shellapi::{ExtractIconExW, SHGetFileInfoW};
    use winapi::um::shellapi::{SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SMALLICON};
    use winapi::um::winuser::DestroyIcon;
    use winapi::um::wingdi::{GetObjectW, BITMAP};
    use winapi::um::winuser::{GetDC, ReleaseDC, ICONINFO};
    use winapi::shared::windef::{HDC, HICON};
    use winapi::um::wingdi::{CreateCompatibleDC, CreateCompatibleBitmap, SelectObject, DeleteObject, BitBlt, SRCCOPY};
    use winapi::um::winuser::{GetDIBits, DIB_RGB_COLORS};
    use std::ptr;

    let path = Path::new(&process_path);
    if !path.exists() {
        return Err("Process path does not exist".into());
    }

    // Generate cache key from process path
    let mut hasher = DefaultHasher::new();
    process_path.hash(&mut hasher);
    let cache_key = format!("process_{:x}", hasher.finish());
    let icon_cache_dir = dirs::app_home_dir().stringify_err()?.join("icons").join("process");
    let icon_path = icon_cache_dir.join(format!("{}.ico", cache_key));

    // Return cached icon if exists
    if icon_path.exists() {
        return Ok(icon_path.to_string_lossy().into());
    }

    // Create cache directory if needed
    if !icon_cache_dir.exists() {
        let _ = fs::create_dir_all(&icon_cache_dir).await;
    }

    // Convert path to wide string
    let wide_path: Vec<u16> = OsStr::new(&process_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        // Try ExtractIconEx first (for .exe files with multiple icons)
        let mut large_icons: [HICON; 1] = [ptr::null_mut(); 1];
        let mut small_icons: [HICON; 1] = [ptr::null_mut(); 1];
        let icon_count = ExtractIconExW(
            wide_path.as_ptr(),
            0,
            large_icons.as_mut_ptr(),
            small_icons.as_mut_ptr(),
            1,
        );

        let icon_handle = if icon_count > 0 && !large_icons[0].is_null() {
            large_icons[0]
        } else {
            // Fallback to SHGetFileInfoW
            let mut file_info: winapi::um::shellapi::SHFILEINFOW = std::mem::zeroed();
            let result = SHGetFileInfoW(
                wide_path.as_ptr(),
                0,
                &mut file_info,
                std::mem::size_of::<winapi::um::shellapi::SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            );

            if result != 0 && !file_info.hIcon.is_null() {
                file_info.hIcon
            } else {
                return Err("Failed to extract icon".into());
            }
        };

        // Get icon info
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if winapi::um::winuser::GetIconInfo(icon_handle, &mut icon_info) == 0 {
            DestroyIcon(icon_handle);
            return Err("Failed to get icon info".into());
        }

        // Get bitmap info
        let mut bitmap: BITMAP = std::mem::zeroed();
        if GetObjectW(
            icon_info.hbmColor as *mut _,
            std::mem::size_of::<BITMAP>() as i32,
            &mut bitmap as *mut _ as *mut _,
        ) == 0
        {
            DestroyIcon(icon_handle);
            return Err("Failed to get bitmap info".into());
        }

        let width = bitmap.bmWidth;
        let height = bitmap.bmHeight;

        // Create compatible DC and bitmap
        let hdc_screen = GetDC(ptr::null_mut());
        let hdc = CreateCompatibleDC(hdc_screen);
        let hbitmap = CreateCompatibleBitmap(hdc_screen, width, height);
        let old_bitmap = SelectObject(hdc, hbitmap as *mut _);

        // Draw icon to bitmap
        if winapi::um::winuser::DrawIconEx(
            hdc,
            0,
            0,
            icon_handle,
            width,
            height,
            0,
            ptr::null_mut(),
            winapi::um::winuser::DI_NORMAL,
        ) == 0
        {
            SelectObject(hdc, old_bitmap);
            DeleteObject(hbitmap as *mut _);
            DeleteObject(icon_info.hbmColor as *mut _);
            if !icon_info.hbmMask.is_null() {
                DeleteObject(icon_info.hbmMask as *mut _);
            }
            ReleaseDC(ptr::null_mut(), hdc_screen);
            DeleteObject(hdc as *mut _);
            DestroyIcon(icon_handle);
            return Err("Failed to draw icon".into());
        }

        // Get bitmap bits
        let mut bitmap_info: winapi::um::wingdi::BITMAPINFO = std::mem::zeroed();
        bitmap_info.bmiHeader.biSize = std::mem::size_of::<winapi::um::wingdi::BITMAPINFOHEADER>() as u32;
        bitmap_info.bmiHeader.biWidth = width;
        bitmap_info.bmiHeader.biHeight = -height; // Negative for top-down
        bitmap_info.bmiHeader.biPlanes = 1;
        bitmap_info.bmiHeader.biBitCount = 32;
        bitmap_info.bmiHeader.biCompression = winapi::um::wingdi::BI_RGB;

        let buffer_size = (width * height * 4) as usize;
        let mut buffer: Vec<u8> = vec![0; buffer_size];

        if GetDIBits(
            hdc,
            hbitmap as *mut _,
            0,
            height as u32,
            buffer.as_mut_ptr() as *mut _,
            &mut bitmap_info,
            DIB_RGB_COLORS,
        ) == 0
        {
            SelectObject(hdc, old_bitmap);
            DeleteObject(hbitmap as *mut _);
            DeleteObject(icon_info.hbmColor as *mut _);
            DeleteObject(icon_info.hbmMask as *mut _);
            ReleaseDC(ptr::null_mut(), hdc_screen);
            DeleteObject(hdc as *mut _);
            DestroyIcon(icon_handle);
            return Err("Failed to get bitmap bits".into());
        }

        // Cleanup GDI objects
        SelectObject(hdc, old_bitmap);
        DeleteObject(hbitmap as *mut _);
        DeleteObject(icon_info.hbmColor as *mut _);
        if !icon_info.hbmMask.is_null() {
            DeleteObject(icon_info.hbmMask as *mut _);
        }
        ReleaseDC(ptr::null_mut(), hdc_screen);
        DeleteObject(hdc as *mut _);
        DestroyIcon(icon_handle);

        // Convert BGRA to RGBA and save as ICO
        let mut rgba_buffer = Vec::with_capacity(buffer_size);
        for chunk in buffer.chunks_exact(4) {
            rgba_buffer.push(chunk[2]); // R
            rgba_buffer.push(chunk[1]); // G
            rgba_buffer.push(chunk[0]); // B
            rgba_buffer.push(chunk[3]); // A
        }

        // Save as ICO file
        let ico_data = create_ico_file(width as u16, height as u16, &rgba_buffer)?;
        fs::write(&icon_path, ico_data).await.stringify_err()?;

        Ok(icon_path.to_string_lossy().into())
    }
}

#[cfg(windows)]
fn create_ico_file(width: u16, height: u16, rgba_data: &[u8]) -> CmdResult<Vec<u8>> {
    use std::io::Write;
    let mut ico = Vec::new();

    // ICO header
    ico.write_all(&[0, 0, 1, 0, 1, 0].as_slice()).unwrap(); // Reserved, Type, Count
    ico.write_all(&[width, height].as_slice()).unwrap(); // Width, Height
    ico.write_all(&[0, 0].as_slice()).unwrap(); // Color palette
    ico.write_all(&[0, 0].as_slice()).unwrap(); // Reserved
    ico.write_all(&[1, 0].as_slice()).unwrap(); // Color planes
    ico.write_all(&[32, 0].as_slice()).unwrap(); // Bits per pixel
    let data_size = (rgba_data.len() + 40) as u32; // BITMAPINFOHEADER + pixel data
    ico.write_all(&data_size.to_le_bytes()).unwrap();
    ico.write_all(&[22, 0, 0, 0].as_slice()).unwrap(); // Offset to image data

    // BITMAPINFOHEADER
    ico.write_all(&(40u32.to_le_bytes())).unwrap(); // Size
    ico.write_all(&(width as i32).to_le_bytes()).unwrap(); // Width
    ico.write_all(&((height * 2) as i32).to_le_bytes()).unwrap(); // Height (double for mask)
    ico.write_all(&(1u16.to_le_bytes())).unwrap(); // Planes
    ico.write_all(&(32u16.to_le_bytes())).unwrap(); // Bit count
    ico.write_all(&(0u32.to_le_bytes())).unwrap(); // Compression
    ico.write_all(&(rgba_data.len() as u32).to_le_bytes()).unwrap(); // Image size
    ico.write_all(&[0; 16].as_slice()).unwrap(); // Unused fields

    // Pixel data (BGRA format for ICO)
    let mut bgra_data = Vec::with_capacity(rgba_data.len());
    for chunk in rgba_data.chunks_exact(4) {
        bgra_data.push(chunk[2]); // B
        bgra_data.push(chunk[1]); // G
        bgra_data.push(chunk[0]); // R
        bgra_data.push(chunk[3]); // A
    }
    ico.write_all(&bgra_data).unwrap();

    // Mask (all zeros for no transparency mask)
    let mask_size = (width as usize * height as usize) / 8;
    ico.write_all(&vec![0u8; mask_size]).unwrap();

    Ok(ico)
}
