//! Startup arguments are the only source of paths and the credential service.
//! The Electron main process fixes them; no request can change them later.
use std::{ffi::OsString, path::PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Tauri `app_local_data_dir()` equivalent: holds the installation marker.
    pub state_dir: PathBuf,
    /// OS credential service, e.g. `com.tarobot.client.device`.
    pub keyring_service: String,
    /// Tauri `resource_dir()/host` equivalent: bundled `node` and `dist/src/index.js`.
    pub resources_dir: PathBuf,
    /// Tauri `app_data_dir()` equivalent. The Host directory is resolved from it
    /// with the shared native identity rules, never taken verbatim.
    pub host_state_dir: PathBuf,
}

pub fn service_valid(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

impl Config {
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, &'static str> {
        let (mut state, mut service, mut resources, mut host) = (None, None, None, None);
        let mut args = args.into_iter();
        while let Some(flag) = args.next() {
            let slot = match flag.to_str() {
                Some("--state-dir") => &mut state,
                Some("--keyring-service") => &mut service,
                Some("--resources-dir") => &mut resources,
                Some("--host-state-dir") => &mut host,
                _ => return Err("invalid_arguments"),
            };
            let value = args.next().ok_or("invalid_arguments")?;
            if slot.replace(value).is_some() { return Err("invalid_arguments"); }
        }
        let path = |value: Option<OsString>| -> Result<PathBuf, &'static str> {
            let path = PathBuf::from(value.ok_or("invalid_arguments")?);
            if !path.is_absolute() || path.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
                return Err("invalid_arguments");
            }
            Ok(path)
        };
        let keyring_service = service.ok_or("invalid_arguments")?.into_string().map_err(|_| "invalid_arguments")?;
        if !service_valid(&keyring_service) { return Err("invalid_arguments"); }
        let host_state_dir = path(host)?;
        // A resolved Host directory passed by mistake would become `<host>/host`.
        if host_state_dir.file_name().is_none_or(|name| name == "host") { return Err("invalid_host_state_dir"); }
        Ok(Self { state_dir: path(state)?, keyring_service, resources_dir: path(resources)?, host_state_dir })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<OsString> { values.iter().map(OsString::from).collect() }
    const VALID: &[&str] = &["--state-dir", "/tmp/a", "--keyring-service", "com.tarobot.client.device.test-1",
        "--resources-dir", "/tmp/r", "--host-state-dir", "/tmp/com.tarobot.client"];

    #[test]
    fn requires_every_fixed_path_once_and_rejects_ambiguity() {
        let config = Config::parse(args(VALID)).unwrap();
        assert_eq!(config.host_state_dir, PathBuf::from("/tmp/com.tarobot.client"));
        for skip in (0..VALID.len()).step_by(2) {
            let mut partial = VALID.to_vec(); partial.drain(skip..skip + 2);
            assert!(Config::parse(args(&partial)).is_err(), "missing {}", VALID[skip]);
        }
        let mut duplicate = VALID.to_vec(); duplicate.extend(["--state-dir", "/tmp/b"]);
        assert!(Config::parse(args(&duplicate)).is_err());
        let mut unknown = VALID.to_vec(); unknown.push("--dev");
        assert!(Config::parse(args(&unknown)).is_err());
        let mut dangling = VALID.to_vec(); dangling.push("--state-dir");
        assert!(Config::parse(args(&dangling)).is_err());
    }

    #[test]
    fn rejects_relative_traversing_or_resolved_host_paths_and_unsafe_services() {
        for (index, value) in [(1, "relative"), (1, "/tmp/../etc"), (5, "r"), (7, "/tmp/x/host"), (7, "/")] {
            let mut bad = VALID.to_vec(); bad[index] = value;
            assert!(Config::parse(args(&bad)).is_err(), "{value}");
        }
        for service in ["", "a b", "svc/../x", "svc\0", &"a".repeat(129)] {
            let mut bad = VALID.to_vec(); bad[3] = service;
            assert!(Config::parse(args(&bad)).is_err(), "{service:?}");
        }
    }
}
