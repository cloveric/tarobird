//! macOS launch guard for the native executables inside TaroBot.app (the
//! device helper, the updater and the migration exporter).
//!
//! Keychain items trust these executables through their code signature, so a
//! certificate-signed copy must serve only the main executable of the App
//! bundle it ships in. The launcher's identity is the audit token the kernel
//! recorded when that process created our stdio sockets (libuv uses
//! socketpairs for child pipes). XNU reports the token of the process that
//! last sent on the peer socket, as it is now; it is not a snapshot of the
//! creator. So the token is checked at start (both pipes, our parent, the main
//! executable of the bundle that contains this executable) and every request must
//! then come from exactly that token (pid and pid version): a process that
//! created our pipes and then exec'd the genuine App, leaving the pipe to
//! another process, is refused at the first request. Nothing comes from argv,
//! the environment or files.
//!
//! "Main executable" is proven, not inferred from a path: the launcher must
//! satisfy one requirement — the same leaf certificate, a TaroBot App
//! identifier, and a code-signature-bound Info.plist naming `tarocub-client` —
//! and its signed main executable must be `Contents/MacOS/tarocub-client` of
//! that bundle. Same-certificate standalone executables (the Host's `node`,
//! the helpers, which are signed `com.tarobot.client` too) have no bound
//! Info.plist and cannot pose as the App even when copied into a bundle.
//!
//! An ad-hoc or unsigned build (development, tests) has no certificate that a
//! Keychain ACL could trust, so it is not restricted.
use core_foundation::{
    array::CFArray,
    base::{CFType, TCFType},
    data::CFData,
    dictionary::CFDictionary,
    string::CFString,
    url::CFURL,
};
use security_framework::{
    certificate::SecCertificate,
    os::macos::code_signing::{Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode},
};
use std::{
    ffi::c_void,
    path::{Path, PathBuf},
    str::FromStr,
};

/// The single code every refusal reports; no detail reaches the caller.
pub const UNVERIFIED: &str = "native_launch_unverified";
/// Electron's main executable in production and acceptance packages.
pub const MAIN_EXECUTABLE: &str = "Contents/MacOS/tarocub-client";
/// Production and development/acceptance App identifiers.
pub const MAIN_IDENTIFIERS: [&str; 2] = ["com.tarobot.client", "com.tarobot.electron.acceptance"];
/// Only this main is production: its fuses refuse inspection and debugging
/// switches. Acceptance mains stay inspectable, so production credentials
/// must never be reachable through them even when their helpers are signed
/// with the production credential identifier.
pub const PRODUCTION_IDENTIFIER: &str = "com.tarobot.client";

#[derive(Debug)]
pub enum Launch {
    /// Ad-hoc or unsigned: development and test builds.
    Unsigned,
    /// Started by the main executable of `bundle`; `requirement` is what that
    /// App's code (and so the sealed bundle) satisfies; `production` when that
    /// main is the production App.
    Verified { bundle: PathBuf, requirement: String, launcher: AuditToken, production: bool },
}

pub type AuditToken = [u32; 8];
const SOL_LOCAL: i32 = 0;
const LOCAL_PEERTOKEN: i32 = 0x006;
const SIGNING_INFORMATION: u32 = 1 << 1; // kSecCSSigningInformation

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecCodeInfoCertificates: core_foundation::string::CFStringRef;
    static kSecCodeInfoMainExecutable: core_foundation::string::CFStringRef;
    static kSecCodeInfoIdentifier: core_foundation::string::CFStringRef;
    fn SecCodeCopySigningInformation(code: *const c_void, flags: u32, information: *mut core_foundation::dictionary::CFDictionaryRef) -> i32;
}
extern "C" {
    fn getsockopt(socket: i32, level: i32, name: i32, value: *mut c_void, length: *mut u32) -> i32;
    fn getppid() -> i32;
    fn CC_SHA1(data: *const c_void, length: u32, digest: *mut u8) -> *mut u8;
}

fn signing_information(code: &SecCode, flags: u32) -> Result<CFDictionary<CFString, CFType>, &'static str> {
    let mut information = std::ptr::null();
    if unsafe { SecCodeCopySigningInformation(code.as_CFTypeRef(), flags, &mut information) } != 0 || information.is_null() {
        return Err(UNVERIFIED);
    }
    Ok(unsafe { CFDictionary::wrap_under_create_rule(information) })
}

/// The requirement the App's own main executable must satisfy.
pub fn main_requirement(leaf: &str) -> String {
    let identifiers = MAIN_IDENTIFIERS.map(|identifier| format!("identifier \"{identifier}\"")).join(" or ");
    let executable = MAIN_EXECUTABLE.rsplit('/').next().unwrap_or_default();
    format!("{leaf} and ({identifiers}) and info [CFBundleExecutable] = \"{executable}\"")
}

/// `certificate leaf = H"…"` for this process, or `None` without a certificate.
fn own_requirement(me: &SecCode) -> Result<Option<String>, &'static str> {
    let information = signing_information(me, SIGNING_INFORMATION)?;
    let key = unsafe { CFString::wrap_under_get_rule(kSecCodeInfoCertificates) };
    let Some(certificates) = information.find(&key) else { return Ok(None) };
    let certificates = certificates.downcast::<CFArray>().ok_or(UNVERIFIED)?;
    let Some(leaf) = certificates.get(0) else { return Ok(None) };
    let leaf = unsafe { SecCertificate::wrap_under_get_rule(*leaf as _) };
    let der = leaf.to_der();
    let mut digest = [0u8; 20];
    unsafe { CC_SHA1(der.as_ptr().cast(), u32::try_from(der.len()).map_err(|_| UNVERIFIED)?, digest.as_mut_ptr()) };
    Ok(Some(format!("certificate leaf = H\"{}\"", digest.iter().map(|byte| format!("{byte:02x}")).collect::<String>())))
}

fn peer_token(fd: i32) -> Result<AuditToken, &'static str> {
    let mut token: AuditToken = [0; 8];
    let mut length = std::mem::size_of::<AuditToken>() as u32;
    if unsafe { getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token.as_mut_ptr().cast(), &mut length) } != 0 || length as usize != std::mem::size_of::<AuditToken>() {
        return Err(UNVERIFIED);
    }
    Ok(token)
}

/// The App bundle that holds `executable` at `relative` (e.g.
/// `Contents/Resources/native/tarobot-desktop-core`).
pub fn bundle_of(executable: &Path, relative: &str) -> Option<PathBuf> {
    let mut bundle = executable;
    for part in Path::new(relative).components().rev() {
        if bundle.file_name()? != part.as_os_str() { return None; }
        bundle = bundle.parent()?;
    }
    (bundle.extension().is_some_and(|extension| extension == "app") && bundle.is_absolute()).then(|| bundle.to_path_buf())
}

/// Both stdio sockets must come from our parent, as one process image.
pub fn launcher_token(stdin: Result<AuditToken, &'static str>, stdout: Result<AuditToken, &'static str>, parent: i32) -> Result<AuditToken, &'static str> {
    let (stdin, stdout) = (stdin?, stdout?);
    // audit_token_t: [5] is the pid, [7] the pid version.
    if stdin != stdout || parent <= 1 || stdout[5] != parent as u32 { return Err(UNVERIFIED); }
    Ok(stdout)
}

/// Checks who started this executable, which sits at `relative` in its App.
pub fn verify(relative: &str) -> Result<Launch, &'static str> {
    let me = SecCode::for_self(Flags::NONE).map_err(|_| UNVERIFIED)?;
    let Some(requirement) = own_requirement(&me)? else { return Ok(Launch::Unsigned) };
    let parsed = SecRequirement::from_str(&requirement).map_err(|_| UNVERIFIED)?;
    me.check_validity(Flags::NONE, &parsed).map_err(|_| UNVERIFIED)?;
    let executable = std::env::current_exe().and_then(|path| path.canonicalize()).map_err(|_| UNVERIFIED)?;
    let bundle = bundle_of(&executable, relative).ok_or(UNVERIFIED)?;
    let parent = unsafe { getppid() };
    let token = launcher_token(peer_token(0), peer_token(1), parent)?;
    let bytes: Vec<u8> = token.iter().flat_map(|part| part.to_ne_bytes()).collect();
    let mut attributes = GuestAttributes::new();
    let data = CFData::from_buffer(&bytes);
    attributes.set_audit_token(data.as_concrete_TypeRef());
    // A pid version that changed (exec) or ended no longer resolves.
    let launcher = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE).map_err(|_| UNVERIFIED)?;
    let main = main_requirement(&requirement);
    launcher.check_validity(Flags::NONE, &SecRequirement::from_str(&main).map_err(|_| UNVERIFIED)?).map_err(|_| UNVERIFIED)?;
    let location = launcher.path(Flags::NONE).ok().and_then(|url| url.to_path()).and_then(|path| path.canonicalize().ok()).ok_or(UNVERIFIED)?;
    let information = signing_information(&launcher, 0)?;
    let key = unsafe { CFString::wrap_under_get_rule(kSecCodeInfoMainExecutable) };
    let executable = information.find(&key).and_then(|url| url.downcast::<CFURL>())
        .and_then(|url| url.to_path()).and_then(|path| path.canonicalize().ok()).ok_or(UNVERIFIED)?;
    let key = unsafe { CFString::wrap_under_get_rule(kSecCodeInfoIdentifier) };
    let identifier = information.find(&key).and_then(|value| value.downcast::<CFString>()).map(|value| value.to_string()).ok_or(UNVERIFIED)?;
    if location != bundle || executable != bundle.join(MAIN_EXECUTABLE) || unsafe { getppid() } != parent { return Err(UNVERIFIED); }
    Ok(Launch::Verified { bundle, requirement: main, launcher: token, production: identifier == PRODUCTION_IDENTIFIER })
}

/// The request just read from stdin was sent by the verified launcher itself.
pub fn sent_by(launcher: &AuditToken) -> bool {
    peer_token(0).is_ok_and(|sender| sender == *launcher)
}

/// One-shot executables have no request stream; the launcher must still prove
/// it holds our stdin by writing `line` (≤ 64 bytes) before any work starts.
/// Bytes are read one at a time so nothing after the line is consumed.
pub fn started_by(launcher: &AuditToken, line: &[u8]) -> bool {
    use std::io::Read;
    let mut received = Vec::with_capacity(line.len() + 1);
    let mut byte = [0u8; 1];
    let mut input = std::io::stdin().lock();
    while received.len() <= 64 {
        match input.read(&mut byte) {
            Ok(1) if byte[0] == b'\n' => return received == line && sent_by(launcher),
            Ok(1) => received.push(byte[0]),
            _ => return false,
        }
    }
    false
}

/// The whole bundle, including resources such as update configuration, is
/// still sealed by the same certificate.
pub fn verify_sealed(bundle: &Path, requirement: &str) -> Result<(), &'static str> {
    let url = CFURL::from_path(bundle, true).ok_or(UNVERIFIED)?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| UNVERIFIED)?;
    let parsed = SecRequirement::from_str(requirement).map_err(|_| UNVERIFIED)?;
    code.check_validity(Flags::NONE, &parsed).map_err(|_| UNVERIFIED)
}

/// `actual` must be exactly `expected` inside the verified bundle.
pub fn bound(actual: &Path, bundle: &Path, expected: &str) -> Result<(), &'static str> {
    let actual = actual.canonicalize().map_err(|_| UNVERIFIED)?;
    let expected = bundle.join(expected).canonicalize().map_err(|_| UNVERIFIED)?;
    if actual == expected { Ok(()) } else { Err(UNVERIFIED) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bundle_is_found_only_at_the_fixed_place() {
        let helper = Path::new("/Applications/TaroBot.app/Contents/Resources/native/tarobot-desktop-core");
        assert_eq!(bundle_of(helper, "Contents/Resources/native/tarobot-desktop-core"), Some(PathBuf::from("/Applications/TaroBot.app")));
        for (path, relative) in [
            ("/tmp/tarobot-desktop-core", "Contents/Resources/native/tarobot-desktop-core"),
            ("/Applications/TaroBot.app/Contents/MacOS/tarobot-desktop-core", "Contents/Resources/native/tarobot-desktop-core"),
            ("/Applications/TaroBot/Contents/Resources/native/tarobot-desktop-core", "Contents/Resources/native/tarobot-desktop-core"),
            ("/x/TaroBot.app/Contents/Resources/native/other", "Contents/Resources/native/tarobot-desktop-core"),
            ("relative.app/Contents/MacOS/tarobot-migration-exporter", "Contents/MacOS/tarobot-migration-exporter"),
        ] {
            assert_eq!(bundle_of(Path::new(path), relative), None, "{path}");
        }
        assert_eq!(bundle_of(Path::new("/A.app/Contents/MacOS/tarobot-migration-exporter"), "Contents/MacOS/tarobot-migration-exporter"), Some(PathBuf::from("/A.app")));
    }
    #[test]
    fn launcher_token_requires_one_parent_image_on_both_pipes() {
        let token = |pid: u32, version: u32| -> Result<AuditToken, &'static str> { Ok([0, 501, 20, 501, 20, pid, 100, version]) };
        assert!(launcher_token(token(42, 7), token(42, 7), 42).is_ok());
        assert!(launcher_token(token(42, 7), token(42, 8), 42).is_err(), "an exec between the two pipes");
        assert!(launcher_token(token(42, 7), token(43, 7), 42).is_err());
        assert!(launcher_token(token(42, 7), token(42, 7), 41).is_err(), "pipes created by another process");
        assert!(launcher_token(token(1, 7), token(1, 7), 1).is_err(), "reparented to launchd");
        assert!(launcher_token(Err(UNVERIFIED), token(42, 7), 42).is_err(), "not a socket");
    }
    #[test]
    fn launcher_must_be_a_bound_tarobot_app_main() {
        let leaf = format!("certificate leaf = H\"{}\"", "ab".repeat(20));
        let requirement = main_requirement(&leaf);
        assert_eq!(requirement, format!("{leaf} and (identifier \"com.tarobot.client\" or identifier \"com.tarobot.electron.acceptance\") and info [CFBundleExecutable] = \"tarocub-client\""));
        assert!(SecRequirement::from_str(&requirement).is_ok(), "the requirement language accepts it");
    }
    #[test]
    fn unsigned_test_builds_are_not_restricted() {
        // cargo's linker signature is ad-hoc: no certificate, so no Keychain
        // ACL can trust this binary by certificate.
        assert!(matches!(verify("Contents/Resources/native/x"), Ok(Launch::Unsigned)));
    }
}
