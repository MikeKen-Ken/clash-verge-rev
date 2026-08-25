use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::{runtime::IRuntime, Config, ConfigType},
    constants,
    core::{CoreManager, handle},
    enhance,
};
use anyhow::{Context as _, anyhow};
use clash_verge_logging::{Type, logging_error};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

/// 获取运行时配置
#[tauri::command]
pub async fn get_runtime_config() -> CmdResult<Option<Mapping>> {
    Ok(Config::runtime().await.latest_arc().config.clone())
}

/// 获取运行时YAML配置
#[tauri::command]
pub async fn get_runtime_yaml() -> CmdResult<String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime.config.as_ref();
    config
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .and_then(|config| {
            serde_yaml_ng::to_string(config)
                .context("failed to convert config to yaml")
                .map(|s| s.into())
        })
        .stringify_err()
}

/// 获取运行时存在的键
#[tauri::command]
pub async fn get_runtime_exists() -> CmdResult<HashSet<String>> {
    Ok(Config::runtime().await.latest_arc().exists_keys.clone())
}

/// 获取运行时日志
#[tauri::command]
pub async fn get_runtime_logs() -> CmdResult<HashMap<String, Vec<(String, String)>>> {
    Ok(Config::runtime().await.latest_arc().chain_logs.clone())
}

#[tauri::command]
pub async fn get_runtime_proxy_chain_config(proxy_chain_exit_node: String) -> CmdResult<String> {
    let runtime = Config::runtime().await;
    let runtime = runtime.latest_arc();

    let config = runtime
        .config
        .as_ref()
        .ok_or_else(|| anyhow!("failed to parse config to yaml file"))
        .stringify_err()?;

    if let Some(serde_yaml_ng::Value::Sequence(proxies)) = config.get("proxies") {
        let mut proxy_name = Some(Some(proxy_chain_exit_node.as_str()));
        let mut proxies_chain = Vec::new();

        while let Some(proxy) = proxies.iter().find(|proxy| {
            if let serde_yaml_ng::Value::Mapping(proxy_map) = proxy {
                proxy_map.get("name").map(|x| x.as_str()) == proxy_name && proxy_map.get("dialer-proxy").is_some()
            } else {
                false
            }
        }) {
            proxies_chain.push(proxy.to_owned());
            proxy_name = proxy.get("dialer-proxy").map(|x| x.as_str());
        }

        if let Some(entry_proxy) = proxies
            .iter()
            .find(|proxy| proxy.get("name").map(|x| x.as_str()) == proxy_name)
            && !proxies_chain.is_empty()
        {
            // 添加第一个节点
            proxies_chain.push(entry_proxy.to_owned());
        }

        proxies_chain.reverse();

        let mut config: HashMap<String, Vec<serde_yaml_ng::Value>> = HashMap::new();

        config.insert("proxies".into(), proxies_chain);

        serde_yaml_ng::to_string(&config)
            .context("YAML generation failed")
            .map(|s| s.into())
            .stringify_err()
    } else {
        Err("failed to get proxies or proxy-groups".into())
    }
}

/// 更新运行时链式代理配置
#[tauri::command]
pub async fn update_proxy_chain_config_in_runtime(proxy_chain_config: Option<serde_yaml_ng::Value>) -> CmdResult<()> {
    {
        let runtime = Config::runtime().await;
        runtime.edit_draft(|d| d.update_proxy_chain_config(proxy_chain_config));
        // 我们需要在 CoreManager 中验证并应用配置，这里不应该直接调用 runtime.apply()
    }
    logging_error!(Type::Core, CoreManager::global().apply_generate_config().await);

    Ok(())
}

/// Persist delay-test connectivity score order into the runtime YAML snapshot
/// without reloading the core.
///
/// A full `apply_generate_config` / `reload_config` after delay tests recreates
/// outbound adapters (wiping LastDelay so every node shows timeout), suspends
/// the tunnel, and can reset DNS while TUN is still up — traffic then stays
/// broken until the app restarts.
#[tauri::command]
pub async fn apply_manual_connectivity_proxy_order() -> CmdResult<()> {
    {
        let runtime = Config::runtime().await;
        let config = runtime
            .latest_arc()
            .config
            .clone()
            .ok_or_else(|| String::from("Runtime configuration is not ready"))?;
        runtime.edit_draft(|draft| {
            draft.config = Some(
                enhance::connectivity_order::apply_manual_connectivity_proxy_order(config),
            );
        });
    }

    match Config::generate_file(ConfigType::Run).await {
        Ok(_) => {
            Config::runtime().await.apply();
            handle::Handle::refresh_clash_config_only();
            Ok(())
        }
        Err(error) => {
            Config::runtime().await.discard();
            Err(error.to_string().into())
        }
    }
}

/// 仅更新运行时配置并应用到核心，不写入 clash_config。
#[tauri::command]
pub async fn patch_runtime_config(payload: Mapping) -> CmdResult<()> {
    let hot_only = IRuntime::is_hot_reload_only_patch(&payload);
    let ads_only = IRuntime::is_proxy_ads_block_only_patch(&payload);
    {
        let runtime = Config::runtime().await;
        runtime.edit_draft(|d| d.patch_config(&payload));
    }

    if hot_only {
        // 热路径：PATCH 核心运行配置，避免 `reload_config` 触发全部 proxy-group 重跑健康检测
        let json = serde_json::to_value(serde_yaml_ng::Value::Mapping(payload)).stringify_err()?;
        match handle::Handle::mihomo().await.patch_base_config(&json).await {
            Ok(()) => {
                Config::runtime().await.apply();
                Config::generate_file(ConfigType::Run).await.stringify_err()?;
                handle::Handle::refresh_clash_config_only();
                handle::Handle::notice_message("runtime_config::updated", "Runtime configuration updated.");
                Ok(())
            }
            Err(e) => {
                Config::runtime().await.discard();
                Err(e.to_string().into())
            }
        }
    } else if ads_only {
        // Mihomo PATCH /configs 不支持 rules/dns，须写入 runtime YAML 后 reload_config 才能使 RULE-SET,ads,REJECT 立刻生效
        let computed = {
            let runtime = Config::runtime().await;
            let cfg_src = runtime.latest_arc();
            let Some(cfg) = cfg_src.config.as_ref() else {
                return Err("Runtime configuration is not ready".into());
            };
            enhance::apply_proxy_ads_block(cfg.clone())
        };

        {
            let runtime = Config::runtime().await;
            runtime.edit_draft(|d| {
                if let Some(config) = d.config.as_mut() {
                    if let Some(rules) = computed.get("rules") {
                        config.insert("rules".into(), rules.clone());
                    }
                    if let Some(dns) = computed.get("dns") {
                        config.insert("dns".into(), dns.clone());
                    }
                    for key in [constants::proxy_ads::RULE_INDEX_KEY] {
                        let vk = Value::from(key);
                        if let Some(v) = computed.get(&vk) {
                            config.insert(vk, v.clone());
                        } else {
                            config.remove(&vk);
                        }
                    }
                }
            });
        }

        Config::runtime().await.apply();

        match CoreManager::global().apply_generate_config().await {
            Ok((true, _)) => {
                handle::Handle::refresh_clash_config_only();
                Ok(())
            }
            Ok((false, msg)) => {
                Config::runtime().await.discard();
                Err(msg.into())
            }
            Err(e) => {
                Config::runtime().await.discard();
                Err(e.to_string().into())
            }
        }
    } else {
        CoreManager::global().apply_generate_config().await.stringify_err()?;
        // 此类补丁不写 proxy-groups，全量刷新会重置前端 fallback/url-test 测速；仅同步配置快照即可
        handle::Handle::refresh_clash_config_only();
        Ok(())
    }
}
