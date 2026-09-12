use super::fingerprint::NetworkFingerprint;
use std::time::{Duration, Instant};

pub struct RecoveryGate {
    duplicate_window: Duration,
    last_success: Option<(Option<NetworkFingerprint>, String, Instant)>,
}

impl RecoveryGate {
    pub fn new(duplicate_window: Duration) -> Self {
        Self {
            duplicate_window,
            last_success: None,
        }
    }

    pub fn is_duplicate(&self, fingerprint: Option<NetworkFingerprint>, kind: &str, now: Instant) -> bool {
        self.last_success
            .as_ref()
            .is_some_and(|(last_fingerprint, last_kind, last_at)| {
                *last_fingerprint == fingerprint
                    && last_kind == kind
                    && now.saturating_duration_since(*last_at) < self.duplicate_window
            })
    }

    pub fn record_success(&mut self, fingerprint: Option<NetworkFingerprint>, kind: &str, now: Instant) {
        self.last_success = Some((fingerprint, kind.to_owned(), now));
    }
}

#[cfg(test)]
mod tests {
    use super::NetworkFingerprint;
    use super::RecoveryGate;
    use std::time::{Duration, Instant};

    #[test]
    fn suppresses_the_same_recent_fingerprint() {
        let now = Instant::now();
        let mut gate = RecoveryGate::new(Duration::from_secs(12));
        let first = Some(NetworkFingerprint { route: 7, dns: 1 });
        gate.record_success(first, "dns-changed", now);

        assert!(gate.is_duplicate(first, "dns-changed", now + Duration::from_secs(5)));
        assert!(!gate.is_duplicate(first, "route-changed", now + Duration::from_secs(5)));
        assert!(!gate.is_duplicate(
            Some(NetworkFingerprint { route: 8, dns: 1 }),
            "dns-changed",
            now + Duration::from_secs(5)
        ));
        assert!(!gate.is_duplicate(first, "dns-changed", now + Duration::from_secs(12)));
    }
}
