use super::{CmdResult, StringifyErr as _};
use crate::utils::mihomo_ipc::build_ipc_client;
use std::time::Duration;

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnostics {
    #[serde(default)]
    observed_at: Option<String>,
    #[serde(default)]
    last_traffic_at: Option<String>,
    events: Vec<RecoveryEvent>,
    switches: u64,
    failed_searches: u64,
    traffic_vetoes: u64,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEvent {
    at: String,
    action: String,
    duration_ms: i64,
}

#[tauri::command]
pub async fn get_network_diagnostics() -> CmdResult<Option<NetworkDiagnostics>> {
    let (client, headers) = build_ipc_client(Duration::from_secs(5)).await.stringify_err()?;
    let response = client
        .get("http://localhost/network/diagnostics")
        .headers(headers)
        .send()
        .await
        .stringify_err()?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let mut data: NetworkDiagnostics = response
        .error_for_status()
        .stringify_err()?
        .json()
        .await
        .stringify_err()?;
    // Core already bounds this ring; constrain it again at the UI boundary.
    if data.events.len() > 64 {
        data.events.drain(..data.events.len() - 64);
    }
    data.events.retain(|event| {
        matches!(
            event.action.as_str(),
            "dns-reset"
                | "route-reset"
                | "backup-unavailable"
                | "backup-verified"
                | "switch"
                | "traffic-veto"
                | "coalesced"
                | "ignored"
        )
    });
    Ok(Some(data))
}
