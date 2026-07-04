mod chain;
pub mod connectivity_order;
pub mod field;
mod merge;
mod script;
pub mod seq;
mod tun;

use self::{
    chain::{AsyncChainItemFrom as _, ChainItem, ChainType},
    connectivity_order::apply_connectivity_proxy_order,
    field::{use_keys, use_lowercase, use_sort},
    merge::use_merge,
    script::use_script,
    seq::{SeqMap, use_seq},
    tun::use_tun,
};
use crate::{
    config::{runtime::IRuntime, Config, IVerge},
    constants,
    utils::{dirs, tmpl},
};
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use tokio::fs;

type ResultLog = Vec<(String, String)>;
#[derive(Debug)]
struct ConfigValues {
    clash_config: Mapping,
    clash_core: Option<String>,
    enable_tun: bool,
    enable_tun_override: bool,
    enable_builtin: bool,
    socks_enabled: bool,
    http_enabled: bool,
    enable_dns_settings: bool,
    #[cfg(not(target_os = "windows"))]
    redir_enabled: bool,
    #[cfg(target_os = "linux")]
    tproxy_enabled: bool,
}

#[derive(Debug)]
struct ProfileItems {
    config: Mapping,
    merge_item: ChainItem,
    script_item: ChainItem,
    rules_item: ChainItem,
    proxies_item: ChainItem,
    groups_item: ChainItem,
    global_merge: ChainItem,
    global_script: ChainItem,
    profile_name: String,
}

impl Default for ProfileItems {
    fn default() -> Self {
        Self {
            config: Default::default(),
            profile_name: Default::default(),
            merge_item: ChainItem {
                uid: "".into(),
                data: ChainType::Merge(Mapping::new()),
            },
            script_item: ChainItem {
                uid: "".into(),
                data: ChainType::Script(tmpl::ITEM_SCRIPT.into()),
            },
            rules_item: ChainItem {
                uid: "".into(),
                data: ChainType::Rules(SeqMap::default()),
            },
            proxies_item: ChainItem {
                uid: "".into(),
                data: ChainType::Proxies(SeqMap::default()),
            },
            groups_item: ChainItem {
                uid: "".into(),
                data: ChainType::Groups(SeqMap::default()),
            },
            global_merge: ChainItem {
                uid: "Merge".into(),
                data: ChainType::Merge(Mapping::new()),
            },
            global_script: ChainItem {
                uid: "Script".into(),
                data: ChainType::Script(tmpl::ITEM_SCRIPT.into()),
            },
        }
    }
}

async fn get_config_values() -> ConfigValues {
    let clash = Config::clash().await;
    let clash_arc = clash.latest_arc();
    let clash_config = clash_arc.0.clone();
    drop(clash_arc);
    drop(clash);

    let verge = Config::verge().await;

    let verge_arc = verge.latest_arc();
    let IVerge {
        ref enable_tun_mode,
        enable_tun_override: _,
        ref enable_builtin_enhanced,
        ref verge_socks_enabled,
        ref verge_http_enabled,
        ref enable_dns_settings,
        ..
    } = *verge_arc;

    let (clash_core, enable_tun, enable_tun_override, enable_builtin, socks_enabled, http_enabled, enable_dns_settings) = (
        Some(verge_arc.get_valid_clash_core()),
        enable_tun_mode.unwrap_or(false),
        false, // TUN 覆写已取消，不再根据设置覆写 TUN 配置
        enable_builtin_enhanced.unwrap_or(true),
        verge_socks_enabled.unwrap_or(false),
        verge_http_enabled.unwrap_or(false),
        enable_dns_settings.unwrap_or(false),
    );

    #[cfg(not(target_os = "windows"))]
    let redir_enabled = verge_arc.verge_redir_enabled.unwrap_or(false);

    #[cfg(target_os = "linux")]
    let tproxy_enabled = verge_arc.verge_tproxy_enabled.unwrap_or(false);

    drop(verge_arc);
    drop(verge);

    ConfigValues {
        clash_config,
        clash_core,
        enable_tun,
        enable_tun_override,
        enable_builtin,
        socks_enabled,
        http_enabled,
        enable_dns_settings,
        #[cfg(not(target_os = "windows"))]
        redir_enabled,
        #[cfg(target_os = "linux")]
        tproxy_enabled,
    }
}

#[allow(clippy::cognitive_complexity)]
async fn collect_profile_items() -> ProfileItems {
    let profiles = Config::profiles().await;
    let profiles_arc = profiles.latest_arc();
    drop(profiles);

    let current = profiles_arc.current_mapping().await.unwrap_or_default();

    let current_profile_uid = match profiles_arc.get_current() {
        Some(uid) => uid,
        None => {
            drop(profiles_arc);
            return ProfileItems::default();
        }
    };

    let current_item = match profiles_arc.get_item(current_profile_uid) {
        Ok(item) => item,
        Err(_) => {
            drop(profiles_arc);
            return ProfileItems::default();
        }
    };

    let merge_uid: Cow<'_, str> = if let Some(s) = current_item.current_merge() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned("Merge".into())
    };
    let script_uid: Cow<'_, str> = if let Some(s) = current_item.current_script() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned("Script".into())
    };
    let rules_uid: Cow<'_, str> = if let Some(s) = current_item.current_rules() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned("Rules".into())
    };
    let proxies_uid: Cow<'_, str> = if let Some(s) = current_item.current_proxies() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned("Proxies".into())
    };
    let groups_uid: Cow<'_, str> = if let Some(s) = current_item.current_groups() {
        Cow::Borrowed(s)
    } else {
        Cow::Owned("Groups".into())
    };

    let name = profiles_arc
        .get_item(current_profile_uid)
        .ok()
        .and_then(|item| item.name.clone())
        .unwrap_or_default();

    let merge_item = {
        let item = profiles_arc.get_item(&merge_uid).ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "".into(),
        data: ChainType::Merge(Mapping::new()),
    });

    let script_item = {
        let item = profiles_arc.get_item(&script_uid).ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "".into(),
        data: ChainType::Script(tmpl::ITEM_SCRIPT.into()),
    });

    let rules_item = {
        let item = profiles_arc.get_item(&rules_uid).ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "".into(),
        data: ChainType::Rules(SeqMap::default()),
    });

    let proxies_item = {
        let item = profiles_arc.get_item(&proxies_uid).ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "".into(),
        data: ChainType::Proxies(SeqMap::default()),
    });

    let groups_item = {
        let item = profiles_arc.get_item(&groups_uid).ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "".into(),
        data: ChainType::Groups(SeqMap::default()),
    });

    let global_merge = {
        let item = profiles_arc.get_item("Merge").ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "Merge".into(),
        data: ChainType::Merge(Mapping::new()),
    });

    let global_script = {
        let item = profiles_arc.get_item("Script").ok().cloned();
        if let Some(item) = item {
            <Option<ChainItem>>::from_async(&item).await
        } else {
            None
        }
    }
    .unwrap_or_else(|| ChainItem {
        uid: "Script".into(),
        data: ChainType::Script(tmpl::ITEM_SCRIPT.into()),
    });

    drop(profiles_arc);

    ProfileItems {
        config: current,
        merge_item,
        script_item,
        rules_item,
        proxies_item,
        groups_item,
        global_merge,
        global_script,
        profile_name: name,
    }
}

fn chain_merge_mapping(item: &ChainItem) -> Option<Mapping> {
    match &item.data {
        ChainType::Merge(merge) => Some(merge.clone()),
        _ => None,
    }
}

/// 在 `merge_persistent_runtime_patch_from_prev` 之后再次叠入 Merge，使全局/订阅 Merge 文件中的字段优先于旧运行时缓存。
fn reapply_merge_layers(config: Mapping, layers: &[Option<Mapping>]) -> Mapping {
    layers
        .iter()
        .filter_map(|layer| layer.as_ref())
        .fold(config, |cfg, merge| use_merge(merge, cfg))
}

fn process_global_items(
    mut config: Mapping,
    global_merge: ChainItem,
    global_script: ChainItem,
    profile_name: &String,
) -> (Mapping, Vec<String>, HashMap<String, ResultLog>) {
    let mut result_map = HashMap::new();
    let mut exists_keys = use_keys(&config).collect::<Vec<_>>();

    if let ChainType::Merge(merge) = global_merge.data {
        exists_keys.extend(use_keys(&merge));
        config = use_merge(&merge, config.to_owned());
    }

    if let ChainType::Script(script) = global_script.data {
        let mut logs = vec![];
        match use_script(script, &config, profile_name) {
            Ok((res_config, res_logs)) => {
                exists_keys.extend(use_keys(&res_config));
                config = res_config;
                logs.extend(res_logs);
            }
            Err(err) => logs.push(("exception".into(), err.to_string().into())),
        }
        result_map.insert(global_script.uid, logs);
    }

    (config, exists_keys, result_map)
}

#[allow(clippy::too_many_arguments)]
fn process_profile_items(
    mut config: Mapping,
    mut exists_keys: Vec<String>,
    mut result_map: HashMap<String, ResultLog>,
    rules_item: ChainItem,
    proxies_item: ChainItem,
    groups_item: ChainItem,
    merge_item: ChainItem,
    script_item: ChainItem,
    profile_name: &String,
) -> (Mapping, Vec<String>, HashMap<String, ResultLog>) {
    if let ChainType::Rules(rules) = rules_item.data {
        config = use_seq(rules, config.to_owned(), "rules");
    }

    if let ChainType::Proxies(proxies) = proxies_item.data {
        config = use_seq(proxies, config.to_owned(), "proxies");
    }

    if let ChainType::Groups(groups) = groups_item.data {
        config = use_seq(groups, config.to_owned(), "proxy-groups");
    }

    if let ChainType::Merge(merge) = merge_item.data {
        exists_keys.extend(use_keys(&merge));
        config = use_merge(&merge, config.to_owned());
    }

    if let ChainType::Script(script) = script_item.data {
        let mut logs = vec![];
        match use_script(script, &config, profile_name) {
            Ok((res_config, res_logs)) => {
                exists_keys.extend(use_keys(&res_config));
                config = res_config;
                logs.extend(res_logs);
            }
            Err(err) => logs.push(("exception".into(), err.to_string().into())),
        }
        result_map.insert(script_item.uid, logs);
    }

    (config, exists_keys, result_map)
}

async fn merge_default_config(
    mut config: Mapping,
    clash_config: Mapping,
    enable_tun_override: bool,
    socks_enabled: bool,
    http_enabled: bool,
    #[cfg(not(target_os = "windows"))] redir_enabled: bool,
    #[cfg(target_os = "linux")] tproxy_enabled: bool,
) -> Mapping {
    for (key, value) in clash_config.into_iter() {
        if key.as_str() == Some("tun") {
            if enable_tun_override {
                let mut tun = config.get_mut("tun").map_or_else(Mapping::new, |val| {
                    val.as_mapping().cloned().unwrap_or_else(Mapping::new)
                });
                let patch_tun = value.as_mapping().cloned().unwrap_or_else(Mapping::new);
                for (key, value) in patch_tun.into_iter() {
                    tun.insert(key, value);
                }
                config.insert("tun".into(), tun.into());
            }
        } else {
            if key.as_str() == Some("socks-port") && !socks_enabled {
                config.remove("socks-port");
                continue;
            }
            if key.as_str() == Some("port") && !http_enabled {
                config.remove("port");
                continue;
            }
            #[cfg(target_os = "windows")]
            {
                if key.as_str() == Some("redir-port") {
                    continue;
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                if key.as_str() == Some("redir-port") && !redir_enabled {
                    config.remove("redir-port");
                    continue;
                }
            }
            #[cfg(target_os = "linux")]
            {
                if key.as_str() == Some("tproxy-port") && !tproxy_enabled {
                    config.remove("tproxy-port");
                    continue;
                }
            }
            #[cfg(not(target_os = "linux"))]
            {
                if key.as_str() == Some("tproxy-port") {
                    config.remove("tproxy-port");
                    continue;
                }
            }
            // 处理 external-controller 键的开关逻辑
            if key.as_str() == Some("external-controller") {
                let enable_external_controller = Config::verge()
                    .await
                    .latest_arc()
                    .enable_external_controller
                    .unwrap_or(false);

                if enable_external_controller {
                    config.insert(key, value);
                } else {
                    // 如果禁用了外部控制器，设置为空字符串
                    config.insert(key, "".into());
                }
            } else {
                config.insert(key, value);
            }
        }
    }

    config
}

fn apply_builtin_scripts(mut config: Mapping, clash_core: Option<String>, enable_builtin: bool) -> Mapping {
    if enable_builtin {
        ChainItem::builtin()
            .into_iter()
            .filter(|(s, _)| s.is_support(clash_core.as_ref()))
            .map(|(_, c)| c)
            .for_each(|item| {
                logging!(debug, Type::Core, "run builtin script {}", item.uid);
                if let ChainType::Script(script) = item.data {
                    match use_script(script, &config, &String::from("")) {
                        Ok((res_config, _)) => {
                            config = res_config;
                        }
                        Err(err) => {
                            logging!(error, Type::Core, "builtin script error `{err}`");
                        }
                    }
                }
            });
    }

    config
}

fn cleanup_proxy_groups(mut config: Mapping) -> Mapping {
    const BUILTIN_POLICIES: &[&str] = &["DIRECT", "REJECT", "REJECT-DROP", "PASS"];

    let proxy_names = config
        .get("proxies")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| match item {
                    Value::Mapping(map) => map
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|name| name.to_owned().into()),
                    Value::String(name) => Some(name.to_owned().into()),
                    _ => None,
                })
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let group_names = config
        .get("proxy-groups")
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .filter_map(|item| {
                    item.as_mapping()
                        .and_then(|map| map.get("name"))
                        .and_then(Value::as_str)
                        .map(std::convert::Into::into)
                })
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let provider_names = config
        .get("proxy-providers")
        .and_then(Value::as_mapping)
        .map(|map| {
            map.keys()
                .filter_map(Value::as_str)
                .map(std::convert::Into::into)
                .collect::<HashSet<String>>()
        })
        .unwrap_or_default();

    let mut allowed_names = proxy_names;
    allowed_names.extend(group_names);
    allowed_names.extend(provider_names.iter().cloned());
    allowed_names.extend(BUILTIN_POLICIES.iter().map(|p| (*p).into()));

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            if let Some(group_map) = group.as_mapping_mut() {
                let mut has_valid_provider = false;

                if let Some(Value::Sequence(uses)) = group_map.get_mut("use") {
                    uses.retain(|provider| match provider {
                        Value::String(name) => {
                            let exists = provider_names.contains(name.as_str());
                            has_valid_provider = has_valid_provider || exists;
                            exists
                        }
                        _ => false,
                    });
                }

                if let Some(Value::Sequence(proxies)) = group_map.get_mut("proxies") {
                    proxies.retain(|proxy| match proxy {
                        Value::String(name) => allowed_names.contains(name.as_str()) || has_valid_provider,
                        _ => true,
                    });
                }
            }
        }
    }

    config
}

/// 健康检测数值合理上限（60 秒），避免写入异常大数
const HEALTH_CHECK_MAX_MS: u64 = 60_000;

/// 将 verge 中的健康检测值作为 url-test/fallback 组的默认值；仅当组内未配置该项时才写入，不覆盖订阅已有设置。
fn apply_health_check_defaults(mut config: Mapping, verge: &IVerge) -> Mapping {
    let timeout = verge
        .health_check_timeout
        .filter(|&v| v > 0 && v <= HEALTH_CHECK_MAX_MS);
    let selected_timeout = verge
        .health_check_selected_timeout
        .filter(|&v| v > 0 && v <= HEALTH_CHECK_MAX_MS)
        .or(Some(5_000));
    let failure_reset = verge
        .health_check_failure_reset_interval
        .filter(|&v| v > 0 && v <= HEALTH_CHECK_MAX_MS);
    if timeout.is_none() && selected_timeout.is_none() && failure_reset.is_none() {
        return config;
    }

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups.iter_mut() {
            if let Some(group_map) = group.as_mapping_mut() {
                let type_str = group_map
                    .get("type")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase)
                    .unwrap_or_default();
                if type_str != "url-test" && type_str != "fallback" {
                    continue;
                }
                if let Some(v) = timeout {
                    if group_map.get("timeout").is_none() {
                        group_map.insert("timeout".into(), v.into());
                    }
                }
                if let Some(v) = selected_timeout {
                    if group_map.get("selected-timeout").is_none() {
                        group_map.insert("selected-timeout".into(), v.into());
                    }
                }
                if let Some(v) = failure_reset {
                    if group_map.get("failure-reset-interval").is_none() {
                        group_map.insert("failure-reset-interval".into(), v.into());
                    }
                }
            }
        }
    }
    config
}

async fn apply_dns_settings(mut config: Mapping, enable_dns_settings: bool) -> Mapping {
    if enable_dns_settings && let Ok(app_dir) = dirs::app_home_dir() {
        let dns_path = app_dir.join(constants::files::DNS_CONFIG);

        if dns_path.exists()
            && let Ok(dns_yaml) = fs::read_to_string(&dns_path).await
            && let Ok(dns_config) = serde_yaml_ng::from_str::<serde_yaml_ng::Mapping>(&dns_yaml)
        {
            if let Some(hosts_value) = dns_config.get("hosts")
                && hosts_value.is_mapping()
            {
                config.insert("hosts".into(), hosts_value.clone());
                logging!(info, Type::Core, "apply hosts configuration");
            }

            if let Some(dns_value) = dns_config.get("dns") {
                if let Some(dns_mapping) = dns_value.as_mapping() {
                    config.insert("dns".into(), dns_mapping.clone().into());
                    logging!(info, Type::Core, "apply dns_config.yaml (dns section)");
                }
            } else {
                config.insert("dns".into(), dns_config.into());
                logging!(info, Type::Core, "apply dns_config.yaml");
            }
        }
    }

    config
}

/// Enhance mode
/// 返回最终订阅、该订阅包含的键、和script执行的结果
pub async fn enhance() -> (Mapping, HashSet<String>, HashMap<String, ResultLog>) {
    // gather config values
    let cfg_vals = get_config_values().await;
    let ConfigValues {
        clash_config,
        clash_core,
        enable_tun,
        enable_builtin,
        enable_dns_settings,
        enable_tun_override: _,
        socks_enabled: _,
        http_enabled: _,
        #[cfg(not(target_os = "windows"))]
        redir_enabled: _,
        #[cfg(target_os = "linux")]
        tproxy_enabled: _,
    } = cfg_vals;

    // collect profile items
    let profile = collect_profile_items().await;
    let config = profile.config;
    let merge_item = profile.merge_item;
    let script_item = profile.script_item;
    let rules_item = profile.rules_item;
    let proxies_item = profile.proxies_item;
    let groups_item = profile.groups_item;
    let global_merge = profile.global_merge;
    let global_script = profile.global_script;
    let profile_name = profile.profile_name;
    let global_merge_snapshot = chain_merge_mapping(&global_merge);
    let profile_merge_snapshot = chain_merge_mapping(&merge_item);

    // process globals
    let (config, exists_keys, result_map) = process_global_items(config, global_merge, global_script, &profile_name);

    // process profile-specific items
    let (config, exists_keys, result_map) = process_profile_items(
        config,
        exists_keys,
        result_map,
        rules_item,
        proxies_item,
        groups_item,
        merge_item,
        script_item,
        &profile_name,
    );

    // 用户要求禁止 clash_config 合并，避免客户端改写 mihomo 配置。
    // 这里保留 clash_config 仅用于后续读取 mode，不再写入运行配置。
    let config = config;

    // builtin scripts
    let mut config = apply_builtin_scripts(config, clash_core, enable_builtin);

    {
        let verge = Config::verge().await;
        let verge_arc = verge.latest_arc();
        config = apply_health_check_defaults(config, &*verge_arc);
    }

    // 直连/全局模式：仅覆盖 rules 和 dns，不切换代理组，界面 groups 保持不变
    let mode = clash_config
        .get("mode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| "rule".into());
    let prev_runtime_config = Config::runtime().await.latest_arc().config.clone();

    // 保留用户经 patch_runtime_config 热改的顶层项（含「屏蔽广告」）；否则 generate 会按订阅默认值覆盖，磁盘运行配置与核心 PATCH 不一致
    IRuntime::merge_persistent_runtime_patch_from_prev(
        prev_runtime_config.as_ref(),
        &mut config,
    );

    // 全局/订阅 Merge 须在 persistent patch 之后再次合并，否则 allow-lan、tun、dns 等会被旧运行时覆盖，保存 Merge 后 clash-verge.yaml 看似无变化
    config = reapply_merge_layers(
        config,
        &[global_merge_snapshot, profile_merge_snapshot],
    );
    IRuntime::restore_runtime_patch_after_merge(prev_runtime_config.as_ref(), &mut config);

    // dns settings
    config = apply_dns_settings(config, enable_dns_settings).await;

    config = finalize_runtime_config(config, enable_tun, &mode);

    let mut exists_keys_set = HashSet::new();
    exists_keys_set.extend(exists_keys);

    (config, exists_keys_set, result_map)
}

fn finalize_runtime_config(mut config: Mapping, enable_tun: bool, mode: &str) -> Mapping {
    // Merge/订阅可能重新带回无效组成员；最终应用前再清理一次，避免核心加载失败或 UI 显示幽灵节点
    config = cleanup_proxy_groups(config);

    if mode == "direct" || mode == "global" {
        config = apply_direct_global_overrides(config, mode);
    } else if mode == "offline" {
        config = apply_offline_overrides(config);
    }

    // Merge/订阅常含 tun.enable:true；须在最终阶段应用 TUN 开关，否则 UI 关闭 TUN 仍实际启用
    config = use_tun(config, enable_tun);
    config = apply_proxy_ads_block(config);
    config = apply_connectivity_proxy_order(config);
    use_sort(config)
}

/// 离线模式：强制 rule + MATCH,REJECT，拒绝全部流量。
fn apply_offline_overrides(mut config: Mapping) -> Mapping {
    config.insert("mode".into(), Value::from("rule"));
    config.insert(
        "rules".into(),
        Value::Sequence(vec![Value::from("MATCH,REJECT")]),
    );
    config.remove("nameserver-policy");
    logging!(info, Type::Core, "applied offline mode overrides (all traffic REJECT)");
    config
}

/// 直连/全局模式下覆盖运行配置的 rules 与顶层 nameserver，不改变 proxy-groups，界面不切换组。
/// 强制 mode: rule，使核心按规则选策略：全局走 MATCH,🔀（策略组 🔀），直连走 MATCH,⬆️（策略 ⬆️），而非核心内置的 GLOBAL/DIRECT。
fn apply_direct_global_overrides(mut config: Mapping, mode: &str) -> Mapping {
    // 强制 rule 模式，否则核心会按 mode: global/direct 用内置 GLOBAL/DIRECT，忽略我们的 MATCH 规则
    config.insert("mode".into(), Value::from("rule"));

    // rules: 直连只保留 MATCH,⬆️（走策略 ⬆️）；全局只保留 MATCH,🔀（走策略组 🔀 的当前节点）
    let match_rule = if mode == "direct" {
        "MATCH,⬆️"
    } else {
        "MATCH,🔀"
    };
    config.insert(
        "rules".into(),
        Value::Sequence(vec![Value::from(match_rule)]),
    );

    // 顶层：删除 nameserver-policy，设置 nameserver（不修改 dns 块）
    config.remove("nameserver-policy");

    let nameservers: Vec<Value> = if mode == "direct" {
        vec![
            Value::from("https://dns.alidns.com/dns-query"),
            Value::from("https://120.53.53.53/dns-query"),
            Value::from("tls://119.29.29.29:853"),
        ]
    } else {
        vec![
            Value::from("https://1.1.1.1/dns-query"),
            Value::from("https://8.8.8.8/dns-query"),
            Value::from("https://9.9.9.9/dns-query"),
            Value::from("tls://1.0.0.1:853"),
        ]
    };
    config.insert("nameserver".into(), Value::Sequence(nameservers));

    logging!(info, Type::Core, "applied {mode} mode overrides (rules + top-level nameserver)");
    config
}

const PROXY_ADS_BLOCK_KEY: &str = "proxy-ads-block";
const PROXY_ADS_RULE: &str = "RULE-SET,ads,REJECT";
const PROXY_ADS_NS_POLICY_KEY: &str = "rule-set:ads";

#[inline]
fn rule_is_proxy_ads(rule: &Value) -> bool {
    rule.as_str()
        .map(|s| s.trim() == PROXY_ADS_RULE)
        .unwrap_or(false)
}

#[inline]
fn nameserver_policy_key_is_ads(k: &Value) -> bool {
    k.as_str() == Some(PROXY_ADS_NS_POLICY_KEY)
}

#[inline]
fn value_as_usize(v: &Value) -> Option<usize> {
    v.as_u64()
        .map(|n| n as usize)
        .or_else(|| v.as_i64().and_then(|n| usize::try_from(n).ok()))
}

/// 无快照时：广告规则插在 `RULE-SET,trackerslist` 之后，否则插在首条 `MATCH` 之前（与常见订阅脚本顺序一致）。
fn default_ads_rule_insert_index(rules: &[Value]) -> usize {
    if let Some(i) = rules.iter().position(|r| {
        r.as_str()
            .map(|s| {
                let t = s.trim();
                t.starts_with("RULE-SET,trackerslist,")
            })
            .unwrap_or(false)
    }) {
        return (i + 1).min(rules.len());
    }
    rules
        .iter()
        .position(|r| {
            r.as_str()
                .map(|s| s.trim().starts_with("MATCH,"))
                .unwrap_or(false)
        })
        .unwrap_or(rules.len())
}

fn strip_ads_nameserver_policy(policy: &mut Mapping) {
    policy.retain(|k, _| !nameserver_policy_key_is_ads(k));
}

/// 从 dns 块移除 rule-set:ads 的 nameserver-policy（不再注入 rcode://success）。
fn strip_ads_nameserver_policy_from_dns(dns: &mut Mapping) {
    for key in ["nameserver-policy", "proxy-server-nameserver-policy"] {
        if let Some(Value::Mapping(policy)) = dns.get_mut(&Value::from(key)) {
            strip_ads_nameserver_policy(policy);
            if policy.is_empty() {
                dns.remove(&Value::from(key));
            }
        }
    }
}

pub(crate) fn apply_proxy_ads_block(mut config: Mapping) -> Mapping {
    let enable_proxy_ads_block = config
        .get(PROXY_ADS_BLOCK_KEY)
        .and_then(Value::as_bool)
        .unwrap_or(true);

    if let Some(Value::Mapping(dns)) = config.get_mut("dns") {
        strip_ads_nameserver_policy_from_dns(dns);
    }
    config.remove(&Value::from(constants::proxy_ads::NS_POLICY_INDEX_KEY));
    config.remove(&Value::from(
        constants::proxy_ads::NS_POLICY_VALUE_SNAPSHOT_KEY,
    ));

    let has_ads_rule = config
        .get("rules")
        .and_then(|v| v.as_sequence())
        .is_some_and(|rules| rules.iter().any(rule_is_proxy_ads));

    if enable_proxy_ads_block {
        if has_ads_rule {
            config.remove(&Value::from(constants::proxy_ads::RULE_INDEX_KEY));
        } else {
            let insert_idx = config
                .get(constants::proxy_ads::RULE_INDEX_KEY)
                .and_then(value_as_usize)
                .unwrap_or_else(|| {
                    config
                        .get("rules")
                        .and_then(|v| v.as_sequence())
                        .map(|rules| default_ads_rule_insert_index(rules.as_slice()))
                        .unwrap_or(0)
                });
            if let Some(Value::Sequence(rules)) = config.get_mut("rules") {
                let insert_idx = insert_idx.min(rules.len());
                rules.insert(insert_idx, Value::from(PROXY_ADS_RULE));
            }
        }
    } else {
        let ads_rule_pos = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .and_then(|rules| rules.iter().position(rule_is_proxy_ads));
        match ads_rule_pos {
            Some(pos) => {
                config.insert(
                    Value::from(constants::proxy_ads::RULE_INDEX_KEY),
                    Value::Number(serde_yaml_ng::Number::from(pos as i64)),
                );
                if let Some(Value::Sequence(rules)) = config.get_mut("rules") {
                    rules.remove(pos);
                }
            }
            None => {
                if config.get("rules").and_then(|v| v.as_sequence()).is_some() {
                    config.remove(&Value::from(constants::proxy_ads::RULE_INDEX_KEY));
                }
            }
        }
    }

    config
}

#[allow(clippy::expect_used)]
#[cfg(test)]
mod tests {
    use super::cleanup_proxy_groups;

    #[test]
    fn finalizers_reassert_runtime_state_after_merge_reapply() {
        use crate::config::runtime::IRuntime;
        use super::{finalize_runtime_config, reapply_merge_layers};

        let base: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(
            r#"
allow-lan: true
proxies:
  - name: "alive-node"
    type: ss
proxy-groups:
  - name: "manual"
    type: select
    proxies:
      - "alive-node"
      - "ghost-node"
tun:
  enable: false
  stack: mixed
rules:
  - MATCH,DIRECT
"#,
        )
        .expect("base yaml");
        let merge: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(
            r#"
allow-lan: false
mode: global
rules:
  - DOMAIN,example.com,PROXY
tun:
  enable: true
  strict-route: true
"#,
        )
        .expect("merge yaml");
        let prev_runtime: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(
            r#"
allow-lan: true
tun:
  strict-route: false
"#,
        )
        .expect("runtime yaml");

        let mut merged = reapply_merge_layers(base, &[Some(merge)]);
        let tun = merged
            .get("tun")
            .and_then(|v| v.as_mapping())
            .expect("tun mapping");
        assert_eq!(
            tun.get("enable").and_then(|v| v.as_bool()),
            Some(true),
            "merge layer overwrites tun.enable before use_tun"
        );
        assert_eq!(merged.get("allow-lan").and_then(|v| v.as_bool()), Some(false));

        IRuntime::restore_runtime_patch_after_merge(Some(&prev_runtime), &mut merged);
        assert_eq!(merged.get("allow-lan").and_then(|v| v.as_bool()), Some(true));

        let config = finalize_runtime_config(merged, false, "direct");
        let tun = config
            .get("tun")
            .and_then(|v| v.as_mapping())
            .expect("tun mapping");
        assert_eq!(tun.get("enable").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(tun.get("strict-route").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(config.get("allow-lan").and_then(|v| v.as_bool()), Some(true));

        assert_eq!(config.get("mode").and_then(|v| v.as_str()), Some("rule"));
        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules");
        assert!(!rules.iter().any(|r| r.as_str() == Some("DOMAIN,example.com,PROXY")));
        assert!(rules.iter().any(|r| r.as_str() == Some("MATCH,⬆️")));

        let manual_proxies = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .and_then(|groups| {
                groups
                    .iter()
                    .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            })
            .and_then(|group| group.get("proxies"))
            .and_then(|v| v.as_sequence())
            .expect("manual proxies");
        assert!(manual_proxies.iter().any(|p| p.as_str() == Some("alive-node")));
        assert!(!manual_proxies.iter().any(|p| p.as_str() == Some("ghost-node")));
    }

    #[test]
    fn offline_mode_overrides_rules_to_match_reject() {
        let mut config: Mapping = serde_yaml_ng::from_str(
            r#"
mode: rule
rules:
  - DOMAIN,example.com,PROXY
  - MATCH,PROXY
"#,
        )
        .expect("yaml");
        let config = finalize_runtime_config(config, false, "offline");
        assert_eq!(config.get("mode").and_then(|v| v.as_str()), Some("rule"));
        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].as_str(), Some("MATCH,REJECT"));
    }

    #[test]
    fn remove_missing_proxies_from_groups() {
        let config_str = r#"
proxies:
  - name: "alive-node"
    type: ss
proxy-groups:
  - name: "manual"
    type: select
    proxies:
      - "alive-node"
      - "missing-node"
      - "DIRECT"
  - name: "nested"
    type: select
    proxies:
      - "manual"
      - "ghost"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let manual_proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("manual proxies should be a sequence");

        assert_eq!(manual_proxies.len(), 2);
        assert!(manual_proxies.iter().any(|p| p.as_str() == Some("alive-node")));
        assert!(manual_proxies.iter().any(|p| p.as_str() == Some("DIRECT")));

        let nested_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("nested"))
            .and_then(|group| group.as_mapping())
            .expect("nested group should exist");

        let nested_proxies = nested_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("nested proxies should be a sequence");

        assert_eq!(nested_proxies.len(), 1);
        assert_eq!(nested_proxies[0].as_str(), Some("manual"));
    }

    #[test]
    fn keep_provider_backed_groups_intact() {
        let config_str = r#"
proxy-providers:
  providerA:
    type: http
    url: https://example.com
    path: ./providerA.yaml
proxies: []
proxy-groups:
  - name: "manual"
    type: select
    use:
      - "providerA"
      - "ghostProvider"
    proxies:
      - "dynamic-node"
      - "DIRECT"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let uses = manual_group
            .get("use")
            .and_then(|v| v.as_sequence())
            .expect("use should be a sequence");
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].as_str(), Some("providerA"));

        let proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("proxies should be a sequence");
        assert_eq!(proxies.len(), 2);
        assert!(proxies.iter().any(|p| p.as_str() == Some("dynamic-node")));
        assert!(proxies.iter().any(|p| p.as_str() == Some("DIRECT")));
    }

    #[test]
    fn prune_invalid_provider_and_proxies_without_provider() {
        let config_str = r#"
proxy-groups:
  - name: "manual"
    type: select
    use:
      - "ghost-provider"
    proxies:
      - "ghost-node"
      - "DIRECT"
"#;

        let mut config: serde_yaml_ng::Mapping =
            serde_yaml_ng::from_str(config_str).expect("Failed to parse test yaml");
        config = cleanup_proxy_groups(config);

        let groups = config
            .get("proxy-groups")
            .and_then(|v| v.as_sequence())
            .cloned()
            .expect("proxy-groups should be a sequence");

        let manual_group = groups
            .iter()
            .find(|group| group.get("name").and_then(serde_yaml_ng::Value::as_str) == Some("manual"))
            .and_then(|group| group.as_mapping())
            .expect("manual group should exist");

        let uses = manual_group
            .get("use")
            .and_then(|v| v.as_sequence())
            .expect("use should be a sequence");
        assert_eq!(uses.len(), 0);

        let proxies = manual_group
            .get("proxies")
            .and_then(|v| v.as_sequence())
            .expect("proxies should be a sequence");
        assert_eq!(proxies.len(), 1);
        assert_eq!(proxies[0].as_str(), Some("DIRECT"));
    }

    #[test]
    fn proxy_ads_disable_removes_rule_and_strips_nameserver_policy() {
        let yaml = r#"
proxy-ads-block: false
rules:
  - GEOIP,CN,DIRECT
  - RULE-SET,trackerslist,REJECT
  - RULE-SET,ads,REJECT
  - MATCH,PROXY
dns:
  nameserver-policy:
    "rule-set:private": https://1.1.1.1/dns-query
    "rule-set:trackerslist": rcode://success
    "rule-set:ads": rcode://success
    "rule-set:cn": https://dns.alidns.com/dns-query
"#;
        let config: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(yaml).expect("yaml");
        let config = super::apply_proxy_ads_block(config);

        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules");
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[2].as_str(), Some("MATCH,PROXY"));
        assert!(!rules.iter().any(|r| r.as_str().map(|s| s.trim()) == Some("RULE-SET,ads,REJECT")));

        let policy = config
            .get("dns")
            .and_then(|d| d.as_mapping())
            .and_then(|d| d.get(&serde_yaml_ng::Value::from("nameserver-policy")))
            .and_then(|p| p.as_mapping())
            .expect("policy");
        assert!(!policy
            .iter()
            .any(|(k, _)| k.as_str() == Some("rule-set:ads")));

        assert_eq!(
            config
                .get(crate::constants::proxy_ads::RULE_INDEX_KEY)
                .and_then(|v| v.as_i64()),
            Some(2)
        );
        assert!(config
            .get(crate::constants::proxy_ads::NS_POLICY_VALUE_SNAPSHOT_KEY)
            .is_none());
    }

    #[test]
    fn proxy_ads_enable_restores_rule_without_nameserver_policy() {
        let yaml = r#"
proxy-ads-block: true
rules:
  - GEOIP,CN,DIRECT
  - RULE-SET,trackerslist,REJECT
  - MATCH,PROXY
dns:
  nameserver-policy:
    "rule-set:private": https://1.1.1.1/dns-query
    "rule-set:trackerslist": rcode://success
    "rule-set:cn": https://dns.alidns.com/dns-query
"#;
        let mut config: serde_yaml_ng::Mapping = serde_yaml_ng::from_str(yaml).expect("yaml");
        config.insert(
            serde_yaml_ng::Value::from(crate::constants::proxy_ads::RULE_INDEX_KEY),
            serde_yaml_ng::Value::Number(serde_yaml_ng::Number::from(2_i64)),
        );

        let config = super::apply_proxy_ads_block(config);

        let rules = config
            .get("rules")
            .and_then(|v| v.as_sequence())
            .expect("rules");
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[2].as_str(), Some("RULE-SET,ads,REJECT"));
        assert_eq!(rules[3].as_str(), Some("MATCH,PROXY"));

        let keys: Vec<_> = config
            .get("dns")
            .and_then(|d| d.as_mapping())
            .and_then(|d| d.get(&serde_yaml_ng::Value::from("nameserver-policy")))
            .and_then(|p| p.as_mapping())
            .expect("policy")
            .iter()
            .filter_map(|(k, _)| k.as_str())
            .collect();
        assert_eq!(
            keys,
            vec!["rule-set:private", "rule-set:trackerslist", "rule-set:cn",]
        );
    }
}
