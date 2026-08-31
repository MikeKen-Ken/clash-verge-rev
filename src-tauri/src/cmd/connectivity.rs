use super::CmdResult;
use crate::{enhance::connectivity_order, feat};

/// 将前端 localStorage 中的联通统计 JSON 同步到数据目录（不触发 reload）。
#[tauri::command]
pub async fn sync_connectivity_stats_file(raw_json: String) -> CmdResult {
    connectivity_order::write_connectivity_stats_file(&raw_json).map_err(|e| e.into())
}

/// 读取数据目录联通统计（含内核 URLTest 写入），供前端 hydrate。
#[tauri::command]
pub async fn read_connectivity_stats_file() -> CmdResult<String> {
    connectivity_order::read_connectivity_stats_file().map_err(|e| e.into())
}

/// Merge this installation's connectivity statistics with all WebDAV device snapshots.
#[tauri::command]
pub async fn merge_connectivity_stats_webdav() -> CmdResult<feat::ConnectivitySyncResult> {
    feat::merge_connectivity_statistics()
        .await
        .map_err(|error| error.to_string().into())
}

/// Persisted last successful merge time in unix milliseconds.
#[tauri::command]
pub async fn connectivity_last_sync_at() -> CmdResult<i64> {
    feat::last_connectivity_sync_at().await.map_err(|error| error.to_string().into())
}

/// Persist a reset generation and clear the selected aggregate counters atomically.
#[tauri::command]
pub async fn reset_connectivity_stats_sync_baseline(
    proxy_name: Option<String>,
) -> CmdResult<()> {
    feat::reset_connectivity_statistics(proxy_name.as_deref())
        .await
        .map_err(|error| error.to_string().into())
}
