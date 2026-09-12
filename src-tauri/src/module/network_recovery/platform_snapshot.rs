use anyhow::{Context, Result, ensure};
use std::process::Command;

fn command(program: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        command.creation_flags(0x0800_0000);
    }
    let output = command.output().with_context(|| format!("run {program}"))?;
    ensure!(output.status.success(), "{program} returned {}", output.status);
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

// Restrict route evidence to default interfaces, excluding unrelated adapters.
#[cfg(windows)]
pub fn capture() -> Result<(Vec<String>, Vec<String>)> {
    let json = command(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT],
    )?;
    let mut snapshot: serde_json::Value =
        serde_json::from_str(json.trim()).context("parse default network snapshot")?;
    Ok((
        serde_json::from_value(snapshot["route"].take())?,
        serde_json::from_value(snapshot["dns"].take())?,
    ))
}

#[cfg(windows)]
const WINDOWS_SNAPSHOT: &str = r#"
$ErrorActionPreference = 'Stop'
$routes = @()
foreach ($family in @('IPv4', 'IPv6')) {
    $prefix = if ($family -eq 'IPv4') { '0.0.0.0/0' } else { '::/0' }
    $candidates = @(Get-NetRoute -AddressFamily $family | Where-Object DestinationPrefix -eq $prefix | ForEach-Object {
        $iface = Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily $family
        if ($iface.ConnectionState -eq 'Connected') {
            [pscustomobject]@{ Index = $_.InterfaceIndex; Family = $family; Hop = $_.NextHop; Cost = ($_.RouteMetric + $iface.InterfaceMetric) }
        }
    } | Sort-Object Cost, Index, Hop)
    if ($candidates.Count -gt 0) { $routes += $candidates[0] }
}
$route = @($routes | ForEach-Object {
    "$($_.Family):$($_.Index):$($_.Hop)"
    Get-NetIPAddress -InterfaceIndex $_.Index -AddressFamily $_.Family | Where-Object AddressState -eq 'Preferred' | ForEach-Object { "address:$($_.InterfaceIndex):$($_.IPAddress)/$($_.PrefixLength)" }
})
$dns = @($routes | ForEach-Object {
    Get-DnsClientServerAddress -InterfaceIndex $_.Index | ForEach-Object { "$($_.InterfaceIndex):$($_.AddressFamily):$($_.ServerAddresses -join ',')" }
})
@{ route = @($route); dns = @($dns) } | ConvertTo-Json -Compress
"#;

#[cfg(target_os = "macos")]
pub fn capture() -> Result<(Vec<String>, Vec<String>)> {
    let output = command("route", &["-n", "get", "default"])?;
    let mut route: Vec<String> = output
        .lines()
        .filter_map(|line| {
            let (key, value) = line.trim().split_once(':')?;
            ["destination", "gateway", "interface"]
                .contains(&key)
                .then(|| format!("{key}:{}", value.trim()))
        })
        .collect();
    if let Some(interface) = output.lines().find_map(|line| line.trim().strip_prefix("interface:")) {
        add_interface_addresses(&mut route, interface.trim())?;
    }
    let dns = command("scutil", &["--dns"])?;
    Ok((route, dns.lines().map(str::to_owned).collect()))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn capture() -> Result<(Vec<String>, Vec<String>)> {
    let mut route = Vec::new();
    for family in ["-4", "-6"] {
        let output = command("ip", &[family, "-j", "route", "show", "default"])?;
        let mut entries: Vec<serde_json::Value> = serde_json::from_str(&output)?;
        entries.sort_by_key(|entry| entry["metric"].as_u64().unwrap_or(0));
        if let Some(entry) = entries.first() {
            let interface = entry["dev"].as_str().context("default route has no interface")?;
            route.push(format!(
                "{family}:{interface}:{}:{}",
                entry["gateway"], entry["prefsrc"]
            ));
            add_interface_addresses(&mut route, interface)?;
        }
    }
    let dns = command("resolvectl", &["dns"]).or_else(|_| std::fs::read_to_string("/etc/resolv.conf"))?;
    Ok((route, dns.lines().map(str::to_owned).collect()))
}

#[cfg(unix)]
fn add_interface_addresses(parts: &mut Vec<String>, name: &str) -> Result<()> {
    use network_interface::{NetworkInterface, NetworkInterfaceConfig};
    for interface in NetworkInterface::show()?
        .into_iter()
        .filter(|interface| interface.name == name)
    {
        parts.extend(interface.addr.into_iter().map(|address| format!("{name}:{address:?}")));
    }
    Ok(())
}
