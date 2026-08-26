//! Direct HTTP calls to the Mihomo control API over the IPC socket (named pipe / Unix socket),
//! mirroring `tauri-plugin-mihomo` when `Protocol::LocalSocket` is used.

use std::time::Duration;

use anyhow::{Context, Result};
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

/// RFC 3986：`unreserved` 在路径分段中应保持字面量，便于与 Mihomo chi 路由及常见规则集命名一致；
/// `NON_ALPHANUMERIC` 会把 `-`/`_`/`.`/`~` 等无需编码的 ASCII 编成 `%XX`，易误判为 URL 错误且无必要。
fn encode_rule_provider_path_segment(name: &str) -> String {
    let reserve = name
        .as_bytes()
        .iter()
        .copied()
        .filter(|&b| {
            !(b.is_ascii_alphanumeric()
                || matches!(b, b'-' | b'_' | b'.' | b'~'))
        })
        .count();
    let mut out = String::with_capacity(name.len() + reserve * 2);
    for &byte in name.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            push_pct_upper_hex(&mut out, byte);
        }
    }
    out
}

fn push_pct_upper_hex(out: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    out.push('%');
    out.push(HEX[(byte >> 4) as usize] as char);
    out.push(HEX[(byte & 0xf) as usize] as char);
}

fn encode_path_segment(segment: &str) -> String {
    let reserve = segment
        .as_bytes()
        .iter()
        .copied()
        .filter(|&b| !(b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~')))
        .count();
    let mut out = String::with_capacity(segment.len() + reserve * 2);
    for &byte in segment.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            push_pct_upper_hex(&mut out, byte);
        }
    }
    out
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
    let enc = encode_rule_provider_path_segment(provider_name);
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

/// PUT `/group/{name}/order` — reorder a live url-test/fallback group's cached proxies.
pub async fn put_group_proxy_order(group_name: &str, proxies: &[String]) -> Result<()> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;
    let encoded = encode_path_segment(group_name);
    let url = format!("http://localhost/group/{encoded}/order");
    let response = client
        .request(Method::PUT, url)
        .headers(headers)
        .json(&serde_json::json!({ "proxies": proxies }))
        .send()
        .await
        .with_context(|| format!("send PUT /group/{{name}}/order for {group_name:?}"))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "PUT /group/{{name}}/order returned {} for group {:?}",
            response.status(),
            group_name
        );
    }
    Ok(())
}

/// DELETE `/proxies/{group}` — clear manual selection for URL-Test/Fallback groups.
pub async fn delete_proxy_fixed(group_name: &str) -> Result<()> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;
    let encoded = encode_path_segment(group_name);
    let url = format!("http://localhost/proxies/{encoded}");
    let response = client
        .request(Method::DELETE, &url)
        .headers(headers)
        .send()
        .await
        .with_context(|| format!("send DELETE {url}"))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "DELETE /proxies/{{name}} returned {} for group {:?}",
            response.status(),
            group_name
        );
    }
    Ok(())
}
