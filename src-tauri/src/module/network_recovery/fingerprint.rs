use network_interface::{NetworkInterface, NetworkInterfaceConfig as _};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;

pub fn capture() -> u64 {
    let mut parts = interface_parts();
    parts.extend(platform_network_parts());
    hash_parts(&parts)
}

fn interface_parts() -> Vec<String> {
    let mut parts = NetworkInterface::show()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|interface| {
            let name = interface.name;
            interface.addr.into_iter().map(move |address| format!("{name}:{address:?}"))
        })
        .collect::<Vec<_>>();
    parts.sort_unstable();
    parts
}

fn command_part(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(windows)]
fn platform_network_parts() -> Vec<String> {
    [
        command_part("route", &["print", "-4"]),
        command_part("ipconfig", &["/all"]),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(target_os = "macos")]
fn platform_network_parts() -> Vec<String> {
    [
        command_part("route", &["-n", "get", "default"]),
        command_part("scutil", &["--dns"]),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_network_parts() -> Vec<String> {
    [
        command_part("ip", &["route", "show", "default"]),
        command_part("resolvectl", &["dns"]),
    ]
    .into_iter()
    .flatten()
    .collect()
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
}
