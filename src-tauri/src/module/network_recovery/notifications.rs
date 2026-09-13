//! Route callbacks only wake the monitor. Fingerprints remain authoritative.
use std::sync::OnceLock;
use tokio::sync::Notify;

static CHANGED: OnceLock<Notify> = OnceLock::new();

pub async fn changed() {
    CHANGED.get_or_init(Notify::new).notified().await;
}

#[cfg(windows)]
mod platform {
    use super::CHANGED;
    use std::ffi::c_void;
    use tokio::sync::Notify;

    // netioapi.h: ADDRESS_FAMILY=u16, BOOLEAN=u8, HANDLE=pointer,
    // MIB_NOTIFICATION_TYPE=C enum. We never dereference the callback row.
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn NotifyRouteChange2(
            family: u16,
            callback: unsafe extern "system" fn(*const c_void, *const c_void, i32),
            context: *const c_void,
            initial: u8,
            handle: *mut *mut c_void,
        ) -> u32;
        fn CancelMibChangeNotify2(handle: *mut c_void) -> u32;
    }

    unsafe extern "system" fn on_change(_: *const c_void, _: *const c_void, _: i32) {
        if let Some(signal) = CHANGED.get() {
            signal.notify_one();
        }
    }

    // Integer storage permits moving the registration with the async monitor;
    // the OS handle is only consumed by CancelMibChangeNotify2 on drop.
    pub struct Registration(usize);

    pub fn register() -> Result<Registration, u32> {
        CHANGED.get_or_init(Notify::new);
        let mut handle = std::ptr::null_mut();
        // AF_UNSPEC covers IPv4 and IPv6; no callback context is allocated.
        let result = unsafe { NotifyRouteChange2(0, on_change, std::ptr::null(), 0, &mut handle) };
        if result == 0 {
            Ok(Registration(handle as usize))
        } else {
            Err(result)
        }
    }

    impl Drop for Registration {
        fn drop(&mut self) {
            // Never cancel inside the callback: cancellation waits for callbacks.
            unsafe {
                CancelMibChangeNotify2(self.0 as *mut c_void);
            }
        }
    }
}

#[cfg(windows)]
pub use platform::register;

#[cfg(not(windows))]
pub fn register() -> Result<(), u32> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn registers_and_releases_os_subscription() {
        // Read-only OS subscription; no route or interface is changed.
        let subscription = register().expect("register route notifications");
        drop(subscription);
    }

    #[test]
    fn burst_is_bounded_and_retains_pending_change() {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(async {
                let signal = CHANGED.get_or_init(Notify::new);
                for _ in 0..1000 {
                    signal.notify_one();
                }
                tokio::time::timeout(std::time::Duration::from_secs(1), changed())
                    .await
                    .unwrap();
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(10), changed())
                        .await
                        .is_err()
                );
            });
    }
}
