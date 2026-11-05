//! Pure policy checks shared by the native updater and its isolated audit.

use serde_json::Value;
use std::time::{Duration, Instant};
pub const MAX_MANIFEST_BYTES: usize = 256 * 1024;
pub const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;
pub struct GithubConfig {
    pub repository: String,
    pub client_id: String,
}
pub fn github_config(
    github: Option<&Value>,
    updater: Option<&Value>,
) -> Result<GithubConfig, String> {
    let result = (|| {
        let github = github?;
        let repository = github.get("repository")?.as_str()?;
        let client_id = github.get("clientId")?.as_str()?;
        let parts: Vec<_> = repository.split('/').collect();
        if parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || part.len() > 100
                    || *part == "."
                    || *part == ".."
                    || !part
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            })
            || client_id.is_empty()
            || client_id.len() > 100
            || !client_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
        {
            return None;
        }
        let owner = parts[0];
        if owner.len() > 39
            || owner.starts_with('-')
            || owner.ends_with('-')
            || owner.contains("--")
            || !owner
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return None;
        }
        let updater = updater?;
        let key = updater.get("pubkey")?.as_str()?;
        if key.trim().is_empty()
            || key.len() > 2048
            || updater.get("requireSignedVersion")?.as_bool()? != true
            || updater
                .get("allowDowngrades")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            || [
                "allow-downgrades",
                "dangerousAcceptInvalidCerts",
                "dangerousAcceptInvalidHostnames",
                "dangerousInsecureTransportProtocol",
                "dangerous-accept-invalid-certs",
                "dangerous-accept-invalid-hostnames",
                "dangerous-insecure-transport-protocol",
            ]
            .iter()
            .any(|key| updater.get(key) == Some(&Value::Bool(true)))
        {
            return None;
        }
        Some(GithubConfig {
            repository: repository.to_owned(),
            client_id: client_id.to_owned(),
        })
    })();
    result.ok_or_else(|| "github_update_configuration".into())
}
pub fn asset_id(url: &str, repository: &str) -> Option<u64> {
    let id = url.strip_prefix(&format!(
        "https://api.github.com/repos/{repository}/releases/assets/"
    ))?;
    if id.is_empty() || id.starts_with('0') || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    id.parse::<u64>().ok().filter(|id| *id > 0)
}
pub fn stable_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u64>().is_ok()
        })
}
pub struct SelectedRelease {
    pub version: String,
    pub manifest_id: u64,
    pub manifest_url: String,
    pub installers: Vec<(u64, u64)>,
}
impl SelectedRelease {
    pub fn installer(&self, url: &str, repository: &str) -> Result<u64, String> {
        let id = asset_id(url, repository).ok_or("github_update_manifest")?;
        self.installers
            .iter()
            .find_map(|(candidate, size)| (*candidate == id).then_some(*size))
            .ok_or_else(|| "github_update_manifest".into())
    }
}
#[derive(Clone, Copy)]
pub enum UpdatePlatform {
    Windows,
    Macos,
}
impl UpdatePlatform {
    pub fn current() -> Result<Self, String> {
        if cfg!(target_os = "macos") {
            Ok(Self::Macos)
        } else if cfg!(target_os = "windows") {
            Ok(Self::Windows)
        } else {
            Err("github_update_configuration".into())
        }
    }
    fn prefix(self) -> &'static str {
        match self {
            Self::Windows => "windows-tarobot-v",
            Self::Macos => "macos-tarobot-v",
        }
    }
    fn manifest(self) -> &'static str {
        match self {
            Self::Windows => "windows-tarobot-latest.json",
            Self::Macos => "macos-tarobot-latest.json",
        }
    }
    fn extension(self) -> &'static str {
        match self {
            Self::Windows => ".exe",
            Self::Macos => ".app.tar.gz",
        }
    }
}
pub fn select_release(
    releases: &Value,
    repository: &str,
    platform: UpdatePlatform,
) -> Result<Option<SelectedRelease>, String> {
    let releases = releases
        .as_array()
        .filter(|items| items.len() <= 100)
        .ok_or("github_update_response")?;
    let mut candidates: Vec<_> = releases.iter().filter_map(|release| {
        if release.get("draft") != Some(&Value::Bool(false)) || release.get("prerelease") != Some(&Value::Bool(false)) { return None; }
        let version = release.get("tag_name")?.as_str()?.strip_prefix(platform.prefix())?;
        stable_version(version).then_some((release, version))
    }).collect();
    let numeric = |value: &str| value.split('.').map(|part| part.parse::<u64>().unwrap()).collect::<Vec<_>>();
    candidates.sort_by(|(_, a), (_, b)| numeric(b).cmp(&numeric(a)));
    for (release, version) in candidates {
        let assets = release
            .get("assets")
            .and_then(Value::as_array)
            .filter(|assets| assets.len() <= 256)
            .ok_or("github_update_response")?;
        if !assets
            .iter()
            .any(|asset| asset.get("name").and_then(Value::as_str) == Some(platform.manifest()))
        {
            continue;
        }
        let mut selected = SelectedRelease {
            version: version.to_owned(),
            manifest_id: 0,
            manifest_url: String::new(),
            installers: Vec::new(),
        };
        let mut ids = std::collections::HashSet::new();
        for asset in assets {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| name.len() <= 256)
                .ok_or("github_update_response")?;
            let url = asset
                .get("url")
                .and_then(Value::as_str)
                .ok_or("github_update_response")?;
            let id = asset_id(url, repository)
                .filter(|id| {
                    asset.get("id").and_then(Value::as_u64) == Some(*id) && ids.insert(*id)
                })
                .ok_or("github_update_manifest")?;
            let size = asset
                .get("size")
                .and_then(Value::as_u64)
                .filter(|size| *size > 0 && *size <= MAX_INSTALLER_BYTES)
                .ok_or("github_update_response")?;
            if name == platform.manifest() {
                if selected.manifest_id != 0 || size > MAX_MANIFEST_BYTES as u64 {
                    return Err("github_update_manifest".into());
                }
                selected.manifest_id = id;
                selected.manifest_url = url.to_owned();
            } else if name.ends_with(platform.extension()) {
                selected.installers.push((id, size));
            }
        }
        return Ok(Some(selected));
    }
    Ok(None)
}
pub struct FlowCadence {
    pub interval: u64,
    expires_at: Instant,
    next_poll: Instant,
    in_flight: bool,
}
impl FlowCadence {
    pub fn provider_interval(&mut self, now: Instant, interval: u64) -> Result<(), String> {
        if !(1..=1800).contains(&interval) {
            return Err("github_update_response".into());
        }
        self.interval = self.interval.max(interval);
        self.next_poll = now + Duration::from_secs(self.interval);
        Ok(())
    }
    pub fn new(now: Instant, expires: u64, interval: u64) -> Result<Self, String> {
        if !(1..=1800).contains(&expires) || !(1..=60).contains(&interval) {
            return Err("github_update_response".into());
        }
        Ok(Self {
            interval,
            expires_at: now + Duration::from_secs(expires),
            next_poll: now + Duration::from_secs(interval),
            in_flight: false,
        })
    }
    pub fn reserve(&mut self, now: Instant) -> Result<Option<u64>, String> {
        if now >= self.expires_at {
            return Err("github_update_expired".into());
        }
        if self.in_flight {
            return Ok(Some(self.interval));
        }
        if now < self.next_poll {
            let remaining = self.next_poll.duration_since(now);
            return Ok(Some(
                remaining.as_secs() + u64::from(remaining.subsec_nanos() > 0),
            ));
        }
        self.in_flight = true;
        self.next_poll = now + Duration::from_secs(self.interval);
        Ok(None)
    }
    pub fn pending(&mut self, now: Instant, slow_down: bool) {
        if slow_down {
            self.interval = (self.interval + 5).min(600);
        }
        self.in_flight = false;
        self.next_poll = now + Duration::from_secs(self.interval);
    }
    pub fn expired(&self, now: Instant) -> bool {
        now >= self.expires_at
    }
}
#[derive(Default)]
pub struct Generation(u64);
impl Generation {
    pub fn advance(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(1);
        self.0
    }
    pub fn current(&self) -> u64 {
        self.0
    }
    pub fn matches(&self, value: u64) -> bool {
        self.0 == value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn updater() -> serde_json::Value {
        json!({"pubkey":"pinned-key", "requireSignedVersion":true, "allowDowngrades":false})
    }

    #[test]
    fn github_configuration_requires_repository_client_and_signed_version_policy() {
        let github = json!({"repository":"owner/private-app", "clientId":"Ov23.example"});
        assert!(github_config(Some(&github), Some(&updater())).is_ok());
        for github in [
            json!({"repository":"../private-app","clientId":"x"}),
            json!({"repository":"owner/repo/extra","clientId":"x"}),
            json!({"repository":"owner/repo","clientId":""}),
        ] {
            assert!(github_config(Some(&github), Some(&updater())).is_err());
        }
        for updater in [
            json!({"pubkey":"pinned-key"}),
            json!({"pubkey":"", "requireSignedVersion":true}),
            json!({"pubkey":"pinned-key", "requireSignedVersion":true, "allowDowngrades":true}),
            json!({"pubkey":"pinned-key", "requireSignedVersion":true,"dangerousAcceptInvalidCerts":true}),
        ] {
            assert!(github_config(Some(&github), Some(&updater)).is_err());
        }
    }

    #[test]
    fn updater_configuration_alias_cannot_enable_downgrades() {
        let github = json!({"repository":"owner/repo","clientId":"client"});
        let insecure_alias =
            json!({"pubkey":"pinned-key","requireSignedVersion":true,"allow-downgrades":true});
        assert!(github_config(Some(&github), Some(&insecure_alias)).is_err());
    }

    #[test]
    fn repository_owner_uses_github_owner_syntax() {
        for repository in [
            "-owner/repo",
            "owner-/repo",
            "owner_name/repo",
            "owner.name/repo",
            "a--b/repo",
        ] {
            assert!(
                github_config(
                    Some(&json!({"repository":repository,"clientId":"client"})),
                    Some(&updater())
                )
                .is_err(),
                "{repository}"
            );
        }
    }

    #[test]
    fn assets_must_be_canonical_positive_ids_in_exact_repository() {
        assert_eq!(
            asset_id(
                "https://api.github.com/repos/owner/repo/releases/assets/42",
                "owner/repo"
            ),
            Some(42)
        );
        for url in [
            "http://api.github.com/repos/owner/repo/releases/assets/42",
            "https://api.github.com/repos/other/repo/releases/assets/42",
            "https://api.github.com@evil.test/repos/owner/repo/releases/assets/42",
            "https://api.github.com/repos/owner/repo/releases/assets/42?token=secret",
            "https://api.github.com/repos/owner/repo/releases/assets/42#fragment",
            "https://api.github.com/repos/owner/repo/releases/assets/0",
            "https://api.github.com/repos/owner/repo/releases/assets/042",
            "https://api.github.com/repos/owner/repo/releases/assets/%34%32",
        ] {
            assert_eq!(asset_id(url, "owner/repo"), None, "{url}");
        }
    }

    fn release(tag: &str, draft: bool, prerelease: bool, asset: u64) -> serde_json::Value {
        json!({"tag_name":tag,"draft":draft,"prerelease":prerelease,"assets":[{"id":asset,"name":"windows-tarobot-latest.json","size":300,"url":format!("https://api.github.com/repos/owner/repo/releases/assets/{asset}")},{"id":99,"name":"TaroBot-setup.exe","size":200000,"url":"https://api.github.com/repos/owner/repo/releases/assets/99"}]})
    }

    #[test]
    fn selects_highest_stable_windows_release_and_restricts_installer_membership() {
        let releases = json!([
            release("windows-tarobot-v2.0.0", true, false, 11),
            release("windows-tarobot-v2.0.0-beta.1", false, false, 12),
            release("v2.0.0", false, false, 13),
            release("windows-tarobot-v1.2.3", false, true, 14),
            release("windows-tarobot-v1.2.2", false, false, 15),
            release("windows-tarobot-v9.0.0", false, false, 16)
        ]);
        let selected = select_release(&releases, "owner/repo", UpdatePlatform::Windows)
            .unwrap()
            .unwrap();
        assert_eq!(selected.version, "9.0.0");
        assert_eq!(selected.manifest_id, 16);
        assert!(selected
            .installer(
                "https://api.github.com/repos/owner/repo/releases/assets/99",
                "owner/repo"
            )
            .is_ok());
        assert!(selected
            .installer(
                "https://api.github.com/repos/owner/repo/releases/assets/16",
                "owner/repo"
            )
            .is_err());
        assert!(selected
            .installer(&selected.manifest_url, "owner/repo")
            .is_err());
    }

    #[test]
    fn new_identity_never_selects_legacy_identity_releases() {
        for (platform, legacy_tag, legacy_manifest) in [
            (UpdatePlatform::Windows, "windows-v99.0.0", "windows-latest.json"),
            (UpdatePlatform::Macos, "macos-v99.0.0", "macos-latest.json"),
        ] {
            let mut legacy = release(legacy_tag, false, false, 17);
            legacy["assets"][0]["name"] = json!(legacy_manifest);
            assert!(select_release(&json!([legacy]), "owner/repo", platform).unwrap().is_none());
            // Old selectors strip the exact <platform>-v prefix. New tags
            // intentionally cannot pass that discovery step either.
            assert!(!platform.prefix().starts_with(legacy_tag.split("99").next().unwrap()));
        }
    }

    #[test]
    fn unsafe_or_oversized_selected_release_assets_fail_closed() {
        let mut bad = release("windows-tarobot-v1.2.3", false, false, 15);
        bad["assets"][0]["url"] = json!("https://evil.test/manifest");
        assert!(select_release(&json!([bad]), "owner/repo", UpdatePlatform::Windows).is_err());
        let mut bad = release("windows-tarobot-v1.2.3", false, false, 15);
        bad["assets"][0]["size"] = json!(MAX_MANIFEST_BYTES + 1);
        assert!(select_release(&json!([bad]), "owner/repo", UpdatePlatform::Windows).is_err());
    }

    #[test]
    fn selection_does_not_validate_superseded_old_assets_or_compare_versions_as_text() {
        let mut old = release("windows-tarobot-v1.2.9", false, false, 1);
        old["assets"][0]["url"] = json!("https://invalid.test/old");
        let selected = select_release(&json!([old, release("windows-tarobot-v1.2.10", false, false, 2)]), "owner/repo", UpdatePlatform::Windows).unwrap().unwrap();
        assert_eq!(selected.version, "1.2.10");
    }

    #[test]
    fn macos_selects_only_its_own_stable_manifest_and_archive() {
        let windows = release("windows-tarobot-v9.0.0", false, false, 10);
        let mut mac = release("macos-tarobot-v1.2.3", false, false, 11);
        mac["assets"][0]["name"] = json!("macos-tarobot-latest.json");
        mac["assets"][1]["name"] = json!("TaroBot.app.tar.gz");
        let releases = json!([windows, mac.clone()]);
        let selected = select_release(&releases, "owner/repo", UpdatePlatform::Macos)
            .unwrap()
            .unwrap();
        assert_eq!(selected.version, "1.2.3");
        assert!(selected
            .installer(
                "https://api.github.com/repos/owner/repo/releases/assets/99",
                "owner/repo"
            )
            .is_ok());
        mac["assets"][1]["name"] = json!("TaroBot.dmg");
        let selected = select_release(&json!([mac.clone()]), "owner/repo", UpdatePlatform::Macos)
            .unwrap()
            .unwrap();
        assert!(selected
            .installer(
                "https://api.github.com/repos/owner/repo/releases/assets/99",
                "owner/repo"
            )
            .is_err());
        mac["prerelease"] = json!(true);
        assert!(
            select_release(&json!([mac]), "owner/repo", UpdatePlatform::Macos)
                .unwrap()
                .is_none()
        );
        assert!(select_release(
            &json!([release("windows-tarobot-v9.0.0", false, false, 10)]),
            "owner/repo",
            UpdatePlatform::Macos
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn stable_versions_reject_prerelease_build_metadata_and_leading_zeroes() {
        for value in ["1.2.3", "0.0.1", "120.0.99"] {
            assert!(stable_version(value));
        }
        for value in [
            "v1.2.3",
            "01.2.3",
            "1.2",
            "1.2.3.4",
            "1.2.3-beta.1",
            "1.2.3+build",
            "1.2.3\n",
            "18446744073709551616.0.1",
        ] {
            assert!(!stable_version(value), "{value}");
        }
    }

    #[test]
    fn polling_respects_provider_cadence_slowdown_and_expiry() {
        let now = Instant::now();
        let mut cadence = FlowCadence::new(now, 60, 5).unwrap();
        assert_eq!(cadence.reserve(now).unwrap(), Some(5));
        assert_eq!(cadence.reserve(now + Duration::from_secs(5)).unwrap(), None);
        assert!(cadence
            .reserve(now + Duration::from_secs(6))
            .unwrap()
            .is_some());
        cadence.pending(now + Duration::from_secs(6), true);
        assert_eq!(cadence.interval, 10);
        assert_eq!(
            cadence.reserve(now + Duration::from_secs(10)).unwrap(),
            Some(6)
        );
        assert_eq!(
            cadence.reserve(now + Duration::from_secs(60)).unwrap_err(),
            "github_update_expired"
        );
        assert!(FlowCadence::new(now, 0, 5).is_err());
        assert!(FlowCadence::new(now, 1801, 5).is_err());
        assert!(FlowCadence::new(now, 60, 0).is_err());
    }

    #[test]
    fn slowdown_uses_larger_provider_interval_without_shortening_local_cadence() {
        let now = Instant::now();
        let mut cadence = FlowCadence::new(now, 900, 5).unwrap();
        cadence.pending(now, true);
        cadence.provider_interval(now, 30).unwrap();
        assert_eq!(
            cadence.reserve(now + Duration::from_secs(10)).unwrap(),
            Some(20)
        );
        cadence.provider_interval(now, 5).unwrap();
        assert_eq!(cadence.interval, 30);
        assert!(cadence.provider_interval(now, 1801).is_err());
    }

    #[test]
    fn generations_fence_cancel_logout_and_newer_requests() {
        let mut fence = Generation::default();
        let login = fence.advance();
        assert!(fence.matches(login));
        let cancelled = fence.advance();
        assert!(!fence.matches(login));
        let newer_login = fence.advance();
        assert!(!fence.matches(cancelled));
        assert!(fence.matches(newer_login));
    }
}
