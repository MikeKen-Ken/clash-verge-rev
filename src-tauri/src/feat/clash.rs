use crate::{
    config::Config,
    core::{CoreManager, handle, tray},
    feat::clean_async,
    process::AsyncHandler,
    utils::{self, resolve::reset_resolve_done},
};
use clash_verge_logging::{Type, logging, logging_error};
use serde_yaml_ng::{Mapping, Value};
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

fn after_change_clash_mode() {
    AsyncHandler::spawn(move || async {
        let mihomo = handle::Handle::mihomo().await;
        match mihomo.get_connections().await {
            Ok(connections) => {
                if let Some(connections_array) = connections.connections {
                    for connection in connections_array {
                        let _ = mihomo.close_connection(&connection.id).await;
                    }
                    drop(mihomo);
                }
            }
            Err(err) => {
                logging!(error, Type::Core, "Failed to get connections: {err}");
            }
        }
    });
}

/// Change Clash mode (rule/global/direct/script).
/// 直连/全局模式不切换代理组：只改运行配置的 rules 和 dns，界面 groups 保持不变。
pub async fn change_clash_mode(mode: String) {
    let mut mapping = Mapping::new();
    mapping.insert(Value::from("mode"), Value::from(mode.as_str()));
    logging!(debug, Type::Core, "change clash mode to {mode}");

    // 先写入 mode 到 clash 配置（供 UI 与 enhance 读取）
    Config::clash().await.edit_draft(|d| d.patch_config(&mapping));
    Config::clash().await.apply();
    let clash_data = Config::clash().await.data_arc();
    let _ = clash_data.save_config().await;

    let mode_lower = mode.to_lowercase();
    // 任意模式切换都走「重新生成 + 应用」：直连/全局时 enhance 会覆盖 rules+dns，规则/脚本时不再覆盖，恢复完整配置
    match crate::core::CoreManager::global().update_config().await {
        Ok(_) => {
            handle::Handle::refresh_clash();
            logging_error!(Type::Tray, tray::Tray::global().update_menu().await);
            logging_error!(
                Type::Tray,
                tray::Tray::global()
                    .update_icon(&Config::verge().await.data_arc())
                    .await
            );
            let is_auto_close_connection =
                Config::verge().await.data_arc().auto_close_connection.unwrap_or(false);
            if is_auto_close_connection {
                after_change_clash_mode();
            }
        }
        Err(err) => logging!(error, Type::Core, "update_config after mode change: {err}"),
    }
}

/// Test connection delay to a URL
pub async fn test_delay(url: String) -> anyhow::Result<u32> {
    use crate::utils::network::{NetworkManager, ProxyType};
    use tokio::time::Instant;

    let tun_mode = Config::verge().await.latest_arc().enable_tun_mode.unwrap_or(false);

    // 如果是TUN模式，不使用代理，否则使用自身代理
    let proxy_type = if !tun_mode {
        ProxyType::Localhost
    } else {
        ProxyType::None
    };

    let user_agent = Some("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0".into());

    let start = Instant::now();

    let response = NetworkManager::new()
        .get_with_interrupt(&url, proxy_type, Some(10), user_agent, false)
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
