use crate::{
    config::Config, core::backup::WebDavClient, enhance::connectivity_order,
    utils::dirs,
};
use anyhow::{Context, Error};
use clash_verge_logging::{Type, logging};
use chrono::{Duration, Local, NaiveDate, Utc};
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write as _,
    path::PathBuf,
};

mod protocol;
mod status;
use protocol::*;
pub use status::{current as connectivity_merge_status, ConnectivityMergeStatus, PulledDevice};

const PROTOCOL_VERSION: u8 = 2;
const STORE_VERSION: u8 = 2;
const RETENTION_DAYS: i64 = 30;
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
const REMOTE_ROOT: &str = "clash-connectivity-sync";
const REMOTE_VERSION_DIR: &str = "clash-connectivity-sync/v2";
const REMOTE_DEVICES_DIR: &str = "clash-connectivity-sync/v2/devices";
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

fn is_zero_i64(value: &i64) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct ProxyEntry {
    #[serde(default)]
    days: HashMap<String, DayCounts>,
    #[serde(default, skip_serializing_if = "is_zero_i64")]
    ls: i64,
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
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    reset_watermarks: ResetWatermarks,
    #[serde(default, skip_serializing_if = "clear_all_absent")]
    clear_all: ResetGeneration,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    v: u8,
    device_id: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    last_others: StatsData,
    #[serde(default)]
    resets: ResetWatermarks,
    #[serde(default, skip_serializing_if = "clear_all_absent")]
    clear_all: ResetGeneration,
    #[serde(default)]
    last_sync_at: i64,
}

struct LocalMergeOutcome {
    own: StatsData,
    merged: StatsData,
    resets: ResetWatermarks,
    clear_all: ResetGeneration,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivitySyncResult {
    pub device_count: usize,
    pub proxy_count: usize,
    pub last_sync_at: i64,
    pub pulled: Vec<PulledDevice>,
    pub skipped: Vec<String>,
}

fn device_label(name: &str, device_id: &str) -> String {
    if name.trim().is_empty() {
        format!("Device {}", device_id.chars().take(6).collect::<String>())
    } else {
        name.trim().to_string()
    }
}

fn local_device_name() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_default();
    let os = match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        other => other,
    };
    if host.trim().is_empty() {
        format!("{os} desktop")
    } else {
        format!("{os} {}", host.trim())
    }
}

fn state_path() -> Result<PathBuf, Error> {
    Ok(dirs::app_home_dir()?.join(LOCAL_STATE_FILE))
}

fn load_state() -> Result<SyncState, Error> {
    let path = state_path()?;
    let mut state = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<SyncState>(&raw).ok())
        .filter(|state| {
            (state.v == 1 || state.v == PROTOCOL_VERSION) && valid_device_id(&state.device_id)
        })
        .unwrap_or_else(|| SyncState {
            v: PROTOCOL_VERSION,
            device_id: nanoid::nanoid!(24),
            ..SyncState::default()
        });
    state.v = PROTOCOL_VERSION;
    prune(&mut state.last_others);
    state.resets = sanitize_reset_watermarks(&state.resets)?;
    state.clear_all = sanitize_clear_all(&state.clear_all)?;
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

fn parse_local_stats_file(raw: &str) -> Result<StatsFile, Error> {
    let mut file: StatsFile = serde_json::from_str(raw).context("invalid local statistics")?;
    if file.v != STORE_VERSION {
        return Err(Error::msg("unsupported local statistics version"));
    }
    prune(&mut file.data);
    if let Some(sync) = file.sync.as_mut() {
        prune(&mut sync.last_others);
        sync.reset_watermarks = sanitize_reset_watermarks(&sync.reset_watermarks)?;
        sync.clear_all = sanitize_clear_all(&sync.clear_all)?;
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
            result.insert(
                proxy.clone(),
                ProxyEntry {
                    days,
                    ls: entry.ls.max(0),
                },
            );
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
        target_entry.ls = target_entry.ls.max(0).max(entry.ls.max(0));
    }
}

fn prepare_local_merge(
    current_raw: &str,
    fallback_others: &StatsData,
    remote_others: &StatsData,
    active_resets: &ResetWatermarks,
    active_clear_all: &ResetGeneration,
) -> Result<(String, LocalMergeOutcome), Error> {
    let mut current = parse_local_stats_file(current_raw)?;
    let embedded_resets = current
        .sync
        .as_ref()
        .map(|sync| sync.reset_watermarks.clone())
        .unwrap_or_default();
    let embedded_clear_all = current
        .sync
        .as_ref()
        .map(|sync| sync.clear_all.clone())
        .unwrap_or_default();
    let active_resets = merge_reset_watermarks([&embedded_resets, active_resets])?;
    let active_clear_all = merge_clear_all([&embedded_clear_all, active_clear_all])?;
    let mut baseline = current
        .sync
        .as_ref()
        .map(|sync| sync.last_others.clone())
        .unwrap_or_else(|| fallback_others.clone());
    if active_clear_all > embedded_clear_all {
        current.data.clear();
        baseline.clear();
    }
    for (name, generation) in &active_resets {
        if embedded_resets
            .get(name)
            .map_or(true, |previous| generation > previous)
        {
            current.data.remove(name);
            baseline.remove(name);
        }
    }
    let mut own = subtract(&current.data, &baseline);
    prune(&mut own);
    let mut merged = own.clone();
    add_into(&mut merged, remote_others);
    prune(&mut merged);

    let replacement = StatsFile {
        v: STORE_VERSION,
        data: merged.clone(),
        sync: Some(LocalSyncMetadata {
            last_others: remote_others.clone(),
            reset_watermarks: active_resets.clone(),
            clear_all: active_clear_all.clone(),
        }),
    };
    Ok((
        serde_json::to_string(&replacement)?,
        LocalMergeOutcome {
            own,
            merged,
            resets: active_resets,
            clear_all: active_clear_all,
        },
    ))
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
    status::begin();
    let result = merge_locked().await;
    status::finish(match &result {
        Ok(result) => Ok((result.pulled.clone(), result.skipped.clone())),
        Err(error) => Err(error.to_string()),
    });
    result
}

async fn merge_locked() -> Result<ConnectivitySyncResult, Error> {
    require_https_webdav().await?;
    let client = WebDavClient::global();
    client.ensure_collection(REMOTE_ROOT).await?;
    client.ensure_collection(REMOTE_VERSION_DIR).await?;
    client.ensure_collection(REMOTE_DEVICES_DIR).await?;
    status::progress(10);

    let mut state = load_state()?;
    let mut files = client.list_files_at(REMOTE_DEVICES_DIR).await?;
    files.sort_by(|a, b| a.href.cmp(&b.href));
    let listed = listed_snapshot_refs(files.iter().map(|file| file.href.as_str()));
    if device_limit_exceeded(&listed, &state.device_id) {
        return Err(Error::msg("Too many connectivity sync devices"));
    }
    status::progress(20);

    let mut references_by_device: HashMap<String, Vec<RemoteSnapshotRef>> = HashMap::new();
    for reference in listed {
        references_by_device
            .entry(reference.device_id.clone())
            .or_default()
            .push(reference);
    }

    let mut newest_by_device: HashMap<String, DeviceSnapshot> = HashMap::new();
    let mut skipped = Vec::new();
    let device_total = references_by_device.len().max(1);
    for (index, (device_id, references)) in references_by_device.into_iter().enumerate() {
        let mut candidates = Vec::with_capacity(references.len());
        let mut skip_reason = None;
        for reference in references {
            let path = format!(
                "{REMOTE_DEVICES_DIR}/{}",
                snapshot_filename(&reference.device_id, reference.slot)
            );
            let bytes = match client.get_bytes(&path, MAX_SNAPSHOT_BYTES).await {
                Ok(bytes) => bytes,
                Err(error) => {
                    skip_reason = Some(format!("unreadable snapshot: {error}"));
                    candidates.push(None);
                    break;
                }
            };
            let mut snapshot = match serde_json::from_slice::<DeviceSnapshot>(&bytes) {
                Ok(snapshot) if snapshot_matches(&snapshot, &reference, PROTOCOL_VERSION) => {
                    snapshot
                }
                Ok(_) => {
                    skip_reason = Some("snapshot identity mismatch".to_string());
                    candidates.push(None);
                    break;
                }
                Err(error) => {
                    skip_reason = Some(format!("invalid snapshot: {error}"));
                    candidates.push(None);
                    break;
                }
            };
            prune(&mut snapshot.data);
            candidates.push(Some(snapshot));
        }
        if let Some(newest) = newest_complete_snapshot(candidates) {
            newest_by_device.insert(device_id, newest);
        } else {
            let reason = skip_reason.unwrap_or_else(|| "no complete snapshot".to_string());
            logging!(
                info,
                Type::Network,
                "Skipping connectivity device {device_id}: {reason}"
            );
            let label = if device_id == state.device_id {
                "This device".to_string()
            } else {
                device_label("", &device_id)
            };
            skipped.push(format!("{label}: {reason}"));
        }
        status::progress((20 + 50 * (index + 1) / device_total) as u8);
    }

    let local_raw = connectivity_order::read_connectivity_stats_file().map_err(Error::msg)?;
    let local_sync = parse_local_stats_file(&local_raw)?.sync.unwrap_or_default();
    let local_resets = local_sync.reset_watermarks;
    let local_clear_all = local_sync.clear_all;
    let active_resets = merge_reset_watermarks(
        [&state.resets, &local_resets]
            .into_iter()
            .chain(newest_by_device.values().map(|item| &item.resets)),
    )?;
    let active_clear_all = merge_clear_all(
        [&state.clear_all, &local_clear_all]
            .into_iter()
            .chain(newest_by_device.values().map(|item| &item.clear_all)),
    )?;
    let mut remote_others = StatsData::new();
    let mut pulled = Vec::new();
    for (device_id, snapshot) in &mut newest_by_device {
        retain_snapshot_for_clear_all(snapshot, &active_clear_all);
        filter_snapshot_data(snapshot, &active_resets);
        if device_id != &state.device_id {
            add_into(&mut remote_others, &snapshot.data);
            pulled.push(PulledDevice {
                device: device_label(&snapshot.device_name, device_id),
                updated_at: snapshot.updated_at,
                proxy_count: snapshot.data.len(),
            });
        }
    }
    pulled.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    prune(&mut remote_others);
    let fallback_others = state.last_others.clone();
    let transaction_others = remote_others.clone();
    let transaction_resets = active_resets.clone();
    let transaction_clear_all = active_clear_all.clone();
    let local_merge = connectivity_order::transact_connectivity_stats_file(|current_raw| {
        let (replacement, outcome) = prepare_local_merge(
            current_raw,
            &fallback_others,
            &transaction_others,
            &transaction_resets,
            &transaction_clear_all,
        )
        .map_err(|error| error.to_string())?;
        Ok((replacement, outcome))
    })
    .map_err(Error::msg)?;
    let now = Utc::now().timestamp_millis();
    status::progress(80);

    // Keep reset filtering monotonic across an upload failure without marking
    // the merge successful or committing its revision/imported baseline.
    state.resets = local_merge.resets.clone();
    state.clear_all = local_merge.clear_all.clone();
    save_state(&state)?;

    let own_remote_revision = newest_by_device
        .get(&state.device_id)
        .map(|snapshot| snapshot.revision)
        .unwrap_or_default();
    let revision = state.revision.max(own_remote_revision).saturating_add(1);
    if revision > MAX_SAFE_COUNT {
        return Err(Error::msg("connectivity snapshot revision overflow"));
    }
    let slot = (revision % SNAPSHOT_SLOT_COUNT as u64) as u8;

    let own_snapshot = DeviceSnapshot {
        v: PROTOCOL_VERSION,
        device_id: state.device_id.clone(),
        revision,
        slot,
        updated_at: now,
        resets: local_merge.resets.clone(),
        generations: generations_for(&local_merge.own, &local_merge.resets),
        data: local_merge.own,
        clear_all: local_merge.clear_all.clone(),
        device_name: local_device_name(),
    };
    let own_path = format!(
        "{REMOTE_DEVICES_DIR}/{}",
        snapshot_filename(&state.device_id, slot)
    );
    client
        .put_bytes(&own_path, serde_json::to_vec(&own_snapshot)?)
        .await?;

    state.revision = revision;
    state.last_others = remote_others;
    state.resets = local_merge.resets;
    state.clear_all = local_merge.clear_all;
    state.last_sync_at = now;
    save_state(&state)?;

    Ok(ConnectivitySyncResult {
        device_count: newest_by_device.len().max(1),
        proxy_count: local_merge.merged.len(),
        last_sync_at: now,
        pulled,
        skipped,
    })
}

pub async fn reset_connectivity_statistics(proxy_name: Option<&str>) -> Result<(), Error> {
    let _guard = sync_lock().lock().await;
    let mut state = load_state()?;
    let fallback_others = state.last_others.clone();
    let device_id = state.device_id.clone();
    let state_resets = state.resets.clone();
    let state_clear_all = state.clear_all.clone();
    let selected_name = proxy_name.filter(|name| !name.is_empty()).map(str::to_string);
    let (next_others, next_resets, next_clear_all) =
        connectivity_order::transact_connectivity_stats_file(|current_raw| {
            let mut current =
                parse_local_stats_file(current_raw).map_err(|error| error.to_string())?;
            let embedded = current.sync.take().unwrap_or_else(|| LocalSyncMetadata {
                last_others: fallback_others.clone(),
                reset_watermarks: ResetWatermarks::new(),
                clear_all: ResetGeneration::default(),
            });
            let active = merge_reset_watermarks([&state_resets, &embedded.reset_watermarks])
                .map_err(|error| error.to_string())?;
            let base_clear_all = merge_clear_all([&state_clear_all, &embedded.clear_all])
                .map_err(|error| error.to_string())?;
            let (resets, clear_all, last_others) = if let Some(name) = selected_name.clone() {
                let resets = advance_reset_watermarks(&active, [name.clone()], &device_id)
                    .map_err(|error| error.to_string())?;
                let mut last_others = embedded.last_others;
                current.data.remove(&name);
                last_others.remove(&name);
                (resets, base_clear_all, last_others)
            } else {
                let clear_all = advance_clear_all(&base_clear_all, &device_id)
                    .map_err(|error| error.to_string())?;
                current.data.clear();
                (active, clear_all, StatsData::new())
            };
            current.sync = Some(LocalSyncMetadata {
                last_others: last_others.clone(),
                reset_watermarks: resets.clone(),
                clear_all: clear_all.clone(),
            });
            let replacement =
                serde_json::to_string(&current).map_err(|error| error.to_string())?;
            Ok((replacement, (last_others, resets, clear_all)))
        })
        .map_err(Error::msg)?;
    state.last_others = next_others;
    state.resets = next_resets;
    state.clear_all = next_clear_all;
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
                ls: 0,
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
    fn merge_keeps_the_latest_last_success_time() {
        let mut left = data(3, 1);
        left.get_mut("node").unwrap().ls = 100;
        let mut right = data(5, 2);
        right.get_mut("node").unwrap().ls = 250;
        let mut merged = StatsData::new();
        add_into(&mut merged, &left);
        add_into(&mut merged, &right);
        assert_eq!(merged["node"].ls, 250);
        let own = subtract(&right, &left);
        assert_eq!(own["node"].ls, 250);
    }

    #[test]
    fn rejects_identity_mismatch_snapshots() {
        let snapshot = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "alpha".into(),
            revision: 3,
            slot: 1,
            updated_at: 1,
            resets: ResetWatermarks::new(),
            generations: ResetWatermarks::new(),
            data: StatsData::new(),
            clear_all: ResetGeneration::default(),
            device_name: String::new(),
        };
        assert!(snapshot_matches(
            &snapshot,
            &RemoteSnapshotRef {
                device_id: "alpha".into(),
                slot: 1,
            },
            PROTOCOL_VERSION,
        ));
        assert!(!snapshot_matches(
            &snapshot,
            &RemoteSnapshotRef {
                device_id: "beta".into(),
                slot: 1,
            },
            PROTOCOL_VERSION,
        ));
    }

    #[test]
    fn device_limit_counts_this_installation_before_upload() {
        let listed: Vec<RemoteSnapshotRef> = (0..MAX_REMOTE_DEVICES)
            .map(|index| RemoteSnapshotRef {
                device_id: format!("device-{index}"),
                slot: 0,
            })
            .collect();
        assert!(device_limit_exceeded(&listed, "new-device"));
        assert!(!device_limit_exceeded(&listed, "device-0"));
    }

    #[test]
    fn lists_unique_valid_device_files() {
        let listed = listed_snapshot_refs([
            "/clash-connectivity-sync/v2/devices/alpha-0.json",
            "/clash-connectivity-sync/v2/devices/alpha-0.json",
            "/clash-connectivity-sync/v2/devices/bad.name-0.json",
            "/clash-connectivity-sync/v2/devices/gamma%2D2-1.json",
            "/clash-connectivity-sync/v2/devices/beta-2.json",
        ]);
        assert_eq!(
            listed,
            vec![
                RemoteSnapshotRef {
                    device_id: "alpha".into(),
                    slot: 0,
                },
                RemoteSnapshotRef {
                    device_id: "gamma-2".into(),
                    slot: 1,
                },
            ]
        );
    }

    #[test]
    fn incomplete_slot_set_is_rejected() {
        let valid = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "alpha".into(),
            revision: 2,
            slot: 0,
            updated_at: 1,
            resets: ResetWatermarks::new(),
            generations: ResetWatermarks::new(),
            data: StatsData::new(),
            clear_all: ResetGeneration::default(),
            device_name: String::new(),
        };

        assert!(newest_complete_snapshot(vec![Some(valid), None]).is_none());
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
            &ResetWatermarks::new(),
            &ResetGeneration::default(),
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
                reset_watermarks: ResetWatermarks::new(),
                clear_all: ResetGeneration::default(),
            }),
        };
        let stale_fallback = StatsData::new();
        let remote = data(5, 1);
        let (_, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &stale_fallback,
            &remote,
            &ResetWatermarks::new(),
            &ResetGeneration::default(),
        )
        .unwrap();
        let day = Local::now().format("%Y-%m-%d").to_string();

        assert_eq!(count_at(&outcome.own, "node", &day).s, 3);
        assert_eq!(count_at(&outcome.merged, "node", &day).s, 8);
    }

    #[test]
    fn newer_reset_removes_the_old_aggregate_and_baseline() {
        let current = StatsFile {
            v: STORE_VERSION,
            data: data(300, 0),
            sync: Some(LocalSyncMetadata {
                last_others: data(200, 0),
                reset_watermarks: ResetWatermarks::new(),
                clear_all: ResetGeneration::default(),
            }),
        };
        let resets = HashMap::from([(
            "node".to_string(),
            ResetGeneration {
                counter: 1,
                device_id: "device-b".into(),
            },
        )]);
        let (_, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &StatsData::new(),
            &StatsData::new(),
            &resets,
            &ResetGeneration::default(),
        )
        .unwrap();

        assert!(!outcome.own.contains_key("node"));
        assert!(!outcome.merged.contains_key("node"));
        assert_eq!(outcome.resets, resets);
    }

    #[test]
    fn retry_after_reset_preserves_post_reset_measurements() {
        let resets = HashMap::from([(
            "node".to_string(),
            ResetGeneration {
                counter: 1,
                device_id: "device-b".into(),
            },
        )]);
        let current = StatsFile {
            v: STORE_VERSION,
            data: data(3, 0),
            sync: Some(LocalSyncMetadata {
                last_others: StatsData::new(),
                reset_watermarks: resets.clone(),
                clear_all: ResetGeneration::default(),
            }),
        };
        let (_, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &StatsData::new(),
            &StatsData::new(),
            &resets,
            &ResetGeneration::default(),
        )
        .unwrap();

        let day = Local::now().format("%Y-%m-%d").to_string();
        assert_eq!(count_at(&outcome.own, "node", &day).s, 3);
    }

    #[test]
    fn global_reset_advances_reset_only_nodes() {
        let active = HashMap::from([(
            "reset-only".to_string(),
            ResetGeneration {
                counter: 1,
                device_id: "device-a".into(),
            },
        )]);

        let names = reset_names(None, &StatsData::new(), &StatsData::new(), &active);

        assert_eq!(names, vec!["reset-only"]);
    }

    #[test]
    fn concurrent_resets_use_counter_then_device_id_order() {
        let left = HashMap::from([(
            "node".to_string(),
            ResetGeneration {
                counter: 4,
                device_id: "device-a".into(),
            },
        )]);
        let right = HashMap::from([(
            "node".to_string(),
            ResetGeneration {
                counter: 4,
                device_id: "device-b".into(),
            },
        )]);
        let merged = merge_reset_watermarks([&left, &right]).unwrap();
        assert_eq!(merged["node"].device_id, "device-b");
    }

    #[test]
    fn snapshot_data_requires_the_active_generation() {
        let active = HashMap::from([(
            "node".to_string(),
            ResetGeneration {
                counter: 2,
                device_id: "device-b".into(),
            },
        )]);
        let mut stale = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "device-a".into(),
            revision: 2,
            slot: 0,
            updated_at: 1,
            resets: active.clone(),
            generations: HashMap::from([(
                "node".to_string(),
                ResetGeneration {
                    counter: 1,
                    device_id: "device-a".into(),
                },
            )]),
            data: data(300, 0),
            clear_all: ResetGeneration::default(),
            device_name: String::new(),
        };
        filter_snapshot_data(&mut stale, &active);
        assert!(!stale.data.contains_key("node"));
    }

    #[test]
    fn clear_all_drops_a_node_this_device_never_stored() {
        let active = ResetGeneration {
            counter: 1,
            device_id: "device-a".into(),
        };
        let mut stale = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "device-b".into(),
            revision: 2,
            slot: 0,
            updated_at: 1,
            resets: ResetWatermarks::new(),
            generations: ResetWatermarks::new(),
            data: data(300, 0),
            clear_all: ResetGeneration::default(),
            device_name: String::new(),
        };
        retain_snapshot_for_clear_all(&mut stale, &active);
        assert!(stale.data.is_empty());

        let mut fresh = DeviceSnapshot {
            v: PROTOCOL_VERSION,
            device_id: "device-b".into(),
            revision: 4,
            slot: 0,
            updated_at: 2,
            resets: ResetWatermarks::new(),
            generations: ResetWatermarks::new(),
            data: data(4, 0),
            clear_all: active.clone(),
            device_name: String::new(),
        };
        retain_snapshot_for_clear_all(&mut fresh, &active);
        assert!(fresh.data.contains_key("node"));
    }

    #[test]
    fn newer_clear_all_drops_local_history() {
        let clear_all = ResetGeneration {
            counter: 1,
            device_id: "device-a".into(),
        };
        let current = StatsFile {
            v: STORE_VERSION,
            data: data(300, 0),
            sync: Some(LocalSyncMetadata {
                last_others: data(200, 0),
                reset_watermarks: ResetWatermarks::new(),
                clear_all: ResetGeneration::default(),
            }),
        };
        let (_, outcome) = prepare_local_merge(
            &serde_json::to_string(&current).unwrap(),
            &StatsData::new(),
            &StatsData::new(),
            &ResetWatermarks::new(),
            &clear_all,
        )
        .unwrap();

        assert!(outcome.own.is_empty());
        assert!(outcome.merged.is_empty());
        assert_eq!(outcome.clear_all, clear_all);
    }

    #[test]
    fn two_slots_bound_remote_files() {
        assert_eq!(MAX_REMOTE_FILES, 64);
        assert_eq!(snapshot_filename("device-a", 0), "device-a-0.json");
        assert_eq!(snapshot_filename("device-a", 1), "device-a-1.json");
    }
}
