//! After a profile file is saved, upload the runtime YAML the core is running.
//! This is the same snapshot as the runtime YAML upload button.

use std::sync::atomic::{AtomicU64, Ordering};

use clash_verge_logging::{Type, logging};
use tokio::sync::Mutex;

use crate::{
    cmd::runtime_yaml_transfer::{current_runtime_yaml, put_remote_runtime_yaml, validate_runtime_yaml},
    config::Config,
    core::handle::Handle,
    process::AsyncHandler,
};

static PUBLISH_SEQ: AtomicU64 = AtomicU64::new(0);
static PUBLISH_LOCK: Mutex<()> = Mutex::const_new(());

pub(crate) fn webdav_ready_for_runtime_publish(url: &str, username: &str, password: &str) -> bool {
    !username.trim().is_empty()
        && !password.trim().is_empty()
        && url.trim().to_ascii_lowercase().starts_with("https://")
}

async fn runtime_webdav_configured() -> bool {
    let verge = Config::verge().await.data_arc();
    webdav_ready_for_runtime_publish(
        verge.webdav_url.as_deref().unwrap_or(""),
        verge.webdav_username.as_deref().unwrap_or(""),
        verge.webdav_password.as_deref().unwrap_or(""),
    )
}

/// Upload the runtime already loaded by the core. Profile files are left as they are.
/// A newer call replaces an older snapshot that has not started its WebDAV write.
pub async fn publish_running_runtime_yaml() -> anyhow::Result<()> {
    let seq = PUBLISH_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let content = current_runtime_yaml().await?;
    validate_runtime_yaml(&content)?;
    let bytes = content.into_bytes();
    let _guard = PUBLISH_LOCK.lock().await;
    if PUBLISH_SEQ.load(Ordering::SeqCst) != seq {
        logging!(info, Type::Config, "[订阅更新] 已有更新的运行配置等待上传，跳过旧快照");
        return Ok(());
    }
    put_remote_runtime_yaml(bytes).await?;
    logging!(info, Type::Config, "[订阅更新] 已将新的运行配置上传到 WebDAV");
    Ok(())
}

pub async fn schedule_runtime_yaml_publish() {
    if Handle::global().is_exiting() || !runtime_webdav_configured().await {
        return;
    }

    AsyncHandler::spawn(move || async move {
        if let Err(err) = publish_running_runtime_yaml().await {
            logging!(warn, Type::Config, "[订阅更新] 未能把新的运行配置上传到 WebDAV: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::webdav_ready_for_runtime_publish;

    #[test]
    fn https_account_can_publish_runtime_yaml() {
        assert!(webdav_ready_for_runtime_publish(
            "https://dav.example.com/remote.php/dav/files/user",
            "user",
            "secret"
        ));
    }

    #[test]
    fn incomplete_or_insecure_webdav_does_not_publish() {
        assert!(!webdav_ready_for_runtime_publish(
            "http://dav.example.com",
            "user",
            "secret"
        ));
        assert!(!webdav_ready_for_runtime_publish(
            "https://dav.example.com",
            "",
            "secret"
        ));
        assert!(!webdav_ready_for_runtime_publish(
            "https://dav.example.com",
            "user",
            "  "
        ));
        assert!(!webdav_ready_for_runtime_publish("", "user", "secret"));
    }
}
