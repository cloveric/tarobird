//! Startup arguments are the only source of paths, version and update policy.
//! Electron main fixes them from the signed bundle; no request can change them.
use crate::policy::{self, GithubConfig};
use serde_json::Value;
use std::{
    ffi::OsString,
    path::{Component, PathBuf},
};

pub const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub struct Args {
    /// `{"updater": {...}, "github-updates": {...}}`, the same shape as the
    /// Tauri `plugins` section produced by the release scripts.
    pub config: PathBuf,
    pub app_version: String,
    /// macOS: the running `.app`. Its parent receives the same-volume backup.
    pub app_bundle: PathBuf,
    /// Bundled Host runtime (`node`, `dist/src/index.js`).
    pub resources_dir: PathBuf,
    /// Tauri `app_data_dir()` equivalent; the Host directory is derived from it.
    pub host_state_dir: PathBuf,
    /// Private scratch root for downloads. Never inside the bundle.
    pub work_dir: PathBuf,
}

impl Args {
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, &'static str> {
        let mut slots: [Option<OsString>; 6] = Default::default();
        let mut args = args.into_iter();
        while let Some(flag) = args.next() {
            let index = match flag.to_str() {
                Some("--config") => 0,
                Some("--app-version") => 1,
                Some("--app-bundle") => 2,
                Some("--resources-dir") => 3,
                Some("--host-state-dir") => 4,
                Some("--work-dir") => 5,
                _ => return Err("invalid_arguments"),
            };
            let value = args.next().ok_or("invalid_arguments")?;
            if slots[index].replace(value).is_some() {
                return Err("invalid_arguments");
            }
        }
        let [config, version, bundle, resources, host, work] = slots;
        let path = |value: Option<OsString>| -> Result<PathBuf, &'static str> {
            let path = PathBuf::from(value.ok_or("invalid_arguments")?);
            if !path.is_absolute()
                || path.components().any(|part| matches!(part, Component::ParentDir))
            {
                return Err("invalid_arguments");
            }
            Ok(path)
        };
        let app_version = version
            .ok_or("invalid_arguments")?
            .into_string()
            .map_err(|_| "invalid_arguments")?;
        if !policy::stable_version(&app_version) {
            return Err("invalid_app_version");
        }
        let app_bundle = path(bundle)?;
        if cfg!(target_os = "macos")
            && app_bundle.extension().and_then(|value| value.to_str()) != Some("app")
        {
            return Err("invalid_app_bundle");
        }
        let host_state_dir = path(host)?;
        // A resolved Host directory passed by mistake would become `<host>/host`.
        if host_state_dir.file_name().is_none_or(|name| name == "host") {
            return Err("invalid_host_state_dir");
        }
        let work_dir = path(work)?;
        // Downloads and scratch state stay out of Spotlight like the staged
        // bundles: some ancestor of the scratch root must be `.noindex`.
        if !work_dir.components().any(|part| matches!(part, Component::Normal(name)
            if std::path::Path::new(name).extension().is_some_and(|ext| ext == "noindex")))
        {
            return Err("invalid_work_dir");
        }
        Ok(Self {
            config: path(config)?,
            app_version,
            app_bundle,
            resources_dir: path(resources)?,
            host_state_dir,
            work_dir,
        })
    }
}

/// The public (default) provider reads a Tauri-format manifest from fixed
/// HTTPS endpoints. It receives no credential.
#[derive(Clone, Debug, PartialEq)]
pub struct PublicConfig {
    pub endpoints: Vec<String>,
}

pub enum Provider {
    Github(Result<GithubConfig, String>),
    Default(Option<PublicConfig>),
}

pub struct Settings {
    pub provider: Provider,
    /// Present only when the updater policy itself is acceptable.
    pub pubkey: Option<String>,
}

fn updater_policy(updater: Option<&Value>) -> Option<String> {
    let updater = updater?;
    let key = updater.get("pubkey")?.as_str()?;
    // Same rules as `policy::github_config`: a pinned key, signed versions,
    // no downgrades and none of the plugin's dangerous transport switches.
    (!key.trim().is_empty()
        && key.len() <= 2048
        && updater.get("requireSignedVersion").and_then(Value::as_bool) == Some(true)
        && !updater.get("allowDowngrades").and_then(Value::as_bool).unwrap_or(false)
        && ![
            "allow-downgrades",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "dangerousInsecureTransportProtocol",
            "dangerous-accept-invalid-certs",
            "dangerous-accept-invalid-hostnames",
            "dangerous-insecure-transport-protocol",
        ]
        .iter()
        .any(|name| updater.get(name) == Some(&Value::Bool(true))))
    .then(|| key.to_owned())
}

fn public_endpoints(updater: Option<&Value>) -> Option<Vec<String>> {
    let urls = updater?.get("endpoints")?.as_array()?;
    if urls.is_empty() || urls.len() > 8 {
        return None;
    }
    urls.iter()
        .map(|url| {
            let url = url.as_str().filter(|url| url.len() <= 2048)?;
            let parsed = reqwest::Url::parse(url).ok()?;
            (parsed.scheme() == "https"
                && parsed.host_str().is_some()
                && parsed.username().is_empty()
                && parsed.password().is_none()
                && parsed.fragment().is_none())
            .then(|| url.to_owned())
        })
        .collect()
}

impl Settings {
    pub fn from_value(value: &Value) -> Self {
        let updater = value.get("updater");
        let pubkey = updater_policy(updater);
        let provider = match value.get("github-updates") {
            Some(github) => Provider::Github(policy::github_config(Some(github), updater)),
            None => Provider::Default(
                pubkey
                    .as_ref()
                    .and(public_endpoints(updater))
                    .map(|endpoints| PublicConfig { endpoints }),
            ),
        };
        Self { provider, pubkey }
    }
    pub fn load(path: &std::path::Path) -> Result<Self, &'static str> {
        let info = std::fs::symlink_metadata(path).map_err(|_| "invalid_update_config")?;
        if !info.is_file() || info.len() > MAX_CONFIG_BYTES {
            return Err("invalid_update_config");
        }
        let bytes = std::fs::read(path).map_err(|_| "invalid_update_config")?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_update_config")?;
        if !value.is_object() {
            return Err("invalid_update_config");
        }
        Ok(Self::from_value(&value))
    }
    pub fn configured(&self) -> bool {
        match &self.provider {
            Provider::Github(config) => config.is_ok() && self.pubkey.is_some(),
            Provider::Default(config) => config.is_some(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    const VALID: &[&str] = &[
        "--config", "/b/TaroBot.app/Contents/Resources/update-config.json",
        "--app-version", "1.2.3",
        "--app-bundle", "/b/TaroBot.app",
        "--resources-dir", "/b/TaroBot.app/Contents/Resources/host",
        "--host-state-dir", "/data/com.tarobot.client",
        "--work-dir", "/data/desktop-updates.noindex",
    ];

    #[test]
    fn requires_every_fixed_argument_once() {
        let parsed = Args::parse(args(VALID)).unwrap();
        assert_eq!(parsed.app_version, "1.2.3");
        for skip in (0..VALID.len()).step_by(2) {
            let mut partial = VALID.to_vec();
            partial.drain(skip..skip + 2);
            assert!(Args::parse(args(&partial)).is_err(), "missing {}", VALID[skip]);
        }
        let mut duplicate = VALID.to_vec();
        duplicate.extend(["--work-dir", "/tmp/other.noindex"]);
        assert!(Args::parse(args(&duplicate)).is_err());
        let mut unknown = VALID.to_vec();
        unknown.push("--lab");
        assert!(Args::parse(args(&unknown)).is_err());
    }

    #[test]
    fn rejects_relative_traversing_unstable_or_resolved_inputs() {
        for (index, value) in [
            (1, "relative.json"),
            (5, "/b/../etc"),
            (3, "1.2"),
            (3, "1.2.3-beta"),
            (3, "01.2.3"),
            (9, "/data/x/host"),
            (11, "tmp"),
            (11, "/tmp/work"),
            (11, "/tmp/noindex/work"),
        ] {
            let mut bad = VALID.to_vec();
            bad[index] = value;
            assert!(Args::parse(args(&bad)).is_err(), "{value}");
        }
        #[cfg(target_os = "macos")]
        {
            let mut bad = VALID.to_vec();
            bad[5] = "/b/TaroBot";
            assert_eq!(Args::parse(args(&bad)), Err("invalid_app_bundle"));
        }
    }

    fn updater() -> Value {
        json!({"pubkey":"pinned-key","requireSignedVersion":true,"allowDowngrades":false,"endpoints":["https://updates.example.test/latest.json"]})
    }

    #[test]
    fn github_provider_reuses_the_tauri_policy() {
        let settings = Settings::from_value(&json!({"updater": updater(), "github-updates": {"repository":"owner/repo","clientId":"Iv1.client"}}));
        assert!(matches!(settings.provider, Provider::Github(Ok(_))) && settings.configured());
        let invalid = Settings::from_value(&json!({"updater": updater(), "github-updates": {"repository":"owner/../repo","clientId":"Iv1.client"}}));
        assert!(matches!(invalid.provider, Provider::Github(Err(_))) && !invalid.configured());
        let mut unsigned = updater();
        unsigned["requireSignedVersion"] = json!(false);
        let unsigned = Settings::from_value(&json!({"updater": unsigned, "github-updates": {"repository":"owner/repo","clientId":"Iv1.client"}}));
        assert!(!unsigned.configured());
    }

    #[test]
    fn public_provider_needs_pinned_policy_and_plain_https_endpoints() {
        assert!(Settings::from_value(&json!({"updater": updater()})).configured());
        for patch in [
            json!({"pubkey": ""}),
            json!({"endpoints": []}),
            json!({"endpoints": ["http://updates.example.test/latest.json"]}),
            json!({"endpoints": ["https://user:pass@updates.example.test/latest.json"]}),
            json!({"requireSignedVersion": false}),
            json!({"allowDowngrades": true}),
            json!({"dangerousAcceptInvalidCerts": true}),
        ] {
            let mut value = updater();
            for (key, item) in patch.as_object().unwrap() {
                value[key] = item.clone();
            }
            assert!(!Settings::from_value(&json!({"updater": value})).configured(), "{patch}");
        }
        assert!(!Settings::from_value(&json!({})).configured());
    }
}
