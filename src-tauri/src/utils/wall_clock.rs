/// Wall-clock due times that survive process restarts.
///
/// `last_at` and `now` are unix timestamps in the same unit as `interval`.
pub fn next_unix_timestamp(last_at: i64, interval: i64, now: i64, just_completed: bool) -> u64 {
    let soon = (now + 2).max(2) as u64;
    if interval <= 0 {
        return soon;
    }
    let due = if last_at <= 0 {
        now
    } else {
        last_at.saturating_add(interval)
    };
    if due > now {
        return due as u64;
    }
    if just_completed {
        now.saturating_add(interval).max(now + 2) as u64
    } else {
        soon
    }
}

pub fn is_due(last_at: i64, interval: i64, now: i64) -> bool {
    if interval <= 0 || last_at <= 0 {
        return true;
    }
    now.saturating_sub(last_at) >= interval
}

#[cfg(test)]
mod tests {
    use super::{is_due, next_unix_timestamp};

    #[test]
    fn first_run_is_due_immediately() {
        assert!(is_due(0, 24 * 3600, 1_700_000_000));
        assert_eq!(next_unix_timestamp(0, 24 * 3600, 1_700_000_000, false), 1_700_000_002);
    }

    #[test]
    fn remaining_time_uses_last_event_not_process_start() {
        let last = 1_700_000_000;
        let interval = 24 * 3600;
        let now = last + 23 * 3600;
        assert!(!is_due(last, interval, now));
        assert_eq!(
            next_unix_timestamp(last, interval, now, false),
            (last + interval) as u64
        );
    }

    #[test]
    fn overdue_on_restart_fires_soon() {
        let last = 1_700_000_000;
        let interval = 24 * 3600;
        let now = last + interval + 60;
        assert!(is_due(last, interval, now));
        assert_eq!(next_unix_timestamp(last, interval, now, false), (now + 2) as u64);
    }

    #[test]
    fn completed_but_still_overdue_waits_a_full_interval() {
        let last = 1_700_000_000;
        let interval = 24 * 3600;
        let now = last + interval + 60;
        assert_eq!(
            next_unix_timestamp(last, interval, now, true),
            (now + interval) as u64
        );
    }
}
