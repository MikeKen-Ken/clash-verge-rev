//! Direct HTTP calls to the Mihomo control API over the IPC socket (named pipe / Unix socket),
//! mirroring `tauri-plugin-mihomo` when `Protocol::LocalSocket` is used.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, HOST};
use reqwest::Method;

use crate::config::{Config, IClashTemp};

const RESET_TIMEOUT: Duration = Duration::from_secs(5);

/// POST `/traffic/reset` — clears global upload/download counters (same as Android `Clash.reset()` on Tun start).
pub async fn post_traffic_reset() -> Result<()> {
    let socket_path = IClashTemp::guard_external_controller_ipc();
    let secret = Config::clash().await.data_arc().get_client_info().secret;

    let mut headers = HeaderMap::new();
    headers.insert(HOST, HeaderValue::from_static("localhost"));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(ref s) = secret {
        let auth = HeaderValue::from_str(&format!("Bearer {s}"))
            .context("invalid clash secret for Authorization header")?;
        headers.insert(AUTHORIZATION, auth);
    }

    let mut builder = reqwest::ClientBuilder::new().timeout(RESET_TIMEOUT);
    #[cfg(windows)]
    {
        builder = builder.windows_named_pipe(socket_path.as_str());
    }
    #[cfg(unix)]
    {
        builder = builder.unix_socket(socket_path.as_str());
    }
    let client = builder.build().context("build reqwest client for Mihomo IPC")?;

    let url = "http://localhost/traffic/reset";
    let response = client
        .request(Method::POST, url)
        .headers(headers)
        .send()
        .await
        .context("send POST /traffic/reset")?;

    if !response.status().is_success() {
        anyhow::bail!("POST /traffic/reset returned {}", response.status());
    }
    Ok(())
}
