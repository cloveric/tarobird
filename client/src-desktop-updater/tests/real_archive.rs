//! Opt-in acceptance against a real release archive: the production extractor
//! and the installer's staged read-back (Info.plist version + identifier and
//! `codesign --verify --deep --strict`). Skips unless both paths are given:
//!   TAROBOT_UPDATER_REAL_ARCHIVE=<TaroBot.app.tar.gz> \
//!   TAROBOT_UPDATER_REAL_OUTPUT=<new directory under a .noindex parent> \
//!   TAROBOT_UPDATER_REAL_VERSION=<x.y.z> [TAROBOT_UPDATER_REAL_IDENTIFIER=<acceptance id>] \
//!   cargo test --test real_archive -- --nocapture
#![cfg(target_os = "macos")]
use std::{fs::File, io::BufReader, path::PathBuf, process::Command, sync::atomic::AtomicBool, time::Instant};
use tarobot_desktop_updater::{archive, macos_core, native_identity::APP_ID};

#[test]
fn real_signed_archive_extracts_and_passes_the_staged_read_back() {
    let (Some(source), Some(output)) = (std::env::var_os("TAROBOT_UPDATER_REAL_ARCHIVE"), std::env::var_os("TAROBOT_UPDATER_REAL_OUTPUT")) else {
        eprintln!("skipped: TAROBOT_UPDATER_REAL_ARCHIVE / TAROBOT_UPDATER_REAL_OUTPUT not set");
        return;
    };
    let output = PathBuf::from(output);
    assert!(output.is_absolute() && output.components().any(|part| part.as_os_str().to_string_lossy().ends_with(".noindex")),
        "output must be absolute and under a .noindex directory");
    let output = output.join("desktop-updater");
    assert!(!output.exists(), "output must be a new directory");
    std::fs::create_dir_all(&output).unwrap();
    // Same layout as the installer: the bundle's physical parent is `.noindex`.
    let into = output.join("staged.noindex");
    let mut archive_file = File::open(&source).expect("archive");
    let started = Instant::now();
    let app = archive::extract_app(&mut archive_file, &into, &AtomicBool::new(false)).expect("production extractor");
    eprintln!("extracted {} in {:.1}s", app.display(), started.elapsed().as_secs_f64());
    if let Some(version) = std::env::var_os("TAROBOT_UPDATER_REAL_VERSION") {
        // Acceptance packages carry their own identity; releases must be APP_ID.
        let identifier = std::env::var("TAROBOT_UPDATER_REAL_IDENTIFIER").unwrap_or_else(|_| APP_ID.to_owned());
        macos_core::validate_bundle(&app, &version.to_string_lossy(), &identifier).expect("installer read-back");
        eprintln!("read-back ok: version {} identifier {identifier}", version.to_string_lossy());
    }
    let verify = Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict", "--verbose=2"]).arg(&app).output().unwrap();
    eprintln!("{}", String::from_utf8_lossy(&verify.stderr).trim());
    assert!(verify.status.success(), "codesign --verify --deep --strict failed");
}

/// The installed Tauri App updates to the first Electron release through
/// tauri-plugin-updater 2.13.1, which cannot be changed any more. Its macOS
/// `install_inner` extraction loop, verbatim apart from the temp directory:
/// strip the first component of every entry and unpack under the new bundle.
#[test]
fn installed_tauri_updater_can_extract_the_same_archive() {
    let (Some(source), Some(output)) = (std::env::var_os("TAROBOT_UPDATER_REAL_ARCHIVE"), std::env::var_os("TAROBOT_UPDATER_REAL_OUTPUT")) else {
        eprintln!("skipped: TAROBOT_UPDATER_REAL_ARCHIVE / TAROBOT_UPDATER_REAL_OUTPUT not set");
        return;
    };
    let output = PathBuf::from(output);
    assert!(output.is_absolute() && output.components().any(|part| part.as_os_str().to_string_lossy().ends_with(".noindex")),
        "output must be absolute and under a .noindex directory");
    let tmp_extract_dir = output.join("tauri-plugin-updater.noindex/TaroBot.app");
    assert!(!tmp_extract_dir.exists(), "output must be a new directory");
    std::fs::create_dir_all(&tmp_extract_dir).unwrap();
    let decoder = flate2::read::GzDecoder::new(BufReader::new(File::open(&source).unwrap()));
    let mut archive = tar::Archive::new(decoder);
    let result = (|| -> std::io::Result<usize> {
        let mut count = 0;
        for entry in archive.entries()? {
            let mut entry = entry?;
            let collected_path: PathBuf = entry.path()?.iter().skip(1).collect();
            let extraction_path = tmp_extract_dir.join(&collected_path);
            if let Some(parent) = extraction_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            entry.unpack(&extraction_path).map_err(|error| std::io::Error::other(format!("{}: {error}", entry.path().unwrap().display())))?;
            count += 1;
        }
        Ok(count)
    })();
    match &result {
        Ok(count) => eprintln!("tauri-plugin-updater loop unpacked {count} entries"),
        Err(error) => eprintln!("tauri-plugin-updater loop failed: {error}"),
    }
    let count = result.expect("the installed Tauri updater must be able to unpack the release archive");
    let verify = Command::new("/usr/bin/codesign").args(["--verify", "--deep", "--strict"]).arg(&tmp_extract_dir).output().unwrap();
    eprintln!("codesign after tauri-plugin-updater extraction ({count} entries): {}", String::from_utf8_lossy(&verify.stderr).trim());
    assert!(verify.status.success(), "the Tauri updater's own read-back would roll back");
}
