use super::CoreManager;
use crate::{
    config::{Config, ConfigType, runtime::IRuntime},
    constants::timing,
    core::{handle, validate::CoreConfigValidator},
    utils::{dirs, help},
};
use anyhow::{Result, anyhow};
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use std::{collections::HashSet, path::PathBuf, time::Instant};
use tauri_plugin_mihomo::Error as MihomoError;
use tokio::time::timeout;

impl CoreManager {
    pub async fn use_default_config(&self, error_key: &str, error_msg: &str) -> Result<()> {
        use crate::constants::files::RUNTIME_CONFIG;

        let runtime_path = dirs::app_home_dir()?.join(RUNTIME_CONFIG);
        let clash_config = &Config::clash().await.latest_arc().0;

        Config::runtime().await.edit_draft(|d| {
            *d = IRuntime {
                config: Some(clash_config.to_owned()),
                exists_keys: HashSet::new(),
                chain_logs: Default::default(),
            }
        });

        help::save_yaml(&runtime_path, &clash_config, Some("# Clash Verge Runtime")).await?;
        handle::Handle::notice_message(error_key, error_msg);
        Ok(())
    }

    pub async fn update_config(&self) -> Result<(bool, String)> {
        if handle::Handle::global().is_exiting() {
            return Ok((true, String::new()));
        }

        // 串行化配置更新，避免并发 patch 导致 core reload 竞态或挂起。
        let _update_guard = self.update_lock.lock().await;

        if !self.should_update_config() {
            return Ok((true, String::new()));
        }

        self.perform_config_update().await
    }

    /// 用户显式保存配置时使用，必须立即重新生成并应用运行配置。
    pub async fn force_update_config(&self) -> Result<(bool, String)> {
        if handle::Handle::global().is_exiting() {
            return Ok((true, String::new()));
        }

        let _update_guard = self.update_lock.lock().await;
        self.set_last_update(Instant::now());
        self.perform_config_update_force().await
    }

    fn should_update_config(&self) -> bool {
        let now = Instant::now();
        let last = self.get_last_update();

        if let Some(last_time) = last
            && now.duration_since(*last_time) < timing::CONFIG_UPDATE_DEBOUNCE
        {
            return false;
        }

        self.set_last_update(now);
        true
    }

    async fn perform_config_update(&self) -> Result<(bool, String)> {
        Config::generate().await?;
        self.apply_generate_config().await
    }

    /// 用户保存 Merge/Script 等增强文件：已做过片段校验，跳过耗时的全量内核校验，直接写盘并 reload。
    async fn perform_config_update_force(&self) -> Result<(bool, String)> {
        Config::generate().await?;
        self.apply_generate_config_force().await
    }

    async fn apply_generate_config_force(&self) -> Result<(bool, String)> {
        let run_path = match Config::generate_file(ConfigType::Run).await {
            Ok(path) => path,
            Err(e) => {
                Config::runtime().await.discard();
                return Err(e);
            }
        };
        logging!(
            info,
            Type::Core,
            "Writing runtime config (force apply): {}",
            run_path.display()
        );
        match self.apply_config(run_path).await {
            Ok(()) => Ok((true, String::new())),
            Err(e) => {
                Config::runtime().await.discard();
                Err(e)
            }
        }
    }

    pub async fn apply_generate_config(&self) -> Result<(bool, String)> {
        match CoreConfigValidator::global().validate_config().await {
            Ok((true, _)) => {
                let run_path = Config::generate_file(ConfigType::Run).await?;
                self.apply_config(run_path).await?;
                Ok((true, String::new()))
            }
            Ok((false, error_msg)) => {
                Config::runtime().await.discard();
                Ok((false, error_msg))
            }
            Err(e) => {
                Config::runtime().await.discard();
                Err(e)
            }
        }
    }

    async fn apply_config(&self, path: PathBuf) -> Result<()> {
        let path = dirs::path_to_str(&path)?;
        let reload_result = timeout(timing::CORE_RELOAD_TIMEOUT, self.reload_config(path)).await;
        match reload_result {
            Err(_) => {
                Config::runtime().await.discard();
                Err(anyhow!(
                    "Failed to apply config: reload timed out after {:?}",
                    timing::CORE_RELOAD_TIMEOUT
                ))
            }
            Ok(Err(err)) => {
                Config::runtime().await.discard();
                Err(anyhow!("Failed to apply config: {}", err))
            }
            Ok(_) => {
                Self::apply_profile_selected_to_core().await;
                Config::runtime().await.apply();
                logging!(info, Type::Core, "Configuration applied");
                Ok(())
            }
        }
    }

    /// Apply current profile's selected proxy groups to core after config load (align with Android proxy-selections).
    async fn apply_profile_selected_to_core() {
        let draft = Config::profiles().await;
        let arc = draft.latest_arc();
        let selected = arc
            .get_current()
            .and_then(|uid| arc.get_item(uid).ok())
            .and_then(|item| item.selected.clone());
        drop(arc);
        drop(draft);
        let Some(selected) = selected else {
            return;
        };
        let handle = handle::Handle::mihomo().await;
        for s in &selected {
            let (name, now) = match (&s.name, &s.now) {
                (Some(n), Some(w)) if !n.is_empty() && !w.is_empty() => (n.as_str(), w.as_str()),
                _ => continue,
            };
            let t_sel = Instant::now();
            match timeout(
                timing::CORE_SELECT_NODE_TIMEOUT,
                handle.select_node_for_group(name, now),
            )
            .await
            {
                Ok(Ok(())) => {
                    logging!(
                        info,
                        Type::Core,
                        "[核心切换] 配置加载后应用选中 {} -> {} 耗时 {:?}",
                        name,
                        now,
                        t_sel.elapsed()
                    );
                }
                Ok(Err(e)) => {
                    logging!(
                        warn,
                        Type::Core,
                        "Apply profile selected {} -> {} failed: {}",
                        name,
                        now,
                        e
                    );
                }
                Err(_) => {
                    logging!(
                        warn,
                        Type::Core,
                        "Apply profile selected {} -> {} timed out after {:?}",
                        name,
                        now,
                        timing::CORE_SELECT_NODE_TIMEOUT
                    );
                }
            }
        }
    }

    async fn reload_config(&self, path: &str) -> Result<(), MihomoError> {
        handle::Handle::mihomo().await.reload_config(true, path).await
    }
}
