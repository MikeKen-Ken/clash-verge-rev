use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    feat::{self, ConnectionTableUiState},
};
use std::collections::HashMap;

/// 将连接表列顺序与列显示状态写入磁盘，供备份打包
#[tauri::command]
pub async fn save_connection_table_ui(
    order: Vec<String>,
    visibility: HashMap<String, bool>,
) -> CmdResult<()> {
    feat::save_connection_table_ui(order, visibility)
        .await
        .stringify_err()
}

/// 读取已持久化的连接表 UI 状态（还原备份后由前端写回 localStorage）
#[tauri::command]
pub async fn get_connection_table_ui() -> CmdResult<ConnectionTableUiState> {
    feat::get_connection_table_ui().await.stringify_err()
}
