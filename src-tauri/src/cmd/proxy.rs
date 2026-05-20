use super::CmdResult;
use clash_verge_logging::{Type, logging};

// TODO: 前端通过 emit 发送更新事件, tray 监听更新事件
/// 同步托盘和GUI的代理选择状态
#[tauri::command]
pub async fn sync_tray_proxy_selection() -> CmdResult<()> {
    use crate::core::tray::Tray;

    match Tray::global().update_menu().await {
        Ok(_) => {
            logging!(info, Type::Cmd, "Tray proxy selection synced successfully");
            Ok(())
        }
        Err(e) => {
            logging!(error, Type::Cmd, "Failed to sync tray proxy selection: {e}");
            Err(e.to_string().into())
        }
    }
}

/// 取消指定代理组的手动固定（内核 DELETE `/proxies/{group}` + 与桌面 profile 解钉由前端 patchCurrent 完成）。
#[tauri::command]
pub async fn clear_proxy_group_manual_selection(group: String) -> CmdResult<()> {
    crate::utils::mihomo_ipc::delete_proxy_manual_unfix(&group)
        .await
        .map_err(|e| e.to_string())
}
