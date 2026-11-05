//! Extracts a signature-verified `.app.tar.gz` (tauri-bundler layout: one
//! top-level `<Name>.app`) into a private same-volume directory. The plugin
//! strips that first component; the result here is the same bundle tree.
use std::{
    ffi::OsString,
    fs::File,
    io::{BufReader, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub const MAX_ENTRIES: u64 = 250_000;
pub const MAX_UNPACKED_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn install_error<E>(_: E) -> String {
    "github_update_install".into()
}

/// A symlink must stay inside the bundle: relative, and never resolving above
/// the `.app` root (framework `Versions/Current -> A` style links only).
fn contained_link(entry: &Path, target: &Path) -> bool {
    let mut depth = entry.components().count() as i64 - 1;
    for part in target.components() {
        match part {
            Component::Normal(_) => depth += 1,
            Component::CurDir => {}
            Component::ParentDir => {
                depth -= 1;
                if depth < 1 {
                    return false;
                }
            }
            Component::RootDir | Component::Prefix(_) => return false,
        }
    }
    depth >= 1
}

pub fn extract_app(archive: &mut File, into: &Path, cancel: &AtomicBool) -> Result<PathBuf, String> {
    archive.seek(SeekFrom::Start(0)).map_err(install_error)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(BufReader::new(archive)));
    // Ordinary mode bits only (no setuid/setgid/sticky); no foreign xattrs.
    tar.set_preserve_permissions(false);
    tar.set_preserve_mtime(true);
    tar.set_overwrite(false);
    std::fs::create_dir(into).map_err(install_error)?;
    let (mut root, mut entries, mut bytes): (Option<OsString>, u64, u64) = (None, 0, 0);
    for entry in tar.entries().map_err(install_error)? {
        if cancel.load(Ordering::Acquire) {
            return Err("github_update_cancelled".into());
        }
        let mut entry = entry.map_err(install_error)?;
        let path = entry.path().map_err(install_error)?.into_owned();
        let mut parts = path.components();
        let Some(Component::Normal(first)) = parts.next() else {
            return Err(install_error(()));
        };
        if !parts.all(|part| matches!(part, Component::Normal(_)))
            || Path::new(first).extension().and_then(|value| value.to_str()) != Some("app")
            || root.get_or_insert_with(|| first.to_owned()) != first
        {
            return Err(install_error(()));
        }
        entries += 1;
        bytes = bytes.saturating_add(entry.header().size().map_err(install_error)?);
        if entries > MAX_ENTRIES || bytes > MAX_UNPACKED_BYTES {
            return Err("github_update_bounds".into());
        }
        match entry.header().entry_type() {
            tar::EntryType::Regular | tar::EntryType::Directory => {}
            tar::EntryType::Symlink => {
                let target = entry
                    .link_name()
                    .map_err(install_error)?
                    .ok_or_else(|| install_error(()))?;
                if !contained_link(&path, &target) {
                    return Err(install_error(()));
                }
            }
            _ => return Err(install_error(())),
        }
        // `unpack_in` also refuses paths that would leave `into`, including
        // through a previously extracted symlink.
        if !entry.unpack_in(into).map_err(install_error)? {
            return Err(install_error(()));
        }
    }
    let app = into.join(root.ok_or_else(|| install_error(()))?);
    if !std::fs::symlink_metadata(&app).is_ok_and(|info| info.is_dir()) {
        return Err(install_error(()));
    }
    Ok(app)
}

// Extraction only runs for macOS bundles; the fixtures rely on Unix modes
// and unprivileged symlinks.
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;

    fn lab(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("tarobot-updater-archive-{}-{name}.noindex", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn archive(root: &Path, build: impl FnOnce(&mut tar::Builder<flate2::write::GzEncoder<File>>)) -> File {
        let path = root.join("update.tar.gz");
        let file = File::create(&path).unwrap();
        let mut builder = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::fast()));
        build(&mut builder);
        builder.into_inner().unwrap().finish().unwrap().flush().unwrap();
        File::open(path).unwrap()
    }

    fn file(builder: &mut tar::Builder<flate2::write::GzEncoder<File>>, path: &str, body: &[u8], mode: u32) {
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(tar::EntryType::Regular);
        builder.append_data(&mut header, path, body).unwrap();
    }

    fn link(builder: &mut tar::Builder<flate2::write::GzEncoder<File>>, path: &str, target: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Symlink);
        builder.append_link(&mut header, path, target).unwrap();
    }

    #[test]
    fn extracts_one_bundle_with_internal_links_and_plain_modes() {
        let root = lab("ok");
        let mut source = archive(&root, |builder| {
            file(builder, "TaroBot.app/Contents/MacOS/TaroBot", b"exe", 0o4755);
            file(builder, "TaroBot.app/Contents/Frameworks/F.framework/Versions/A/F", b"lib", 0o644);
            link(builder, "TaroBot.app/Contents/Frameworks/F.framework/Versions/Current", "A");
            link(builder, "TaroBot.app/Contents/Frameworks/F.framework/F", "Versions/Current/F");
        });
        let app = extract_app(&mut source, &root.join("staged"), &AtomicBool::new(false)).unwrap();
        assert_eq!(app, root.join("staged/TaroBot.app"));
        assert_eq!(std::fs::read(app.join("Contents/Frameworks/F.framework/F")).unwrap(), b"lib");
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(app.join("Contents/MacOS/TaroBot")).unwrap().permissions().mode();
        assert_eq!(mode & 0o7777, 0o755, "setuid must not survive extraction");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn escaping_mixed_or_special_entries_are_refused() {
        let cases: Vec<(&str, Box<dyn Fn(&mut tar::Builder<flate2::write::GzEncoder<File>>)>)> = vec![
            ("escape-link", Box::new(|b| link(b, "TaroBot.app/Contents/x", "../../outside"))),
            ("absolute-link", Box::new(|b| link(b, "TaroBot.app/Contents/x", "/etc/passwd"))),
            ("two-roots", Box::new(|b| { file(b, "TaroBot.app/a", b"a", 0o644); file(b, "Other.app/b", b"b", 0o644); })),
            ("not-app", Box::new(|b| file(b, "TaroBot/a", b"a", 0o644))),
            ("loose-file", Box::new(|b| file(b, "README", b"a", 0o644))),
            ("hardlink", Box::new(|b| {
                file(b, "TaroBot.app/a", b"a", 0o644);
                let mut header = tar::Header::new_gnu();
                header.set_size(0);
                header.set_entry_type(tar::EntryType::Link);
                b.append_link(&mut header, "TaroBot.app/b", "TaroBot.app/a").unwrap();
            })),
            ("empty", Box::new(|_| {})),
        ];
        for (name, build) in cases {
            let root = lab(name);
            let mut source = archive(&root, |builder| build(builder));
            assert!(extract_app(&mut source, &root.join("staged"), &AtomicBool::new(false)).is_err(), "{name}");
            assert!(!root.parent().unwrap().join("outside").exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn cancellation_stops_before_the_next_entry() {
        let root = lab("cancel");
        let mut source = archive(&root, |builder| file(builder, "TaroBot.app/a", b"a", 0o644));
        assert_eq!(
            extract_app(&mut source, &root.join("staged"), &AtomicBool::new(true)).unwrap_err(),
            "github_update_cancelled"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
