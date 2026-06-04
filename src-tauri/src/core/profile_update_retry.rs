//! 订阅更新失败后的独立重试调度（5 / 15 / 30 分钟），与 `update_interval` 定时同步无关。

use crate::{config::Config, feat, singleton};
use clash_verge_logging::{Type, logging, logging_error};
use parking_lot::RwLock;
use std::{
    collections::HashMap,
    sync::Arc,
    time::Duration,
};
use tokio::{sync::Mutex, time::sleep};

/// 自首次失败时刻起，在第 5 / 15 / 30 分钟各重试一次。
const FAILURE_RETRY_DELAYS_MIN: [i64; 3] = [5, 15, 30];

pub struct ProfileUpdateRetry {
    /// uid -> 当前重试链代数；代数变化则旧任务自行退出
    generations: RwLock<HashMap<String, u64>>,
    /// 同一订阅串行更新，避免定时任务与失败重试并发拉取
    update_locks: RwLock<HashMap<String, Arc<Mutex<()>>>>,
}

singleton!(ProfileUpdateRetry, PROFILE_UPDATE_RETRY_INSTANCE);

impl ProfileUpdateRetry {
    fn new() -> Self {
        Self {
            generations: RwLock::new(HashMap::new()),
            update_locks: RwLock::new(HashMap::new()),
        }
    }

    fn uid_lock(&self, uid: &str) -> Arc<Mutex<()>> {
        let mut locks = self.update_locks.write();
        locks
            .entry(uid.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn bump_generation(&self, uid: &str) -> u64 {
        let mut gens = self.generations.write();
        let next = gens.get(uid).copied().unwrap_or(0).saturating_add(1);
        gens.insert(uid.to_string(), next);
        next
    }

    fn is_generation_current(&self, uid: &str, generation: u64) -> bool {
        self.generations
            .read()
            .get(uid)
            .is_some_and(|&g| g == generation)
    }

    /// 取消该订阅尚未执行的重试（成功、删除、禁用自动更新等场景）
    pub fn cancel_failure_retries(&self, uid: &str) {
        if self.generations.write().remove(uid).is_some() {
            logging!(info, Type::Timer, "[订阅失败重试] 已取消 uid={}", uid);
        }
        self.update_locks.write().remove(uid);
    }

    /// 下载失败后启动 5 / 15 / 30 分钟重试链；若已有重试链则重置
    pub fn schedule_failure_retries(&self, uid: String) {
        let generation = self.bump_generation(&uid);
        let failure_at = chrono::Local::now().timestamp();

        logging!(
            info,
            Type::Timer,
            "[订阅失败重试] 已调度 uid={}，将在失败后 {} / {} / {} 分钟重试",
            uid,
            FAILURE_RETRY_DELAYS_MIN[0],
            FAILURE_RETRY_DELAYS_MIN[1],
            FAILURE_RETRY_DELAYS_MIN[2]
        );

        tokio::spawn(async move {
            for &delay_min in &FAILURE_RETRY_DELAYS_MIN {
                if !ProfileUpdateRetry::global().is_generation_current(&uid, generation) {
                    return;
                }

                let now = chrono::Local::now().timestamp();
                let target = failure_at + delay_min * 60;
                let wait_secs = (target - now).max(0) as u64;
                if wait_secs > 0 {
                    sleep(Duration::from_secs(wait_secs)).await;
                }

                if !ProfileUpdateRetry::global().is_generation_current(&uid, generation) {
                    return;
                }

                logging!(
                    info,
                    Type::Timer,
                    "[订阅失败重试] 第 {} 分钟检查点执行 uid={}",
                    delay_min,
                    uid
                );

                let result = ProfileUpdateRetry::global()
                    .run_locked_update(&uid, false, false)
                    .await;

                match result {
                    feat::ProfileUpdateResult::DownloadSucceeded => {
                        logging!(
                            info,
                            Type::Timer,
                            "[订阅失败重试] uid={} 重试成功，停止后续重试",
                            uid
                        );
                        ProfileUpdateRetry::global().cancel_failure_retries(&uid);
                        return;
                    }
                    feat::ProfileUpdateResult::DownloadFailed => {
                        logging!(
                            warn,
                            Type::Timer,
                            "[订阅失败重试] uid={} 在 {} 分钟检查点仍失败，继续等待下一检查点",
                            uid,
                            delay_min
                        );
                    }
                    feat::ProfileUpdateResult::Skipped => {
                        logging!(
                            info,
                            Type::Timer,
                            "[订阅失败重试] uid={} 已跳过更新，取消重试链",
                            uid
                        );
                        ProfileUpdateRetry::global().cancel_failure_retries(&uid);
                        return;
                    }
                }
            }

            logging!(
                info,
                Type::Timer,
                "[订阅失败重试] uid={} 已用尽 5/15/30 分钟重试，等待下次定时同步",
                uid
            );
            ProfileUpdateRetry::global().cancel_failure_retries(&uid);
        });
    }

    /// 串行执行订阅更新
    pub async fn run_locked_update(
        &self,
        uid: &str,
        auto_refresh: bool,
        ignore_auto_update: bool,
    ) -> feat::ProfileUpdateResult {
        let lock = self.uid_lock(uid);
        let _guard = lock.lock().await;

        let uid_ss: smartstring::alias::String = uid.into();
        match feat::update_profile(
            &uid_ss,
            None,
            auto_refresh,
            ignore_auto_update,
        )
        .await
        {
            Ok(result) => result,
            Err(e) => {
                logging_error!(Type::Timer, "Failed to update profile uid {}: {}", uid, e);
                feat::ProfileUpdateResult::Skipped
            }
        }
    }

    /// 是否仍允许对该 uid 做失败重试（远程订阅且允许自动更新）
    pub async fn can_schedule_failure_retries(uid: &str) -> bool {
        let profiles = Config::profiles().await;
        let profiles = profiles.latest_arc();
        let Ok(item) = profiles.get_item(uid) else {
            return false;
        };
        if !item.itype.as_ref().is_some_and(|s| s == "remote") {
            return false;
        }
        if item.url.is_none() {
            return false;
        }
        item.option
            .as_ref()
            .and_then(|o| o.allow_auto_update)
            .unwrap_or(true)
    }
}
