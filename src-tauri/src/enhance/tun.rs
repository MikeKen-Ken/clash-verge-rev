use serde_yaml_ng::{Mapping, Value};

#[cfg(target_os = "macos")]
use crate::process::AsyncHandler;

macro_rules! revise {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        $map.insert(ret_key, Value::from($val));
    };
}

// if key not exists then append value
#[allow(unused_macros)]
macro_rules! append {
    ($map: expr, $key: expr, $val: expr) => {
        let ret_key = Value::String($key.into());
        if !$map.contains_key(&ret_key) {
            $map.insert(ret_key, Value::from($val));
        }
    };
}

pub fn use_tun(mut config: Mapping, enable: bool) -> Mapping {
    let tun_key = Value::from("tun");
    let tun_val = config.get(&tun_key);
    let mut tun_val = tun_val.map_or_else(Mapping::new, |val| {
        val.as_mapping().cloned().unwrap_or_else(Mapping::new)
    });

    if enable {
        // 读取DNS配置
        let dns_key = Value::from("dns");
        let dns_val = config.get(&dns_key);
        let mut dns_val = dns_val.map_or_else(Mapping::new, |val| {
            val.as_mapping().cloned().unwrap_or_else(Mapping::new)
        });
        let ipv6_key = Value::from("ipv6");
        let ipv6_val = config.get(&ipv6_key).and_then(|v| v.as_bool()).unwrap_or(false);

        // 检查现有的 enhanced-mode 设置
        let current_mode = dns_val
            .get(Value::from("enhanced-mode"))
            .and_then(|v| v.as_str())
            .unwrap_or("fake-ip");

        // 只有当 enhanced-mode 是 fake-ip 或未设置时才修改 DNS 配置
        if current_mode == "fake-ip" || !dns_val.contains_key(Value::from("enhanced-mode")) {
            revise!(dns_val, "enable", true);
            revise!(dns_val, "ipv6", ipv6_val);

            if !dns_val.contains_key(Value::from("enhanced-mode")) {
                revise!(dns_val, "enhanced-mode", "fake-ip");
            }

            if !dns_val.contains_key(Value::from("fake-ip-range")) {
                revise!(dns_val, "fake-ip-range", "198.18.0.1/16");
            }

            #[cfg(target_os = "macos")]
            {
                AsyncHandler::spawn(move || async move {
                    crate::utils::resolve::dns::restore_public_dns().await;
                    crate::utils::resolve::dns::set_public_dns("223.6.6.6".to_string()).await;
                });
            }
        }

        // 当TUN启用时，将修改后的DNS配置写回
        revise!(config, "dns", dns_val);

        // macOS：纠正易导致 DNS 回环的组合（gvisor / strict-route:false）
        #[cfg(target_os = "macos")]
        {
            let stack = tun_val
                .get(Value::from("stack"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if stack.is_empty() || stack.eq_ignore_ascii_case("gvisor") {
                revise!(tun_val, "stack", "mixed");
            }
            let strict_route = tun_val
                .get(Value::from("strict-route"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !strict_route {
                revise!(tun_val, "strict-route", true);
            }
        }
    } else {
        // TUN未启用时，仅恢复系统DNS，不修改配置文件中的DNS设置
        #[cfg(target_os = "macos")]
        AsyncHandler::spawn(move || async move {
            crate::utils::resolve::dns::restore_public_dns().await;
        });
    }

    // 仅设置 tun.enable（开关），保留订阅/配置中的 stack、device 等
    revise!(tun_val, "enable", enable);
    revise!(config, "tun", tun_val);

    config
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tun_of(config: &Mapping) -> &Mapping {
        config
            .get(Value::from("tun"))
            .and_then(|v| v.as_mapping())
            .expect("tun mapping")
    }

    #[test]
    fn use_tun_preserves_existing_settings() {
        let mut config = Mapping::new();
        let mut tun = Mapping::new();
        tun.insert("stack".into(), "system".into());
        tun.insert("strict-route".into(), true.into());
        tun.insert("device".into(), "utun9".into());
        config.insert("tun".into(), tun.into());

        let result = use_tun(config, true);
        let tun = tun_of(&result);
        assert_eq!(tun.get("enable").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(tun.get("stack").and_then(|v| v.as_str()), Some("system"));
        assert_eq!(tun.get("strict-route").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(tun.get("device").and_then(|v| v.as_str()), Some("utun9"));
    }

    #[test]
    fn use_tun_disable() {
        let mut config = Mapping::new();
        let mut tun = Mapping::new();
        tun.insert("enable".into(), true.into());
        tun.insert("stack".into(), "mixed".into());
        config.insert("tun".into(), tun.into());

        let result = use_tun(config, false);
        let tun = tun_of(&result);
        assert_eq!(tun.get("enable").and_then(|v| v.as_bool()), Some(false));
        assert_eq!(tun.get("stack").and_then(|v| v.as_str()), Some("mixed"));
    }

    #[test]
    fn use_tun_creates_tun_section_if_missing() {
        let config = Mapping::new();
        let result = use_tun(config, true);
        let tun = tun_of(&result);
        assert_eq!(tun.get("enable").and_then(|v| v.as_bool()), Some(true));
    }
}
