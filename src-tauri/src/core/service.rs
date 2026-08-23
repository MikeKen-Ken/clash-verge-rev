use crate::{
    config::{Config, IClashTemp},
    core::{logger::Logger, tray::Tray},
    utils::dirs,
};
use anyhow::{Context as _, Result, bail};
use clash_verge_logging::{Type, logging};
use clash_verge_service_ipc::CoreConfig;
use compact_str::CompactString;
use once_cell::sync::Lazy;
use std::{
    env::current_exe,
    path::{Path, PathBuf},
    process::Command as StdCommand,
    time::Duration,
};
use tokio::sync::Mutex;

/// 服务刚拉起时 IPC 可能尚未就绪，先等待再决定是否重装
const SERVICE_READY_ATTEMPTS: usize = 12;
const SERVICE_READY_INTERVAL: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServiceStatus {
    Ready,
    NeedsReinstall,
    InstallRequired,
    UninstallRequired,
    ReinstallRequired,
    ForceReinstallRequired,
    Unavailable(String),
}

#[derive(Clone)]
pub struct ServiceManager(ServiceStatus);

#[cfg(any(target_os = "macos", test))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(any(target_os = "macos", test))]
fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(any(target_os = "macos", test))]
fn macos_admin_command(shell: &str, prompt: &str) -> String {
    let shell = escape_applescript_string(shell);
    let prompt = escape_applescript_string(prompt);
    format!(r#"do shell script "{shell}" with administrator privileges with prompt "{prompt}""#)
}

#[cfg(target_os = "windows")]
fn uninstall_service() -> Result<()> {
    logging!(info, Type::Service, "uninstall service");

    use deelevate::{PrivilegeLevel, Token};
    use runas::Command as RunasCommand;
    use std::os::windows::process::CommandExt as _;

    let binary_path = dirs::service_path()?;
    let uninstall_path = binary_path.with_file_name("clash-verge-service-uninstall.exe");

    if !uninstall_path.exists() {
        bail!(format!("uninstaller not found: {uninstall_path:?}"));
    }

    let token = Token::with_current_process()?;
    let level = token.privilege_level()?;
    let status = match level {
        PrivilegeLevel::NotPrivileged => RunasCommand::new(uninstall_path).show(false).status()?,
        _ => StdCommand::new(uninstall_path).creation_flags(0x08000000).status()?,
    };

    if !status.success() {
        bail!(
            "failed to uninstall service with status {}",
            status.code().unwrap_or(-1)
        );
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn install_service() -> Result<()> {
    logging!(info, Type::Service, "install service");

    use deelevate::{PrivilegeLevel, Token};
    use runas::Command as RunasCommand;
    use std::os::windows::process::CommandExt as _;

    let binary_path = dirs::service_path()?;
    let install_path = binary_path.with_file_name("clash-verge-service-install.exe");

    if !install_path.exists() {
        bail!(format!("installer not found: {install_path:?}"));
    }

    let token = Token::with_current_process()?;
    let level = token.privilege_level()?;
    let status = match level {
        PrivilegeLevel::NotPrivileged => RunasCommand::new(install_path).show(false).status()?,
        _ => StdCommand::new(install_path).creation_flags(0x08000000).status()?,
    };

    if !status.success() {
        bail!("failed to install service with status {}", status.code().unwrap_or(-1));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_service() -> Result<()> {
    logging!(info, Type::Service, "uninstall service");

    let uninstall_path = tauri::utils::platform::current_exe()?.with_file_name("clash-verge-service-uninstall");

    if !uninstall_path.exists() {
        bail!(format!("uninstaller not found: {uninstall_path:?}"));
    }

    let uninstall_shell: String = uninstall_path.to_string_lossy().replace(" ", "\\ ");

    let elevator = crate::utils::help::linux_elevator();
    let status = if linux_running_as_root() {
        StdCommand::new(&uninstall_path).status()?
    } else {
        let result = StdCommand::new(&elevator)
            .arg("sh")
            .arg("-c")
            .arg(&uninstall_shell)
            .status()?;

        // 如果 pkexec 执行失败，回退到 sudo
        if !result.success() && elevator.contains("pkexec") {
            logging!(
                warn,
                Type::Service,
                "pkexec failed with code {}, falling back to sudo",
                result.code().unwrap_or(-1)
            );
            StdCommand::new("sudo")
                .arg("sh")
                .arg("-c")
                .arg(&uninstall_shell)
                .status()?
        } else {
            result
        }
    };
    logging!(
        info,
        Type::Service,
        "uninstall status code:{}",
        status.code().unwrap_or(-1)
    );

    if !status.success() {
        bail!(
            "failed to uninstall service with status {}",
            status.code().unwrap_or(-1)
        );
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn install_service() -> Result<()> {
    logging!(info, Type::Service, "install service");

    let install_path = tauri::utils::platform::current_exe()?.with_file_name("clash-verge-service-install");

    if !install_path.exists() {
        bail!(format!("installer not found: {install_path:?}"));
    }

    let install_shell: String = install_path.to_string_lossy().replace(" ", "\\ ");

    let elevator = crate::utils::help::linux_elevator();
    let status = if linux_running_as_root() {
        StdCommand::new(&install_path).status()?
    } else {
        let result = StdCommand::new(&elevator)
            .arg("sh")
            .arg("-c")
            .arg(&install_shell)
            .status()?;

        // 如果 pkexec 执行失败，回退到 sudo
        if !result.success() && elevator.contains("pkexec") {
            logging!(
                warn,
                Type::Service,
                "pkexec failed with code {}, falling back to sudo",
                result.code().unwrap_or(-1)
            );
            StdCommand::new("sudo")
                .arg("sh")
                .arg("-c")
                .arg(&install_shell)
                .status()?
        } else {
            result
        }
    };
    logging!(
        info,
        Type::Service,
        "install status code:{}",
        status.code().unwrap_or(-1)
    );

    if !status.success() {
        bail!("failed to install service with status {}", status.code().unwrap_or(-1));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_running_as_root() -> bool {
    use crate::core::handle;
    use tauri_plugin_clash_verge_sysinfo::is_current_app_handle_admin;
    let app_handle = handle::Handle::app_handle();
    is_current_app_handle_admin(app_handle)
}

#[cfg(target_os = "macos")]
fn uninstall_service() -> Result<()> {
    logging!(info, Type::Service, "uninstall service");

    let binary_path = dirs::service_path()?;
    let uninstall_path = binary_path.with_file_name("clash-verge-service-uninstall");

    if !uninstall_path.exists() {
        bail!(format!("uninstaller not found: {uninstall_path:?}"));
    }

    // clash_verge_i18n::sync_locale(Config::verge().await.latest_arc().language.as_deref());

    let prompt = clash_verge_i18n::t!("service.adminUninstallPrompt");
    let uninstall_shell = shell_single_quote(&uninstall_path.to_string_lossy());
    let command = macos_admin_command(&uninstall_shell, prompt.as_ref());

    // logging!(debug, Type::Service, "uninstall command: {}", command);

    let output = StdCommand::new("osascript").args(["-e", &command]).output()?;

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        bail!(
            "failed to uninstall service with status {}: {}",
            output.status.code().unwrap_or(-1),
            details.trim()
        );
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn install_service() -> Result<()> {
    logging!(info, Type::Service, "install service");

    let binary_path = dirs::service_path()?;
    let install_path = binary_path.with_file_name("clash-verge-service-install");

    if !install_path.exists() {
        bail!(format!("installer not found: {install_path:?}"));
    }

    // clash_verge_i18n::sync_locale(Config::verge().await.latest_arc().language.as_deref());

    let gid = tauri_plugin_clash_verge_sysinfo::current_gid();
    let prompt = clash_verge_i18n::t!("service.adminInstallPrompt");
    let install_path = shell_single_quote(&install_path.to_string_lossy());
    let install_shell = format!("CLASH_VERGE_SERVICE_GID={gid} {install_path}");
    let command = macos_admin_command(&install_shell, prompt.as_ref());

    let output = StdCommand::new("osascript").args(["-e", &command]).output()?;

    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        bail!(
            "failed to install service with status {}: {}",
            output.status.code().unwrap_or(-1),
            details.trim()
        );
    }

    Ok(())
}

fn reinstall_service() -> Result<()> {
    logging!(info, Type::Service, "reinstall service");

    // The macOS installer now stops and replaces the launchd daemon itself.
    // Running the separate uninstaller first would only add a second admin
    // prompt and another failure point to the version-mismatch recovery path.
    #[cfg(target_os = "macos")]
    return install_service().context("failed to replace macOS service");

    #[cfg(not(target_os = "macos"))]
    {
        // 先卸载服务
        if let Err(err) = uninstall_service() {
            logging!(warn, Type::Service, "failed to uninstall service: {}", err);
        }

        // 再安装服务
        match install_service() {
            Ok(_) => Ok(()),
            Err(err) => {
                bail!(format!("failed to install service: {err}"))
            }
        }
    }
}

/// 强制重装服务（UI修复按钮）
fn force_reinstall_service() -> Result<()> {
    logging!(info, Type::Service, "User requested a forced service reinstall");
    reinstall_service().map_err(|err| {
        logging!(error, Type::Service, "Forced service reinstall failed: {}", err);
        err
    })
}

/// 尝试使用服务启动core
pub(super) async fn start_with_existing_service(config_file: &PathBuf) -> Result<()> {
    logging!(info, Type::Service, "Trying to start the core with the existing service");

    let verge_config = Config::verge().await;
    let clash_core = verge_config.latest_arc().get_valid_clash_core();
    let binary = crate::config::sidecar_binary_name(clash_core.as_str());
    drop(verge_config);

    let bin_ext = if cfg!(windows) { ".exe" } else { "" };
    let bin_path = current_exe()?.with_file_name(format!("{binary}{bin_ext}"));

    let payload = clash_verge_service_ipc::ClashConfig {
        core_config: CoreConfig {
            config_path: dirs::path_to_str(config_file)?.into(),
            core_path: dirs::path_to_str(&bin_path)?.into(),
            core_ipc_path: IClashTemp::guard_external_controller_ipc(),
            config_dir: dirs::path_to_str(&dirs::app_home_dir()?)?.into(),
        },
        log_config: Logger::global().service_writer_config()?,
    };

    let response = clash_verge_service_ipc::start_clash(&payload)
        .await
        .context("Unable to connect to the Clash Verge Service")?;

    if response.code > 0 {
        let err_msg = response.message;
        logging!(error, Type::Service, "Failed to start the core: {}", err_msg);
        bail!(err_msg);
    }

    logging!(info, Type::Service, "Service started the core successfully");
    Ok(())
}

// 以服务启动core
pub(super) async fn run_core_by_service(config_file: &PathBuf) -> Result<()> {
    logging!(info, Type::Service, "Trying to start the core through the service");

    let mut manager = SERVICE_MANAGER.lock().await;
    let status = manager.check_service_comprehensive().await;
    manager.handle_service_status(&status).await?;
    drop(manager);

    logging!(info, Type::Service, "Service is running with a matching version; using it directly");
    start_with_existing_service(config_file).await
}

pub(super) async fn get_clash_logs_by_service() -> Result<Vec<CompactString>> {
    logging!(info, Type::Service, "Fetching Clash logs through service mode");

    let logs = poll_clash_logs_by_service().await?;

    logging!(info, Type::Service, "Fetched Clash logs through service mode successfully");
    Ok(logs)
}

pub(super) async fn poll_clash_logs_by_service() -> Result<Vec<CompactString>> {
    let response = clash_verge_service_ipc::get_clash_logs()
        .await
        .context("Unable to connect to the Clash Verge Service")?;

    if response.code > 0 {
        let err_msg = response.message;
        logging!(error, Type::Service, "Failed to fetch Clash logs through service mode: {}", err_msg);
        bail!(err_msg);
    }

    Ok(response.data.unwrap_or_default())
}

/// 通过服务停止core
pub(super) async fn stop_core_by_service() -> Result<()> {
    logging!(info, Type::Service, "Stopping the core through the service (IPC)");

    let response = clash_verge_service_ipc::stop_clash()
        .await
        .context("Unable to connect to the Clash Verge Service")?;

    if response.code > 0 {
        let err_msg = response.message;
        logging!(error, Type::Service, "Failed to stop the core: {}", err_msg);
        bail!(err_msg);
    }

    logging!(info, Type::Service, "Service stopped the core successfully");
    Ok(())
}

/// 检查服务是否正在运行
pub async fn is_service_available() -> Result<()> {
    if let Err(e) = Path::metadata(clash_verge_service_ipc::IPC_PATH.as_ref()) {
        let verge = Config::verge().await;
        let verge_last = verge.latest_arc();
        let is_enable = verge_last.enable_tun_mode.unwrap_or(false);
        if is_enable {
            logging!(warn, Type::Service, "Some issue with service IPC Path: {}", e);
        }
        return Err(e.into());
    }
    match probe_service_version().await {
        Ok(ServiceStatus::Ready) => Ok(()),
        Ok(ServiceStatus::NeedsReinstall) => {
            bail!("Service version mismatch; reinstall required")
        }
        Ok(status) => bail!("Service unavailable: {status:?}"),
        Err(reason) => bail!("Service unavailable: {reason}"),
    }
}

/// 安装/重装后等待服务 IPC 真正可用
pub async fn wait_and_check_service_available(status: &mut ServiceManager) -> Result<()> {
    status.0 = ServiceStatus::Unavailable("Waiting for service to be available".into());
    match wait_for_service_probe().await {
        ServiceStatus::Ready => {
            status.0 = ServiceStatus::Ready;
            Ok(())
        }
        other => {
            status.0 = other.clone();
            bail!("Service is still not ready after installation: {:?}", other)
        }
    }
}

pub fn is_service_ipc_path_exists() -> bool {
    Path::new(clash_verge_service_ipc::IPC_PATH).exists()
}

/// 探测服务版本：就绪 / 确认版本不匹配 / 暂时连不上
async fn probe_service_version() -> std::result::Result<ServiceStatus, String> {
    match clash_verge_service_ipc::get_version().await {
        Ok(resp) => match resp.data {
            Some(ver) if ver == clash_verge_service_ipc::VERSION => {
                Ok(ServiceStatus::Ready)
            }
            Some(ver) => {
                logging!(
                    info,
                    Type::Service,
                    "服务版本不匹配: installed={} expected={}",
                    ver,
                    clash_verge_service_ipc::VERSION
                );
                Ok(ServiceStatus::NeedsReinstall)
            }
            None => Err("Service version is empty".into()),
        },
        Err(e) => Err(e.to_string()),
    }
}

/// 先等待服务就绪；只有确认版本不匹配才返回 NeedsReinstall。
/// 连接失败不再自动当成「必须重装」，避免启动阶段连环弹密码。
async fn wait_for_service_probe() -> ServiceStatus {
    let mut last_err = String::from("unknown");
    for attempt in 1..=SERVICE_READY_ATTEMPTS {
        match probe_service_version().await {
            Ok(status) => return status,
            Err(err) => {
                last_err = err;
                logging!(
                    info,
                    Type::Service,
                    "等待服务就绪 ({}/{}): {}",
                    attempt,
                    SERVICE_READY_ATTEMPTS,
                    last_err
                );
                tokio::time::sleep(SERVICE_READY_INTERVAL).await;
            }
        }
    }
    ServiceStatus::Unavailable(format!("Service is not ready yet: {last_err}"))
}

impl ServiceManager {
    pub fn default() -> Self {
        Self(ServiceStatus::Unavailable("Need Checks".into()))
    }

    pub const fn config() -> clash_verge_service_ipc::IpcConfig {
        clash_verge_service_ipc::IpcConfig {
            default_timeout: Duration::from_millis(100),
            retry_delay: Duration::from_millis(200),
            max_retries: 6,
        }
    }

    pub async fn init(&mut self) -> Result<()> {
        if let Err(e) = clash_verge_service_ipc::connect().await {
            self.0 = ServiceStatus::Unavailable(format!("Service connection failed: {e}"));
            return Err(e);
        }
        Ok(())
    }

    pub fn current(&self) -> ServiceStatus {
        self.0.clone()
    }

    pub async fn refresh(&mut self) -> Result<()> {
        let status = self.check_service_comprehensive().await;
        self.0 = status.clone();

        match status {
            ServiceStatus::Ready => {
                logging!(info, Type::Service, "Service is ready");
            }
            ServiceStatus::NeedsReinstall => {
                logging!(
                    info,
                    Type::Service,
                    "Service version mismatch; waiting for an explicit repair action"
                );
            }
            ServiceStatus::Unavailable(reason) => {
                logging!(info, Type::Service, "Service unavailable: {reason}");
            }
            _ => {}
        }

        Ok(())
    }

    /// 综合服务状态检查：等待就绪；仅版本不匹配才要求重装
    pub async fn check_service_comprehensive(&self) -> ServiceStatus {
        if !clash_verge_service_ipc::is_ipc_path_exists() {
            return ServiceStatus::Unavailable("Service is not installed".into());
        }
        wait_for_service_probe().await
    }

    /// 根据服务状态执行相应操作
    pub async fn handle_service_status(&mut self, status: &ServiceStatus) -> Result<()> {
        match status {
            ServiceStatus::Ready => {
                logging!(info, Type::Service, "Service is ready; starting directly");
                self.0 = ServiceStatus::Ready;
            }
            ServiceStatus::NeedsReinstall => {
                logging!(
                    info,
                    Type::Service,
                    "Service version mismatch; using Sidecar mode until the user repairs it"
                );
                self.0 = ServiceStatus::NeedsReinstall;
                return Err(anyhow::anyhow!(
                    "Service version mismatch; explicit repair required"
                ));
            }
            ServiceStatus::ReinstallRequired => {
                logging!(info, Type::Service, "User requested service reinstall");
                reinstall_service()?;
                wait_and_check_service_available(self).await?;
            }
            ServiceStatus::ForceReinstallRequired => {
                logging!(info, Type::Service, "Service requires a forced reinstall; starting forced reinstall flow");
                force_reinstall_service()?;
                wait_and_check_service_available(self).await?;
            }
            ServiceStatus::InstallRequired => {
                logging!(info, Type::Service, "Service installation required; starting installation flow");
                install_service()?;
                wait_and_check_service_available(self).await?;
            }
            ServiceStatus::UninstallRequired => {
                logging!(info, Type::Service, "Service uninstallation required; starting uninstallation flow");
                uninstall_service()?;
                self.0 = ServiceStatus::Unavailable("Service Uninstalled".into());
            }
            ServiceStatus::Unavailable(reason) => {
                logging!(info, Type::Service, "Service unavailable: {}; using Sidecar mode", reason);
                self.0 = ServiceStatus::Unavailable(reason.clone());
                return Err(anyhow::anyhow!("Service unavailable: {}", reason));
            }
        }

        // 防止服务安装成功后，内核未完全启动导致系统托盘无法获取代理节点信息
        Tray::global().update_menu().await?;
        Ok(())
    }
}

pub static SERVICE_MANAGER: Lazy<Mutex<ServiceManager>> = Lazy::new(|| Mutex::new(ServiceManager::default()));

#[cfg(test)]
mod tests {
    use super::{macos_admin_command, shell_single_quote};

    #[test]
    fn macos_service_path_is_safe_for_shell_and_applescript() {
        let path = shell_single_quote("/Applications/Ken's App/service");
        let command = macos_admin_command(&path, "Install \"Service\"");

        assert!(command.contains(r#"'Ken'\"'\"'s App/service'"#));
        assert!(command.contains(r#"prompt "Install \"Service\"""#));
    }
}
