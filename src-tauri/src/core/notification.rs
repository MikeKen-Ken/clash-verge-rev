use super::handle::Handle;
use crate::constants::timing;
use clash_verge_logging::{Type, logging};
use smartstring::alias::String;
use std::{
    sync::{
        Arc, Condvar, Mutex,
        mpsc::{self, TrySendError},
    },
    thread,
    time::Duration,
};
use tauri::{Emitter as _, WebviewWindow};

/// 前端事件队列上限。
/// 使用有界队列避免生产者快于 worker 时无界堆积导致内存增长；
/// 实际场景下若到达上限说明前端长时间未消费，丢弃后续幂等事件是可接受的。
const FRONTEND_EVENT_CHANNEL_CAPACITY: usize = 256;
const SHUTDOWN_JOIN_TIMEOUT: Duration = Duration::from_millis(500);

// TODO 重构或优化，避免 Clone 过多
#[derive(Debug, Clone)]
pub enum FrontendEvent {
    RefreshClash,
    /// Only refresh clash config (e.g. after log-level change), do not refresh proxy or re-trigger fallback health check
    RefreshClashConfigOnly,
    RefreshVerge,
    NoticeMessage {
        status: String,
        message: String,
    },
    ProfileChanged {
        current_profile_id: String,
    },
    TimerUpdated {
        profile_index: String,
    },
    ProfileUpdateStarted {
        uid: String,
    },
    ProfileUpdateCompleted {
        uid: String,
    },
    CloseAllConnections,
}

#[derive(Debug)]
pub struct NotificationSystem {
    sender: Option<mpsc::SyncSender<FrontendEvent>>,
    #[allow(clippy::type_complexity)]
    worker_handle: Option<thread::JoinHandle<()>>,
    worker_done: Option<Arc<(Mutex<bool>, Condvar)>>,
}

impl Default for NotificationSystem {
    fn default() -> Self {
        Self::new()
    }
}

impl NotificationSystem {
    pub const fn new() -> Self {
        Self {
            sender: None,
            worker_handle: None,
            worker_done: None,
        }
    }

    pub const fn is_running(&self) -> bool {
        self.sender.is_some() && self.worker_handle.is_some()
    }

    pub fn start(&mut self) {
        if self.is_running() {
            return;
        }

        let (tx, rx) = mpsc::sync_channel(FRONTEND_EVENT_CHANNEL_CAPACITY);
        let done = Arc::new((Mutex::new(false), Condvar::new()));
        self.sender = Some(tx);
        self.worker_done = Some(Arc::clone(&done));

        //? Do we have to create a new thread for this?
        let result = thread::Builder::new()
            .name("frontend-notifier".into())
            .spawn(move || Self::worker_loop(rx, done));

        match result {
            Ok(handle) => self.worker_handle = Some(handle),
            Err(e) => {
                self.sender = None;
                self.worker_done = None;
                logging!(error, Type::System, "Failed to start notification worker: {}", e);
            }
        }
    }

    fn worker_loop(rx: mpsc::Receiver<FrontendEvent>, done: Arc<(Mutex<bool>, Condvar)>) {
        let handle = Handle::global();
        loop {
            if handle.is_exiting() {
                break;
            }
            match rx.recv() {
                Ok(event) => Self::process_event(handle, event),
                Err(e) => {
                    logging!(error, Type::System, "Notification System will exit, recv error: {}", e);
                    break;
                }
            }
        }
        if let Ok(mut finished) = done.0.lock() {
            *finished = true;
            done.1.notify_all();
        }
    }

    fn process_event(handle: &super::handle::Handle, event: FrontendEvent) {
        if handle.is_exiting() {
            return;
        }

        // 先获取窗口并释放任何锁外调用，避免持 notification_system 锁期间阻塞在 WebView2 emit 上
        if let Some(window) = super::handle::Handle::get_window() {
            Self::emit_to_window(&window, event);
            thread::sleep(timing::EVENT_EMIT_DELAY);
        }
    }

    fn emit_to_window(window: &WebviewWindow, event: FrontendEvent) {
        let (event_name, payload) = Self::serialize_event(event);

        let Ok(payload) = payload else {
            return;
        };

        if let Err(e) = window.emit(event_name, payload) {
            logging!(warn, Type::Frontend, "Event emit failed: {}", e);
        }
    }

    fn serialize_event(event: FrontendEvent) -> (&'static str, Result<serde_json::Value, serde_json::Error>) {
        use serde_json::json;

        match event {
            FrontendEvent::RefreshClash => ("verge://refresh-clash-config", Ok(json!("yes"))),
            FrontendEvent::RefreshClashConfigOnly => ("verge://refresh-clash-config-only", Ok(json!("yes"))),
            FrontendEvent::RefreshVerge => ("verge://refresh-verge-config", Ok(json!("yes"))),
            FrontendEvent::NoticeMessage { status, message } => {
                ("verge://notice-message", serde_json::to_value((status, message)))
            }
            FrontendEvent::ProfileChanged { current_profile_id } => ("profile-changed", Ok(json!(current_profile_id))),
            FrontendEvent::TimerUpdated { profile_index } => ("verge://timer-updated", Ok(json!(profile_index))),
            FrontendEvent::ProfileUpdateStarted { uid } => ("profile-update-started", Ok(json!({ "uid": uid }))),
            FrontendEvent::ProfileUpdateCompleted { uid } => ("profile-update-completed", Ok(json!({ "uid": uid }))),
            FrontendEvent::CloseAllConnections => ("verge://close-all-connections", Ok(json!("yes"))),
        }
    }

    fn can_drop_when_full(event: &FrontendEvent) -> bool {
        matches!(
            event,
            FrontendEvent::RefreshClash | FrontendEvent::RefreshClashConfigOnly | FrontendEvent::RefreshVerge
        )
    }

    pub fn send_event(&self, event: FrontendEvent) -> bool {
        if !self.is_running() {
            return false;
        }

        let Some(sender) = &self.sender else {
            return false;
        };

        // 调用方可能持有 notification_system 读锁或处于 Tokio 异步上下文，
        // 统一使用非阻塞 try_send，避免前端消费卡住时连带阻塞后台线程或退出流程。
        match sender.try_send(event) {
            Ok(()) => true,
            Err(TrySendError::Full(dropped)) => {
                if Self::can_drop_when_full(&dropped) {
                    logging!(
                        warn,
                        Type::System,
                        "前端事件队列已满（容量 {}），丢弃可合并事件: {:?}",
                        FRONTEND_EVENT_CHANNEL_CAPACITY,
                        dropped
                    );
                } else {
                    logging!(
                        warn,
                        Type::System,
                        "前端事件队列已满（容量 {}），跳过阻塞投递事件: {:?}",
                        FRONTEND_EVENT_CHANNEL_CAPACITY,
                        dropped
                    );
                }
                false
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    pub fn shutdown(&mut self) {
        if let Some(sender) = self.sender.take() {
            drop(sender);
        }

        let handle = self.worker_handle.take();
        let done = self.worker_done.take();
        if let Some(done) = done
            && let Ok(mut finished) = done.0.lock()
        {
            while !*finished {
                let (guard, timeout) = match done.1.wait_timeout(finished, SHUTDOWN_JOIN_TIMEOUT) {
                    Ok(res) => res,
                    Err(poisoned) => poisoned.into_inner(),
                };
                finished = guard;
                if timeout.timed_out() {
                    break;
                }
            }
            if *finished
                && let Some(handle) = handle
            {
                let _ = handle.join();
            }
            return;
        }

        if let Some(handle) = handle {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_event_does_not_block_when_channel_is_full() {
        let (tx, _rx) = mpsc::sync_channel(1);
        let dummy_handle = thread::spawn(|| {});
        let system = NotificationSystem {
            sender: Some(tx),
            worker_handle: Some(dummy_handle),
            worker_done: None,
        };

        assert!(system.send_event(FrontendEvent::RefreshClash));
        assert!(!system.send_event(FrontendEvent::NoticeMessage {
            status: "error".into(),
            message: "test".into(),
        }));
    }

    #[test]
    fn shutdown_returns_within_bounded_time_if_worker_is_stuck() {
        let (tx, rx) = mpsc::sync_channel::<FrontendEvent>(1);
        let done = Arc::new((Mutex::new(false), Condvar::new()));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let worker = thread::spawn(move || {
            let _ = rx;
            let _ = release_rx.recv();
        });
        let mut system = NotificationSystem {
            sender: Some(tx),
            worker_handle: Some(worker),
            worker_done: Some(done),
        };

        let started = std::time::Instant::now();
        system.shutdown();
        assert!(started.elapsed() < Duration::from_secs(2));
        let _ = release_tx.send(());
    }
}
