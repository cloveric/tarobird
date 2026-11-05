//! HTTP clients. Release builds trust the OS (rustls-platform-verifier), as
//! the Tauri updater does. Lab builds reach the same GitHub hostnames through a
//! fixture proxy whose CA only lab builds trust.
use crate::net;
use reqwest::Client;
use std::{sync::Arc, time::Duration};

#[cfg(not(feature = "lab"))]
fn tls_config() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = rustls_platform_verifier::Verifier::new(provider.clone())
        .map_err(|_| "github_update_network")?;
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "github_update_network")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

#[cfg(feature = "lab")]
fn tls_config() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let der = std::fs::read(std::env::var_os("TAROBOT_UPDATER_LAB_CA").ok_or("github_update_network")?)
        .map_err(|_| "github_update_network")?;
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(der))
        .map_err(|_| "github_update_network")?;
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| "github_update_network")?
        .with_root_certificates(roots)
        .with_no_client_auth())
}

fn finish(builder: reqwest::ClientBuilder) -> Result<Client, String> {
    #[cfg(feature = "lab")]
    let builder = builder.proxy(
        reqwest::Proxy::all(
            std::env::var("TAROBOT_UPDATER_LAB_PROXY").map_err(|_| "github_update_network")?,
        )
        .map_err(|_| "github_update_network")?,
    );
    #[cfg(not(feature = "lab"))]
    let builder = builder;
    builder.build().map_err(|_| "github_update_network".into())
}

/// GitHub API/OAuth (`asset == false`) or authenticated asset requests.
pub fn github(asset: bool) -> Result<Client, String> {
    finish(net::client_builder(asset, tls_config()?))
}

/// Installer downloads: the Tauri updater's connect/read bounds. The total is
/// longer than Tauri's 120 s because Electron archives are larger; a stalled
/// connection still fails after 20 s without data.
pub fn download(github: bool) -> Result<Client, String> {
    finish(
        Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(net::USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30 * 60))
            .redirect(if github {
                net::asset_redirects()
            } else {
                public_redirects()
            }),
    )
}

/// Public manifests and archives carry no credential; redirects stay on HTTPS.
pub fn public() -> Result<Client, String> {
    finish(
        Client::builder()
            .tls_backend_preconfigured(tls_config()?)
            .user_agent(net::USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(15))
            .redirect(public_redirects()),
    )
}

fn public_redirects() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let url = attempt.url();
        if attempt.previous().len() >= 5
            || url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
        {
            attempt.stop()
        } else {
            attempt.follow()
        }
    })
}
