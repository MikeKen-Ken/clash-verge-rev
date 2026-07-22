use super::CmdResult;
use crate::enhance::connectivity_order;

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
