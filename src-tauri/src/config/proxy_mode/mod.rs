use anyhow::{Result, bail};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClashMode {
    Rule,
    Global,
    Direct,
    Script,
    Offline,
}

impl ClashMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Rule => "rule",
            Self::Global => "global",
            Self::Direct => "direct",
            Self::Script => "script",
            Self::Offline => "offline",
        }
    }

    pub const fn notification_label(self) -> &'static str {
        match self {
            Self::Rule => "Rule",
            Self::Global => "Global",
            Self::Direct => "Direct",
            Self::Script => "Script",
            Self::Offline => "Offline",
        }
    }
}

impl TryFrom<&str> for ClashMode {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self> {
        match value.to_ascii_lowercase().as_str() {
            "rule" => Ok(Self::Rule),
            "global" => Ok(Self::Global),
            "direct" => Ok(Self::Direct),
            "script" => Ok(Self::Script),
            "offline" => Ok(Self::Offline),
            invalid => bail!("Invalid Clash mode: {invalid}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_supported_mode() {
        for (raw, expected) in [
            ("rule", ClashMode::Rule),
            ("GLOBAL", ClashMode::Global),
            ("direct", ClashMode::Direct),
            ("script", ClashMode::Script),
            ("offline", ClashMode::Offline),
        ] {
            assert_eq!(ClashMode::try_from(raw).expect("supported mode"), expected);
        }
    }

    #[test]
    fn rejects_unknown_mode() {
        assert!(ClashMode::try_from("unexpected").is_err());
    }
}
