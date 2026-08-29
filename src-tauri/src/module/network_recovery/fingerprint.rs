use anyhow::{Context, Result, ensure};
use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;

pub fn capture() -> Result<u64> {
    let mut parts = interface_parts()?;
    parts.extend(platform_network_parts()?);
    Ok(hash_parts(&parts))
}

fn interface_parts() -> Result<Vec<String>> {
    let mut parts = NetworkInterface::show()
        .context("read network interfaces")?
        .into_iter()
        .flat_map(|interface| {
            let name = interface.name;
            interface.addr.into_iter().map(move |address| format!("{name}:{address:?}"))
        })
        .collect::<Vec<_>>();
    parts.sort_unstable();
    Ok(parts)
}

fn command_part(program: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command
        .output()
        .with_context(|| format!("run {program}"))?;
    ensure!(output.status.success(), "{program} returned {}", output.status);
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn platform_network_parts() -> Result<Vec<String>> {
    Ok(vec![
        stable_windows_network_output(&command_part("route", &["print", "-4"])?),
        stable_windows_network_output(&command_part("ipconfig", &["/all"])?),
    ])
}

#[cfg(target_os = "macos")]
fn platform_network_parts() -> Result<Vec<String>> {
    Ok(vec![
        command_part("route", &["-n", "get", "default"])?,
        command_part("scutil", &["--dns"])?,
    ])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_network_parts() -> Result<Vec<String>> {
    let routes = command_part("ip", &["route", "show", "default"]).or_else(|_| {
        std::fs::read_to_string("/proc/net/route").context("read Linux route table")
    })?;
    let dns = command_part("resolvectl", &["dns"]).or_else(|_| {
        std::fs::read_to_string("/etc/resolv.conf").context("read Linux resolver configuration")
    })?;
    Ok(vec![
        routes,
        dns,
    ])
}

#[cfg(windows)]
fn stable_windows_network_output(output: &str) -> String {
    let mut addresses = output
        .split_whitespace()
        .filter_map(|token| {
            let token = token
                .trim_matches(|character: char| matches!(character, '[' | ']' | ',' | ';'))
                .split('(')
                .next()
                .unwrap_or_default();
            let token = token.split('%').next().unwrap_or_default();
            token.parse::<std::net::IpAddr>().ok().map(|address| address.to_string())
        })
        .collect::<Vec<_>>();
    addresses.sort_unstable();
    addresses.join("\n")
}

fn hash_parts(parts: &[String]) -> u64 {
    let mut hasher = DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::hash_parts;

    #[test]
    fn fingerprint_changes_with_route_or_dns_state() {
        let first = hash_parts(&["interface=wifi".to_owned(), "dns=1.1.1.1".to_owned()]);
        let second = hash_parts(&["interface=wifi".to_owned(), "dns=8.8.8.8".to_owned()]);
        assert_ne!(first, second);
    }

    #[cfg(windows)]
    #[test]
    fn windows_fingerprint_ignores_lease_timestamps() {
        use super::stable_windows_network_output;

        let first = "Lease Obtained. . . : Saturday, August 29, 2026 10:00:00\nDNS Servers . . . : 1.1.1.1";
        let second = "Lease Obtained. . . : Saturday, August 29, 2026 11:00:00\nDNS Servers . . . : 1.1.1.1";
        assert_eq!(stable_windows_network_output(first), stable_windows_network_output(second));
    }

    #[cfg(windows)]
    #[test]
    fn windows_fingerprint_keeps_address_changes() {
        use super::stable_windows_network_output;

        let first = "DNS Servers . . . : 1.1.1.1";
        let second = "DNS Servers . . . : 8.8.8.8";
        assert_ne!(stable_windows_network_output(first), stable_windows_network_output(second));
    }
}
