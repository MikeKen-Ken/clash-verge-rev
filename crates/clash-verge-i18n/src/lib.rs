use rust_i18n::i18n;

const DEFAULT_LANGUAGE: &str = "zh";
i18n!("locales", fallback = "zh");

/// 语言解析逻辑在非测试构建中暂未接入（`sync_locale` / `set_locale` 固定 zh），保留给单元测试与后续扩展。
#[cfg(test)]
mod language_resolve {
    #[inline]
    fn locale_alias(locale: &str) -> Option<&'static str> {
        match locale {
            "ja" | "ja-jp" | "jp" => Some("jp"),
            "zh" | "zh-cn" | "zh-hans" | "zh-sg" | "zh-my" | "zh-chs" => Some("zh"),
            "zh-tw" | "zh-hk" | "zh-hant" | "zh-mo" | "zh-cht" => Some("zhtw"),
            _ => None,
        }
    }

    #[inline]
    pub(super) fn resolve_supported_language(language: &str) -> Option<&'static str> {
        if language.is_empty() {
            return None;
        }
        let normalized = language.to_lowercase().replace('_', "-");
        let segments: Vec<&str> = normalized.split('-').collect();
        let supported = rust_i18n::available_locales!();
        for i in (1..=segments.len()).rev() {
            let prefix = segments[..i].join("-");
            if let Some(alias) = locale_alias(&prefix)
                && let Some(&found) = supported.iter().find(|&&l| l.eq_ignore_ascii_case(alias))
            {
                return Some(found);
            }
            if let Some(&found) = supported.iter().find(|&&l| l.eq_ignore_ascii_case(&prefix)) {
                return Some(found);
            }
        }
        None
    }
}

/// 本分支固定为简体中文：不随系统区域或配置文件切换（托盘/原生通知等始终 zh）
#[inline]
pub fn system_language() -> &'static str {
    DEFAULT_LANGUAGE
}

#[inline]
pub fn sync_locale(_language: Option<&str>) {
    rust_i18n::set_locale(DEFAULT_LANGUAGE);
}

#[inline]
pub fn set_locale(_language: &str) {
    rust_i18n::set_locale(DEFAULT_LANGUAGE);
}

#[inline]
pub fn translate(key: &str) -> Cow<'_, str> {
    rust_i18n::t!(key)
}

#[macro_export]
macro_rules! t {
    ($key:expr) => {
        $crate::translate(&$key)
    };
    ($key:expr, $($arg_name:ident = $arg_value:expr),*) => {
        {
            let mut _text = $crate::translate(&$key);
            $(
                _text = _text.replace(&format!("{{{}}}", stringify!($arg_name)), &$arg_value);
            )*
            _text
        }
    };
}

#[cfg(test)]
mod test {
    use super::language_resolve::resolve_supported_language;

    #[test]
    fn test_resolve_supported_language() {
        assert_eq!(resolve_supported_language("en"), Some("en"));
        assert_eq!(resolve_supported_language("en-US"), Some("en"));
        assert_eq!(resolve_supported_language("zh"), Some("zh"));
        assert_eq!(resolve_supported_language("zh-CN"), Some("zh"));
        assert_eq!(resolve_supported_language("zh-Hant"), Some("zhtw"));
        assert_eq!(resolve_supported_language("jp"), Some("jp"));
        assert_eq!(resolve_supported_language("ja-JP"), Some("jp"));
        assert_eq!(resolve_supported_language("fr"), None);
    }
}
