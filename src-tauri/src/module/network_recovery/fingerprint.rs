use anyhow::Result;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[path = "platform_snapshot.rs"]
mod platform_snapshot;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetworkFingerprint {
    pub route: u64,
    pub dns: u64,
}

impl NetworkFingerprint {
    pub fn change_from(self, old: Self) -> Option<&'static str> {
        if self.route != old.route {
            Some("route-changed")
        } else if self.dns != old.dns {
            Some("dns-changed")
        } else {
            None
        }
    }
}

pub fn capture() -> Result<NetworkFingerprint> {
    let (route, dns) = platform_snapshot::capture()?;
    Ok(NetworkFingerprint {
        route: hash_parts(route),
        dns: hash_parts(dns),
    })
}

fn hash_parts(mut parts: Vec<String>) -> u64 {
    parts.sort_unstable();
    parts.dedup();
    let mut hasher = DefaultHasher::new();
    parts.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dns_only_change_does_not_request_route_reset() {
        let old = NetworkFingerprint { route: 7, dns: 1 };
        assert_eq!(
            NetworkFingerprint { route: 7, dns: 2 }.change_from(old),
            Some("dns-changed")
        );
        assert_eq!(
            NetworkFingerprint { route: 8, dns: 2 }.change_from(old),
            Some("route-changed")
        );
        assert_eq!(old.change_from(old), None);
    }
    #[test]
    fn order_and_duplicates_do_not_trigger_recovery() {
        assert_eq!(
            hash_parts(vec!["a".into(), "b".into()]),
            hash_parts(vec!["b".into(), "a".into(), "a".into()])
        );
    }
}
