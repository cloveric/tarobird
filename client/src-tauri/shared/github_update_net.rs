//! GitHub request rules shared by the Tauri updater and the Electron update
//! helper. Each caller supplies its own TLS trust; the policy is identical.
use reqwest::{
    header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION},
    Client, ClientBuilder, Response,
};
use serde_json::Value;
use std::time::Duration;
use zeroize::Zeroizing;

pub const DEVICE_URI: &str = "https://github.com/login/device";
pub const USER_AGENT: &str = "TaroBot-private-updater";
pub const MAX_API_BYTES: usize = 4 * 1024 * 1024;

pub fn asset_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        // reqwest strips Authorization on cross-origin redirects. Only GitHub's
        // release storage can receive the short-lived signed CDN destination.
        if attempt.previous().len() >= 5
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !matches!(
                url.host_str(),
                Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
            )
            || url.port_or_known_default() != Some(443)
        {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}
pub fn client_builder(asset: bool, tls: rustls::ClientConfig) -> ClientBuilder {
    Client::builder()
        .tls_backend_preconfigured(tls)
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .redirect(if asset {
            asset_redirects()
        } else {
            reqwest::redirect::Policy::none()
        })
}
pub fn headers(token: &str, asset: bool) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    let mut bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "github_update_login_required")?;
    bearer.set_sensitive(true);
    headers.insert(AUTHORIZATION, bearer);
    headers.insert(
        ACCEPT,
        HeaderValue::from_static(if asset {
            "application/octet-stream"
        } else {
            "application/vnd.github+json"
        }),
    );
    headers.insert(
        "X-GitHub-Api-Version",
        HeaderValue::from_static("2022-11-28"),
    );
    Ok(headers)
}
pub async fn bounded_json(mut response: Response, limit: usize) -> Result<Value, String> {
    match response.status().as_u16() {
        200..=299 => {}
        401 => return Err("github_update_login_required".into()),
        403 | 404 => return Err("github_update_repo_unavailable".into()),
        _ => return Err("github_update_network".into()),
    }
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("github_update_bounds".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "github_update_network")?
    {
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err("github_update_bounds".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "github_update_response".into())
}
pub async fn oauth_with(client: Client, path: &str, body: Value) -> Result<Value, String> {
    let body = Zeroizing::new(serde_json::to_vec(&body).map_err(|_| "github_update_response")?);
    let response = client
        .post(format!("https://github.com/login/{path}"))
        .header(ACCEPT, "application/json")
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|_| "github_update_network")?;
    bounded_json(response, 16 * 1024).await
}
