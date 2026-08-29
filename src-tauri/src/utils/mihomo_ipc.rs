//! Direct HTTP calls to the Mihomo control API over the IPC socket (named pipe / Unix socket),
//! mirroring `tauri-plugin-mihomo` when `Protocol::LocalSocket` is used.

use std::time::Duration;

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, HOST};
use reqwest::{Method, StatusCode};

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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRecoveryReport {
    pub sequence: u64,
    pub action: String,
    pub coalesced: bool,
    pub closed_connections: bool,
    pub reset_adapters: usize,
    pub restart_recommended: bool,
    pub error: Option<String>,
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

/// POST `/network/recover` through the authenticated local controller socket.
pub async fn post_network_recovery(kind: &str, reason: &str) -> Result<NetworkRecoveryReport> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;

    let url = "http://localhost/network/recover";
    let response = client
        .request(Method::POST, url)
        .headers(headers)
        .json(&serde_json::json!({ "kind": kind, "reason": reason }))
        .send()
        .await
        .context("send POST /network/recover")?;

    if response.status() == StatusCode::NOT_FOUND {
        return legacy_network_recovery(kind).await;
    }
    if !response.status().is_success() {
        anyhow::bail!("POST /network/recover returned {}", response.status());
    }
    response
        .json()
        .await
        .context("decode POST /network/recover response")
}

async fn legacy_network_recovery(kind: &str) -> Result<NetworkRecoveryReport> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;
    let close_response = client
        .delete("http://localhost/connections")
        .headers(headers.clone())
        .send()
        .await
        .context("send legacy DELETE /connections")?;
    if !close_response.status().is_success() {
        anyhow::bail!("legacy DELETE /connections returned {}", close_response.status());
    }

    let flush_response = client
        .post("http://localhost/cache/fakeip/flush")
        .headers(headers)
        .send()
        .await
        .context("send legacy POST /cache/fakeip/flush")?;
    if !flush_response.status().is_success() {
        anyhow::bail!("legacy POST /cache/fakeip/flush returned {}", flush_response.status());
    }

    Ok(NetworkRecoveryReport {
        sequence: 0,
        action: format!("legacy-{kind}").into(),
        coalesced: false,
        closed_connections: true,
        reset_adapters: 0,
        restart_recommended: false,
        error: None,
    })
}

/// GET `/network/status` — returns the most recent typed recovery result.
pub async fn get_network_recovery_status() -> Result<NetworkRecoveryReport> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;
    let response = client
        .get("http://localhost/network/status")
        .headers(headers)
        .send()
        .await
        .context("send GET /network/status")?;
    if !response.status().is_success() {
        anyhow::bail!("GET /network/status returned {}", response.status());
    }
    response
        .json()
        .await
        .context("decode GET /network/status response")
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

/// PUT `/proxies/{group}` — select a node; `force` skips the extra URLTest in Set().
pub async fn put_group_selected_proxy(
    group_name: &str,
    proxy_name: &str,
    force: bool,
) -> Result<()> {
    let (client, headers) = build_ipc_client(RESET_TIMEOUT).await?;
    let encoded = encode_path_segment(group_name);
    let url = format!("http://localhost/proxies/{encoded}");
    let response = client
        .request(Method::PUT, url)
        .headers(headers)
        .json(&serde_json::json!({ "name": proxy_name, "force": force }))
        .send()
        .await
        .with_context(|| format!("send PUT /proxies/{{name}} for {group_name:?}"))?;

    if !response.status().is_success() {
        anyhow::bail!(
            "PUT /proxies/{{name}} returned {} for group {:?}",
            response.status(),
            group_name
        );
    }
    Ok(())
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
