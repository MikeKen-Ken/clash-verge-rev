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

/// 清除单个代理组的手动固定（仅 URL-Test/Fallback 可用）。
#[tauri::command]
pub async fn clear_proxy_group_manual_selection(group: String) -> CmdResult<()> {
    match crate::utils::mihomo_ipc::delete_proxy_fixed(&group).await {
        Ok(_) => {
            logging!(
                info,
                Type::Cmd,
                "Cleared manual selection for proxy group: {}",
                group
            );
            Ok(())
        }
        Err(e) => {
            logging!(
                error,
                Type::Cmd,
                "Failed to clear manual selection for group {}: {}",
                group,
                e
            );
            Err(e.to_string().into())
        }
    }
}
