//! 局域网短时 HTTP 提供运行时 YAML，供手机等设备扫码后以 URL 订阅导入。

use std::{
    net::{Ipv4Addr, UdpSocket},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::Duration,
};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::oneshot;
use tauri::Emitter as _;
use warp::Filter as _;

use crate::{
    cmd::{CmdResult, StringifyErr as _},
    config::Config,
    process::AsyncHandler,
};
use clash_verge_logging::{Type, logging};
use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};

const RUNTIME_SHARE_TTL_SECS: u64 = 600;

static SHARE_SEQ: AtomicU64 = AtomicU64::new(1);

struct ActiveLanShare {
    id: u64,
    stop_tx: oneshot::Sender<()>,
}

static ACTIVE_LAN_SHARE: Mutex<Option<ActiveLanShare>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLanShareInfo {
    pub urls: Vec<String>,
    pub primary_url: String,
    pub ttl_secs: u64,
}

fn stop_previous_inner() {
    let mut guard = ACTIVE_LAN_SHARE.lock();
    if let Some(prev) = guard.take() {
        let _ = prev.stop_tx.send(());
    }
}

fn stop_share_if_active(share_id: u64) {
    let mut guard = ACTIVE_LAN_SHARE.lock();
    if let Some(active) = guard.as_ref() {
        if active.id == share_id {
            if let Some(active) = guard.take() {
                let _ = active.stop_tx.send(());
            }
        }
    }
}

/// 停止局域网运行时配置分享 HTTP 服务。
#[tauri::command]
pub async fn stop_runtime_config_lan_share() -> CmdResult<()> {
    stop_previous_inner();
    Ok(())
}

fn collect_lan_urls(port: u16, token: &str) -> CmdResult<Vec<String>> {
    let interfaces = NetworkInterface::show().stringify_err()?;
    let mut ips: Vec<Ipv4Addr> = Vec::new();

    for iface in interfaces {
        for addr in iface.addr {
            match addr {
                network_interface::Addr::V4(v4if) => {
                    let ip = v4if.ip;
                    if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() {
                        ips.push(ip);
                    }
                }
                network_interface::Addr::V6(_) => {}
            }
        }
    }

    ips.sort_unstable_by_key(|ip| ip.to_bits());
    ips.dedup();

    Ok(ips
        .into_iter()
        .map(|ip| format!("http://{ip}:{port}/share/{token}/runtime.yaml"))
        .collect())
}

fn detect_preferred_ipv4() -> Option<Ipv4Addr> {
    // 通过系统路由选择一个对外 UDP 目标，读取本地绑定地址作为默认网卡 IPv4。
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("223.5.5.5:80").ok()?;
    let local = socket.local_addr().ok()?;
    match local.ip() {
        std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_multicast() => {
            Some(ip)
        }
        _ => None,
    }
}

fn pick_primary_url(urls: &[String]) -> Option<String> {
    if let Some(preferred_ip) = detect_preferred_ipv4() {
        let expected = format!("//{preferred_ip}:");
        if let Some(url) = urls.iter().find(|u| u.contains(&expected)) {
            return Some(url.clone());
        }
    }

    urls
        .iter()
        .min_by_key(|u| {
            if u.contains("192.168.") {
                0u8
            } else if u.contains("//10.") {
                1u8
            } else if u.contains("//172.") {
                2u8
            } else {
                3u8
            }
        })
        .cloned()
}

/// 在本机所有网卡上监听随机端口，短时提供当前运行时 YAML；二维码内容为局域网 HTTP URL。
#[tauri::command]
pub async fn start_runtime_config_lan_share() -> CmdResult<RuntimeLanShareInfo> {
    stop_previous_inner();

    let runtime = Config::runtime().await;
    let snapshot = runtime.latest_arc();
    let config = snapshot
        .config
        .as_ref()
        .ok_or_else(|| "failed to read runtime config for LAN share".to_string())?;
    let yaml_text = serde_yaml_ng::to_string(config).stringify_err()?;

    let token = nanoid::nanoid!(24);

    let std_listener = std::net::TcpListener::bind("0.0.0.0:0").stringify_err()?;
    std_listener.set_nonblocking(true).stringify_err()?;
    let port = std_listener.local_addr().stringify_err()?.port();
    let listener = tokio::net::TcpListener::from_std(std_listener).stringify_err()?;

    let yaml_arc = std::sync::Arc::new(yaml_text);
    let token_expect = token.clone();

    let share_id = SHARE_SEQ.fetch_add(1, Ordering::SeqCst);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let used_once = std::sync::Arc::new(AtomicBool::new(false));

    let route = warp::path!("share" / String / "runtime.yaml").and_then(
        move |path_token: String| {
            let yaml_arc = yaml_arc.clone();
            let token_expect = token_expect.clone();
            let used_once = used_once.clone();
            async move {
                if path_token != token_expect {
                    return Err(warp::reject::not_found());
                }
                if used_once
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_err()
                {
                    return Err(warp::reject::not_found());
                }
                let reply = warp::reply::with_header(
                    yaml_arc.as_ref().clone(),
                    "Content-Type",
                    "application/yaml; charset=utf-8",
                );
                let _ = crate::core::handle::Handle::app_handle()
                    .emit("verge://runtime-lan-share-consumed", ());
                stop_share_if_active(share_id);
                Ok::<_, warp::Rejection>(reply)
            }
        },
    );

    {
        let mut guard = ACTIVE_LAN_SHARE.lock();
        *guard = Some(ActiveLanShare {
            id: share_id,
            stop_tx,
        });
    }

    let ttl = RUNTIME_SHARE_TTL_SECS;

    AsyncHandler::spawn(move || async move {
        let shutdown = async move {
            tokio::select! {
                _ = stop_rx => {
                    logging!(info, Type::Network, "运行时配置局域网分享已手动停止");
                }
                _ = tokio::time::sleep(Duration::from_secs(ttl)) => {
                    logging!(info, Type::Network, "运行时配置局域网分享已超时关闭");
                }
            }
        };

        warp::serve(route)
            .incoming(listener)
            .graceful(shutdown)
            .run()
            .await;

        let mut guard = ACTIVE_LAN_SHARE.lock();
        if let Some(active) = guard.as_ref() {
            if active.id == share_id {
                guard.take();
            }
        }
        logging!(info, Type::Network, "局域网运行时配置 HTTP 服务已退出");
    });

    let mut urls = collect_lan_urls(port, &token)?;

    let primary_url = if let Some(u) = pick_primary_url(&urls) {
        u
    } else {
        let localhost = format!("http://127.0.0.1:{port}/share/{token}/runtime.yaml");
        urls.push(localhost.clone());
        localhost
    };

    logging!(
        info,
        Type::Network,
        "已启动运行时配置局域网分享 port={} ttl_secs={}",
        port,
        ttl
    );

    Ok(RuntimeLanShareInfo {
        urls,
        primary_url,
        ttl_secs: ttl,
    })
}
