//! Finds the app process listening on the singleton port so a new launch can
//! replace one whose window no longer answers.

pub fn terminate_app_listeners(port: u16) -> bool {
    terminate_previous_instance(port)
}

/// Another Clash window or its mihomo sidecar is still running.
pub fn other_instance_running() -> bool {
    let mine = std::process::id();
    process_rows()
        .into_iter()
        .any(|(pid, _, exe)| pid != mine && (exe_is_ui(&exe) || exe_is_sidecar(&exe)))
}

/// End the previous UI, its WebView children, and the mihomo sidecar.
/// The current process is left alone. An already-exited pid counts as done.
pub fn terminate_previous_instance(port: u16) -> bool {
    let pids = instance_pids(port);
    if pids.is_empty() {
        return true;
    }
    pids.into_iter().all(terminate_pid)
}

fn instance_pids(port: u16) -> Vec<u32> {
    let mine = std::process::id();
    let rows = process_rows();
    let mut pids = Vec::new();
    for (pid, _, exe) in &rows {
        if *pid != 0 && *pid != mine && (exe_is_ui(exe) || exe_is_sidecar(exe)) {
            push_pid(&mut pids, *pid);
        }
    }
    // WebView children are parented under the browser process, not the UI.
    let mut grew = true;
    while grew {
        grew = false;
        for (pid, parent, exe) in &rows {
            if *pid != mine && exe_is_webview(exe) && pids.contains(parent) && !pids.contains(pid) {
                pids.push(*pid);
                grew = true;
            }
        }
    }
    for pid in listener_pids(port) {
        if pid != 0 && pid != mine && is_app_process(pid) {
            push_pid(&mut pids, pid);
        }
    }
    pids
}

fn push_pid(pids: &mut Vec<u32>, pid: u32) {
    if !pids.contains(&pid) {
        pids.push(pid);
    }
}

pub fn exe_is_ui(name: &str) -> bool {
    let file = file_name(name);
    file.contains("clash-verge") || file.contains("clash verge")
}

pub fn exe_is_sidecar(name: &str) -> bool {
    let file = file_name(name);
    let stem = file.strip_suffix(".exe").unwrap_or(&file);
    stem == "mihomo" || stem.starts_with("verge-mihomo")
}

fn exe_is_webview(name: &str) -> bool {
    file_name(name).contains("msedgewebview2")
}

fn file_name(name: &str) -> std::string::String {
    name.rsplit(['\\', '/']).next().unwrap_or(name).to_lowercase()
}

#[cfg(windows)]
fn process_rows() -> Vec<(u32, u32, std::string::String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };

    let mut rows = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return rows;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let exe = wide_exe(&entry.szExeFile);
                rows.push((entry.th32ProcessID, entry.th32ParentProcessID, exe));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    rows
}

fn wide_exe(buf: &[u16]) -> std::string::String {
    let end = buf.iter().position(|&unit| unit == 0).unwrap_or(buf.len());
    std::string::String::from_utf16_lossy(&buf[..end])
}

#[cfg(not(windows))]
fn process_rows() -> Vec<(u32, u32, std::string::String)> {
    Vec::new()
}

#[cfg(windows)]
fn listener_pids(port: u16) -> Vec<u32> {
    use std::ffi::c_void;

    const AF_INET: u32 = 2;
    const TCP_TABLE_OWNER_PID_LISTENER: i32 = 3;
    const NO_ERROR: u32 = 0;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ROW_LEN: usize = 24;

    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(
            table: *mut c_void,
            size: *mut u32,
            order: i32,
            af: u32,
            table_class: i32,
            reserved: u32,
        ) -> u32;
    }

    let mut size = 0u32;
    let first = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if (first != ERROR_INSUFFICIENT_BUFFER && first != NO_ERROR) || size == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u8; size as usize];
    let status = unsafe {
        GetExtendedTcpTable(
            buffer.as_mut_ptr().cast(),
            &mut size,
            0,
            AF_INET,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if status != NO_ERROR || buffer.len() < 4 {
        return Vec::new();
    }
    let count = u32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
    let mut pids = Vec::new();
    for index in 0..count {
        let start = 4 + index * ROW_LEN;
        let Some(row) = buffer.get(start..start + ROW_LEN) else {
            break;
        };
        let raw_port = u32::from_ne_bytes([row[8], row[9], row[10], row[11]]);
        if tcp_port(raw_port) != port {
            continue;
        }
        let pid = u32::from_ne_bytes([row[20], row[21], row[22], row[23]]);
        pids.push(pid);
    }
    pids
}

#[cfg(not(windows))]
fn listener_pids(port: u16) -> Vec<u32> {
    let _ = port;
    Vec::new()
}

#[cfg(windows)]
fn is_app_process(pid: u32) -> bool {
    let Some(path) = image_path(pid) else {
        return false;
    };
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path.as_str());
    let file = file.to_lowercase();
    file.contains("clash-verge") || file.contains("clash verge")
}

#[cfg(not(windows))]
fn is_app_process(pid: u32) -> bool {
    let _ = pid;
    false
}

#[cfg(windows)]
fn image_path(pid: u32) -> Option<String> {
    use std::ffi::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(process: *mut c_void, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len);
        let _ = CloseHandle(handle);
        if ok == 0 {
            return None;
        }
        let len = (len as usize).min(buf.len());
        Some(String::from_utf16_lossy(&buf[..len]))
    }
}

#[cfg(windows)]
fn terminate_pid(pid: u32) -> bool {
    use std::ffi::c_void;

    const PROCESS_TERMINATE: u32 = 0x0001;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn TerminateProcess(process: *mut c_void, exit_code: u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            // 87: the pid is already gone. Anything else is a real failure.
            return last_error() == 87;
        }
        let ok = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        ok != 0
    }
}

#[cfg(windows)]
fn last_error() -> u32 {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetLastError() -> u32;
    }
    unsafe { GetLastError() }
}

#[cfg(not(windows))]
fn terminate_pid(pid: u32) -> bool {
    let _ = pid;
    false
}

/// `dwLocalPort` from `MIB_TCPROW_OWNER_PID` is a DWORD in network byte order.
pub const fn tcp_port(raw: u32) -> u16 {
    let bytes = raw.to_ne_bytes();
    u16::from_be_bytes([bytes[0], bytes[1]])
}

#[cfg(test)]
mod tests {
    use super::tcp_port;

    #[test]
    fn network_order_port_uses_the_first_two_bytes() {
        let raw = u32::from_ne_bytes([0x82, 0x33, 0, 0]);
        assert_eq!(tcp_port(raw), 0x8233);
    }

    #[test]
    fn ui_and_sidecar_names_match_the_running_executables() {
        use super::{exe_is_sidecar, exe_is_ui};

        assert!(exe_is_ui("clash-verge.exe"));
        assert!(exe_is_ui(r"C:\Program Files\Clash Verge\clash-verge.exe"));
        assert!(!exe_is_ui("verge-mihomo-custom.exe"));
        assert!(exe_is_sidecar("verge-mihomo-custom.exe"));
        assert!(exe_is_sidecar("mihomo.exe"));
        assert!(!exe_is_sidecar("clash-verge.exe"));
        assert!(!exe_is_sidecar("msedgewebview2.exe"));
    }
}
