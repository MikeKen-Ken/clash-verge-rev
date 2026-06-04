use crate::{
    cmd,
    config::{Config, PrfItem, PrfOption, profiles::profiles_draft_update_item_safe},
    core::{CoreManager, handle, tray},
};
use anyhow::{Result, bail};
use clash_verge_logging::{Type, logging, logging_error};
use smartstring::alias::String;
use std::time::Instant;
use tauri::Emitter as _;

/// Toggle proxy profile
pub async fn toggle_proxy_profile(profile_index: String) {
    logging_error!(
        Type::Config,
        cmd::patch_profiles_config_by_profile_index(profile_index).await
    );
}

pub async fn switch_proxy_node(group_name: &str, proxy_name: &str) {
    let t0 = Instant::now();
    logging!(
        info,
        Type::Tray,
        "[核心切换] 托盘/后端开始 select_node_for_group {} -> {}",
        group_name,
        proxy_name
    );
    match handle::Handle::mihomo()
        .await
        .select_node_for_group(group_name, proxy_name)
        .await
    {
        Ok(_) => {
            logging!(
                info,
                Type::Tray,
                "[核心切换] 托盘首次成功 {} -> {} 耗时 {:?}",
                group_name,
                proxy_name,
                t0.elapsed()
            );
            logging!(info, Type::Tray, "切换代理成功: {} -> {}", group_name, proxy_name);
            let _ = handle::Handle::app_handle().emit("verge://refresh-proxy-config", ());
            let _ = tray::Tray::global().update_menu().await;
            return;
        }
        Err(err) => {
            logging!(
                error,
                Type::Tray,
                "切换代理失败: {} -> {}, 错误: {:?}",
                group_name,
                proxy_name,
                err
            );
        }
    }

    match handle::Handle::mihomo()
        .await
        .select_node_for_group(group_name, proxy_name)
        .await
    {
        Ok(_) => {
            logging!(
                info,
                Type::Tray,
                "[核心切换] 托盘重试成功 {} -> {} 自首次起总耗时 {:?}",
                group_name,
                proxy_name,
                t0.elapsed()
            );
            logging!(info, Type::Tray, "代理切换回退成功: {} -> {}", group_name, proxy_name);
            let _ = tray::Tray::global().update_menu().await;
        }
        Err(err) => {
            logging!(
                error,
                Type::Tray,
                "代理切换最终失败: {} -> {}, 错误: {:?}",
                group_name,
                proxy_name,
                err
            );
        }
    }
}

async fn should_update_profile(uid: &String, ignore_auto_update: bool) -> Result<Option<(String, Option<PrfOption>)>> {
    let profiles = Config::profiles().await;
    let profiles = profiles.latest_arc();
    let item = profiles.get_item(uid)?;
    let is_remote = item.itype.as_ref().is_some_and(|s| s == "remote");

    if !is_remote {
        logging!(info, Type::Config, "[订阅更新] {uid} 不是远程订阅，跳过更新");
        Ok(None)
    } else if item.url.is_none() {
        logging!(warn, Type::Config, "Warning: [订阅更新] {uid} 缺少URL，无法更新");
        bail!("failed to get the profile item url");
    } else if !ignore_auto_update && !item.option.as_ref().and_then(|o| o.allow_auto_update).unwrap_or(true) {
        logging!(info, Type::Config, "[订阅更新] {} 禁止自动更新，跳过更新", uid);
        Ok(None)
    } else {
        logging!(
            info,
            Type::Config,
            "[订阅更新] {} 是远程订阅，URL: {}",
            uid,
            item.url
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Profile URL is None"))?
        );
        Ok(Some((
            item.url.clone().ok_or_else(|| anyhow::anyhow!("Profile URL is None"))?,
            item.option.clone(),
        )))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileUpdateResult {
    /// 非远程、禁止自动更新等，未尝试下载
    Skipped,
    /// 订阅文件已成功拉取并写入
    DownloadSucceeded,
    /// 直连与代理方式均拉取失败
    DownloadFailed,
}

enum PerformUpdateResult {
    Succeeded(bool),
    Failed,
}

async fn perform_profile_update(
    uid: &String,
    url: &String,
    opt: Option<&PrfOption>,
    option: Option<&PrfOption>,
) -> Result<PerformUpdateResult> {
    logging!(info, Type::Config, "[订阅更新] 开始下载新的订阅内容");
    let mut merged_opt = PrfOption::merge(opt, option);
    let is_current = {
        let profiles = Config::profiles().await;
        profiles.latest_arc().is_current_profile_index(uid)
    };
    let profiles = Config::profiles().await;
    let profiles_arc = profiles.latest_arc();
    let profile_name = profiles_arc
        .get_name_by_uid(uid)
        .cloned()
        .unwrap_or_else(|| String::from("UnKnown Profile"));

    let mut last_err;

    match PrfItem::from_url(url, None, None, merged_opt.as_ref()).await {
        Ok(mut item) => {
            logging!(info, Type::Config, "[订阅更新] 更新订阅配置成功");
            profiles_draft_update_item_safe(uid, &mut item).await?;
            return Ok(PerformUpdateResult::Succeeded(is_current));
        }
        Err(err) => {
            logging!(
                warn,
                Type::Config,
                "Warning: [订阅更新] 正常更新失败: {err}，尝试使用Clash代理更新"
            );
            last_err = err;
        }
    }

    merged_opt.get_or_insert_with(PrfOption::default).self_proxy = Some(true);
    merged_opt.get_or_insert_with(PrfOption::default).with_proxy = Some(false);

    match PrfItem::from_url(url, None, None, merged_opt.as_ref()).await {
        Ok(mut item) => {
            logging!(info, Type::Config, "[订阅更新] 使用 Clash代理 更新订阅配置成功");
            profiles_draft_update_item_safe(uid, &mut item).await?;
            handle::Handle::notice_message("update_with_clash_proxy", profile_name);
            drop(last_err);
            return Ok(PerformUpdateResult::Succeeded(is_current));
        }
        Err(err) => {
            logging!(
                warn,
                Type::Config,
                "Warning: [订阅更新] Clash 代理更新失败: {err}，尝试使用系统代理更新"
            );
            last_err = err;
        }
    }

    merged_opt.get_or_insert_with(PrfOption::default).self_proxy = Some(false);
    merged_opt.get_or_insert_with(PrfOption::default).with_proxy = Some(true);

    match PrfItem::from_url(url, None, None, merged_opt.as_ref()).await {
        Ok(mut item) => {
            logging!(info, Type::Config, "[订阅更新] 使用 系统代理 更新订阅配置成功");
            profiles_draft_update_item_safe(uid, &mut item).await?;
            handle::Handle::notice_message("update_with_clash_proxy", profile_name);
            drop(last_err);
            return Ok(PerformUpdateResult::Succeeded(is_current));
        }
        Err(err) => {
            logging!(
                warn,
                Type::Config,
                "Warning: [订阅更新] 系统代理更新失败: {err}",
            );
            last_err = err;
        }
    }

    handle::Handle::notice_message("update_failed_even_with_clash", format!("{profile_name} - {last_err}"));
    Ok(PerformUpdateResult::Failed)
}

pub async fn update_profile(
    uid: &String,
    option: Option<&PrfOption>,
    auto_refresh: bool,
    ignore_auto_update: bool,
) -> Result<ProfileUpdateResult> {
    logging!(info, Type::Config, "[订阅更新] 开始更新订阅 {}", uid);
    let url_opt = should_update_profile(uid, ignore_auto_update).await?;

    let outcome = match url_opt {
        Some((url, opt)) => match perform_profile_update(uid, &url, opt.as_ref(), option).await? {
            PerformUpdateResult::Succeeded(is_current) => {
                if auto_refresh && is_current {
                    logging!(info, Type::Config, "[订阅更新] 更新内核配置");
                    match CoreManager::global().update_config().await {
                        Ok(_) => {
                            logging!(info, Type::Config, "[订阅更新] 更新成功");
                            handle::Handle::refresh_clash();
                        }
                        Err(err) => {
                            logging!(error, Type::Config, "[订阅更新] 更新失败: {}", err);
                            handle::Handle::notice_message("update_failed", format!("{err}"));
                            logging!(error, Type::Config, "{err}");
                        }
                    }
                }
                ProfileUpdateResult::DownloadSucceeded
            }
            PerformUpdateResult::Failed => ProfileUpdateResult::DownloadFailed,
        },
        None => ProfileUpdateResult::Skipped,
    };

    Ok(outcome)
}

/// 根据更新结果维护失败重试链（与 `update_interval` 定时器无关）
pub fn handle_update_retry_side_effects(uid: &str, result: ProfileUpdateResult) {
    use crate::core::profile_update_retry::ProfileUpdateRetry;

    match result {
        ProfileUpdateResult::DownloadFailed => {
            let uid_owned = uid.to_string();
            tokio::spawn(async move {
                if ProfileUpdateRetry::can_schedule_failure_retries(&uid_owned).await {
                    ProfileUpdateRetry::global().schedule_failure_retries(uid_owned);
                }
            });
        }
        ProfileUpdateResult::DownloadSucceeded => {
            ProfileUpdateRetry::global().cancel_failure_retries(uid);
        }
        ProfileUpdateResult::Skipped => {}
    }
}

/// 增强配置
pub async fn enhance_profiles() -> Result<(bool, String)> {
    crate::core::CoreManager::global().force_update_config().await
}
