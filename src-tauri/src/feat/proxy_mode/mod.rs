use crate::{
    config::{ClashMode, Config},
    core::{CoreManager, handle, tray},
};
use anyhow::Result;
use clash_verge_logging::{Type, logging, logging_error};

/// Apply a supported proxy mode and perform success-only side effects.
pub async fn change_clash_mode(mode: ClashMode) -> Result<()> {
    logging!(debug, Type::Core, "change clash mode to {}", mode.as_str());

    if let Err(error) = CoreManager::global().change_clash_mode(mode).await {
        logging!(error, Type::Core, "Failed to change Clash mode: {error}");
        handle::Handle::notice_message("set_config::error", format!("{error}"));
        return Err(error);
    }

    handle::Handle::refresh_clash_config_only();
    logging_error!(Type::Tray, tray::Tray::global().update_menu().await);
    logging_error!(
        Type::Tray,
        tray::Tray::global()
            .update_icon(&Config::verge().await.data_arc())
            .await
    );

    Ok(())
}
