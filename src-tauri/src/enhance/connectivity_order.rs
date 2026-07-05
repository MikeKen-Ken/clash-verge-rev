//! 在 Config::generate 阶段按指数衰减 + 贝叶斯平滑成功率重排 proxies / proxy-groups.proxies。

use crate::utils::dirs;
use chrono::{Duration, Local, NaiveDate};
use serde::Deserialize;
use serde_yaml_ng::{Mapping, Value};
use std::collections::HashMap;
use std::path::PathBuf;

const STATS_FILE: &str = "proxy-connectivity-stats.json";
const RETENTION_DAYS: i64 = 30;
const DECAY_HALF_LIFE_DAYS: f64 = 3.0;
const PRIOR_VIRTUAL_SAMPLES: f64 = 20.0;
const FALLBACK_PRIOR_RATE: f64 = 0.75;

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

#[derive(Debug, Clone, Copy)]
struct BayesianPrior {
    alpha: f64,
    beta: f64,
}

#[derive(Debug, Clone, Copy, Default)]
struct WeightedStats {
    success: f64,
    failure: f64,
}

fn cutoff_day(now: NaiveDate) -> NaiveDate {
    now - Duration::days(RETENTION_DAYS - 1)
}

fn day_age_in_days(day: NaiveDate, today: NaiveDate) -> i64 {
    (today - day).num_days()
}

fn connectivity_decay_weight(age_days: i64) -> f64 {
    if age_days < 0 || age_days >= RETENTION_DAYS {
        return 0.0;
    }
    if DECAY_HALF_LIFE_DAYS <= 0.0 {
        return if age_days == 0 { 1.0 } else { 0.0 };
    }
    0.5_f64.powf(age_days as f64 / DECAY_HALF_LIFE_DAYS)
}

fn sum_weighted_days(days: &HashMap<String, DayCounts>, today: NaiveDate) -> WeightedStats {
    let mut stats = WeightedStats::default();
    for (day, counts) in days {
        let Ok(parsed) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
            continue;
        };
        let weight = connectivity_decay_weight(day_age_in_days(parsed, today));
        if weight <= 0.0 {
            continue;
        }
        stats.success += counts.s as f64 * weight;
        stats.failure += counts.f as f64 * weight;
    }
    stats
}

fn load_weighted_connectivity_stats() -> HashMap<String, WeightedStats> {
    let Ok(home) = dirs::app_home_dir() else {
        return HashMap::new();
    };
    load_weighted_connectivity_stats_from_dir(&home)
}

fn load_weighted_connectivity_stats_from_dir(home: &PathBuf) -> HashMap<String, WeightedStats> {
    let path = home.join(STATS_FILE);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };

    let today = Local::now().date_naive();

    let Ok(file) = serde_json::from_str::<StatsFileV2>(&raw) else {
        if let Ok(legacy) = serde_json::from_str::<HashMap<String, LegacyEntry>>(&raw) {
            let mut out = HashMap::new();
            for (name, entry) in legacy {
                if entry.success > 0 || entry.failure > 0 {
                    out.insert(
                        name,
                        WeightedStats {
                            success: entry.success as f64,
                            failure: entry.failure as f64,
                        },
                    );
                }
            }
            return out;
        }
        return HashMap::new();
    };

    if file.v != 2 {
        return HashMap::new();
    }

    let _cutoff = cutoff_day(today);
    let mut out = HashMap::new();
    for (name, entry) in file.data {
        let weighted = sum_weighted_days(&entry.days, today);
        if weighted.success > 0.0 || weighted.failure > 0.0 {
            out.insert(name, weighted);
        }
    }
    out
}

fn compute_bayesian_prior(stats: &HashMap<String, WeightedStats>) -> BayesianPrior {
    let mut total_success = 0.0;
    let mut total_failure = 0.0;
    for entry in stats.values() {
        total_success += entry.success;
        total_failure += entry.failure;
    }

    let total = total_success + total_failure;
    let rate = if total > 0.0 {
        total_success / total
    } else {
        FALLBACK_PRIOR_RATE
    };

    BayesianPrior {
        alpha: rate * PRIOR_VIRTUAL_SAMPLES,
        beta: (1.0 - rate) * PRIOR_VIRTUAL_SAMPLES,
    }
}

fn bayesian_score(success: f64, failure: f64, prior: BayesianPrior) -> f64 {
    let denom = success + failure + prior.alpha + prior.beta;
    if denom <= 0.0 {
        return FALLBACK_PRIOR_RATE;
    }
    (success + prior.alpha) / denom
}

fn sort_names_by_connectivity(
    names: &[String],
    stats: &HashMap<String, WeightedStats>,
    prior: BayesianPrior,
) -> Vec<String> {
    if names.len() <= 1 {
        return names.to_vec();
    }

    let mut decorated: Vec<(usize, f64, String)> = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let entry = stats.get(name).copied().unwrap_or_default();
            let score = bayesian_score(entry.success, entry.failure, prior);
            (index, score, name.clone())
        })
        .collect();

    decorated.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });

    decorated.into_iter().map(|item| item.2).collect()
}

fn sort_proxy_mappings(
    proxies: &mut [Value],
    stats: &HashMap<String, WeightedStats>,
    prior: BayesianPrior,
) {
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
    let sorted = sort_names_by_connectivity(&names, stats, prior);
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
    stats: &HashMap<String, WeightedStats>,
    prior: BayesianPrior,
) {
    let names: Vec<String> = list
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if names.len() != list.len() || names.len() <= 1 {
        return;
    }
    let sorted = sort_names_by_connectivity(&names, stats, prior);
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
    let stats = load_weighted_connectivity_stats();
    let prior = compute_bayesian_prior(&stats);

    if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
        sort_proxy_mappings(proxies, &stats, prior);
    }

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            let Some(group_map) = group.as_mapping_mut() else {
                continue;
            };
            if let Some(Value::Sequence(list)) = group_map.get_mut("proxies") {
                sort_group_proxies_list(list, &stats, prior);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decay_weight_halves_every_half_life() {
        assert!((connectivity_decay_weight(0) - 1.0).abs() < f64::EPSILON);
        assert!((connectivity_decay_weight(3) - 0.5).abs() < f64::EPSILON);
        assert!((connectivity_decay_weight(6) - 0.25).abs() < f64::EPSILON);
        assert_eq!(connectivity_decay_weight(30), 0.0);
    }

    #[test]
    fn sort_names_by_bayesian_score_desc() {
        let names = vec![
            "node-low".into(),
            "node-high".into(),
            "node-untested".into(),
        ];
        let mut stats = HashMap::new();
        stats.insert(
            "node-low".into(),
            WeightedStats {
                success: 1.0,
                failure: 9.0,
            },
        );
        stats.insert(
            "node-high".into(),
            WeightedStats {
                success: 45.0,
                failure: 5.0,
            },
        );
        let prior = compute_bayesian_prior(&stats);
        let sorted = sort_names_by_connectivity(&names, &stats, prior);
        assert_eq!(sorted[0], "node-high");
        assert_eq!(sorted[1], "node-untested");
        assert_eq!(sorted[2], "node-low");
    }

    #[test]
    fn bayesian_score_shrinks_small_sample_with_k20() {
        let prior = BayesianPrior {
            alpha: 15.0,
            beta: 5.0,
        };
        let perfect_small = bayesian_score(1.0, 0.0, prior);
        let stable_large = bayesian_score(9.0, 1.0, prior);
        assert!(stable_large > perfect_small);
    }

    #[test]
    fn older_day_counts_less_than_today() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 5).unwrap();
        let mut days = HashMap::new();
        days.insert(
            "2026-07-05".into(),
            DayCounts { s: 10, f: 0 },
        );
        days.insert(
            "2026-07-02".into(),
            DayCounts { s: 10, f: 0 },
        );
        let weighted = sum_weighted_days(&days, today);
        assert!(weighted.success > 10.0);
        assert!(weighted.success < 20.0);
    }
}
