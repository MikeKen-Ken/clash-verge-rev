/// Validate at the native boundary so persisted and frontend-provided URLs
/// follow the same policy as subscription metadata.
pub fn normalize_web_url(raw: &str) -> Result<String, &'static str> {
    let url = tauri::Url::parse(raw.trim()).map_err(|_| "Invalid web URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP and HTTPS URLs are allowed");
    }
    Ok(url.to_string())
}

#[cfg(test)]
mod tests {
    use super::normalize_web_url;

    #[test]
    fn accepts_web_urls() {
        for url in [
            "https://example.com/path?q=1#part",
            "http://127.0.0.1:9090/ui",
            "https://[::1]/",
        ] {
            assert_eq!(normalize_web_url(url).unwrap(), url);
        }
        assert_eq!(
            normalize_web_url(" HTTPS://example.com ").unwrap(),
            "https://example.com/"
        );
    }

    #[test]
    fn rejects_non_web_targets() {
        for url in [
            "",
            "example.com",
            "//example.com",
            "file:///tmp/test",
            "javascript:alert(1)",
            "data:text/html,test",
            "mailto:test@example.com",
            "ms-settings:network",
            "C:\\test.exe",
        ] {
            assert!(normalize_web_url(url).is_err(), "{url}");
        }
    }
}
