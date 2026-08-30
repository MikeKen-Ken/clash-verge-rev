use crate::{
    config::Config,
    core::profile_update_retry::ProfileUpdateRetry,
    feat::{self, handle_update_retry_side_effects},
    singleton,
    utils::{resolve::is_resolve_done, wall_clock},
};
use anyhow::{Context as _, Result};
use clash_verge_logging::{Type, logging, logging_error};
use delay_timer::prelude::{DelayTimer, DelayTimerBuilder, TaskBuilder};
use parking_lot::RwLock;
use smartstring::alias::String;
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::Mutex as AsyncMutex,
    time::{sleep, timeout},
};

type TaskID = u64;

#[derive(Debug, Clone)]
pub struct TimerTask {
    pub task_id: TaskID,
    pub interval_minutes: u64,
    #[allow(unused)]
    pub last_run: i64, // Timestamp of last execution
}

pub struct Timer {
    /// cron manager
    pub delay_timer: Arc<RwLock<DelayTimer>>,

    /// save the current state - using RwLock for better read concurrency
    pub timer_map: Arc<RwLock<HashMap<String, TimerTask>>>,

    /// increment id - atomic counter for better performance
    pub timer_count: AtomicU64,

    /// Flag to mark if timer is initialized - atomic for better performance
    pub initialized: AtomicBool,

    /// Serialize timer-map and DelayTimer registration changes across refresh and task completion.
    schedule_lock: AsyncMutex<()>,
}

// Use singleton macro
singleton!(Timer, TIMER_INSTANCE);

impl Timer {
    fn new() -> Self {
        Self {
            delay_timer: Arc::new(RwLock::new(DelayTimerBuilder::default().build())),
            timer_map: Arc::new(RwLock::new(HashMap::new())),
            timer_count: AtomicU64::new(1),
            initialized: AtomicBool::new(false),
            schedule_lock: AsyncMutex::new(()),
        }
    }

    /// Initialize timer with better error handling and atomic operations
    pub async fn init(&self) -> Result<()> {
        // Use compare_exchange for thread-safe initialization check
        if self
            .initialized
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            logging!(debug, Type::Timer, "Timer already initialized, skipping...");
            return Ok(());
        }

        // Initialize timer tasks
        if let Err(e) = self.refresh().await {
            // Reset initialization flag on error
            self.initialized.store(false, Ordering::SeqCst);
            logging_error!(Type::Timer, "Failed to initialize timer: {}", e);
            return Err(e);
        }

        // Log timer info first
        {
            let timer_map = self.timer_map.read();
            logging!(info, Type::Timer, "已注册的定时任务数量: {}", timer_map.len());

            for (uid, task) in timer_map.iter() {
                logging!(
                    info,
                    Type::Timer,
                    "注册了定时任务 - uid={}, interval={}min, task_id={}",
                    uid,
                    task.interval_minutes,
                    task.task_id
                );
            }
        }

        logging!(info, Type::Timer, "Timer initialization completed");
        Ok(())
    }

    /// Refresh timer tasks with better error handling
    pub async fn refresh(&self) -> Result<()> {
        let _schedule_guard = self.schedule_lock.lock().await;

        // Generate diff outside of lock to minimize lock contention
        let diff_map = self.gen_diff().await;

        if diff_map.is_empty() {
            logging!(debug, Type::Timer, "No timer changes needed");
            return Ok(());
        }

        logging!(info, Type::Timer, "Refreshing {} timer tasks", diff_map.len());

        // Apply changes - first collect operations to perform without holding locks
        let mut operations_to_add: Vec<(String, TaskID, u64)> = Vec::new();
        let _operations_to_remove: Vec<String> = Vec::new();

        // Perform sync operations while holding locks
        {
            for (uid, diff) in diff_map {
                match diff {
                    DiffFlag::Del(tid) => {
                        ProfileUpdateRetry::global().cancel_failure_retries(&uid);
                        self.timer_map.write().remove(&uid);
                        let value = self.delay_timer.write().remove_task(tid);
                        if let Err(e) = value {
                            logging!(
                                warn,
                                Type::Timer,
                                "Failed to remove task {} for uid {}: {}",
                                tid,
                                uid,
                                e
                            );
                        } else {
                            logging!(debug, Type::Timer, "Removed task {} for uid {}", tid, uid);
                        }
                    }
                    DiffFlag::Add(tid, interval) => {
                        let task = TimerTask {
                            task_id: tid,
                            interval_minutes: interval,
                            last_run: chrono::Local::now().timestamp(),
                        };

                        self.timer_map.write().insert(uid.clone(), task);
                        operations_to_add.push((uid, tid, interval));
                    }
                    DiffFlag::Mod(tid, interval) => {
                        // Remove old task first
                        let value = self.delay_timer.write().remove_task(tid);
                        if let Err(e) = value {
                            if Self::is_missing_delay_timer_task_error(&e) {
                                logging!(
                                    info,
                                    Type::Timer,
                                    "旧任务已不存在，继续按新间隔重新注册: task_id={}, uid={}",
                                    tid,
                                    uid
                                );
                            } else {
                                // 旧任务移除失败时不要再以同样的 task_id 重新注册，
                                // 否则 DelayTimer 内部状态可能重复，导致任务泄露或多次触发；
                                // 跳过本次更新，保留 timer_map 旧记录，下次 refresh 重试。
                                logging!(
                                    warn,
                                    Type::Timer,
                                    "旧任务移除失败，跳过重新注册以避免重复任务: task_id={}, uid={}, error={}",
                                    tid,
                                    uid,
                                    e
                                );
                                continue;
                            }
                        }

                        // Then add the new one
                        let task = TimerTask {
                            task_id: tid,
                            interval_minutes: interval,
                            last_run: chrono::Local::now().timestamp(),
                        };

                        self.timer_map.write().insert(uid.clone(), task);
                        operations_to_add.push((uid, tid, interval));
                    }
                }
            }
        } // Locks are dropped here

        // Now perform async operations without holding locks
        let mut prepared = Vec::new();
        for (uid, tid, interval) in operations_to_add {
            let run_at = self.next_run_at(&uid, interval, false).await;
            prepared.push((uid, tid, interval, run_at));
        }
        let delay_timer = self.delay_timer.write();
        for (uid, tid, interval, run_at) in prepared {
            if let Err(e) = self.add_task(&delay_timer, uid.clone(), tid, interval, run_at) {
                logging_error!(Type::Timer, "Failed to add task for uid {}: {}", uid, e);
                // Rollback on failure - remove from timer_map
                self.timer_map.write().remove(&uid);
            } else {
                logging!(debug, Type::Timer, "Added task {} for uid {}", tid, uid);
            }
        }

        Ok(())
    }

    fn is_missing_delay_timer_task_error(error: &impl std::fmt::Display) -> bool {
        let message = error.to_string().to_ascii_lowercase();
        message.contains("not found")
            || message.contains("not exist")
            || message.contains("no such")
            || message.contains("不存在")
    }

    /// Generate map of profile UIDs to update intervals
    async fn gen_map(&self) -> HashMap<String, u64> {
        let mut new_map = HashMap::new();

        if let Some(items) = Config::profiles().await.latest_arc().get_items() {
            for item in items.iter() {
                if let Some(option) = item.option.as_ref()
                    && let Some(allow_auto_update) = option.allow_auto_update
                    && let (Some(interval), Some(uid)) = (option.update_interval, &item.uid)
                    && allow_auto_update
                    && interval > 0
                {
                    logging!(
                        debug,
                        Type::Timer,
                        "找到定时更新配置: uid={}, interval={}min",
                        uid,
                        interval
                    );
                    new_map.insert(uid.clone(), interval);
                }
            }
        }

        logging!(debug, Type::Timer, "生成的定时更新配置数量: {}", new_map.len());
        new_map
    }

    /// Generate differences between current and new timer configuration
    async fn gen_diff(&self) -> HashMap<String, DiffFlag> {
        let mut diff_map = HashMap::new();
        let new_map = self.gen_map().await;

        // Read lock for comparing current state
        let timer_map = self.timer_map.read();
        logging!(debug, Type::Timer, "当前 timer_map 大小: {}", timer_map.len());

        // Find tasks to modify or delete
        for (uid, task) in timer_map.iter() {
            match new_map.get(uid) {
                Some(&interval) if interval != task.interval_minutes => {
                    // Task exists but interval changed
                    logging!(
                        debug,
                        Type::Timer,
                        "定时任务间隔变更: uid={}, 旧={}, 新={}",
                        uid,
                        task.interval_minutes,
                        interval
                    );
                    diff_map.insert(uid.clone(), DiffFlag::Mod(task.task_id, interval));
                }
                None => {
                    // Task no longer needed
                    logging!(debug, Type::Timer, "定时任务已删除: uid={}", uid);
                    diff_map.insert(uid.clone(), DiffFlag::Del(task.task_id));
                }
                _ => {
                    // Task exists with same interval, no change needed
                    logging!(debug, Type::Timer, "定时任务保持不变: uid={}", uid);
                }
            }
        }

        // Find new tasks to add
        let mut next_id = self.timer_count.load(Ordering::Relaxed);
        let original_id = next_id;

        for (uid, &interval) in new_map.iter() {
            if !timer_map.contains_key(uid) {
                logging!(
                    debug,
                    Type::Timer,
                    "新增定时任务: uid={}, interval={}min",
                    uid,
                    interval
                );
                diff_map.insert(uid.clone(), DiffFlag::Add(next_id, interval));
                next_id += 1;
            }
        }

        // Update counter only if we added new tasks
        if next_id > original_id {
            self.timer_count.store(next_id, Ordering::Relaxed);
        }

        logging!(debug, Type::Timer, "定时任务变更数量: {}", diff_map.len());
        diff_map
    }

    /// Add a timer task with better error handling
    fn add_task(
        &self,
        delay_timer: &DelayTimer,
        uid: String,
        tid: TaskID,
        minutes: u64,
        run_at_secs: u64,
    ) -> Result<()> {
        logging!(
            info,
            Type::Timer,
            "Adding task: uid={}, id={}, interval={}min, run_at={}",
            uid,
            tid,
            minutes,
            run_at_secs
        );

        // Create a task with reasonable retries and backoff
        let task = TaskBuilder::default()
            .set_task_id(tid)
            .set_maximum_parallel_runnable_num(1)
            .set_frequency_once_by_timestamp_seconds(run_at_secs)
            .spawn_async_routine(move || {
                let uid = uid.clone();
                Box::pin(async move {
                    Self::wait_until_resolve_done(Duration::from_millis(5000)).await;
                    Self::async_task(&uid).await;
                }) as Pin<Box<dyn std::future::Future<Output = ()> + Send>>
            })
            .context("failed to create timer task")?;

        delay_timer.add_task(task).context("failed to add timer task")?;

        Ok(())
    }

    async fn next_run_at(&self, uid: &str, interval_minutes: u64, just_completed: bool) -> u64 {
        let updated = self.profile_updated_at(uid).await;
        let now = chrono::Local::now().timestamp();
        wall_clock::next_unix_timestamp(updated, interval_minutes as i64 * 60, now, just_completed)
    }

    async fn profile_updated_at(&self, uid: &str) -> i64 {
        let items = Config::profiles().await.latest_arc();
        items
            .get_items()
            .into_iter()
            .flatten()
            .find(|item| item.uid.as_deref() == Some(uid))
            .and_then(|item| item.updated)
            .map(|value| value as i64)
            .unwrap_or(0)
    }

    async fn schedule_next(uid: &String) {
        let timer = Self::global();
        let _schedule_guard = timer.schedule_lock.lock().await;
        let (old_tid, interval) = {
            let timer_map = timer.timer_map.read();
            match timer_map.get(uid) {
                Some(task) => (task.task_id, task.interval_minutes),
                None => return,
            }
        };
        {
            let delay_timer = timer.delay_timer.write();
            if let Err(e) = delay_timer.remove_task(old_tid) {
                if !Self::is_missing_delay_timer_task_error(&e) {
                    logging!(
                        warn,
                        Type::Timer,
                        "Failed to remove task {} for {}: {}",
                        old_tid,
                        uid,
                        e
                    );
                    return;
                }
            }
        }
        let run_at = timer.next_run_at(uid, interval, true).await;
        let tid = timer.timer_count.fetch_add(1, Ordering::Relaxed);
        let delay_timer = timer.delay_timer.write();
        if let Err(e) = timer.add_task(&delay_timer, uid.clone(), tid, interval, run_at) {
            logging_error!(
                Type::Timer,
                "Failed to reschedule task for uid {}: {}",
                uid,
                e
            );
            drop(delay_timer);
            let mut timer_map = timer.timer_map.write();
            if timer_map.get(uid).is_some_and(|task| task.task_id == old_tid) {
                timer_map.remove(uid);
            }
            return;
        }
        drop(delay_timer);

        let mut timer_map = timer.timer_map.write();
        match timer_map.get_mut(uid) {
            Some(task) if task.task_id == old_tid => task.task_id = tid,
            _ => {
                drop(timer_map);
                if let Err(e) = timer.delay_timer.write().remove_task(tid) {
                    if !Self::is_missing_delay_timer_task_error(&e) {
                        logging!(
                            warn,
                            Type::Timer,
                            "Failed to remove orphaned rescheduled task {} for {}: {}",
                            tid,
                            uid,
                            e
                        );
                    }
                }
            }
        }
    }

    /// Get next update time for a profile
    pub async fn get_next_update_time(&self, uid: &str) -> Option<i64> {
        logging!(info, Type::Timer, "获取下次更新时间，uid={}", uid);

        // First extract timer task data without holding the lock across await
        let task_interval = {
            let timer_map = self.timer_map.read();
            match timer_map.get(uid) {
                Some(t) => t.interval_minutes,
                None => {
                    logging!(warn, Type::Timer, "找不到对应的定时任务，uid={}", uid);
                    return None;
                }
            }
        };

        // Get the profile updated timestamp - now safe to await
        let items = {
            let profiles = Config::profiles().await;
            let profiles_guard = profiles.latest_arc();
            match profiles_guard.get_items() {
                Some(i) => i.clone(),
                None => {
                    logging!(warn, Type::Timer, "获取配置列表失败");
                    return None;
                }
            }
        };

        let profile = match items.iter().find(|item| item.uid.as_deref() == Some(uid)) {
            Some(p) => p,
            None => {
                logging!(warn, Type::Timer, "找不到对应的配置，uid={}", uid);
                return None;
            }
        };

        let updated = profile.updated.unwrap_or(0) as i64;

        // Calculate next update time
        if updated > 0 && task_interval > 0 {
            let next_time = updated + (task_interval as i64 * 60);
            logging!(info, Type::Timer, "计算得到下次更新时间: {}, uid={}", next_time, uid);
            Some(next_time)
        } else {
            logging!(
                warn,
                Type::Timer,
                "更新时间或间隔无效，updated={}, interval={}",
                updated,
                task_interval
            );
            None
        }
    }

    /// 通知前端订阅正在/完成更新
    pub(crate) fn emit_update_event(_uid: &str, _is_start: bool) {
        {
            if _is_start {
                super::handle::Handle::notify_profile_update_started(_uid.into());
            } else {
                super::handle::Handle::notify_profile_update_completed(_uid.into());
            }
        }
    }

    /// Async task with better error handling and logging
    async fn async_task(uid: &String) {
        let task_start = std::time::Instant::now();
        logging!(info, Type::Timer, "Running timer task for profile: {}", uid);

        let is_current = Config::profiles().await.latest_arc().current.as_ref() == Some(uid);
        logging!(
            info,
            Type::Timer,
            "配置 {} 是否为当前激活配置: {}，定时更新仅保存订阅文件，不立即应用运行配置",
            uid,
            is_current
        );

        Self::emit_update_event(uid, true);

        let result = match tokio::time::timeout(std::time::Duration::from_secs(40), async {
            ProfileUpdateRetry::global()
                .run_locked_update(uid, false, false)
                .await
        })
        .await
        {
            Ok(result) => {
                let duration = task_start.elapsed().as_millis();
                logging!(
                    info,
                    Type::Timer,
                    "Timer task finished for uid: {} outcome={:?} (took {}ms)",
                    uid,
                    result,
                    duration
                );
                result
            }
            Err(_) => {
                logging_error!(Type::Timer, "Timer task timed out for uid: {}", uid);
                feat::ProfileUpdateResult::DownloadFailed
            }
        };

        Self::emit_update_event(uid, false);
        handle_update_retry_side_effects(uid, result);
        Self::schedule_next(uid).await;
    }

    async fn wait_until_resolve_done(max_wait: Duration) {
        let _ = timeout(max_wait, async {
            while !is_resolve_done() {
                logging!(debug, Type::Timer, "Waiting for resolve to be done...");
                sleep(Duration::from_millis(200)).await;
            }
        })
        .await;
    }
}

#[derive(Debug)]
enum DiffFlag {
    Del(TaskID),
    Add(TaskID, u64),
    Mod(TaskID, u64),
}
