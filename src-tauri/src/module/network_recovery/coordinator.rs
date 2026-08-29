use std::time::{Duration, Instant};

pub struct RecoveryGate {
    duplicate_window: Duration,
    last_success: Option<(Option<u64>, Instant)>,
}

impl RecoveryGate {
    pub fn new(duplicate_window: Duration) -> Self {
        Self {
            duplicate_window,
            last_success: None,
        }
    }

    pub fn is_duplicate(&self, fingerprint: Option<u64>, now: Instant) -> bool {
        self.last_success
            .as_ref()
            .is_some_and(|(last_fingerprint, last_at)| {
                *last_fingerprint == fingerprint
                    && now.saturating_duration_since(*last_at) < self.duplicate_window
            })
    }

    pub fn record_success(&mut self, fingerprint: Option<u64>, now: Instant) {
        self.last_success = Some((fingerprint, now));
    }
}

#[cfg(test)]
mod tests {
    use super::RecoveryGate;
    use std::time::{Duration, Instant};

    #[test]
    fn suppresses_the_same_recent_fingerprint() {
        let now = Instant::now();
        let mut gate = RecoveryGate::new(Duration::from_secs(12));
        gate.record_success(Some(7), now);

        assert!(gate.is_duplicate(Some(7), now + Duration::from_secs(5)));
        assert!(!gate.is_duplicate(Some(8), now + Duration::from_secs(5)));
        assert!(!gate.is_duplicate(Some(7), now + Duration::from_secs(12)));
    }
}
