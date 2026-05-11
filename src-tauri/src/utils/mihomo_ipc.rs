//! Direct HTTP calls to the Mihomo control API over the IPC socket (named pipe / Unix socket),
//! mirroring `tauri-plugin-mihomo` when `Protocol::LocalSocket` is used.

use std::time::Duration;

use anyhow::{Context, Result};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, HOST};
use reqwest::Method;

use crate::config::{Config, IClashTemp};

const RESET_TIMEOUT: Duration = Duration::from_secs(5);
const RULE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(120);

/// 规则提供者展开预览（GET `/providers/rules/{name}`），与 Mihomo REST 对齐。
#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuleProviderPreviewDto {
    pub name: String,
    pub behavior: String,
    pub policy: String,
    pub rules: Vec<RuleProviderPreviewRuleDto>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RuleProviderPreviewRuleDto {
    pub rule_type: String,
    pub payload: String,
    pub policy: String,
}

async fn build_ipc_client(timeout: Duration) -> Result<(reqwest::Client, HeaderMap)> {
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

    let mut builder = reqwest::ClientBuilder::new().timeout(timeout);
    #[cfg(windows)]
    {
        builder = builder.windows_named_pipe(socket_path.as_str());
    }
    #[cfg(unix)]
    {
        builder = builder.unix_socket(socket_path.as_str());
    }
    let client = builder.build().context("build reqwest client for Mihomo IPC")?;
    Ok((client, headers))
}

/// POST `/traffic/reset` — clears global upload/download counters (same as Android `Clash.reset()` on Tun start).
pub async fn post_traffic_reset() -> Result<()> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;

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

/// GET `/providers/rules/{name}` — 展开规则集内全部规则行（需与当前运行核心版本一致）。
pub async fn get_rule_provider_preview(provider_name: &str) -> Result<RuleProviderPreviewDto> {
    let (client, headers) = build_ipc_client(RULE_PREVIEW_TIMEOUT).await?;
    let enc = utf8_percent_encode(provider_name, NON_ALPHANUMERIC).to_string();
    let url = format!("http://localhost/providers/rules/{enc}");
    let response = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("send GET {url}"))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "GET /providers/rules/… returned {} for provider {:?}",
            response.status(),
            provider_name
        );
    }
    let body = response.text().await.context("read rule provider preview body")?;
    serde_json::from_str(&body).with_context(|| {
        format!("parse rule provider preview JSON for provider {provider_name:?}")
    })
}
