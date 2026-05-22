use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::{Config, PrfItem},
    core::{CoreManager, handle, validate::CoreConfigValidator},
    module::auto_backup::{AutoBackupManager, AutoBackupTrigger},
    utils::dirs,
};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use tokio::fs;

/// 保存profiles的配置
#[tauri::command]
pub async fn save_profile_file(index: String, file_data: Option<String>) -> CmdResult {
    let file_data = file_data.ok_or_else(|| "save payload is empty".to_string())?;

    let backup_trigger = match index.as_str() {
        "Merge" => Some(AutoBackupTrigger::GlobalMerge),
        "Script" => Some(AutoBackupTrigger::GlobalScript),
        _ => Some(AutoBackupTrigger::ProfileChange),
    };

    // 在异步操作前获取必要元数据并释放锁
    let (rel_path, is_merge_file, is_script_file) = {
        let profiles = Config::profiles().await;
        let profiles_guard = profiles.latest_arc();
        let item = profiles_guard.get_item(&index).stringify_err()?;
        let itype = item.itype.as_deref();
        let is_merge = itype == Some("merge") || index == "Merge";
        let is_script = itype == Some("script") || index == "Script";
        let path = item.file.clone().ok_or("file field is null")?;
        (path, is_merge, is_script)
    };

    // 读取原始内容（在释放profiles_guard后进行）
    let original_content = PrfItem {
        file: Some(rel_path.clone()),
        ..Default::default()
    }
    .read_file()
    .await
    .stringify_err()?;

    let profiles_dir = dirs::app_profiles_dir().stringify_err()?;
    let file_path = profiles_dir.join(rel_path.as_str());
    let file_path_str = file_path.to_string_lossy().to_string();

    // 保存新的配置文件
    fs::write(&file_path, &file_data).await.stringify_err()?;

    logging!(
        info,
        Type::Config,
        "[cmd配置save] 开始验证配置文件: {}, merge={}, script={}",
        file_path_str,
        is_merge_file,
        is_script_file
    );

    let changes_applied = if is_merge_file {
        handle_merge_file(&file_path_str, &file_path, &original_content).await?
    } else if is_script_file {
        handle_script_file(&file_path_str, &file_path, &original_content).await?
    } else {
        handle_full_validation(&file_path_str, &file_path, &original_content).await?
    };

    if changes_applied && let Some(trigger) = backup_trigger {
        AutoBackupManager::trigger_backup(trigger);
    }

    Ok(())
}

async fn restore_original(file_path: &std::path::Path, original_content: &str) -> Result<(), String> {
    fs::write(file_path, original_content).await.stringify_err()
}

fn is_script_error(err: &str, file_path_str: &str) -> bool {
    file_path_str.ends_with(".js")
        || err.contains("Script syntax error")
        || err.contains("Script must contain a main function")
        || err.contains("Failed to read script file")
}

/// 增强配置保存后必须立即重算并应用运行配置（订阅页全局 Merge/Script 等）。
async fn apply_runtime_config_after_enhance_save(
    file_path: &std::path::Path,
    original_content: &str,
    failure_notice_type: &str,
) -> CmdResult<bool> {
    match CoreManager::global().force_update_config().await {
        Ok((true, _)) => {
            handle::Handle::refresh_clash();
            Ok(true)
        }
        Ok((false, error_msg)) => {
            logging!(
                warn,
                Type::Config,
                "[cmd配置save] 增强配置保存后运行配置验证失败: {}",
                error_msg
            );
            restore_original(file_path, original_content).await?;
            let result = (false, error_msg.clone());
            crate::cmd::validate::handle_yaml_validation_notice(&result, failure_notice_type);
            Err(error_msg.into())
        }
        Err(e) => {
            logging!(warn, Type::Config, "[cmd配置save] 应用运行配置时发生错误: {}", e);
            restore_original(file_path, original_content).await?;
            Err(e.to_string().into())
        }
    }
}

async fn handle_merge_file(
    file_path_str: &str,
    file_path: &std::path::Path,
    original_content: &str,
) -> CmdResult<bool> {
    logging!(info, Type::Config, "[cmd配置save] 检测到merge文件，只进行语法验证");

    match CoreConfigValidator::validate_config_file(file_path_str, Some(true)).await {
        Ok((true, _)) => {
            logging!(info, Type::Config, "[cmd配置save] merge文件语法验证通过");
            apply_runtime_config_after_enhance_save(file_path, original_content, "合并后的运行配置").await
        }
        Ok((false, error_msg)) => {
            logging!(warn, Type::Config, "[cmd配置save] merge文件语法验证失败: {}", error_msg);
            restore_original(file_path, original_content).await?;
            let result = (false, error_msg.clone());
            crate::cmd::validate::handle_yaml_validation_notice(&result, "合并配置文件");
            Err(error_msg.into())
        }
        Err(e) => {
            logging!(error, Type::Config, "[cmd配置save] 验证过程发生错误: {}", e);
            restore_original(file_path, original_content).await?;
            Err(e.to_string().into())
        }
    }
}

async fn handle_script_file(
    file_path_str: &str,
    file_path: &std::path::Path,
    original_content: &str,
) -> CmdResult<bool> {
    logging!(info, Type::Config, "[cmd配置save] 检测到script文件，进行脚本语法验证");

    match CoreConfigValidator::validate_config_file(file_path_str, None).await {
        Ok((true, _)) => {
            logging!(info, Type::Config, "[cmd配置save] script文件语法验证通过");
            apply_runtime_config_after_enhance_save(file_path, original_content, "脚本应用后的运行配置").await
        }
        Ok((false, error_msg)) => {
            logging!(warn, Type::Config, "[cmd配置save] script文件验证失败: {}", error_msg);
            restore_original(file_path, original_content).await?;
            let result = (false, error_msg.to_owned());
            crate::cmd::validate::handle_script_validation_notice(&result, "脚本文件");
            Err(error_msg.into())
        }
        Err(e) => {
            logging!(error, Type::Config, "[cmd配置save] 验证过程发生错误: {}", e);
            restore_original(file_path, original_content).await?;
            Err(e.to_string().into())
        }
    }
}

async fn handle_full_validation(
    file_path_str: &str,
    file_path: &std::path::Path,
    original_content: &str,
) -> CmdResult<bool> {
    match CoreConfigValidator::validate_config_file(file_path_str, None).await {
        Ok((true, _)) => {
            logging!(info, Type::Config, "[cmd配置save] 验证成功");
            Ok(true)
        }
        Ok((false, error_msg)) => {
            logging!(warn, Type::Config, "[cmd配置save] 验证失败: {}", error_msg);
            restore_original(file_path, original_content).await?;

            if error_msg.contains("YAML syntax error")
                || error_msg.contains("Failed to read file:")
                || (!file_path_str.ends_with(".js") && !is_script_error(&error_msg, file_path_str))
            {
                logging!(info, Type::Config, "[cmd配置save] YAML配置文件验证失败，发送通知");
                let result = (false, error_msg.to_owned());
                crate::cmd::validate::handle_yaml_validation_notice(&result, "YAML配置文件");
            } else if is_script_error(&error_msg, file_path_str) {
                logging!(info, Type::Config, "[cmd配置save] 脚本文件验证失败，发送通知");
                let result = (false, error_msg.to_owned());
                crate::cmd::validate::handle_script_validation_notice(&result, "脚本文件");
            } else {
                logging!(info, Type::Config, "[cmd配置save] 其他类型验证失败，发送一般通知");
                handle::Handle::notice_message("config_validate::error", error_msg.to_owned());
            }

            Err(error_msg.into())
        }
        Err(e) => {
            logging!(error, Type::Config, "[cmd配置save] 验证过程发生错误: {}", e);
            restore_original(file_path, original_content).await?;
            Err(e.to_string().into())
        }
    }
}
