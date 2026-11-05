/// Fixed, credential-free shell on a separate origin. No user content is served
/// through this handler. User code runs in an opaque about:srcdoc guest; the
/// relay never forwards guest requests to native commands.
pub fn response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let found = path == "/widget-sandbox.html";
    tauri::http::Response::builder()
        .status(if found { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; base-uri 'none'; form-action 'none'; sandbox allow-scripts")
        .body(if found { include_bytes!("../../public/widget-sandbox.html").to_vec() } else { Vec::new() })
        .expect("static widget response")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_serves_the_fixed_sandbox_shell() {
        assert_eq!(response("/widget-sandbox.html").status(), 200);
        assert_eq!(response("/api/credentials").status(), 404);
        let html = String::from_utf8(response("/widget-sandbox.html").into_body()).unwrap();
        assert!(html.contains("sandbox=\"allow-scripts\""));
        assert!(!html.contains("allow-same-origin"));
    }
}
