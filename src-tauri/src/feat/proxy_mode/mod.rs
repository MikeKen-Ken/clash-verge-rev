use crate::{
    config::{ClashMode, Config},
    core::{CoreManager, handle, tray},
};
use anyhow::Result;
use clash_verge_logging::{Type, logging, logging_error};
use tokio::time::{Duration, timeout};

async fn close_connections_before_mode_change() {
    let mihomo = handle::Handle::mihomo().await;
    match timeout(Duration::from_secs(2), mihomo.close_all_connections()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            logging!(
                warn,
                Type::Core,
                "Failed to close connections before mode change: {error}"
            );
        }
        Err(_) => {
            logging!(
                warn,
                Type::Core,
                "Closing connections before mode change timed out"
            );
        }
    }
}

/// Apply a supported proxy mode and perform success-only side effects.
pub async fn change_clash_mode(mode: ClashMode) -> Result<()> {
    logging!(debug, Type::Core, "change clash mode to {}", mode.as_str());

    if Config::verge().await.data_arc().auto_close_connection.unwrap_or(false) {
        close_connections_before_mode_change().await;
    }

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

    Ok(())
}
