//! Finds the app process listening on the singleton port so a new launch can
//! replace one whose window no longer answers.

pub fn terminate_app_listeners(port: u16) -> bool {
    let mine = std::process::id();
    let mut found = false;
    let mut terminated = true;
    for pid in listener_pids(port) {
        if pid == 0 || pid == mine || !is_app_process(pid) {
            continue;
        }
        found = true;
        terminated &= terminate_pid(pid);
    }
    found && terminated
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
            return false;
        }
        let ok = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        ok != 0
    }
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
}
