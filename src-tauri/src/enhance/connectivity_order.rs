//! 在 Config::generate 阶段按联通统计重排 proxies / proxy-groups.proxies（随已有 reload 生效，不单独触发 reload）。

use crate::utils::dirs;
use chrono::{Duration, Local, NaiveDate};
use serde::Deserialize;
use serde_yaml_ng::{Mapping, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const STATS_FILE: &str = "proxy-connectivity-stats.json";
const REGION_ORDER_FILE: &str = "proxy-region-order.json";
const RETENTION_DAYS: i64 = 3;

const DEFAULT_CUSTOM_PROXY_ORDER: [&str; 5] = ["🇭🇰", "🇯🇵", "🇸🇬", "🇹🇼", "🇺🇸"];

#[derive(Debug, Deserialize)]
struct DayCounts {
    #[serde(default)]
    s: i64,
    #[serde(default)]
    f: i64,
}

#[derive(Debug, Deserialize)]
struct ProxyConnectivityEntry {
    #[serde(default)]
    days: HashMap<String, DayCounts>,
}

#[derive(Debug, Deserialize)]
struct StatsFileV2 {
    #[serde(default)]
    v: i64,
    #[serde(default)]
    data: HashMap<String, ProxyConnectivityEntry>,
}

#[derive(Debug, Deserialize)]
struct LegacyEntry {
    #[serde(default)]
    success: i64,
    #[serde(default)]
    failure: i64,
}

#[derive(Debug, Deserialize)]
struct RegionOrderFile {
    #[serde(default, rename = "customOrder")]
    custom_order: Vec<String>,
}

struct FlagRule {
    flag: &'static str,
    keywords: &'static [&'static str],
}

// 顺序敏感：长关键字必须在短关键字之前
const COUNTRY_FLAG_KEYWORDS: &[FlagRule] = &[
    FlagRule { flag: "🇭🇰", keywords: &["香港"] },
    FlagRule { flag: "🇲🇴", keywords: &["澳门"] },
    FlagRule { flag: "🇹🇼", keywords: &["台湾", "台北", "高雄", "台中", "台南"] },
    FlagRule {
        flag: "🇨🇳",
        keywords: &["中国", "大陆", "回国", "上海", "北京", "广州", "深圳", "成都", "杭州"],
    },
    FlagRule {
        flag: "🇯🇵",
        keywords: &["日本", "东京", "大阪", "名古屋", "京都", "福冈", "札幌", "横滨"],
    },
    FlagRule { flag: "🇰🇷", keywords: &["韩国", "南韩", "首尔", "釜山"] },
    FlagRule { flag: "🇲🇳", keywords: &["蒙古"] },
    FlagRule { flag: "🇸🇬", keywords: &["新加坡", "狮城"] },
    FlagRule {
        flag: "🇮🇩",
        keywords: &["印度尼西亚", "印尼", "雅加达", "巴厘岛"],
    },
    FlagRule { flag: "🇲🇾", keywords: &["马来西亚", "吉隆坡"] },
    FlagRule { flag: "🇹🇭", keywords: &["泰国", "曼谷"] },
    FlagRule { flag: "🇻🇳", keywords: &["越南", "胡志明", "河内"] },
    FlagRule { flag: "🇵🇭", keywords: &["菲律宾", "马尼拉"] },
    FlagRule { flag: "🇰🇭", keywords: &["柬埔寨", "金边"] },
    FlagRule { flag: "🇱🇦", keywords: &["老挝"] },
    FlagRule { flag: "🇲🇲", keywords: &["缅甸"] },
    FlagRule {
        flag: "🇮🇳",
        keywords: &["印度", "孟买", "新德里", "班加罗尔"],
    },
    FlagRule { flag: "🇵🇰", keywords: &["巴基斯坦"] },
    FlagRule { flag: "🇧🇩", keywords: &["孟加拉"] },
    FlagRule { flag: "🇱🇰", keywords: &["斯里兰卡"] },
    FlagRule { flag: "🇰🇿", keywords: &["哈萨克斯坦", "哈萨克"] },
    FlagRule {
        flag: "🇦🇪",
        keywords: &["阿联酋", "迪拜", "阿布扎比"],
    },
    FlagRule { flag: "🇸🇦", keywords: &["沙特"] },
    FlagRule { flag: "🇶🇦", keywords: &["卡塔尔"] },
    FlagRule { flag: "🇮🇱", keywords: &["以色列"] },
    FlagRule { flag: "🇮🇷", keywords: &["伊朗"] },
    FlagRule { flag: "🇹🇷", keywords: &["土耳其", "伊斯坦布尔"] },
    FlagRule { flag: "🇧🇾", keywords: &["白俄罗斯"] },
    FlagRule {
        flag: "🇷🇺",
        keywords: &["俄罗斯", "莫斯科", "圣彼得堡"],
    },
    FlagRule { flag: "🇺🇦", keywords: &["乌克兰"] },
    FlagRule { flag: "🇷🇴", keywords: &["罗马尼亚"] },
    FlagRule {
        flag: "🇩🇪",
        keywords: &["德国", "法兰克福", "柏林", "慕尼黑", "汉堡"],
    },
    FlagRule { flag: "🇫🇷", keywords: &["法国", "巴黎", "马赛"] },
    FlagRule {
        flag: "🇬🇧",
        keywords: &["英国", "伦敦", "曼彻斯特"],
    },
    FlagRule { flag: "🇮🇪", keywords: &["爱尔兰", "都柏林"] },
    FlagRule { flag: "🇳🇱", keywords: &["荷兰", "阿姆斯特丹"] },
    FlagRule { flag: "🇧🇪", keywords: &["比利时", "布鲁塞尔"] },
    FlagRule { flag: "🇱🇺", keywords: &["卢森堡"] },
    FlagRule {
        flag: "🇨🇭",
        keywords: &["瑞士", "苏黎世", "日内瓦"],
    },
    FlagRule { flag: "🇦🇹", keywords: &["奥地利", "维也纳"] },
    FlagRule { flag: "🇮🇹", keywords: &["意大利", "罗马", "米兰"] },
    FlagRule {
        flag: "🇪🇸",
        keywords: &["西班牙", "马德里", "巴塞罗那"],
    },
    FlagRule { flag: "🇵🇹", keywords: &["葡萄牙", "里斯本"] },
    FlagRule { flag: "🇬🇷", keywords: &["希腊", "雅典"] },
    FlagRule {
        flag: "🇸🇪",
        keywords: &["瑞典", "斯德哥尔摩"],
    },
    FlagRule { flag: "🇳🇴", keywords: &["挪威", "奥斯陆"] },
    FlagRule {
        flag: "🇫🇮",
        keywords: &["芬兰", "赫尔辛基"],
    },
    FlagRule { flag: "🇩🇰", keywords: &["丹麦", "哥本哈根"] },
    FlagRule { flag: "🇮🇸", keywords: &["冰岛"] },
    FlagRule { flag: "🇵🇱", keywords: &["波兰", "华沙"] },
    FlagRule { flag: "🇨🇿", keywords: &["捷克"] },
    FlagRule { flag: "🇸🇰", keywords: &["斯洛伐克"] },
    FlagRule { flag: "🇸🇮", keywords: &["斯洛文尼亚"] },
    FlagRule {
        flag: "🇭🇺",
        keywords: &["匈牙利", "布达佩斯"],
    },
    FlagRule { flag: "🇧🇬", keywords: &["保加利亚"] },
    FlagRule { flag: "🇷🇸", keywords: &["塞尔维亚"] },
    FlagRule { flag: "🇭🇷", keywords: &["克罗地亚"] },
    FlagRule {
        flag: "🇺🇸",
        keywords: &[
            "美国", "纽约", "洛杉矶", "圣何塞", "阿什本", "华盛顿", "波士顿", "迈阿密", "西雅图",
            "芝加哥", "达拉斯", "休斯顿", "丹佛", "凤凰城", "圣地亚哥", "夏威夷", "硅谷",
        ],
    },
    FlagRule {
        flag: "🇨🇦",
        keywords: &["加拿大", "多伦多", "温哥华", "蒙特利尔"],
    },
    FlagRule { flag: "🇲🇽", keywords: &["墨西哥"] },
    FlagRule {
        flag: "🇧🇷",
        keywords: &["巴西", "圣保罗", "里约"],
    },
    FlagRule { flag: "🇦🇷", keywords: &["阿根廷"] },
    FlagRule { flag: "🇨🇱", keywords: &["智利"] },
    FlagRule { flag: "🇨🇴", keywords: &["哥伦比亚"] },
    FlagRule { flag: "🇵🇪", keywords: &["秘鲁"] },
    FlagRule {
        flag: "🇿🇦",
        keywords: &["南非", "约翰内斯堡"],
    },
    FlagRule { flag: "🇪🇬", keywords: &["埃及", "开罗"] },
    FlagRule { flag: "🇳🇬", keywords: &["尼日利亚"] },
    FlagRule { flag: "🇰🇪", keywords: &["肯尼亚"] },
    FlagRule { flag: "🇲🇦", keywords: &["摩洛哥"] },
    FlagRule {
        flag: "🇦🇺",
        keywords: &["澳大利亚", "澳洲", "悉尼", "墨尔本", "布里斯班", "珀斯"],
    },
    FlagRule { flag: "🇳🇿", keywords: &["新西兰", "奥克兰"] },
];

fn resolve_proxy_flag(name: &str) -> String {
    for rule in COUNTRY_FLAG_KEYWORDS {
        for keyword in rule.keywords {
            if name.contains(keyword) {
                return rule.flag.into();
            }
        }
    }
    String::new()
}

fn cutoff_day(now: NaiveDate) -> NaiveDate {
    now - Duration::days(RETENTION_DAYS - 1)
}

fn load_success_counts() -> HashMap<String, i64> {
    let Ok(home) = dirs::app_home_dir() else {
        return HashMap::new();
    };
    load_success_counts_from_dir(&home)
}

fn load_success_counts_from_dir(home: &PathBuf) -> HashMap<String, i64> {
    let path = home.join(STATS_FILE);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(file) = serde_json::from_str::<StatsFileV2>(&raw) else {
        if let Ok(legacy) = serde_json::from_str::<HashMap<String, LegacyEntry>>(&raw) {
            let today = Local::now().date_naive().format("%Y-%m-%d").to_string();
            let mut out = HashMap::new();
            for (name, entry) in legacy {
                if entry.success > 0 {
                    out.insert(name, entry.success);
                }
            }
            let _ = today;
            return out;
        }
        return HashMap::new();
    };

    if file.v != 2 {
        return HashMap::new();
    }

    let today = Local::now().date_naive();
    let cutoff = cutoff_day(today);
    let mut out = HashMap::new();
    for (name, entry) in file.data {
        let mut total = 0i64;
        for (day, counts) in &entry.days {
            if let Ok(parsed) = NaiveDate::parse_from_str(day, "%Y-%m-%d") {
                if parsed >= cutoff {
                    total += counts.s;
                }
            }
        }
        if total > 0 {
            out.insert(name, total);
        }
    }
    out
}

fn load_custom_proxy_order() -> Vec<String> {
    let Ok(home) = dirs::app_home_dir() else {
        return default_custom_order();
    };
    let path = home.join(REGION_ORDER_FILE);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return default_custom_order();
    };
    let Ok(file) = serde_json::from_str::<RegionOrderFile>(&raw) else {
        return default_custom_order();
    };
    if file.custom_order.is_empty() {
        default_custom_order()
    } else {
        file.custom_order
    }
}

fn default_custom_order() -> Vec<String> {
    DEFAULT_CUSTOM_PROXY_ORDER
        .iter()
        .map(|s| (*s).into())
        .collect()
}

fn resolve_group_order(
    flag: &str,
    custom_order: &[String],
    fallback_order: &mut HashMap<String, i64>,
    next_fallback: &mut i64,
) -> i64 {
    if let Some(index) = custom_order.iter().position(|f| f == flag) {
        return index as i64;
    }
    if let Some(cached) = fallback_order.get(flag) {
        return *cached;
    }
    let order = *next_fallback;
    fallback_order.insert(flag.into(), order);
    *next_fallback += 1;
    order
}

fn sort_names_by_region_and_connectivity(
    names: &[String],
    custom_order: &[String],
    success_counts: &HashMap<String, i64>,
) -> Vec<String> {
    if names.len() <= 1 {
        return names.to_vec();
    }

    let mut fallback_order = HashMap::new();
    let mut next_fallback = custom_order.len() as i64;

    let mut decorated: Vec<(usize, i64, i64, String)> = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let flag = resolve_proxy_flag(name);
            let group_order = resolve_group_order(
                &flag,
                custom_order,
                &mut fallback_order,
                &mut next_fallback,
            );
            let success = success_counts.get(name).copied().unwrap_or(0);
            (index, group_order, -success, name.clone())
        })
        .collect();

    decorated.sort_by(|a, b| {
        a.1.cmp(&b.1)
            .then(a.2.cmp(&b.2))
            .then(a.0.cmp(&b.0))
    });

    decorated.into_iter().map(|item| item.3).collect()
}

fn sort_proxy_mappings(proxies: &mut [Value], custom_order: &[String], success_counts: &HashMap<String, i64>) {
    if proxies.len() <= 1 {
        return;
    }
    let names: Vec<String> = proxies
        .iter()
        .filter_map(|item| item.as_mapping()?.get("name")?.as_str().map(String::from))
        .collect();
    if names.len() != proxies.len() {
        return;
    }
    let sorted = sort_names_by_region_and_connectivity(&names, custom_order, success_counts);
    let index_by_name: HashMap<String, usize> = sorted
        .iter()
        .enumerate()
        .map(|(i, name)| (name.clone(), i))
        .collect();
    proxies.sort_by_key(|item| {
        item.as_mapping()
            .and_then(|m| m.get("name"))
            .and_then(|v| v.as_str())
            .and_then(|name| index_by_name.get(name).copied())
            .unwrap_or(usize::MAX)
    });
}

fn sort_group_proxies_list(
    list: &mut [Value],
    custom_order: &[String],
    success_counts: &HashMap<String, i64>,
) {
    let names: Vec<String> = list
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if names.len() != list.len() || names.len() <= 1 {
        return;
    }
    let sorted = sort_names_by_region_and_connectivity(&names, custom_order, success_counts);
    let index_by_name: HashMap<String, usize> = sorted
        .iter()
        .enumerate()
        .map(|(i, name)| (name.clone(), i))
        .collect();
    list.sort_by_key(|v| {
        v.as_str()
            .and_then(|name| index_by_name.get(name).copied())
            .unwrap_or(usize::MAX)
    });
}

/// 在 finalize_runtime_config 末尾调用：重排运行时 YAML 中的节点顺序。
pub fn apply_connectivity_proxy_order(mut config: Mapping) -> Mapping {
    let success_counts = load_success_counts();
    let custom_order = load_custom_proxy_order();

    if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
        sort_proxy_mappings(proxies, &custom_order, &success_counts);
    }

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            let Some(group_map) = group.as_mapping_mut() else {
                continue;
            };
            if let Some(Value::Sequence(list)) = group_map.get_mut("proxies") {
                sort_group_proxies_list(list, &custom_order, &success_counts);
            }
        }
    }

    config
}

/// 前端同步联通统计 JSON 到数据目录（不触发 reload）。
pub fn write_connectivity_stats_file(raw_json: &str) -> Result<(), String> {
    let home = dirs::app_home_dir().map_err(|e| e.to_string())?;
    let path = home.join(STATS_FILE);
    std::fs::write(path, raw_json).map_err(|e| e.to_string())
}

/// 前端同步地区顺序到数据目录（不触发 reload）。
pub fn write_region_order_file(custom_order: &[String]) -> Result<(), String> {
    let home = dirs::app_home_dir().map_err(|e| e.to_string())?;
    let path = home.join(REGION_ORDER_FILE);
    let payload = serde_json::json!({ "customOrder": custom_order });
    std::fs::write(path, payload.to_string()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sort_names_keeps_region_priority() {
        let names = vec![
            "🇯🇵 test 01".into(),
            "🇭🇰 test 01".into(),
            "🇭🇰 test 02".into(),
        ];
        let order = default_custom_order();
        let mut success = HashMap::new();
        success.insert("🇭🇰 test 02".into(), 5);
        success.insert("🇭🇰 test 01".into(), 1);
        let sorted = sort_names_by_region_and_connectivity(&names, &order, &success);
        assert_eq!(sorted[0], "🇭🇰 test 02");
        assert_eq!(sorted[1], "🇭🇰 test 01");
        assert_eq!(sorted[2], "🇯🇵 test 01");
    }
}
