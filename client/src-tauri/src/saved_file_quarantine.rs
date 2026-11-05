use std::path::Path;

/// Mark incoming attachments before writing their payload, so Launch Services
/// can apply the system's normal download policy when the saved file is opened.
#[cfg(target_os = "macos")]
pub fn mark(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSDictionary, NSString, NSURL, NSURLQuarantinePropertiesKey};

    // Launch Services declares these as CFStringRef. CFString and NSString are
    // toll-free bridged; borrowing the immutable system constants is safe.
    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        static kLSQuarantineTypeKey: &'static NSString;
        static kLSQuarantineTypeInstantMessageAttachment: &'static NSString;
    }

    let path = path.to_str().ok_or("saved_file_unavailable")?;
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    unsafe {
        let properties = NSDictionary::from_slices(
            &[kLSQuarantineTypeKey], &[kLSQuarantineTypeInstantMessageAttachment],
        );
        // The value is the documented quarantine NSDictionary. The OS supplies
        // the timestamp and actual app identity; no credentials or Hub URLs are stored.
        url.setResourceValue_forKey_error(Some(&properties), NSURLQuarantinePropertiesKey)
            .map_err(|_| "saved_file_quarantine_failed".to_string())
    }
}

/// NTFS Internet-zone marker. Failure is surfaced before payload replacement;
/// unsupported filesystems must not be reported as protected downloads.
#[cfg(target_os = "windows")]
pub fn mark(path: &Path) -> Result<(), String> {
    use std::{fs::OpenOptions, io::Write};
    if !path.is_file() { return Err("saved_file_quarantine_failed".into()); }
    let mut stream = path.as_os_str().to_os_string();
    stream.push(":Zone.Identifier");
    let mut file = OpenOptions::new().create(true).truncate(true).write(true).open(stream)
        .map_err(|_| "saved_file_quarantine_failed".to_string())?;
    file.write_all(b"[ZoneTransfer]\r\nZoneId=3\r\n")
        .and_then(|_| file.sync_all()).map_err(|_| "saved_file_quarantine_failed".to_string())
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn mark(_path: &Path) -> Result<(), String> { Ok(()) }

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let next = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("tarobot-quarantine-{}-{nonce}-{next}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn quarantine(path: &Path) -> Option<String> {
        let output = Command::new("/usr/bin/xattr").args(["-p", "com.apple.quarantine"]).arg(path).output().unwrap();
        output.status.success().then(|| String::from_utf8(output.stdout).unwrap())
    }

    #[test]
    fn native_quarantine_marks_documents_and_handler_files_without_changing_bytes_or_permissions() {
        let scratch = Scratch::new();
        for name in ["文档.txt", "harmless.terminal", "harmless.command"] {
            let path = scratch.0.join(name);
            let bytes = b"Harmless attachment fixture; never execute or open.\n";
            fs::write(&path, bytes).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(quarantine(&path).is_none());
            mark(&path).unwrap();
            let attribute = quarantine(&path).expect("system quarantine xattr");
            let flags = u32::from_str_radix(attribute.split(';').next().unwrap(), 16).unwrap();
            assert_ne!(flags & 1, 0, "the system quarantine flag must be set");
            assert_eq!(fs::read(&path).unwrap(), bytes);
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);
        }
    }

    #[test]
    fn quarantine_survives_payload_writes_and_replacement_of_an_existing_file() {
        let scratch = Scratch::new();
        let path = scratch.0.join("existing.txt");
        fs::write(&path, "previous document").unwrap();
        let mut file = fs::OpenOptions::new().write(true).create(true).open(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"previous document");
        mark(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"previous document");
        file.set_len(0).unwrap();
        file.write_all(b"new attachment").unwrap();
        drop(file);
        assert!(quarantine(&path).is_some());
        assert_eq!(fs::read(&path).unwrap(), b"new attachment");
    }

    #[test]
    fn unavailable_target_is_not_reported_as_quarantined() {
        let scratch = Scratch::new();
        assert!(mark(&scratch.0.join("missing.txt")).is_err());
    }

    #[test]
    fn unavailable_target_after_nontruncating_open_preserves_the_previous_document() {
        let scratch = Scratch::new();
        let path = scratch.0.join("existing.txt");
        let moved = scratch.0.join("moved.txt");
        fs::write(&path, "previous document").unwrap();
        let file = fs::OpenOptions::new().write(true).create(true).open(&path).unwrap();
        // A file can move after the dialog/open but before quarantine. Exercise
        // a real OS metadata failure without changing a volume or user setting.
        fs::rename(&path, &moved).unwrap();
        assert!(mark(&path).is_err());
        drop(file);
        assert_eq!(fs::read(&moved).unwrap(), b"previous document");
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    #[test]
    fn mark_of_the_web_preserves_payload_and_rejects_missing_targets() {
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("tarobot-motw-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("fixture.ps1");
        std::fs::write(&target, b"Synthetic test fixture, never execute.").unwrap();
        mark(&target).expect("target filesystem must support Windows download provenance");
        let mut ads = target.as_os_str().to_os_string(); ads.push(":Zone.Identifier");
        assert!(std::fs::read_to_string(ads).unwrap().contains("ZoneId=3"));
        assert_eq!(std::fs::read(&target).unwrap(), b"Synthetic test fixture, never execute.");
        assert!(mark(&root.join("missing.txt")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
