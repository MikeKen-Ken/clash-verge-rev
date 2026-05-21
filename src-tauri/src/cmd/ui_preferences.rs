use super::CmdResult;
use crate::{cmd::StringifyErr as _, feat};

/// 将连接表列顺序写入磁盘，供备份打包
#[tauri::command]
pub async fn save_connection_table_order(order: Vec<String>) -> CmdResult<()> {
    feat::save_connection_table_order(order)
        .await
        .stringify_err()
}

/// 读取已持久化的连接表列顺序（还原备份后由前端写回 localStorage）
#[tauri::command]
pub async fn get_connection_table_order() -> CmdResult<Option<Vec<String>>> {
    feat::get_connection_table_order()
        .await
        .stringify_err()
}
