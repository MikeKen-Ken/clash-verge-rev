use super::{StatsData, MAX_SAFE_COUNT};
use crate::utils::help;
use anyhow::Error;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(super) const SNAPSHOT_SLOT_COUNT: u8 = 2;
pub(super) const MAX_REMOTE_DEVICES: usize = 32;
pub(super) const MAX_REMOTE_FILES: usize = MAX_REMOTE_DEVICES * SNAPSHOT_SLOT_COUNT as usize;
const MAX_RESET_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub(super) struct ResetGeneration {
    pub(super) counter: u64,
    pub(super) device_id: String,
}

pub(super) type ResetWatermarks = HashMap<String, ResetGeneration>;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DeviceSnapshot {
    pub(super) v: u8,
    pub(super) device_id: String,
    pub(super) revision: u64,
    pub(super) slot: u8,
    pub(super) updated_at: i64,
    #[serde(default)]
    pub(super) resets: ResetWatermarks,
    #[serde(default)]
    pub(super) generations: ResetWatermarks,
    #[serde(default)]
    pub(super) data: StatsData,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct RemoteSnapshotRef {
    pub(super) device_id: String,
    pub(super) slot: u8,
}

pub(super) fn valid_device_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(super) fn sanitize_reset_watermarks(
    input: &ResetWatermarks,
) -> Result<ResetWatermarks, Error> {
    if input.len() > MAX_RESET_ENTRIES {
        return Err(Error::msg("too many connectivity reset watermarks"));
    }
    let mut sanitized = ResetWatermarks::new();
    for (name, generation) in input {
        if name.is_empty()
            || generation.counter == 0
            || generation.counter > MAX_SAFE_COUNT
            || !valid_device_id(&generation.device_id)
        {
            return Err(Error::msg("invalid connectivity reset watermark"));
        }
        sanitized.insert(name.clone(), generation.clone());
    }
    Ok(sanitized)
}

pub(super) fn merge_reset_watermarks<'a>(
    parts: impl IntoIterator<Item = &'a ResetWatermarks>,
) -> Result<ResetWatermarks, Error> {
    let mut merged = ResetWatermarks::new();
    for part in parts {
        for (name, generation) in sanitize_reset_watermarks(part)? {
            let should_replace = merged
                .get(&name)
                .map_or(true, |current| generation > current.clone());
            if should_replace {
                merged.insert(name, generation);
            }
        }
    }
    if merged.len() > MAX_RESET_ENTRIES {
        return Err(Error::msg("too many connectivity reset watermarks"));
    }
    Ok(merged)
}

pub(super) fn advance_reset_watermarks(
    current: &ResetWatermarks,
    names: impl IntoIterator<Item = String>,
    device_id: &str,
) -> Result<ResetWatermarks, Error> {
    let mut result = sanitize_reset_watermarks(current)?;
    for name in names {
        if name.is_empty() {
            continue;
        }
        let next = result
            .get(&name)
            .map(|generation| generation.counter.saturating_add(1))
            .unwrap_or(1);
        if next > MAX_SAFE_COUNT {
            return Err(Error::msg("connectivity reset generation overflow"));
        }
        result.insert(
            name,
            ResetGeneration {
                counter: next,
                device_id: device_id.to_string(),
            },
        );
    }
    if result.len() > MAX_RESET_ENTRIES {
        return Err(Error::msg("too many connectivity reset watermarks"));
    }
    Ok(result)
}

pub(super) fn snapshot_filename(device_id: &str, slot: u8) -> String {
    format!("{device_id}-{slot}.json")
}

fn filename_from_href(href: &str) -> Option<String> {
    let decoded = help::get_last_part_and_decode(href.trim_end_matches('/'))?;
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

pub(super) fn snapshot_matches(
    snapshot: &DeviceSnapshot,
    reference: &RemoteSnapshotRef,
    protocol_version: u8,
) -> bool {
    snapshot.v == protocol_version
        && snapshot.device_id == reference.device_id
        && snapshot.slot == reference.slot
        && snapshot.slot < SNAPSHOT_SLOT_COUNT
        && snapshot.revision > 0
        && snapshot.revision <= MAX_SAFE_COUNT
        && snapshot.revision % SNAPSHOT_SLOT_COUNT as u64 == snapshot.slot as u64
        && sanitize_reset_watermarks(&snapshot.resets).is_ok()
        && sanitize_reset_watermarks(&snapshot.generations).is_ok()
        && snapshot
            .generations
            .iter()
            .all(|(name, generation)| {
                snapshot.data.contains_key(name) && snapshot.resets.get(name) == Some(generation)
            })
        && snapshot
            .data
            .keys()
            .all(|name| snapshot.generations.get(name) == snapshot.resets.get(name))
}

pub(super) fn newest_complete_snapshot(
    candidates: Vec<Option<DeviceSnapshot>>,
) -> Option<DeviceSnapshot> {
    if candidates.iter().any(Option::is_none) {
        return None;
    }
    candidates
        .into_iter()
        .flatten()
        .max_by_key(|snapshot| snapshot.revision)
}

pub(super) fn reset_names(
    proxy_name: Option<&str>,
    current: &StatsData,
    last_others: &StatsData,
    active_resets: &ResetWatermarks,
) -> Vec<String> {
    if let Some(name) = proxy_name.filter(|name| !name.is_empty()) {
        return vec![name.to_string()];
    }
    current
        .keys()
        .chain(last_others.keys())
        .chain(active_resets.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect()
}

pub(super) fn listed_snapshot_refs<'a>(
    hrefs: impl IntoIterator<Item = &'a str>,
) -> Vec<RemoteSnapshotRef> {
    let mut listed = Vec::new();
    let mut seen = HashSet::new();
    for href in hrefs {
        let Some(filename) = filename_from_href(href) else {
            continue;
        };
        let Some(stem) = filename.strip_suffix(".json") else {
            continue;
        };
        let Some((device_id, slot_raw)) = stem.rsplit_once('-') else {
            continue;
        };
        let Ok(slot) = slot_raw.parse::<u8>() else {
            continue;
        };
        if !valid_device_id(device_id) || slot >= SNAPSHOT_SLOT_COUNT {
            continue;
        }
        let reference = RemoteSnapshotRef {
            device_id: device_id.to_string(),
            slot,
        };
        if seen.insert(reference.clone()) {
            listed.push(reference);
        }
    }
    listed
}

pub(super) fn device_limit_exceeded(
    listed: &[RemoteSnapshotRef],
    own_device_id: &str,
) -> bool {
    if listed.len() > MAX_REMOTE_FILES {
        return true;
    }
    let devices: HashSet<&str> = listed.iter().map(|item| item.device_id.as_str()).collect();
    devices.len() > MAX_REMOTE_DEVICES
        || (!devices.contains(own_device_id) && devices.len() >= MAX_REMOTE_DEVICES)
}

pub(super) fn filter_snapshot_data(snapshot: &mut DeviceSnapshot, active: &ResetWatermarks) {
    snapshot.data.retain(|name, _| match active.get(name) {
        Some(generation) => snapshot.generations.get(name) == Some(generation),
        None => !snapshot.generations.contains_key(name),
    });
}

pub(super) fn generations_for(
    data: &StatsData,
    active: &ResetWatermarks,
) -> ResetWatermarks {
    data.keys()
        .filter_map(|name| {
            active
                .get(name)
                .cloned()
                .map(|generation| (name.clone(), generation))
        })
        .collect()
}
