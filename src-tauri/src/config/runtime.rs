use serde_yaml_ng::{Mapping, Value};
use smartstring::alias::String;
use std::collections::{HashMap, HashSet};

use crate::{constants, enhance::field::use_keys};

#[inline]
fn merge_clash_for_android_mapping(config: &mut Mapping, patch_cfa: &Mapping) {
    let mut cfa = config
        .get("clash-for-android")
        .and_then(|v| v.as_mapping())
        .cloned()
        .unwrap_or_default();
    for key in use_keys(patch_cfa) {
        if let Some(v) = patch_cfa.get(key.as_str()) {
            cfa.insert(Value::from(key.as_str()), v.clone());
        }
    }
    config.insert("clash-for-android".into(), Value::from(cfa));
}

const PATCH_CONFIG_INNER: [&str; 6] = [
    "allow-lan",
    "bind-address",
    "ipv6",
    "log-level",
    "unified-delay",
    "tunnels",
];

/// 与 [`PATCH_CONFIG_INNER`] 及 [`IRuntime::patch_config`] 中的 `tun` 分支一致；此类字段可走 Mihomo PATCH `/configs`，避免全量 reload。
const HOT_RELOAD_PATCH_KEYS: &[&str] = &[
    "allow-lan",
    "bind-address",
    "ipv6",
    "log-level",
    "unified-delay",
    "tunnels",
    "tun",
];

#[derive(Default, Clone)]
pub struct IRuntime {
    pub config: Option<Mapping>,
    // 记录在订阅中（包括merge和script生成的）出现过的keys
    // 这些keys不一定都生效
    pub exists_keys: HashSet<String>,
    // TODO 或许可以用 FixMap 来存储以提升效率
    pub chain_logs: HashMap<String, Vec<(String, String)>>,
}

impl IRuntime {
    #[inline]
    pub fn new() -> Self {
        Self::default()
    }

    // 这里只更改 allow-lan | bind-address | ipv6 | log-level | tun | tunnels | proxy-ads-block | clash-for-android（局域网设备禁用等）
    #[inline]
    pub fn patch_config(&mut self, patch: &Mapping) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        for key in PATCH_CONFIG_INNER.iter() {
            if let Some(value) = patch.get(key) {
                config.insert((*key).into(), value.clone());
            }
        }

        // 代理页「屏蔽广告」开关：仅客户端使用，须写入运行时 Mapping，否则 PATCH 无效且刷新后前端会回退为默认开启
        if let Some(value) = patch.get("proxy-ads-block") {
            config.insert("proxy-ads-block".into(), value.clone());
        }

        // 局域网设备禁用 / 上限等：须写入运行时 YAML，核心才会注入 SRC-IP-CIDR REJECT-DROP 规则
        match patch.get("clash-for-android") {
            Some(Value::Null) => {
                config.remove("clash-for-android");
            }
            Some(Value::Mapping(patch_cfa)) => {
                merge_clash_for_android_mapping(config, patch_cfa);
            }
            _ => {}
        }

        let patch_tun = patch.get("tun");
        if let Some(patch_tun_value) = patch_tun {
            let mut tun = config
                .get("tun")
                .and_then(|val| val.as_mapping())
                .cloned()
                .unwrap_or_else(Mapping::new);

            if let Some(patch_tun_mapping) = patch_tun_value.as_mapping() {
                for key in use_keys(patch_tun_mapping) {
                    if let Some(value) = patch_tun_mapping.get(key.as_str()) {
                        tun.insert(Value::from(key.as_str()), value.clone());
                    }
                }
            }

            config.insert("tun".into(), Value::from(tun));
        }
    }

    /// 全量 `Config::generate()` 合并订阅后，从上一版运行时 YAML 恢复用户经 `patch_runtime_config` 改过的字段。
    ///
    /// 否则仅 PATCH 核心 + 内存草稿时正确，一旦触发 `generate()` 会按订阅默认值重写顶层键，磁盘上的运行配置会与核心不一致（例如 `allow-lan` 仍为 false）。
    #[inline]
    pub fn merge_persistent_runtime_patch_from_prev(prev: Option<&Mapping>, config: &mut Mapping) {
        let Some(prev_cfg) = prev else {
            return;
        };
        for key in PATCH_CONFIG_INNER.iter() {
            if let Some(v) = prev_cfg.get(*key) {
                config.insert((*key).into(), v.clone());
            }
        }
        if let Some(v) = prev_cfg.get("proxy-ads-block") {
            config.insert("proxy-ads-block".into(), v.clone());
        }
        if let Some(v) = prev_cfg.get(constants::proxy_ads::RULE_INDEX_KEY) {
            config.insert(constants::proxy_ads::RULE_INDEX_KEY.into(), v.clone());
        }

        // tun：与 `patch_config` 的 tun 分支一致；`enable` 以当前 config 为准（已由 `use_tun` 根据 verge 写入）
        if let Some(prev_tun) = prev_cfg.get("tun").and_then(|v| v.as_mapping()) {
            let mut tun = config
                .get("tun")
                .and_then(|v| v.as_mapping())
                .cloned()
                .unwrap_or_default();
            let enable_val = tun.get(Value::from("enable")).cloned();
            for key in use_keys(prev_tun) {
                if key.eq_ignore_ascii_case("enable") {
                    continue;
                }
                if let Some(value) = prev_tun.get(key.as_str()) {
                    tun.insert(Value::from(key.as_str()), value.clone());
                }
            }
            if let Some(e) = enable_val {
                tun.insert(Value::from("enable"), e);
            }
            config.insert("tun".into(), Value::from(tun));
        }

        // clash-for-android：全量 generate 后把上一版运行时的子表整表叠到新生成配置之上。
        // 若只合并少数键，而上一版 YAML 省略了空的 `lan-blocked-devices`，则无法覆盖订阅里自带的列表，会导致「移除禁用」仍走拦截。
        if let Some(prev_cfa) = prev_cfg.get("clash-for-android").and_then(|v| v.as_mapping()) {
            let mut cfa = config
                .get("clash-for-android")
                .and_then(|v| v.as_mapping())
                .cloned()
                .unwrap_or_default();
            for key in use_keys(prev_cfa) {
                if let Some(v) = prev_cfa.get(key.as_str()) {
                    cfa.insert(Value::from(key.as_str()), v.clone());
                }
            }
            if !cfa.is_empty() {
                config.insert("clash-for-android".into(), Value::from(cfa));
            }
        }
    }

    /// 是否仅包含可通过 Mihomo 控制 API 热更新的顶层键（无需 `reload_config` 全量重载）。
    #[inline]
    pub fn is_hot_reload_only_patch(patch: &Mapping) -> bool {
        if patch.is_empty() {
            return false;
        }
        patch.keys().all(|k| {
            k.as_str()
                .map(|s| HOT_RELOAD_PATCH_KEYS.iter().any(|h| *h == s))
                .unwrap_or(false)
        })
    }

    /// 是否仅为代理页「屏蔽广告」开关（可走 PATCH `rules`，避免 `reload_config` 触发健康检测）。
    #[inline]
    pub fn is_proxy_ads_block_only_patch(patch: &Mapping) -> bool {
        !patch.is_empty()
            && patch.keys().all(|k| k.as_str() == Some("proxy-ads-block"))
    }

    /// 更新链式代理配置
    ///
    /// 该函数更新 `proxies` 和 `proxy-groups` 配置，并处理链式代理的修改或(传入 None )删除。
    ///
    /// 配置示例：
    ///
    /// ```json
    /// {
    ///     "proxies": [
    ///         {
    ///             "name": "入口节点",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx"
    ///         },
    ///         {
    ///             "name": "hop_node_1_xxxx",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx",
    ///             "dialer-proxy": "入口节点"
    ///         },
    ///         {
    ///             "name": "出口节点",
    ///             "type": "xxx",
    ///             "server": "xxx",
    ///             "port": "xxx",
    ///             "ports": "xxx",
    ///             "password": "xxx",
    ///             "skip-cert-verify": "xxx",
    ///             "dialer-proxy": "hop_node_1_xxxx"
    ///         }
    ///     ],
    ///     "proxy-groups": [
    ///         {
    ///             "name": "proxy_chain",
    ///             "type": "select",
    ///             "proxies": ["出口节点"]
    ///         }
    ///     ]
    /// }
    /// ```
    #[inline]
    pub fn update_proxy_chain_config(&mut self, proxy_chain_config: Option<Value>) {
        let config = if let Some(config) = self.config.as_mut() {
            config
        } else {
            return;
        };

        if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
            proxies.iter_mut().for_each(|proxy| {
                if let Some(proxy) = proxy.as_mapping_mut()
                    && proxy.get("dialer-proxy").is_some()
                {
                    proxy.remove("dialer-proxy");
                }
            });
        }

        if let Some(Value::Sequence(dialer_proxies)) = proxy_chain_config
            && let Some(Value::Sequence(proxies)) = config.get_mut("proxies")
        {
            for (i, dialer_proxy) in dialer_proxies.iter().enumerate() {
                if let Some(Value::Mapping(proxy)) =
                    proxies.iter_mut().find(|proxy| proxy.get("name") == Some(dialer_proxy))
                    && i != 0
                    && let Some(dialer_proxy) = dialer_proxies.get(i - 1)
                {
                    proxy.insert("dialer-proxy".into(), dialer_proxy.to_owned());
                }
            }
        }
    }
}
