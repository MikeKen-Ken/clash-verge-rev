use crate::config::Config;
use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use clash_verge_logging::{Type, logging};
use reqwest::{
    Client, Proxy, StatusCode,
    header::{HeaderMap, HeaderValue, USER_AGENT},
};
use smartstring::alias::String;
use std::time::Duration;
use sysproxy::Sysproxy;
use tauri::Url;

#[derive(Debug)]
pub struct HttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl HttpResponse {
    pub const fn new(status: StatusCode, headers: HeaderMap, body: String) -> Self {
        Self { status, headers, body }
    }

    pub const fn status(&self) -> StatusCode {
        self.status
    }

    pub const fn headers(&self) -> &HeaderMap {
        &self.headers
    }

    pub fn text_with_charset(&self) -> Result<&str> {
        Ok(&self.body)
    }
}

#[derive(Debug, Clone, Copy)]
pub enum ProxyType {
    None,
    /// mixed-port HTTP 代理
    Localhost,
    /// mixed-port SOCKS5（HTTP CONNECT 失败时的备用）
    LocalhostSocks,
    System,
}

/// 按当前运行模式排列出站尝试顺序（与 `test_delay` 策略对齐）。
pub async fn resolve_egress_routes() -> Vec<ProxyType> {
    let verge = Config::verge().await.latest_arc();
    let tun = verge.enable_tun_mode.unwrap_or(false);
    let sys = verge.enable_system_proxy.unwrap_or(false);

    if tun {
        // TUN：进程流量由虚拟网卡接管，直连优先；mixed-port / 系统代理作备用
        vec![
            ProxyType::None,
            ProxyType::Localhost,
            ProxyType::LocalhostSocks,
            ProxyType::System,
        ]
    } else if sys {
        vec![
            ProxyType::System,
            ProxyType::Localhost,
            ProxyType::LocalhostSocks,
            ProxyType::None,
        ]
    } else {
        vec![
            ProxyType::Localhost,
            ProxyType::LocalhostSocks,
            ProxyType::System,
            ProxyType::None,
        ]
    }
}

pub struct NetworkManager;

impl Default for NetworkManager {
    fn default() -> Self {
        Self::new()
    }
}

impl NetworkManager {
    pub const fn new() -> Self {
        Self
    }

    /// 解析 mixed-port：前端传入 > Clash 运行配置 > verge 设置
    async fn resolve_mixed_port(override_port: Option<u16>) -> u16 {
        if let Some(port) = override_port.filter(|&p| p > 0) {
            return port;
        }
        let clash_port = Config::clash().await.latest_arc().get_mixed_port();
        let verge_port = Config::verge().await.data_arc().verge_mixed_port;
        match verge_port {
            Some(vp) if vp == clash_port => vp,
            Some(_) => clash_port,
            None => clash_port,
        }
    }

    fn build_client(
        &self,
        proxy_url: Option<std::string::String>,
        default_headers: HeaderMap,
        accept_invalid_certs: bool,
        timeout_secs: Option<u64>,
    ) -> Result<Client> {
        let mut builder = Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::limited(10))
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(0)
            .pool_idle_timeout(None);

        // 设置代理
        if let Some(proxy_str) = proxy_url {
            let proxy = Proxy::all(proxy_str)?;
            builder = builder.proxy(proxy);
        } else {
            builder = builder.no_proxy();
        }

        builder = builder.default_headers(default_headers);

        // SSL/TLS
        if accept_invalid_certs {
            builder = builder
                .danger_accept_invalid_certs(true)
                .danger_accept_invalid_hostnames(true);
        }

        // 超时设置
        if let Some(secs) = timeout_secs {
            builder = builder
                .timeout(Duration::from_secs(secs))
                .connect_timeout(Duration::from_secs(secs.min(30)));
        }

        Ok(builder.build()?)
    }

    pub async fn create_request(
        &self,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
        mixed_port_override: Option<u16>,
    ) -> Result<Client> {
        let proxy_url: Option<std::string::String> = match proxy_type {
            ProxyType::None => None,
            ProxyType::Localhost => {
                let port = Self::resolve_mixed_port(mixed_port_override).await;
                Some(format!("http://127.0.0.1:{port}"))
            }
            ProxyType::LocalhostSocks => {
                let port = Self::resolve_mixed_port(mixed_port_override).await;
                Some(format!("socks5://127.0.0.1:{port}"))
            }
            ProxyType::System => {
                if let Ok(p @ Sysproxy { enable: true, .. }) = Sysproxy::get_system_proxy() {
                    Some(format!("http://{}:{}", p.host, p.port))
                } else {
                    None
                }
            }
        };

        let mut headers = HeaderMap::new();

        // 设置 User-Agent
        if let Some(ua) = user_agent {
            headers.insert(USER_AGENT, HeaderValue::from_str(ua.as_str())?);
        } else {
            headers.insert(
                USER_AGENT,
                HeaderValue::from_str(&format!("clash-verge/v{}", env!("CARGO_PKG_VERSION")))?,
            );
        }

        let client = self.build_client(proxy_url, headers, accept_invalid_certs, timeout_secs)?;

        Ok(client)
    }

    pub async fn get_with_interrupt(
        &self,
        url: &str,
        proxy_type: ProxyType,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
        mixed_port_override: Option<u16>,
    ) -> Result<HttpResponse> {
        let mut parsed = Url::parse(url)?;
        let mut extra_headers = HeaderMap::new();

        if !parsed.username().is_empty()
            && let Some(pass) = parsed.password()
        {
            let auth_str = format!("{}:{}", parsed.username(), pass);
            let encoded = general_purpose::STANDARD.encode(auth_str);
            extra_headers.insert("Authorization", HeaderValue::from_str(&format!("Basic {}", encoded))?);
        }

        parsed.set_username("").ok();
        parsed.set_password(None).ok();

        // 创建请求
        let client = self
            .create_request(
                proxy_type,
                timeout_secs,
                user_agent,
                accept_invalid_certs,
                mixed_port_override,
            )
            .await?;

        let mut request_builder = client.get(parsed);

        for (key, value) in extra_headers.iter() {
            request_builder = request_builder.header(key, value);
        }

        let response = match request_builder.send().await {
            Ok(resp) => resp,
            Err(e) => {
                return Err(anyhow::anyhow!("Request failed: {}", e));
            }
        };

        let status = response.status();
        let headers = response.headers().to_owned();
        let body = match response.text().await {
            Ok(text) => text.into(),
            Err(e) => {
                return Err(anyhow::anyhow!("Failed to read response body: {}", e));
            }
        };

        Ok(HttpResponse::new(status, headers, body))
    }

    /// 按当前运行模式依次尝试多种出站路径，任一成功即返回。
    pub async fn get_with_egress(
        &self,
        url: &str,
        timeout_secs: Option<u64>,
        user_agent: Option<String>,
        accept_invalid_certs: bool,
        mixed_port_override: Option<u16>,
    ) -> Result<HttpResponse> {
        let routes = resolve_egress_routes().await;
        let mut last_err = String::from("请求失败");

        for proxy_type in routes {
            logging!(
                debug,
                Type::Network,
                "get_with_egress: {:?} mixed_port={:?} url={}",
                proxy_type,
                mixed_port_override,
                url
            );

            match self
                .get_with_interrupt(
                    url,
                    proxy_type,
                    timeout_secs,
                    user_agent.clone(),
                    accept_invalid_certs,
                    mixed_port_override,
                )
                .await
            {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    last_err = format!("HTTP {}", response.status()).into();
                }
                Err(err) => {
                    last_err = err.to_string().into();
                }
            }
        }

        Err(anyhow::anyhow!(last_err))
    }
}
