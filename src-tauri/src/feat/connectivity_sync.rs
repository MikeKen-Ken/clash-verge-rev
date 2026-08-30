use crate::{core::backup::WebDavClient, enhance::connectivity_order, utils::dirs};
use anyhow::{Context, Error};
use chrono::{Duration, Local, NaiveDate, Utc};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};

const PROTOCOL_VERSION: u8 = 1;
const STORE_VERSION: u8 = 2;
const RETENTION_DAYS: i64 = 30;
const MAX_REMOTE_DEVICES: usize = 128;
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
const REMOTE_ROOT: &str = "clash-connectivity-sync";
const REMOTE_VERSION_DIR: &str = "clash-connectivity-sync/v1";
const REMOTE_DEVICES_DIR: &str = "clash-connectivity-sync/v1/devices";
const LOCAL_STATE_FILE: &str = "connectivity-sync-state.json";

fn sync_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceCell<tokio::sync::Mutex<()>> = OnceCell::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct DayCounts {
    #[serde(default)]
    s: u64,
    #[serde(default)]
    f: u64,
    #[serde(default, skip_serializing_if = "is_zero")]
    ds: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct ProxyEntry {
    #[serde(default)]
    days: HashMap<String, DayCounts>,
}

type StatsData = HashMap<String, ProxyEntry>;

#[derive(Debug, Default, Deserialize, Serialize)]
struct StatsFile {
    v: u8,
    #[serde(default)]
    data: StatsData,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSnapshot {
    v: u8,
    device_id: String,
    updated_at: i64,
    #[serde(default)]
    data: StatsData,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    v: u8,
    device_id: String,
    #[serde(default)]
    last_others: StatsData,
    #[serde(default)]
    last_sync_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivitySyncResult {
    pub device_count: usize,
    pub proxy_count: usize,
    pub last_sync_at: i64,
}

fn state_path() -> Result<PathBuf, Error> {
    Ok(dirs::app_home_dir()?.join(LOCAL_STATE_FILE))
}

fn load_state() -> Result<SyncState, Error> {
    let path = state_path()?;
    let mut state = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SyncState>(&raw).ok())
        .filter(|state| state.v == PROTOCOL_VERSION && valid_device_id(&state.device_id))
        .unwrap_or_else(|| SyncState {
            v: PROTOCOL_VERSION,
            device_id: nanoid::nanoid!(24),
            ..SyncState::default()
        });
    prune(&mut state.last_others);
    Ok(state)
}

fn save_state(state: &SyncState) -> Result<(), Error> {
    let path = state_path()?;
    fs::write(path, serde_json::to_vec(state)?)?;
    Ok(())
}

fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn parse_local_stats(raw: &str) -> Result<StatsData, Error> {
    let mut file: StatsFile = serde_json::from_str(raw).context("invalid local statistics")?;
    if file.v != STORE_VERSION {
        return Err(Error::msg("unsupported local statistics version"));
    }
    prune(&mut file.data);
    Ok(file.data)
}

fn prune(data: &mut StatsData) {
    let today = Local::now().date_naive();
    let cutoff = today - Duration::days(RETENTION_DAYS - 1);
    data.retain(|_, entry| {
        entry.days.retain(|day, counts| {
            let Ok(parsed) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else {
                return false;
            };
            parsed >= cutoff
                && parsed <= today
                && (counts.s > 0 || counts.f > 0 || counts.ds > 0)
        });
        !entry.days.is_empty()
    });
}

fn count_at(data: &StatsData, proxy: &str, day: &str) -> DayCounts {
    data.get(proxy)
        .and_then(|entry| entry.days.get(day))
        .copied()
        .unwrap_or_default()
}

fn subtract(current: &StatsData, imported: &StatsData) -> StatsData {
    let mut result = StatsData::new();
    for (proxy, entry) in current {
        let mut days = HashMap::new();
        for (day, counts) in &entry.days {
            let previous = count_at(imported, proxy, day);
            let own = DayCounts {
                s: counts.s.saturating_sub(previous.s),
                f: counts.f.saturating_sub(previous.f),
                ds: counts.ds.saturating_sub(previous.ds),
            };
            if own.s > 0 || own.f > 0 || own.ds > 0 {
                days.insert(day.clone(), own);
            }
        }
        if !days.is_empty() {
            result.insert(proxy.clone(), ProxyEntry { days });
        }
    }
    result
}

fn add_into(target: &mut StatsData, source: &StatsData) {
    for (proxy, entry) in source {
        let target_entry = target.entry(proxy.clone()).or_default();
        for (day, counts) in &entry.days {
            let total = target_entry.days.entry(day.clone()).or_default();
            total.s = total.s.saturating_add(counts.s).min(MAX_SAFE_COUNT);
            total.f = total.f.saturating_add(counts.f).min(MAX_SAFE_COUNT);
            total.ds = total.ds.saturating_add(counts.ds).min(MAX_SAFE_COUNT);
        }
    }
}

fn snapshot_filename(device_id: &str) -> String {
    format!("{device_id}.json")
}

fn filename_from_href(href: &str) -> Option<&str> {
    href.trim_end_matches('/').rsplit('/').next()
}

pub async fn merge_connectivity_statistics() -> Result<ConnectivitySyncResult, Error> {
    let _guard = sync_lock().lock().await;
    let client = WebDavClient::global();
    client.ensure_collection(REMOTE_ROOT).await?;
    client.ensure_collection(REMOTE_VERSION_DIR).await?;
    client.ensure_collection(REMOTE_DEVICES_DIR).await?;

    let mut state = load_state()?;
    let current_raw = connectivity_order::read_connectivity_stats_file().map_err(Error::msg)?;
    let current = parse_local_stats(&current_raw)?;
    let mut own = subtract(&current, &state.last_others);
    prune(&mut own);

    let now = Utc::now().timestamp_millis();
    let own_snapshot = DeviceSnapshot {
        v: PROTOCOL_VERSION,
        device_id: state.device_id.clone(),
        updated_at: now,
        data: own.clone(),
    };
    let own_path = format!(
        "{REMOTE_DEVICES_DIR}/{}",
        snapshot_filename(&state.device_id)
    );
    client
        .put_bytes(&own_path, serde_json::to_vec(&own_snapshot)?)
        .await?;

    let mut files = client.list_files_at(REMOTE_DEVICES_DIR).await?;
    files.sort_by(|a, b| a.href.cmp(&b.href));
    let valid_file_count = files
        .iter()
        .filter_map(|file| filename_from_href(file.href.as_str()))
        .filter_map(|filename| filename.strip_suffix(".json"))
        .filter(|device_id| valid_device_id(device_id))
        .count();
    if valid_file_count > MAX_REMOTE_DEVICES {
        return Err(Error::msg("Too many connectivity sync devices"));
    }

    let mut merged = StatsData::new();
    let mut others = StatsData::new();
    let mut seen_devices = std::collections::HashSet::new();
    for file in files {
        let Some(filename) = filename_from_href(file.href.as_str()) else {
            continue;
        };
        let Some(device_id) = filename.strip_suffix(".json") else {
            continue;
        };
        if !valid_device_id(device_id) || seen_devices.contains(device_id) {
            continue;
        }
        let path = format!("{REMOTE_DEVICES_DIR}/{filename}");
        let bytes = client.get_bytes(&path, MAX_SNAPSHOT_BYTES).await?;
        let mut snapshot = serde_json::from_slice::<DeviceSnapshot>(&bytes)
            .context("invalid connectivity device snapshot")?;
        if snapshot.v != PROTOCOL_VERSION || snapshot.device_id != device_id {
            return Err(Error::msg("connectivity snapshot identity mismatch"));
        }
        seen_devices.insert(device_id.to_string());
        prune(&mut snapshot.data);
        add_into(&mut merged, &snapshot.data);
        if device_id != state.device_id {
            add_into(&mut others, &snapshot.data);
        }
    }

    if !seen_devices.contains(&state.device_id) {
        add_into(&mut merged, &own);
    }
    prune(&mut merged);
    prune(&mut others);
    let local_payload = StatsFile {
        v: STORE_VERSION,
        data: merged.clone(),
    };
    connectivity_order::write_connectivity_stats_file(&serde_json::to_string(&local_payload)?)
        .map_err(Error::msg)?;

    state.last_others = others;
    state.last_sync_at = now;
    save_state(&state)?;

    Ok(ConnectivitySyncResult {
        device_count: seen_devices.len().max(1),
        proxy_count: merged.len(),
        last_sync_at: now,
    })
}

pub async fn reset_connectivity_sync_baseline(proxy_name: Option<&str>) -> Result<(), Error> {
    let _guard = sync_lock().lock().await;
    let mut state = load_state()?;
    if let Some(name) = proxy_name.filter(|name| !name.is_empty()) {
        state.last_others.remove(name);
    } else {
        state.last_others.clear();
    }
    save_state(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(success: u64, failure: u64) -> StatsData {
        HashMap::from([(
            "node".to_string(),
            ProxyEntry {
                days: HashMap::from([(
                    Local::now().format("%Y-%m-%d").to_string(),
                    DayCounts {
                        s: success,
                        f: failure,
                        ds: 100,
                    },
                )]),
            },
        )])
    }

    #[test]
    fn derives_only_the_local_contribution_after_a_previous_merge() {
        let current = data(8, 3);
        let others = data(5, 1);
        let own = subtract(&current, &others);
        let counts = count_at(
            &own,
            "node",
            &Local::now().format("%Y-%m-%d").to_string(),
        );
        assert_eq!((counts.s, counts.f), (3, 2));
    }

    #[test]
    fn repeated_device_snapshots_are_added_once_by_the_caller() {
        let mut merged = StatsData::new();
        add_into(&mut merged, &data(3, 1));
        add_into(&mut merged, &data(5, 2));
        let counts = count_at(
            &merged,
            "node",
            &Local::now().format("%Y-%m-%d").to_string(),
        );
        assert_eq!((counts.s, counts.f), (8, 3));
    }
}
