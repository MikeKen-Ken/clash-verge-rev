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

/// 立刻固定组当前节点（不额外 URLTest）。测速过程中按积分顺序提前切节点用。
#[tauri::command]
pub async fn force_select_group_proxy(group: String, name: String) -> CmdResult<()> {
    crate::utils::mihomo_ipc::put_group_selected_proxy(&group, &name, true)
        .await
        .map_err(|e| e.to_string().into())
}

/// 保存（`name` 非空）或移除（`name` 为空）当前订阅里某个组的固定节点。
/// 在 profiles 锁内读改写，避免并发修改把别的组的固定覆盖掉。
#[tauri::command]
pub async fn set_profile_group_pin(group: String, name: Option<String>) -> CmdResult<()> {
    crate::config::profiles_set_current_group_pin_safe(&group, name.as_deref())
        .await
        .map_err(|e| e.to_string().into())
}

/// 按积分顺序重排运行中的 url-test/fallback 组节点列表（不 reload 核心）。
#[tauri::command]
pub async fn apply_group_proxy_order(group: String, proxies: Vec<String>) -> CmdResult<()> {
    crate::utils::mihomo_ipc::put_group_proxy_order(&group, &proxies)
        .await
        .map_err(|e| e.to_string().into())
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
