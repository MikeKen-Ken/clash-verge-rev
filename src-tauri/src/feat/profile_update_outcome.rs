#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileUpdateResult {
    Skipped,
    DownloadSucceeded,
    DownloadFailed,
    Applied,
    ActivationFailed,
}

// This is the IPC contract consumed by the frontend. Keep names explicit.
impl serde::Serialize for ProfileUpdateResult {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            Self::Skipped => "skipped",
            Self::DownloadSucceeded => "downloadSucceeded",
            Self::DownloadFailed => "downloadFailed",
            Self::Applied => "applied",
            Self::ActivationFailed => "activationFailed",
        })
    }
}

impl ProfileUpdateResult {
    pub fn downloaded(self) -> bool {
        matches!(self, Self::DownloadSucceeded | Self::Applied | Self::ActivationFailed)
    }

    pub fn from_activation<T, E>(result: &Result<(bool, T), E>) -> Self {
        match result {
            Ok((true, _)) => Self::Applied,
            Ok((false, _)) | Err(_) => Self::ActivationFailed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_failure_does_not_retry_the_download() {
        assert!(ProfileUpdateResult::ActivationFailed.downloaded());
        assert!(ProfileUpdateResult::Applied.downloaded());
        assert!(ProfileUpdateResult::DownloadSucceeded.downloaded());
        assert!(!ProfileUpdateResult::DownloadFailed.downloaded());
        assert!(!ProfileUpdateResult::Skipped.downloaded());
    }
    #[test]
    fn rejected_validation_and_transport_failure_are_not_applied() {
        let rejected: Result<(bool, &str), &str> = Ok((false, "invalid config"));
        let disconnected: Result<(bool, &str), &str> = Err("core disconnected");
        let applied: Result<(bool, &str), &str> = Ok((true, ""));
        assert_eq!(
            ProfileUpdateResult::from_activation(&rejected),
            ProfileUpdateResult::ActivationFailed
        );
        assert_eq!(
            ProfileUpdateResult::from_activation(&disconnected),
            ProfileUpdateResult::ActivationFailed
        );
        assert_eq!(
            ProfileUpdateResult::from_activation(&applied),
            ProfileUpdateResult::Applied
        );
    }

    #[test]
    fn activation_outcomes_have_distinct_ipc_values() {
        assert_eq!(serde_json::to_string(&ProfileUpdateResult::Applied).unwrap(), "\"applied\"");
        assert_eq!(serde_json::to_string(&ProfileUpdateResult::ActivationFailed).unwrap(), "\"activationFailed\"");
    }
}
