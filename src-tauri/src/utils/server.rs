use super::resolve;
use crate::{
    cmd::is_port_in_use,
    config::{Config, DEFAULT_PAC, IVerge},
    module::{
        lightweight,
        window_liveness::{self, ExistingInstance, HealthReply, classify_health, handoff},
    },
    process::AsyncHandler,
    utils::window_manager::WindowManager,
};
use anyhow::{Result, bail};
use clash_verge_logging::{Type, logging, logging_error};
use once_cell::sync::OnceCell;
use parking_lot::Mutex;
use reqwest::ClientBuilder;
use smartstring::alias::String;
use std::time::Duration;
use tokio::sync::oneshot;
use warp::Filter as _;

#[derive(serde::Deserialize, Debug)]
struct QueryParam {
    param: String,
}

// 关闭 embedded server 的信号发送端
static SHUTDOWN_SENDER: OnceCell<Mutex<Option<oneshot::Sender<()>>>> = OnceCell::new();

/// check whether there is already exists
pub async fn check_singleton() -> Result<()> {
    let port = IVerge::get_singleton_port();
    if !is_port_in_use(port) {
        return Ok(());
    }
    let health = probe_health(port).await;
    let visible_ok = match health {
        HealthReply::Ok | HealthReply::Other => notify_existing(port).await.is_ok(),
        HealthReply::Stuck | HealthReply::Unreachable => false,
    };
    if handoff(health, visible_ok) == ExistingInstance::Keep {
        logging!(error, Type::Window, "failed to setup singleton listen server");
        bail!("app exists");
    }
    logging!(
        warn,
        Type::Window,
        "Replacing a stuck instance that held the singleton port {port}"
    );
    if !crate::utils::listener_pid::terminate_app_listeners(port) {
        bail!("stuck instance still holds the singleton port");
    }
    for _ in 0..30 {
        if !is_port_in_use(port) {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("stuck instance still holds the singleton port")
}

async fn probe_health(port: u16) -> HealthReply {
    let Ok(client) = ClientBuilder::new().timeout(Duration::from_millis(500)).build() else {
        return HealthReply::Unreachable;
    };
    let Ok(response) = client
        .get(format!("http://127.0.0.1:{port}/commands/health"))
        .send()
        .await
    else {
        return HealthReply::Unreachable;
    };
    let body = response.text().await.unwrap_or_default();
    classify_health(true, &body)
}

async fn notify_existing(port: u16) -> Result<()> {
    let client = ClientBuilder::new().timeout(Duration::from_millis(500)).build()?;
    #[allow(clippy::needless_collect)]
    let argvs: Vec<std::string::String> = std::env::args().collect();
    if argvs.len() > 1 {
        #[cfg(not(target_os = "macos"))]
        {
            let param = argvs[1].as_str();
            if param.starts_with("clash:") {
                client
                    .get(format!("http://127.0.0.1:{port}/commands/scheme?param={param}"))
                    .send()
                    .await?;
                return Ok(());
            }
        }
        return Ok(());
    }
    client
        .get(format!("http://127.0.0.1:{port}/commands/visible"))
        .send()
        .await?;
    Ok(())
}

/// Close and a second launch cannot escape a stuck window while this process keeps the port.
pub fn exit_if_window_is_stuck() {
    if !window_liveness::should_yield_to_next_instance() {
        return;
    }
    logging!(
        error,
        Type::Window,
        "Window is stuck; releasing the singleton so a new instance can start"
    );
    shutdown_embedded_server();
    std::process::exit(0);
}

/// The embed server only be used to implement singleton process
/// maybe it can be used as pac server later
pub fn embed_server() {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    #[allow(clippy::expect_used)]
    SHUTDOWN_SENDER
        .set(Mutex::new(Some(shutdown_tx)))
        .expect("failed to set shutdown signal for embedded server");
    let port = IVerge::get_singleton_port();

    let health = warp::path!("commands" / "health").map(|| {
        if window_liveness::should_yield_to_next_instance() {
            warp::reply::with_status("stuck".to_string(), warp::http::StatusCode::SERVICE_UNAVAILABLE)
        } else {
            warp::reply::with_status("ok".to_string(), warp::http::StatusCode::OK)
        }
    });

    let visible = warp::path!("commands" / "visible").and_then(|| async {
        logging!(info, Type::Window, "检测到从单例模式恢复应用窗口");
        if !lightweight::exit_lightweight_mode().await {
            WindowManager::show_main_window().await;
        } else {
            logging!(error, Type::Window, "轻量模式退出失败，无法恢复应用窗口");
        };
        Ok::<_, warp::Rejection>(warp::reply::with_status::<std::string::String>(
            "ok".to_string(),
            warp::http::StatusCode::OK,
        ))
    });

    let pac = warp::path!("commands" / "pac").and_then(|| async move {
        let verge_config = Config::verge().await;
        let clash_config = Config::clash().await;

        let pac_content = verge_config
            .data_arc()
            .pac_file_content
            .clone()
            .unwrap_or_else(|| DEFAULT_PAC.into());

        let pac_port = verge_config
            .data_arc()
            .verge_mixed_port
            .unwrap_or_else(|| clash_config.data_arc().get_mixed_port());
        let processed_content = pac_content.replace("%mixed-port%", &format!("{pac_port}"));
        Ok::<_, warp::Rejection>(
            warp::http::Response::builder()
                .header("Content-Type", "application/x-ns-proxy-autoconfig")
                .body(processed_content)
                .unwrap_or_default(),
        )
    });

    // Use map instead of and_then to avoid Send issues
    let scheme = warp::path!("commands" / "scheme")
        .and(warp::query::<QueryParam>())
        .and_then(|query: QueryParam| async move {
            AsyncHandler::spawn(|| async move {
                logging_error!(Type::Setup, resolve::resolve_scheme(&query.param).await);
            });
            Ok::<_, warp::Rejection>(warp::reply::with_status::<std::string::String>(
                "ok".to_string(),
                warp::http::StatusCode::OK,
            ))
        });

    let commands = health.or(visible).or(scheme).or(pac);

    AsyncHandler::spawn(move || async move {
        warp::serve(commands)
            .bind(([127, 0, 0, 1], port))
            .await
            .graceful(async {
                shutdown_rx.await.ok();
            })
            .run()
            .await;
    });
}

pub fn shutdown_embedded_server() {
    logging!(info, Type::Window, "shutting down embedded server");
    if let Some(sender) = SHUTDOWN_SENDER.get()
        && let Some(sender) = sender.lock().take()
    {
        sender.send(()).ok();
    }
}
