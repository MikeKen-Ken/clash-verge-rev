use crate::{core::handle, utils::dirs};
use chrono::Utc;
use once_cell::sync::OnceCell;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::Emitter as _;

const STATUS_FILE: &str = "connectivity-sync-status.json";
const STATUS_EVENT: &str = "verge://connectivity-merge-status";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MergePhase {
    #[default]
    Idle,
    Running,
    Success,
    Partial,
    Failed,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PulledDevice {
    pub device: String,
    pub updated_at: i64,
    pub proxy_count: usize,
}

/// Last merge attempt, shown in the statistics panel. `finished_at` is unix ms.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivityMergeStatus {
    #[serde(default)]
    pub phase: MergePhase,
    #[serde(default)]
    pub progress: u8,
    #[serde(default)]
    pub finished_at: i64,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub pulled: Vec<PulledDevice>,
    #[serde(default)]
    pub skipped: Vec<String>,
}

fn cell() -> &'static RwLock<ConnectivityMergeStatus> {
    static STATUS: OnceCell<RwLock<ConnectivityMergeStatus>> = OnceCell::new();
    STATUS.get_or_init(|| RwLock::new(load()))
}

fn load() -> ConnectivityMergeStatus {
    let mut status = dirs::app_home_dir()
        .ok()
        .and_then(|home| fs::read_to_string(home.join(STATUS_FILE)).ok())
        .and_then(|raw| serde_json::from_str::<ConnectivityMergeStatus>(&raw).ok())
        .unwrap_or_default();
    if status.phase == MergePhase::Running {
        status.phase = MergePhase::Failed;
        status.error = Some("Interrupted".to_string());
    }
    status
}

fn persist(status: &ConnectivityMergeStatus) {
    let Ok(home) = dirs::app_home_dir() else {
        return;
    };
    if let Ok(raw) = serde_json::to_vec(status) {
        let _ = fs::write(home.join(STATUS_FILE), raw);
    }
}

fn publish(status: ConnectivityMergeStatus) {
    let _ = handle::Handle::app_handle().emit(STATUS_EVENT, status);
}

pub fn current() -> ConnectivityMergeStatus {
    cell().read().clone()
}

pub(super) fn begin() {
    let snapshot = {
        let mut status = cell().write();
        *status = ConnectivityMergeStatus {
            phase: MergePhase::Running,
            ..ConnectivityMergeStatus::default()
        };
        status.clone()
    };
    publish(snapshot);
}

pub(super) fn progress(percent: u8) {
    let snapshot = {
        let mut status = cell().write();
        status.progress = percent.min(99);
        status.clone()
    };
    publish(snapshot);
}

pub(super) fn finish(outcome: Result<(Vec<PulledDevice>, Vec<String>), String>) {
    let snapshot = {
        let mut status = cell().write();
        status.progress = 100;
        status.finished_at = Utc::now().timestamp_millis();
        match outcome {
            Ok((pulled, skipped)) => {
                status.phase = if skipped.is_empty() {
                    MergePhase::Success
                } else {
                    MergePhase::Partial
                };
                status.error = None;
                status.pulled = pulled;
                status.skipped = skipped;
            }
            Err(error) => {
                status.phase = MergePhase::Failed;
                status.error = Some(error);
            }
        }
        status.clone()
    };
    persist(&snapshot);
    publish(snapshot);
}
