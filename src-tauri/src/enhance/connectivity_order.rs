//! 在 Config::generate 阶段按惩罚有效延迟（含失败 timeout）重排 proxies / proxy-groups.proxies。

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
const FALLBACK_DELAY_MS: f64 = 400.0;
const SCORE_REFERENCE_DELAY_MS: f64 = 400.0;

#[derive(Debug, Deserialize)]
struct DayCounts {
    #[serde(default)]
    s: i64,
    #[serde(default)]
    f: i64,
    #[serde(default)]
    ds: i64,
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

#[derive(Debug, Clone, Copy, Default)]
struct WeightedStats {
    success: f64,
    failure: f64,
    delay_sum: f64,
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
        stats.delay_sum += counts.ds as f64 * weight;
    }
    stats
}

fn weighted_trial_count(stats: WeightedStats) -> f64 {
    stats.success + stats.failure
}

fn load_weighted_connectivity_stats() -> HashMap<String, WeightedStats> {
    let Ok(home) = dirs::app_home_dir() else {
        return HashMap::new();
    };
    load_weighted_connectivity_stats_from_dir(&home)
}

fn load_weighted_connectivity_stats_from_dir(home: &PathBuf) -> HashMap<String, WeightedStats> {
    let raw = match with_connectivity_stats_lock(home, || {
        let path = home.join(STATS_FILE);
        match std::fs::read_to_string(path) {
            Ok(raw) => Ok(raw),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(err) => Err(err.to_string()),
        }
    }) {
        Ok(raw) if !raw.is_empty() => raw,
        _ => return HashMap::new(),
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
                            delay_sum: 0.0,
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

fn compute_prior_effective_delay_ms(stats: &HashMap<String, WeightedStats>) -> f64 {
    let mut total_delay = 0.0;
    let mut total_trials = 0.0;
    for entry in stats.values() {
        total_delay += entry.delay_sum;
        total_trials += weighted_trial_count(*entry);
    }
    if total_trials <= 0.0 {
        return FALLBACK_DELAY_MS;
    }
    let avg = total_delay / total_trials;
    if !avg.is_finite() || avg < 0.0 {
        FALLBACK_DELAY_MS
    } else {
        avg
    }
}

fn smoothed_effective_avg_delay(stats: WeightedStats, prior_delay_ms: f64) -> f64 {
    let trials = weighted_trial_count(stats);
    let prior = if prior_delay_ms.is_finite() && prior_delay_ms > 0.0 {
        prior_delay_ms
    } else {
        FALLBACK_DELAY_MS
    };
    (stats.delay_sum + PRIOR_VIRTUAL_SAMPLES * prior) / (trials + PRIOR_VIRTUAL_SAMPLES)
}

fn connectivity_score_from_avg_delay(avg_delay_ms: f64) -> f64 {
    if !avg_delay_ms.is_finite() || avg_delay_ms < 0.0 {
        return 1.0 / (1.0 + FALLBACK_DELAY_MS / SCORE_REFERENCE_DELAY_MS);
    }
    1.0 / (1.0 + avg_delay_ms / SCORE_REFERENCE_DELAY_MS)
}

fn penalized_delay_score(stats: WeightedStats, prior_delay_ms: f64) -> f64 {
    let avg = smoothed_effective_avg_delay(stats, prior_delay_ms);
    connectivity_score_from_avg_delay(avg)
}

fn sort_names_by_connectivity(
    names: &[String],
    stats: &HashMap<String, WeightedStats>,
    prior_delay_ms: f64,
) -> Vec<String> {
    if names.len() <= 1 {
        return names.to_vec();
    }

    let mut decorated: Vec<(usize, f64, String)> = names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            let entry = stats.get(name).copied().unwrap_or_default();
            let score = penalized_delay_score(entry, prior_delay_ms);
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
    prior_delay_ms: f64,
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
    let sorted = sort_names_by_connectivity(&names, stats, prior_delay_ms);
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
    prior_delay_ms: f64,
) {
    let names: Vec<String> = list
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    if names.len() != list.len() || names.len() <= 1 {
        return;
    }
    let sorted = sort_names_by_connectivity(&names, stats, prior_delay_ms);
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

fn apply_manual_connectivity_proxy_order_inner(mut config: Mapping) -> Mapping {
    let stats = load_weighted_connectivity_stats();
    let prior_delay_ms = compute_prior_effective_delay_ms(&stats);

    if let Some(Value::Sequence(proxies)) = config.get_mut("proxies") {
        sort_proxy_mappings(proxies, &stats, prior_delay_ms);
    }

    if let Some(Value::Sequence(groups)) = config.get_mut("proxy-groups") {
        for group in groups {
            let Some(group_map) = group.as_mapping_mut() else {
                continue;
            };
            if let Some(Value::Sequence(list)) = group_map.get_mut("proxies") {
                sort_group_proxies_list(list, &stats, prior_delay_ms);
            }
        }
    }

    config
}

/// Reorder every proxy group after the user explicitly completes a delay test.
/// This affects only the generated runtime YAML, never the source profile.
pub fn apply_manual_connectivity_proxy_order(config: Mapping) -> Mapping {
    apply_manual_connectivity_proxy_order_inner(config)
}

/// 前端同步联通统计 JSON 到数据目录（不触发 reload）。
pub fn write_connectivity_stats_file(raw_json: &str) -> Result<(), String> {
    let home = dirs::app_home_dir().map_err(|e| e.to_string())?;
    with_connectivity_stats_lock(&home, || {
        let path = home.join(STATS_FILE);
        let tmp = home.join(format!("{STATS_FILE}.tmp"));
        std::fs::write(&tmp, raw_json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    })
}

/// 读取数据目录中的联通统计 JSON（核心 URLTest 也会写入同一文件）。
pub fn read_connectivity_stats_file() -> Result<String, String> {
    let home = dirs::app_home_dir().map_err(|e| e.to_string())?;
    with_connectivity_stats_lock(&home, || {
        let path = home.join(STATS_FILE);
        match std::fs::read_to_string(&path) {
            Ok(raw) => Ok(raw),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok(r#"{"v":2,"data":{}}"#.to_string())
            }
            Err(err) => Err(err.to_string()),
        }
    })
}

fn with_connectivity_stats_lock<T>(
    home: &PathBuf,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use fs2::FileExt;
    use std::fs::OpenOptions;
    use std::time::{Duration, Instant};

    let lock_path = home.join(format!("{STATS_FILE}.lock"));
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(&lock_path)
            .map_err(|e| e.to_string())?;
        match file.try_lock_exclusive() {
            Ok(()) => {
                let result = f();
                let _ = file.unlock();
                return result;
            }
            Err(_) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => {
                // 超时降级：避免 UI 永久卡住
                return f();
            }
        }
    }
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
    fn failure_penalty_raises_avg_delay() {
        let prior = 400.0;
        let mostly_fast = penalized_delay_score(
            WeightedStats {
                success: 10.0,
                failure: 0.0,
                delay_sum: 10.0 * 200.0,
            },
            prior,
        );
        let with_failure = penalized_delay_score(
            WeightedStats {
                success: 10.0,
                failure: 1.0,
                delay_sum: 10.0 * 200.0 + 5000.0,
            },
            prior,
        );
        assert!(mostly_fast > with_failure);
    }

    #[test]
    fn sort_names_by_penalized_delay_desc() {
        let names = vec![
            "node-low".into(),
            "node-high".into(),
            "node-untested".into(),
        ];
        let mut stats = HashMap::new();
        stats.insert(
            "node-low".into(),
            WeightedStats {
                success: 2.0,
                failure: 8.0,
                delay_sum: 2.0 * 200.0 + 8.0 * 5000.0,
            },
        );
        stats.insert(
            "node-high".into(),
            WeightedStats {
                success: 45.0,
                failure: 2.0,
                delay_sum: 45.0 * 200.0 + 2.0 * 5000.0,
            },
        );
        let prior = compute_prior_effective_delay_ms(&stats);
        let sorted = sort_names_by_connectivity(&names, &stats, prior);
        assert_eq!(sorted[0], "node-high");
        assert_eq!(sorted[1], "node-untested");
        assert_eq!(sorted[2], "node-low");
    }

    #[test]
    fn smoothed_avg_uses_prior_for_small_sample() {
        let avg = smoothed_effective_avg_delay(
            WeightedStats {
                success: 1.0,
                failure: 0.0,
                delay_sum: 100.0,
            },
            400.0,
        );
        assert!(avg > 100.0);
        assert!(avg < 400.0);
    }

    #[test]
    fn older_day_counts_less_than_today() {
        let today = NaiveDate::from_ymd_opt(2026, 7, 5).unwrap();
        let mut days = HashMap::new();
        days.insert(
            "2026-07-05".into(),
            DayCounts {
                s: 10,
                f: 0,
                ds: 3000,
            },
        );
        days.insert(
            "2026-07-02".into(),
            DayCounts {
                s: 10,
                f: 0,
                ds: 3000,
            },
        );
        let weighted = sum_weighted_days(&days, today);
        assert!(weighted.success > 10.0);
        assert!(weighted.success < 20.0);
    }

}
