//! The tauri-plugin-updater manifest format (static `platforms` map or a
//! dynamic `url`/`signature` pair). Existing releases and the release scripts
//! keep producing it, so the Tauri App can update to the Electron App and back.
use crate::policy;
use serde_json::Value;

pub const MAX_NOTES_BYTES: usize = 64 * 1024;

pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub url: String,
    pub signature: String,
}

pub fn os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}
pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}
/// The installer kind the plugin derives from the bundle type.
pub fn bundle_type() -> &'static str {
    if cfg!(target_os = "windows") {
        "nsis"
    } else {
        "app"
    }
}
/// `{os}-{arch}-{installer}` first, then `{os}-{arch}`, like the plugin.
pub fn targets() -> [String; 2] {
    [
        format!("{}-{}-{}", os(), arch(), bundle_type()),
        format!("{}-{}", os(), arch()),
    ]
}

pub fn endpoint(template: &str, current: &str) -> String {
    let mut url = template.to_owned();
    for (name, value) in [
        ("current_version", current),
        ("target", os()),
        ("arch", arch()),
        ("bundle_type", bundle_type()),
    ] {
        url = url
            .replace(&format!("{{{{{name}}}}}"), value)
            .replace(&format!("%7B%7B{name}%7D%7D"), value);
    }
    url
}

fn numeric(version: &str) -> [u64; 3] {
    let mut parts = version.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    [
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    ]
}
/// Both sides are `policy::stable_version`; compare numerically, never as text.
pub fn newer(remote: &str, current: &str) -> bool {
    numeric(remote) > numeric(current)
}

pub fn parse(manifest: &Value, targets: &[String]) -> Result<Release, String> {
    let fail = || "github_update_manifest".to_owned();
    let object = manifest.as_object().ok_or_else(fail)?;
    let version = object
        .get("version")
        .or_else(|| object.get("name"))
        .and_then(Value::as_str)
        .map(|version| version.strip_prefix('v').unwrap_or(version))
        .filter(|version| policy::stable_version(version))
        .ok_or_else(fail)?
        .to_owned();
    let notes = match object.get("notes") {
        None | Some(Value::Null) => None,
        Some(Value::String(notes)) if notes.len() <= MAX_NOTES_BYTES => Some(notes.clone()),
        Some(_) => return Err(fail()),
    };
    let platform = match object.get("platforms") {
        Some(platforms) => {
            let platforms = platforms.as_object().ok_or_else(fail)?;
            targets
                .iter()
                .find_map(|target| platforms.get(target))
                .ok_or_else(fail)?
        }
        None => manifest,
    };
    let url = platform
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| url.len() <= 2048)
        .ok_or_else(fail)?;
    let parsed = reqwest::Url::parse(url).map_err(|_| fail())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(fail());
    }
    let signature = platform
        .get("signature")
        .and_then(Value::as_str)
        .filter(|signature| !signature.is_empty() && signature.len() <= 4096)
        .ok_or_else(fail)?;
    Ok(Release {
        version,
        notes,
        url: url.to_owned(),
        signature: signature.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn targets() -> Vec<String> {
        vec!["darwin-aarch64-app".into(), "darwin-aarch64".into()]
    }

    #[test]
    fn static_manifest_prefers_the_installer_specific_target() {
        let manifest = json!({"version":"1.2.3","notes":"n","platforms":{
            "darwin-aarch64":{"url":"https://api.github.com/repos/o/r/releases/assets/2","signature":"generic"},
            "darwin-aarch64-app":{"url":"https://api.github.com/repos/o/r/releases/assets/1","signature":"specific"}}});
        let release = parse(&manifest, &targets()).unwrap();
        assert_eq!((release.version.as_str(), release.signature.as_str()), ("1.2.3", "specific"));
        let generic = json!({"version":"v1.2.3","platforms":{"darwin-aarch64":{"url":"https://x.test/a","signature":"s"}}});
        assert_eq!(parse(&generic, &targets()).unwrap().version, "1.2.3");
        let dynamic = json!({"name":"1.2.3","url":"https://x.test/a","signature":"s"});
        assert_eq!(parse(&dynamic, &targets()).unwrap().url, "https://x.test/a");
    }

    #[test]
    fn invalid_or_foreign_manifests_fail_closed() {
        for manifest in [
            json!({"version":"1.2.3-beta","url":"https://x.test/a","signature":"s"}),
            json!({"version":"1.2","url":"https://x.test/a","signature":"s"}),
            json!({"version":"1.2.3","url":"http://x.test/a","signature":"s"}),
            json!({"version":"1.2.3","url":"https://u:p@x.test/a","signature":"s"}),
            json!({"version":"1.2.3","url":"https://x.test/a"}),
            json!({"version":"1.2.3","url":"https://x.test/a","signature":""}),
            json!({"version":"1.2.3","platforms":{"windows-x86_64":{"url":"https://x.test/a","signature":"s"}}}),
            json!({"version":"1.2.3","notes":7,"url":"https://x.test/a","signature":"s"}),
            json!([]),
        ] {
            assert!(parse(&manifest, &targets()).is_err(), "{manifest}");
        }
    }

    #[test]
    fn versions_compare_numerically_and_templates_expand() {
        assert!(newer("1.10.0", "1.9.9"));
        assert!(!newer("1.2.3", "1.2.3"));
        assert!(!newer("1.2.2", "1.2.3"));
        let url = endpoint("https://u.test/{{target}}/{{arch}}/{{current_version}}/%7B%7Bbundle_type%7D%7D", "1.0.0");
        assert_eq!(url, format!("https://u.test/{}/{}/1.0.0/{}", os(), arch(), bundle_type()));
    }
}
