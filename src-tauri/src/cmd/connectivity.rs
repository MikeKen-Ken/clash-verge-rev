use super::CmdResult;
use crate::enhance::connectivity_order;

/// 将前端 localStorage 中的联通统计 JSON 同步到数据目录（不触发 reload）。
#[tauri::command]
pub async fn sync_connectivity_stats_file(raw_json: String) -> CmdResult {
    connectivity_order::write_connectivity_stats_file(&raw_json).map_err(|e| e.into())
}
