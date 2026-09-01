use crate::{
    config::{ClashMode, Config},
    core::{CoreManager, handle, tray},
    process::AsyncHandler,
};
use anyhow::Result;
use clash_verge_logging::{Type, logging, logging_error};

fn close_connections_after_mode_change() {
    AsyncHandler::spawn(move || async {
        let mihomo = handle::Handle::mihomo().await;
        match mihomo.get_connections().await {
            Ok(connections) => {
                if let Some(connections_array) = connections.connections {
                    for connection in connections_array {
                        let _ = mihomo.close_connection(&connection.id).await;
                    }
                }
            }
            Err(error) => {
                logging!(error, Type::Core, "Failed to get connections: {error}");
            }
        }
    });
}

/// Apply a supported proxy mode and perform success-only side effects.
pub async fn change_clash_mode(mode: ClashMode) -> Result<()> {
    logging!(debug, Type::Core, "change clash mode to {}", mode.as_str());

    if let Err(error) = CoreManager::global().change_clash_mode(mode).await {
        logging!(error, Type::Core, "Failed to change Clash mode: {error}");
        handle::Handle::notice_message("set_config::error", format!("{error}"));
        return Err(error);
    }

    handle::Handle::refresh_clash();
    logging_error!(Type::Tray, tray::Tray::global().update_menu().await);
    logging_error!(
        Type::Tray,
        tray::Tray::global()
            .update_icon(&Config::verge().await.data_arc())
            .await
    );

    if Config::verge().await.data_arc().auto_close_connection.unwrap_or(false) {
        close_connections_after_mode_change();
    }

    Ok(())
}
