use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::Path;

use base64::Engine;
use smartstring::alias::String as SmartString;

use super::{CmdResult, StringifyErr as _};
use crate::utils::dirs;

const ICON_PX: u32 = 20;

/// Temp、安装器和更新目录里的同名 exe 通常不是用户看到的那个程序。
#[cfg(any(windows, test))]
fn is_transient_install_path(path: &str) -> bool {
    path.split(['\\', '/']).any(|part| {
        let part = part.to_ascii_lowercase();
        part == "temp"
            || part == "tmp"
            || part == "installer"
            || part.contains("update")
    })
}

/// 同一进程名对应多个路径时，优先实例更多、且不在临时目录中的那个。
#[cfg(any(windows, test))]
fn choose_best_path(
    paths: impl IntoIterator<Item = (std::string::String, usize)>,
) -> Option<std::string::String> {
    let mut best_stable: Option<(std::string::String, usize)> = None;
    let mut best_any: Option<(std::string::String, usize)> = None;
    for (path, count) in paths {
        if best_any.as_ref().is_none_or(|(_, best)| count > *best) {
            best_any = Some((path.clone(), count));
        }
        if !is_transient_install_path(&path)
            && best_stable.as_ref().is_none_or(|(_, best)| count > *best)
        {
            best_stable = Some((path, count));
        }
    }
    best_stable.or(best_any).map(|(path, _)| path)
}

fn path_cache_key(path: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}

fn encode_png(png: &[u8]) -> SmartString {
    let encoded = base64::engine::general_purpose::STANDARD.encode(png);
    format!("data:image/png;base64,{encoded}").into()
}

pub async fn load_process_icon(process_path: &str) -> CmdResult<Option<SmartString>> {
    if process_path.is_empty() || !Path::new(process_path).exists() {
        return Ok(None);
    }
    let cache_path = icon_cache_file(process_path).await?;
    if let Some(icon) = read_cached_icon(&cache_path).await {
        return Ok(Some(icon));
    }

    let owned = process_path.to_owned();
    let png = tokio::task::spawn_blocking(move || extract_shell_icon(&owned))
        .await
        .stringify_err()?;
    match png {
        Some(bytes) => {
            let _ = tokio::fs::write(&cache_path, &bytes).await;
            Ok(Some(encode_png(&bytes)))
        }
        None => Ok(None),
    }
}

pub async fn load_process_icon_by_name(process_name: &str) -> CmdResult<Option<SmartString>> {
    if process_name.is_empty() {
        return Ok(None);
    }
    let owned = process_name.to_owned();
    let resolved = tokio::task::spawn_blocking(move || resolve_process_path(&owned))
        .await
        .stringify_err()?;
    match resolved {
        Some(path) => load_process_icon(&path).await,
        None => Ok(None),
    }
}

async fn icon_cache_file(process_path: &str) -> CmdResult<std::path::PathBuf> {
    let dir = dirs::app_home_dir()
        .stringify_err()?
        .join("icons")
        .join("process_cache_v2");
    if !dir.exists() {
        let _ = tokio::fs::create_dir_all(&dir).await;
    }
    Ok(dir.join(format!("{:x}.png", path_cache_key(process_path))))
}

async fn read_cached_icon(cache_path: &Path) -> Option<SmartString> {
    let data = tokio::fs::read(cache_path).await.ok()?;
    if data.is_empty() {
        return None;
    }
    Some(encode_png(&data))
}

#[cfg(target_os = "windows")]
fn resolve_process_path(process_name: &str) -> Option<std::string::String> {
    use std::collections::HashMap;

    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let target = process_name.to_lowercase();
    let mut counts: HashMap<std::string::String, usize> = HashMap::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_err() {
            let _ = CloseHandle(snapshot);
            return None;
        }
        loop {
            let exe_name = wide_cstr(&entry.szExeFile);
            if exe_name.to_lowercase() == target
                && let Some(path) = process_image_path(entry.th32ProcessID)
            {
                *counts.entry(path).or_insert(0) += 1;
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
        let _ = CloseHandle(snapshot);
    }
    choose_best_path(counts)
}

#[cfg(not(target_os = "windows"))]
fn resolve_process_path(_process_name: &str) -> Option<std::string::String> {
    None
}

#[cfg(target_os = "windows")]
fn process_image_path(pid: u32) -> Option<std::string::String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let queried = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = CloseHandle(handle);
        queried.ok()?;
        if len == 0 {
            return None;
        }
        Some(std::string::String::from_utf16_lossy(
            &buf[..len as usize],
        ))
    }
}

#[cfg(target_os = "windows")]
fn extract_shell_icon(exe_path: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON};
    use windows::Win32::UI::WindowsAndMessaging::DestroyIcon;

    let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let com_ready = hr.is_ok();
        let mut info = SHFILEINFOW::default();
        let got = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(std::ptr::addr_of_mut!(info)),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON,
        );
        let png = if got == 0 || info.hIcon.is_invalid() {
            None
        } else {
            let rendered = render_icon(info.hIcon);
            let _ = DestroyIcon(info.hIcon);
            rendered
        };
        if com_ready {
            CoUninitialize();
        }
        png
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_shell_icon(_exe_path: &str) -> Option<Vec<u8>> {
    None
}

#[cfg(target_os = "windows")]
fn render_icon(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DrawIconEx, GetIconInfo, DI_NORMAL, ICONINFO};

    unsafe {
        let mut icon_info = ICONINFO::default();
        if GetIconInfo(icon, std::ptr::addr_of_mut!(icon_info)).is_err() {
            return None;
        }
        let (width, height) = icon_size(&icon_info);
        let hdc = CreateCompatibleDC(None);
        if hdc.is_invalid() || width <= 0 || height <= 0 {
            release_icon_bitmaps(&icon_info);
            if !hdc.is_invalid() {
                let _ = DeleteDC(hdc);
            }
            return None;
        }

        let bmi = dib_info(width, height);
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = CreateDIBSection(
            Some(hdc),
            &bmi,
            DIB_RGB_COLORS,
            std::ptr::addr_of_mut!(bits),
            None,
            0,
        )
        .ok();
        let Some(bitmap) = bitmap else {
            release_icon_bitmaps(&icon_info);
            let _ = DeleteDC(hdc);
            return None;
        };
        let old = SelectObject(hdc, HGDIOBJ(bitmap.0));
        if DrawIconEx(hdc, 0, 0, icon, width, height, 0, None, DI_NORMAL).is_err() {
            release_icon_bitmaps(&icon_info);
            let _ = SelectObject(hdc, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(hdc);
            return None;
        }

        let byte_count = (width as usize)
            .saturating_mul(height as usize)
            .saturating_mul(4);
        if bits.is_null() || byte_count == 0 {
            release_icon_bitmaps(&icon_info);
            let _ = SelectObject(hdc, old);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(hdc);
            return None;
        }
        let bgra = std::slice::from_raw_parts(bits as *const u8, byte_count);
        let mut rgba = bgra_to_rgba(bgra);
        if !rgba.chunks(4).any(|px| px[3] != 0) {
            apply_mask_alpha(hdc, &icon_info, &mut rgba, width, height);
        }
        release_icon_bitmaps(&icon_info);
        let _ = SelectObject(hdc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(hdc);
        png_from_rgba(&rgba, width as u32, height as u32)
    }
}

#[cfg(target_os = "windows")]
fn icon_size(icon_info: &windows::Win32::UI::WindowsAndMessaging::ICONINFO) -> (i32, i32) {
    use windows::Win32::Graphics::Gdi::{GetObjectW, BITMAP, HGDIOBJ};

    let mut bmp = BITMAP::default();
    let read = unsafe {
        GetObjectW(
            HGDIOBJ(icon_info.hbmColor.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut core::ffi::c_void),
        )
    };
    if read == 0
        || bmp.bmWidth <= 0
        || bmp.bmHeight == 0
        || bmp.bmWidth > 256
        || bmp.bmHeight.abs() > 256
    {
        return (32, 32);
    }
    (bmp.bmWidth, bmp.bmHeight.abs())
}

#[cfg(target_os = "windows")]
fn dib_info(width: i32, height: i32) -> windows::Win32::Graphics::Gdi::BITMAPINFO {
    use windows::Win32::Graphics::Gdi::{BITMAPINFO, BITMAPINFOHEADER, BI_RGB};

    BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
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
    }
}

#[cfg(target_os = "windows")]
fn apply_mask_alpha(
    hdc: windows::Win32::Graphics::Gdi::HDC,
    icon_info: &windows::Win32::UI::WindowsAndMessaging::ICONINFO,
    rgba: &mut [u8],
    width: i32,
    height: i32,
) {
    use windows::Win32::Graphics::Gdi::{GetDIBits, GetObjectW, BITMAP, DIB_RGB_COLORS, HGDIOBJ};

    if icon_info.hbmMask.is_invalid() {
        fill_opaque_where_colored(rgba);
        return;
    }
    let mut mask_bmp = BITMAP::default();
    let read = unsafe {
        GetObjectW(
            HGDIOBJ(icon_info.hbmMask.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut mask_bmp as *mut BITMAP as *mut core::ffi::c_void),
        )
    };
    if read == 0 || mask_bmp.bmWidth != width || mask_bmp.bmHeight.abs() != height {
        fill_opaque_where_colored(rgba);
        return;
    }
    let mut info = dib_info(width, height);
    let mut mask = vec![0u8; rgba.len()];
    let lines = unsafe {
        GetDIBits(
            hdc,
            icon_info.hbmMask,
            0,
            height as u32,
            Some(mask.as_mut_ptr().cast()),
            std::ptr::addr_of_mut!(info),
            DIB_RGB_COLORS,
        )
    };
    if lines == 0 {
        fill_opaque_where_colored(rgba);
        return;
    }
    for (pixel, mask_px) in rgba.chunks_mut(4).zip(mask.chunks(4)) {
        let covered = mask_px[0] > 0 || mask_px[1] > 0 || mask_px[2] > 0;
        pixel[3] = if covered { 0 } else { 255 };
    }
}

#[cfg(target_os = "windows")]
fn fill_opaque_where_colored(rgba: &mut [u8]) {
    for pixel in rgba.chunks_mut(4) {
        if pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0 {
            pixel[3] = 255;
        }
    }
}

#[cfg(target_os = "windows")]
fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    rgba
}

#[cfg(target_os = "windows")]
fn png_from_rgba(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    use std::io::Cursor;

    let image = image::RgbaImage::from_raw(width, height, rgba.to_vec())?;
    let resized = image::imageops::resize(
        &image,
        ICON_PX,
        ICON_PX,
        image::imageops::FilterType::Lanczos3,
    );
    let mut png = Cursor::new(Vec::new());
    resized
        .write_to(&mut png, image::ImageFormat::Png)
        .ok()?;
    Some(png.into_inner())
}

#[cfg(target_os = "windows")]
fn release_icon_bitmaps(icon_info: &windows::Win32::UI::WindowsAndMessaging::ICONINFO) {
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};

    unsafe {
        if !icon_info.hbmColor.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        }
        if !icon_info.hbmMask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        }
    }
}

#[cfg(target_os = "windows")]
fn wide_cstr(buf: &[u16]) -> std::string::String {
    let end = buf.iter().position(|&unit| unit == 0).unwrap_or(buf.len());
    std::string::String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::{choose_best_path, is_transient_install_path};

    #[test]
    fn temp_and_updater_paths_are_transient() {
        assert!(is_transient_install_path(
            r"C:\Users\me\AppData\Local\Temp\Cursor.exe"
        ));
        assert!(is_transient_install_path(
            r"C:\Users\me\AppData\Local\cursor-updater\Cursor.exe"
        ));
        assert!(!is_transient_install_path(
            r"C:\Program Files\NVIDIA Corporation\NVIDIA App\NVIDIA App.exe"
        ));
    }

    #[test]
    fn prefers_the_installed_binary_over_a_temp_copy() {
        let chosen = choose_best_path(vec![
            (r"C:\Users\me\AppData\Local\Temp\Cursor.exe".to_owned(), 2),
            (r"C:\Program Files\cursor\Cursor.exe".to_owned(), 1),
        ]);
        assert_eq!(
            chosen.as_deref(),
            Some(r"C:\Program Files\cursor\Cursor.exe")
        );
    }

    #[test]
    fn uses_the_most_common_stable_path() {
        let chosen = choose_best_path(vec![
            (r"C:\Program Files\A\Weixin.exe".to_owned(), 1),
            (r"C:\Program Files\B\Weixin.exe".to_owned(), 4),
        ]);
        assert_eq!(chosen.as_deref(), Some(r"C:\Program Files\B\Weixin.exe"));
    }
}
