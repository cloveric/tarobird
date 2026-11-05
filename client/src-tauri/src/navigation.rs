use tauri::Url;

/// Wry invokes this for frames as well as the main document. Local preview
/// documents remain available, but dropped URLs cannot replace the App with a
/// remote page. External links use the OS opener, not WebView navigation.
pub fn allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() { return false; }
    match url.scheme() {
        "widget" => url.host_str() == Some("localhost") && url.path() == "/widget-sandbox.html" && url.port().is_none(),
        "blob" => true,
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || (url.scheme() == "http" && url.host_str() == Some("widget.localhost") && url.port().is_none() && url.path() == "/widget-sandbox.html")
                || dev_url.is_some_and(|dev| matches!(dev.scheme(), "http" | "https") && url.origin() == dev.origin())
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn url(value: &str) -> Url { Url::parse(value).unwrap() }

    #[test]
    fn app_origins_and_local_preview_documents_remain_available() {
        for value in ["tauri://localhost", "tauri://localhost/index.html#chat", "http://tauri.localhost/", "https://tauri.localhost/index.html", "blob:tauri://localhost/preview", "blob:https://tauri.localhost/preview", "about:blank", "about:srcdoc"] {
            assert!(allowed(&url(value), None), "{value}");
        }
    }

    #[test]
    fn external_documents_and_local_files_cannot_replace_the_app() {
        for value in ["https://example.com/", "http://localhost:1420/", "http://127.0.0.1:1420/", "file:///tmp/drop.txt", "data:text/html,replace-app", "javascript:alert(1)", "mailto:test@example.com", "tauri://example.com", "https://tauri.localhost.example.com", "https://tauri.localhost:8443/", "https://user@tauri.localhost/", "about:config"] {
            assert!(!allowed(&url(value), None), "{value}");
        }
    }

    #[test]
    fn development_navigation_is_scoped_to_the_configured_origin() {
        let dev = url("http://localhost:1420/");
        assert!(allowed(&url("http://localhost:1420/src/main.tsx"), Some(&dev)));
        for value in ["http://localhost:1421", "https://localhost:1420", "http://127.0.0.1:1420", "http://user@localhost:1420/", "https://example.com"] {
            assert!(!allowed(&url(value), Some(&dev)), "{value}");
        }
    }
}
