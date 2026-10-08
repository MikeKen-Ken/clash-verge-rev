use super::{CmdResult, StringifyErr as _};
use crate::{
    config::{Config, IClashTemp},
    core::{CoreManager, handle, sysopt},
};
use clash_verge_logging::{Type, logging};
use std::net::{Ipv4Addr, TcpListener, UdpSocket};

const LAN_PORT_MIN: u16 = 10000;
/// Well-known Clash defaults; a random LAN port must never land on one a scanner tries first.
const RESERVED_PORTS: [u16; 4] = [7890, 7897, 7898, 7899];
const PICK_ATTEMPTS: usize = 48;

/// Moves the mixed (LAN share) port to a random free port and restarts the core,
/// so devices that only know the old `ip:port` can no longer connect.
#[tauri::command]
pub async fn refresh_lan_port() -> CmdResult<u16> {
    let current = current_mixed_port().await;
    let port = pick_port(current, random_ports(), can_bind)
        .or_else(|| pick_port(current, random_ports(), |_| true))
        .ok_or("Could not pick a LAN port")?;

    Config::verge().await.edit_draft(|d| {
        d.lan_mixed_port = Some(port);
        d.verge_mixed_port = Some(port);
    });
    Config::verge().await.apply();
    Config::verge().await.data_arc().save_file().await.stringify_err()?;

    CoreManager::global().restart_core().await.stringify_err()?;
    if Config::verge().await.latest_arc().enable_system_proxy.unwrap_or(false) {
        sysopt::Sysopt::global().update_sysproxy().await.stringify_err()?;
    }

    handle::Handle::refresh_clash();
    handle::Handle::refresh_verge();
    logging!(info, Type::Core, "LAN mixed port refreshed to {port}");
    Ok(port)
}

async fn current_mixed_port() -> u16 {
    let runtime = Config::runtime().await;
    let snapshot = runtime.latest_arc();
    snapshot
        .config
        .as_ref()
        .map(IClashTemp::guard_mixed_port)
        .unwrap_or(0)
}

fn random_ports() -> impl Iterator<Item = u16> {
    std::iter::repeat_with(|| {
        let mut buf = [0u8; 2];
        if getrandom::fill(&mut buf).is_err() {
            return 0;
        }
        let span = u32::from(u16::MAX - LAN_PORT_MIN) + 1;
        LAN_PORT_MIN + (u32::from(u16::from_le_bytes(buf)) % span) as u16
    })
}

fn pick_port(
    current: u16,
    candidates: impl Iterator<Item = u16>,
    free: impl Fn(u16) -> bool,
) -> Option<u16> {
    candidates.take(PICK_ATTEMPTS).find(|&port| {
        port >= LAN_PORT_MIN && port != current && !RESERVED_PORTS.contains(&port) && free(port)
    })
}

fn can_bind(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok()
        && UdpSocket::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_skips_current_reserved_low_and_busy_ports() {
        let candidates = [7890, 21, 20000, 40000, 40001].into_iter();
        let port = pick_port(20000, candidates, |p| p != 40000);
        assert_eq!(port, Some(40001));
    }

    #[test]
    fn pick_returns_none_when_all_rejected() {
        let port = pick_port(30000, [30000, 7897, 50000].into_iter(), |_| false);
        assert_eq!(port, None);
    }

    #[test]
    fn random_ports_stay_in_range() {
        assert!(random_ports().take(500).all(|p| p == 0 || p >= LAN_PORT_MIN));
    }
}
