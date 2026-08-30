use crate::{
    config::Config, core::backup::WebDavClient, enhance::connectivity_order,
    utils::{dirs, help},
};
use anyhow::{Context, Error};
use clash_verge_logging::{Type, logging};
use chrono::{Duration, Local, NaiveDate, Utc};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, io::Write as _, path::PathBuf};

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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct StatsFile {
    v: u8,
    #[serde(default)]
    data: StatsData,
    #[serde(default, rename = "_sync", skip_serializing_if = "Option::is_none")]
    sync: Option<LocalSyncMetadata>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSyncMetadata {
    #[serde(default)]
    last_others: StatsData,
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

struct LocalMergeOutcome {
    own: StatsData,
    merged: StatsData,
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
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(&serde_json::to_vec(state)?)?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, path)?;
    Ok(())
}

fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn parse_local_stats_file(raw: &str) -> Result<StatsFile, Error> {
    let mut file: StatsFile = serde_json::from_str(raw).context("invalid local statistics")?;
    if file.v != STORE_VERSION {
        return Err(Error::msg("unsupported local statistics version"));
    }
    prune(&mut file.data);
    if let Some(sync) = file.sync.as_mut() {
        prune(&mut sync.last_others);
    }
    Ok(file)
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

fn prepare_local_merge(
    current_raw: &str,
    fallback_others: &StatsData,
    remote_others: &StatsData,
) -> Result<(String, LocalMergeOutcome), Error> {
    let current = parse_local_stats_file(current_raw)?;
    let baseline = current
        .sync
        .as_ref()
        .map(|sync| &sync.last_others)
        .unwrap_or(fallback_others);
    let mut own = subtract(&current.data, baseline);
    prune(&mut own);
    let mut merged = own.clone();
    add_into(&mut merged, remote_others);
    prune(&mut merged);

    let replacement = StatsFile {
        v: STORE_VERSION,
        data: merged.clone(),
        sync: Some(LocalSyncMetadata {
            last_others: remote_others.clone(),
        }),
    };
    Ok((
        serde_json::to_string(&replacement)?,
        LocalMergeOutcome { own, merged },
    ))
}

fn snapshot_filename(device_id: &str) -> String {
    format!("{device_id}.json")
}

fn filename_from_href(href: &str) -> Option<String> {
    let decoded = help::get_last_part_and_decode(href.trim_end_matches('/'))?;
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

fn snapshot_matches(snapshot: &DeviceSnapshot, device_id: &str) -> bool {
    snapshot.v == PROTOCOL_VERSION && snapshot.device_id == device_id
}

fn listed_device_ids<'a>(hrefs: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut listed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for href in hrefs {
        let Some(filename) = filename_from_href(href) else {
            continue;
        };
        let Some(device_id) = filename.strip_suffix(".json") else {
            continue;
        };
        if !valid_device_id(device_id) || !seen.insert(device_id.to_string()) {
            continue;
        }
        listed.push(device_id.to_string());
    }
    listed
}

fn device_limit_exceeded(listed_ids: &[String], own_device_id: &str) -> bool {
    if listed_ids.len() > MAX_REMOTE_DEVICES {
        return true;
    }
    !listed_ids.iter().any(|id| id == own_device_id) && listed_ids.len() >= MAX_REMOTE_DEVICES
}

async fn require_https_webdav() -> Result<(), Error> {
    let url = Config::verge()
        .await
        .data_arc()
        .webdav_url
        .clone()
        .unwrap_or_default();
    if !url.trim().to_ascii_lowercase().starts_with("https://") {
        return Err(Error::msg("WebDAV URL must be https"));
    }
    Ok(())
}

pub async fn last_connectivity_sync_at() -> Result<i64, Error> {
    let _guard = sync_lock().lock().await;
    Ok(load_state()?.last_sync_at)
}

pub async fn merge_connectivity_statistics() -> Result<ConnectivitySyncResult, Error> {
    let _guard = sync_lock().lock().await;
    require_https_webdav().await?;
    let client = WebDavClient::global();
    client.ensure_collection(REMOTE_ROOT).await?;
    client.ensure_collection(REMOTE_VERSION_DIR).await?;
    client.ensure_collection(REMOTE_DEVICES_DIR).await?;

    let mut state = load_state()?;
    let mut files = client.list_files_at(REMOTE_DEVICES_DIR).await?;
    files.sort_by(|a, b| a.href.cmp(&b.href));
    let listed_ids = listed_device_ids(files.iter().map(|file| file.href.as_str()));
    if device_limit_exceeded(&listed_ids, &state.device_id) {
        return Err(Error::msg("Too many connectivity sync devices"));
    }

    let mut remote_others = StatsData::new();
    let mut seen_devices = std::collections::HashSet::new();
    for device_id in listed_ids {
        let path = format!("{REMOTE_DEVICES_DIR}/{}", snapshot_filename(&device_id));
        let bytes = match client.get_bytes(&path, MAX_SNAPSHOT_BYTES).await {
            Ok(bytes) => bytes,
            Err(error) => {
                logging!(
                    info,
                    Type::Network,
                    "Skipping connectivity snapshot {device_id}: {error}"
                );
                continue;
            }
        };
        let mut snapshot = match serde_json::from_slice::<DeviceSnapshot>(&bytes) {
            Ok(snapshot) if snapshot_matches(&snapshot, &device_id) => snapshot,
            Ok(_) => {
                logging!(
                    info,
                    Type::Network,
                    "Skipping connectivity snapshot {device_id}: identity mismatch"
                );
                continue;
            }
            Err(error) => {
                logging!(
                    info,
                    Type::Network,
                    "Skipping connectivity snapshot {device_id}: {error}"
                );
                continue;
            }
        };
        seen_devices.insert(device_id.clone());
        prune(&mut snapshot.data);
        if device_id != state.device_id {
            add_into(&mut remote_others, &snapshot.data);
        }
    }

    seen_devices.insert(state.device_id.clone());
    prune(&mut remote_others);
    let fallback_others = state.last_others.clone();
    let transaction_others = remote_others.clone();
    let local_merge = connectivity_order::transact_connectivity_stats_file(|current_raw| {
        let (replacement, outcome) = prepare_local_merge(
            current_raw,
            &fallback_others,
            &transaction_others,
        )
        .map_err(|error| error.to_string())?;
        Ok((replacement, outcome))
    })
    .map_err(Error::msg)?;
    let now = Utc::now().timestamp_millis();

    state.last_others = remote_others;
    state.last_sync_at = now;
    save_state(&state)?;

    let own_snapshot = DeviceSnapshot {
        v: PROTOCOL_VERSION,
        device_id: state.device_id.clone(),
        updated_at: now,
        data: local_merge.own,
    };
    let own_path = format!(
        "{REMOTE_DEVICES_DIR}/{}",
        snapshot_filename(&state.device_id)
    );
    client
        .put_bytes(&own_path, serde_json::to_vec(&own_snapshot)?)
        .await
        .unwrap_or_else(|error| {
            logging!(
                info,
                Type::Network,
                "Connectivity snapshot upload will retry on the next merge: {error}"
            );
        });

    Ok(ConnectivitySyncResult {
        device_count: seen_devices.len().max(1),
        proxy_count: local_merge.merged.len(),
        last_sync_at: now,
    })
}

pub async fn reset_connectivity_sync_baseline(proxy_name: Option<&str>) -> Result<(), Error> {
    let _guard = sync_lock().lock().await;
    let mut state = load_state()?;
    let fallback_others = state.last_others.clone();
    connectivity_order::transact_connectivity_stats_file(|current_raw| {
        let mut current = parse_local_stats_file(current_raw).map_err(|error| error.to_string())?;
        let sync = current.sync.get_or_insert_with(|| LocalSyncMetadata {
            last_others: fallback_others,
        });
        if let Some(name) = proxy_name.filter(|name| !name.is_empty()) {
            sync.last_others.remove(name);
        } else {
            sync.last_others.clear();
        }
        let replacement = serde_json::to_string(&current).map_err(|error| error.to_string())?;
        Ok((replacement, ()))
    })
    .map_err(Error::msg)?;
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

    #[test]
    fn rejects_identity_mismatch_snapshots() {
        let snapshot = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "alpha".into(),
            updated_at: 1,
            data: StatsData::new(),
        };
        assert!(snapshot_matches(&snapshot, "alpha"));
        assert!(!snapshot_matches(&snapshot, "beta"));
    }

    #[test]
    fn device_limit_counts_this_installation_before_upload() {
        let listed: Vec<String> = (0..MAX_REMOTE_DEVICES)
            .map(|index| format!("device-{index}"))
            .collect();
        assert!(device_limit_exceeded(&listed, "new-device"));
        assert!(!device_limit_exceeded(&listed, "device-0"));
    }

    #[test]
    fn lists_unique_valid_device_files() {
        let listed = listed_device_ids([
            "/clash-connectivity-sync/v1/devices/alpha.json",
            "/clash-connectivity-sync/v1/devices/alpha.json",
            "/clash-connectivity-sync/v1/devices/bad.name.json",
            "/clash-connectivity-sync/v1/devices/gamma%2D2.json",
            "/clash-connectivity-sync/v1/devices/beta.json",
        ]);
        assert_eq!(
            listed,
            vec!["alpha".into(), "gamma-2".into(), "beta".into()]
        );
    }

    #[test]
    fn local_merge_uses_latest_counters_and_persists_the_baseline() {
        let current = StatsFile {
            v: STORE_VERSION,
            data: data(9, 3),
            sync: None,
        };
        let fallback = data(5, 1);
        let remote = data(5, 1);
        let (replacement, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &fallback,
            &remote,
        )
        .unwrap();
        let day = Local::now().format("%Y-%m-%d").to_string();

        assert_eq!(count_at(&outcome.own, "node", &day).s, 4);
        assert_eq!(count_at(&outcome.merged, "node", &day).s, 9);
        let stored = parse_local_stats_file(&replacement).unwrap();
        assert_eq!(stored.sync.unwrap().last_others, remote);
    }

    #[test]
    fn retry_uses_embedded_baseline_instead_of_stale_side_state() {
        let current = StatsFile {
            v: STORE_VERSION,
            data: data(8, 3),
            sync: Some(LocalSyncMetadata {
                last_others: data(5, 1),
            }),
        };
        let stale_fallback = StatsData::new();
        let remote = data(5, 1);
        let (_, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &stale_fallback,
            &remote,
        )
        .unwrap();
        let day = Local::now().format("%Y-%m-%d").to_string();

        assert_eq!(count_at(&outcome.own, "node", &day).s, 3);
        assert_eq!(count_at(&outcome.merged, "node", &day).s, 8);
    }
}
