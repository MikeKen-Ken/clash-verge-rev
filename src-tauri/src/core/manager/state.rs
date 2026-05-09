use super::{CoreManager, RunningMode};
use crate::{
    AsyncHandler,
    config::{sidecar_binary_name, Config, IClashTemp},
    core::{handle, logger::Logger, manager::CLASH_LOGGER, service},
    logging,
    utils::{
        dirs,
        notification::{NotificationEvent, notify_event},
    },
};
use anyhow::Result;
use clash_verge_logging::Type;
use compact_str::CompactString;
use log::Level;
use scopeguard::defer;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri_plugin_shell::ShellExt as _;
use tokio::time::sleep;

static SERVICE_MAX_CONNECT_TIMES_LOG_MONITOR_RUNNING: AtomicBool = AtomicBool::new(false);

impl CoreManager {
    pub async fn get_clash_logs(&self) -> Result<Vec<CompactString>> {
        match *self.get_running_mode() {
            RunningMode::Service => service::get_clash_logs_by_service().await,
            RunningMode::Sidecar => Ok(CLASH_LOGGER.get_logs().await),
            RunningMode::NotRunning => Ok(Vec::new()),
        }
    }

    pub(super) async fn start_core_by_sidecar(&self) -> Result<()> {
        logging!(info, Type::Core, "Starting core in sidecar mode");

        let config_file = Config::generate_file(crate::config::ConfigType::Run).await?;
        let app_handle = handle::Handle::app_handle();
        let clash_core = Config::verge().await.latest_arc().get_valid_clash_core();
        let binary = sidecar_binary_name(clash_core.as_str());
        let config_dir = dirs::app_home_dir()?;

        let command = app_handle
            .shell()
            .sidecar(binary)?
            .args([
                "-d",
                dirs::path_to_str(&config_dir)?,
                "-f",
                dirs::path_to_str(&config_file)?,
                if cfg!(windows) {
                    "-ext-ctl-pipe"
                } else {
                    "-ext-ctl-unix"
                },
                &IClashTemp::guard_external_controller_ipc(),
            ]);

        // 防御性清理：避免重复调用导致旧子进程与 stdout reader 任务叠加。
        // 放在所有可提前失败的准备步骤之后，减少启动失败时误杀当前可用核心的窗口。
        if let Some(old_child) = self.take_child_sidecar() {
            let pid = old_child.pid();
            let result = old_child.kill();
            logging!(
                info,
                Type::Core,
                "Killed leftover sidecar before restart (PID: {:?}, Result: {:?})",
                pid,
                result
            );
        }

        #[cfg(unix)]
        let previous_mask = unsafe { tauri_plugin_clash_verge_sysinfo::libc::umask(0o007) };
        let spawn_result = command.spawn();
        #[cfg(unix)]
        unsafe {
            tauri_plugin_clash_verge_sysinfo::libc::umask(previous_mask)
        };

        let (mut rx, child) = match spawn_result {
            Ok(value) => value,
            Err(err) => {
                self.set_running_mode(RunningMode::NotRunning);
                return Err(err.into());
            }
        };

        let pid = child.pid();
        logging!(trace, Type::Core, "Sidecar started with PID: {}", pid);

        let sidecar_generation = self.next_sidecar_generation();
        self.set_running_child_sidecar(child);
        self.set_running_mode(RunningMode::Sidecar);

        AsyncHandler::spawn(move || async move {
            while let Some(event) = rx.recv().await {
                match event {
                    tauri_plugin_shell::process::CommandEvent::Stdout(line)
                    | tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                        let message = CompactString::from(&*String::from_utf8_lossy(&line));
                        if let Some((group, proxy)) = parse_max_connect_times_test_log(message.as_str()) {
                            notify_event(NotificationEvent::MaxConnectTimesDelayTest {
                                group: group.as_str(),
                                proxy: proxy.as_str(),
                            })
                            .await;
                        }
                        Logger::global().writer_sidecar_log(Level::Error, &message);
                        CLASH_LOGGER.append_log(message).await;
                    }
                    tauri_plugin_shell::process::CommandEvent::Terminated(term) => {
                        let message = if let Some(code) = term.code {
                            CompactString::from(format!("Process terminated with code: {}", code))
                        } else if let Some(signal) = term.signal {
                            CompactString::from(format!("Process terminated by signal: {}", signal))
                        } else {
                            CompactString::from("Process terminated")
                        };
                        Logger::global().writer_sidecar_log(Level::Info, &message);
                        CLASH_LOGGER.clear_logs().await;

                        let manager = CoreManager::global();
                        let _guard = manager.update_lock.lock().await;

                        if manager.sidecar_generation() != sidecar_generation {
                            logging!(
                                debug,
                                Type::Core,
                                "忽略过期的 sidecar 终止事件：terminated_pid={}, generation={}",
                                pid,
                                sidecar_generation
                            );
                            break;
                        }

                        manager.clear_running_child_sidecar();

                        if matches!(*manager.get_running_mode(), RunningMode::Sidecar) {
                            manager.set_running_mode(RunningMode::NotRunning);
                            logging!(
                                warn,
                                Type::Core,
                                "sidecar 异常终止，已切换运行模式为 NotRunning（PID: {}）",
                                pid
                            );
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    pub(super) fn stop_core_by_sidecar(&self) {
        logging!(info, Type::Core, "Stopping sidecar");
        defer! {
            self.set_running_mode(RunningMode::NotRunning);
        }
        if let Some(child) = self.take_child_sidecar() {
            let pid = child.pid();
            let result = child.kill();
            logging!(
                trace,
                Type::Core,
                "Sidecar stopped (PID: {:?}, Result: {:?})",
                pid,
                result
            );
        }
    }

    pub(super) async fn start_core_by_service(&self) -> Result<()> {
        logging!(info, Type::Core, "Starting core in service mode");
        let config_file = Config::generate_file(crate::config::ConfigType::Run).await?;
        service::run_core_by_service(&config_file).await?;
        self.set_running_mode(RunningMode::Service);
        self.spawn_service_max_connect_times_log_monitor();
        Ok(())
    }

    pub(super) async fn stop_core_by_service(&self) -> Result<()> {
        logging!(info, Type::Core, "Stopping service");
        defer! {
            self.set_running_mode(RunningMode::NotRunning);
        }
        service::stop_core_by_service().await?;
        Ok(())
    }

    fn spawn_service_max_connect_times_log_monitor(&self) {
        if SERVICE_MAX_CONNECT_TIMES_LOG_MONITOR_RUNNING.swap(true, Ordering::AcqRel) {
            return;
        }

        AsyncHandler::spawn(|| async move {
            // 服务端返回的是当前日志快照。只保存上一轮匹配快照，避免跨轮 seen 无界增长，
            // 同时不会因为 FIFO 淘汰把仍在快照里的旧日志反复当成新日志。
            let mut previous_matches: HashSet<String> = HashSet::new();
            let mut initialized = false;

            loop {
                if handle::Handle::global().is_exiting()
                    || !matches!(*CoreManager::global().get_running_mode(), RunningMode::Service)
                {
                    break;
                }

                match service::poll_clash_logs_by_service().await {
                    Ok(logs) => {
                        let mut current_matches: HashSet<String> = HashSet::new();
                        for message in logs {
                            if parse_max_connect_times_test_log(message.as_str()).is_none() {
                                continue;
                            }

                            let key = message.to_string();
                            if initialized && !previous_matches.contains(&key) {
                                if let Some((group, proxy)) =
                                    parse_max_connect_times_test_log(message.as_str())
                                {
                                    notify_event(NotificationEvent::MaxConnectTimesDelayTest {
                                        group: group.as_str(),
                                        proxy: proxy.as_str(),
                                    })
                                    .await;
                                }
                            }

                            current_matches.insert(key);
                        }

                        previous_matches = current_matches;
                        initialized = true;
                    }
                    Err(err) => {
                        logging!(debug, Type::Service, "服务模式测速通知日志轮询失败: {err}");
                    }
                }

                sleep(Duration::from_secs(3)).await;
            }

            SERVICE_MAX_CONNECT_TIMES_LOG_MONITOR_RUNNING.store(false, Ordering::Release);
        });
    }
}

const MAX_CONNECT_TIMES_TEST_LOG_PREFIX: &str = "[APP] max-connect-times test triggered\t";

fn parse_max_connect_times_test_log(message: &str) -> Option<(String, String)> {
    let payload = message
        .find(MAX_CONNECT_TIMES_TEST_LOG_PREFIX)
        .map(|index| &message[index + MAX_CONNECT_TIMES_TEST_LOG_PREFIX.len()..])?;
    let mut parts = payload.splitn(2, '\t');
    let group = trim_log_field(parts.next()?);
    let proxy = trim_log_field(parts.next()?);

    if group.is_empty() || proxy.is_empty() {
        return None;
    }

    Some((group, proxy))
}

fn trim_log_field(value: &str) -> String {
    value
        .trim()
        .trim_matches(|c| c == '"' || c == '\r' || c == '\n')
        .to_owned()
}
