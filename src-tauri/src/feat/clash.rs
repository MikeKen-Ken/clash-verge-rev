use crate::{
    config::Config,
    core::{CoreManager, handle},
    feat::clean_async,
    utils::{self, resolve::reset_resolve_done},
};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;

/// Restart the Clash core
pub async fn restart_clash_core() {
    match CoreManager::global().restart_core().await {
        Ok(_) => {
            handle::Handle::refresh_clash();
            handle::Handle::notice_message("set_config::ok", "ok");
        }
        Err(err) => {
            handle::Handle::notice_message("set_config::error", format!("{err}"));
            logging!(error, Type::Core, "{err}");
        }
    }
}

/// Restart the application
pub async fn restart_app() {
    logging!(debug, Type::System, "启动重启应用流程");
    // 设置退出标志
    handle::Handle::global().set_is_exiting();

    utils::server::shutdown_embedded_server();
    Config::apply_all_and_save_file().await;

    logging!(info, Type::System, "开始异步清理资源");
    let cleanup_result = clean_async().await;

    logging!(
        info,
        Type::System,
        "资源清理完成，退出代码: {}",
        if cleanup_result { 0 } else { 1 }
    );

    reset_resolve_done();
    let app_handle = handle::Handle::app_handle();
    app_handle.restart();
}

/// Test connection delay to a URL
pub async fn test_delay(url: String) -> anyhow::Result<u32> {
    use crate::utils::network::{NetworkManager, ProxyType};
    use tokio::time::Instant;

    let tun_mode = crate::config::effective_tun_enabled(
        Config::verge().await.latest_arc().enable_tun_mode,
        crate::config::tun_privilege_available().await,
    );

    // 如果是TUN模式，不使用代理，否则使用自身代理
    let proxy_type = if !tun_mode {
        ProxyType::Localhost
    } else {
        ProxyType::None
    };

    let user_agent = Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0".into());

    let start = Instant::now();

    let response = NetworkManager::new()
        .get_with_interrupt(&url, proxy_type, Some(10), user_agent, false, None)
        .await;

    match response {
        Ok(response) => {
            logging!(trace, Type::Network, "test_delay response: {response:#?}");
            if response.status().is_success() {
                Ok(start.elapsed().as_millis() as u32)
            } else {
                Ok(10000u32)
            }
        }
        Err(err) => {
            logging!(trace, Type::Network, "test_delay error: {err:#?}");
            Err(err)
        }
    }
}
