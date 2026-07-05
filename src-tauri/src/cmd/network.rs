use super::CmdResult;
use crate::cmd::StringifyErr as _;
use clash_verge_logging::{Type, logging};
use gethostname::gethostname;
use network_interface::NetworkInterface;
use serde_yaml_ng::Mapping;
use std::net::TcpListener;
use sysproxy::{Autoproxy, Sysproxy};
use tauri_plugin_clash_verge_sysinfo;

/// get the system proxy
#[tauri::command]
pub async fn get_sys_proxy() -> CmdResult<Mapping> {
    logging!(debug, Type::Network, "异步获取系统代理配置");

    let sys_proxy = Sysproxy::get_system_proxy().stringify_err()?;
    let Sysproxy {
        ref host,
        ref bypass,
        ref port,
        ref enable,
    } = sys_proxy;

    let mut map = Mapping::new();
    map.insert("enable".into(), (*enable).into());
    map.insert("server".into(), format!("{}:{}", host, port).into());
    map.insert("bypass".into(), bypass.as_str().into());

    logging!(
        debug,
        Type::Network,
        "返回系统代理配置: enable={}, {}:{}",
        sys_proxy.enable,
        sys_proxy.host,
        sys_proxy.port
    );
    Ok(map)
}

/// 获取自动代理配置
#[tauri::command]
pub async fn get_auto_proxy() -> CmdResult<Mapping> {
    let auto_proxy = Autoproxy::get_auto_proxy().stringify_err()?;
    let Autoproxy { ref enable, ref url } = auto_proxy;

    let mut map = Mapping::new();
    map.insert("enable".into(), (*enable).into());
    map.insert("url".into(), url.as_str().into());

    logging!(
        debug,
        Type::Network,
        "返回自动代理配置（缓存）: enable={}, url={}",
        auto_proxy.enable,
        auto_proxy.url
    );
    Ok(map)
}

/// 获取系统主机名
#[tauri::command]
pub fn get_system_hostname() -> String {
    // 获取系统主机名，处理可能的非UTF-8字符
    match gethostname().into_string() {
        Ok(name) => name,
        Err(os_string) => {
            // 对于包含非UTF-8的主机名，使用调试格式化
            let fallback = format!("{os_string:?}");
            // 去掉可能存在的引号
            fallback.trim_matches('"').to_string()
        }
    }
}

/// 获取网络接口列表
#[tauri::command]
pub fn get_network_interfaces() -> Vec<String> {
    tauri_plugin_clash_verge_sysinfo::list_network_interfaces()
}

/// 获取网络接口详细信息
#[tauri::command]
pub fn get_network_interfaces_info() -> CmdResult<Vec<NetworkInterface>> {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};

    let names = get_network_interfaces();
    let interfaces = NetworkInterface::show().stringify_err()?;

    let mut result = Vec::new();

    for interface in interfaces {
        if names.contains(&interface.name) {
            result.push(interface);
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn is_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// 经 Clash 当前出站路径发起 GET（出口 IP 检测等）。
/// 按 TUN / 系统代理 / mixed-port 自动选择出站，与 `test_delay` 策略一致。
#[tauri::command]
pub async fn fetch_with_local_proxy(
    url: String,
    timeout_secs: Option<u64>,
    mixed_port: Option<u16>,
) -> CmdResult<String> {
    use crate::utils::network::NetworkManager;

    let timeout = timeout_secs.unwrap_or(5);
    let user_agent = Some(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            .into(),
    );

    let response = NetworkManager::new()
        .get_with_egress(
            &url,
            Some(timeout),
            user_agent,
            false,
            mixed_port,
        )
        .await
        .stringify_err()?;

    Ok(response.text_with_charset().stringify_err()?.to_string())
}
