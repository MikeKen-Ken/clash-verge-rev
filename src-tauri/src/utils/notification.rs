use std::borrow::Cow;

use crate::core::handle;
use clash_verge_i18n;
use tauri_plugin_notification::NotificationExt as _;

pub enum NotificationEvent<'a> {
    DashboardToggled,
    ClashModeChanged {
        mode: &'a str,
    },
    SystemProxyToggled,
    TunModeToggled,
    LightweightModeEntered,
    ProfilesReactivated,
    AppQuit,
    CloseAllConnectionsStarted,
    CloseAllConnectionsCompleted,
    FallbackProxySwitched {
        group: &'a str,
        from: &'a str,
        to: &'a str,
    },
    #[cfg(target_os = "macos")]
    AppHidden,
}

fn notify(title: Cow<'_, str>, body: Cow<'_, str>) {
    let app_handle = handle::Handle::app_handle();
    app_handle.notification().builder().title(title).body(body).show().ok();
}

pub async fn notify_event<'a>(event: NotificationEvent<'a>) {
    match event {
        NotificationEvent::DashboardToggled => {
            let title = clash_verge_i18n::t!("notifications.dashboardToggled.title");
            let body = clash_verge_i18n::t!("notifications.dashboardToggled.body");
            notify(title, body);
        }
        NotificationEvent::ClashModeChanged { mode } => {
            let title = clash_verge_i18n::t!("notifications.clashModeChanged.title");
            let body = clash_verge_i18n::t!("notifications.clashModeChanged.body")
                .replace("{mode}", mode)
                .into();
            notify(title, body);
        }
        NotificationEvent::SystemProxyToggled => {
            let title = clash_verge_i18n::t!("notifications.systemProxyToggled.title");
            let body = clash_verge_i18n::t!("notifications.systemProxyToggled.body");
            notify(title, body);
        }
        NotificationEvent::TunModeToggled => {
            let title = clash_verge_i18n::t!("notifications.tunModeToggled.title");
            let body = clash_verge_i18n::t!("notifications.tunModeToggled.body");
            notify(title, body);
        }
        NotificationEvent::LightweightModeEntered => {
            let title = clash_verge_i18n::t!("notifications.lightweightModeEntered.title");
            let body = clash_verge_i18n::t!("notifications.lightweightModeEntered.body");
            notify(title, body);
        }
        NotificationEvent::ProfilesReactivated => {
            let title = clash_verge_i18n::t!("notifications.profilesReactivated.title");
            let body = clash_verge_i18n::t!("notifications.profilesReactivated.body");
            notify(title, body);
        }
        NotificationEvent::AppQuit => {
            let title = clash_verge_i18n::t!("notifications.appQuit.title");
            let body = clash_verge_i18n::t!("notifications.appQuit.body");
            notify(title, body);
        }
        NotificationEvent::CloseAllConnectionsStarted => {
            notify(
                "开始关闭连接".into(),
                "正在检测节点延迟并关闭所有连接...".into(),
            );
        }
        NotificationEvent::CloseAllConnectionsCompleted => {
            notify(
                "操作完成".into(),
                "所有连接已关闭，节点已切换完成，可以正常使用网络".into(),
            );
        }
        NotificationEvent::FallbackProxySwitched { group, from, to } => {
            notify(
                "节点自动切换".into(),
                format!("分组 {} 已从 {} 切换到 {}", group, from, to).into(),
            );
        }
        #[cfg(target_os = "macos")]
        NotificationEvent::AppHidden => {
            let title = clash_verge_i18n::t!("notifications.appHidden.title");
            let body = clash_verge_i18n::t!("notifications.appHidden.body");
            notify(title, body);
        }
    }
}
