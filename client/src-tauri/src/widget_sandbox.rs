/// Fixed, credential-free shells on a separate origin. No user content is served
/// through this handler. User code runs in an opaque about:srcdoc guest; the
/// relays never forward guest requests to native commands.
pub fn response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let (status, csp, body): (u16, &str, Vec<u8>) = match path {
        "/widget-sandbox.html" => (
            200,
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline' https:; img-src data: https:; media-src https:; font-src data: https:; connect-src https: wss:; frame-src about:; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
            include_bytes!("../../public/widget-sandbox.html").to_vec(),
        ),
        "/plugin-sandbox.html" => (
            200,
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src https: wss:; frame-src about:; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
            include_bytes!("../../public/plugin-sandbox.html").to_vec(),
        ),
        _ => (
            404,
            "default-src 'none'; base-uri 'none'; form-action 'none'; sandbox",
            Vec::new(),
        ),
    };
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", csp)
        .body(body)
        .expect("static widget response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_serves_the_fixed_sandbox_shells() {
        assert_eq!(response("/widget-sandbox.html").status(), 200);
        assert_eq!(response("/plugin-sandbox.html").status(), 200);
        assert_eq!(response("/api/credentials").status(), 404);
        for path in ["/widget-sandbox.html", "/plugin-sandbox.html"] {
            let html = String::from_utf8(response(path).into_body()).unwrap();
            assert!(html.contains("sandbox=\"allow-scripts\""), "{path}");
            assert!(!html.contains("allow-same-origin"), "{path}");
        }
        let plugin_csp = response("/plugin-sandbox.html")
            .headers()
            .get("Content-Security-Policy")
            .and_then(|value| value.to_str().ok())
            .unwrap()
            .to_string();
        assert!(plugin_csp.contains("connect-src https: wss:"));
        assert!(plugin_csp.contains("img-src data: blob: https:"));
        assert!(!plugin_csp.contains("'unsafe-eval'"));
    }
}
