//! Build-time boundary shared with the standalone fixture audit. The host/
//! directory is reused across platforms; a receipt alone cannot prove its bytes.
use std::{fs, io::{Read, Seek, SeekFrom}, path::Path};

#[derive(Clone, Copy)]
enum Runtime { MacArm64, WindowsX64 }

fn binary(path: &Path, runtime: Runtime) -> Result<(), String> {
    let invalid = || format!("wrong or unavailable native binary: {}", path.display());
    let mut file = fs::File::open(path).map_err(|_| invalid())?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header).map_err(|_| invalid())?;
    let matches = match runtime {
        Runtime::MacArm64 => header[..4] == [0xcf, 0xfa, 0xed, 0xfe]
            && u32::from_le_bytes(header[4..8].try_into().unwrap()) == 0x0100_000c,
        Runtime::WindowsX64 => {
            if &header[..2] != b"MZ" { return Err(invalid()); }
            let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
            if offset < 64 { return Err(invalid()); }
            file.seek(SeekFrom::Start(u64::from(offset))).map_err(|_| invalid())?;
            let mut pe = [0u8; 6];
            file.read_exact(&mut pe).map_err(|_| invalid())?;
            &pe[..4] == b"PE\0\0" && u16::from_le_bytes(pe[4..6].try_into().unwrap()) == 0x8664
        }
    };
    if !matches { return Err(invalid()); }
    Ok(())
}

fn addons(directory: &Path, runtime: Runtime) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| format!("missing host dependencies: {}", directory.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file = entry.path();
        if entry.file_type().map_err(|error| error.to_string())?.is_dir() { addons(&file, runtime)?; }
        else if file.extension().and_then(|value| value.to_str()).is_some_and(|value| matches!(value, "node" | "dll" | "dylib")) {
            binary(&file, runtime)?;
        }
    }
    Ok(())
}

pub fn validate(root: &Path, target: &str) -> Result<(), String> {
    // Unit/audit-only builds from a clean checkout need no host. Tauri's bundle
    // resource mapping still requires host/ when producing an installer.
    if !root.exists() { return Ok(()); }
    let (runtime, platform, arch, node, other) = match target {
        "aarch64-apple-darwin" => (Runtime::MacArm64, "darwin", "arm64", "node", "node.exe"),
        "x86_64-pc-windows-msvc" => (Runtime::WindowsX64, "win32", "x64", "node.exe", "node"),
        _ => return Err(format!("no verified full-host runtime for {target}; supported targets are macOS arm64 and Windows x64")),
    };
    let receipt: serde_json::Value = serde_json::from_slice(&fs::read(root.join("runtime-receipt.json"))
        .map_err(|_| "missing host/runtime-receipt.json".to_string())?).map_err(|_| "invalid runtime receipt".to_string())?;
    if receipt["platform"].as_str() != Some(platform) || receipt["arch"].as_str() != Some(arch)
        || receipt["sdk"].as_str() != Some("standalone-no-feishu") {
        return Err(format!("runtime receipt does not match {target}"));
    }
    if root.join(other).exists() { return Err(format!("foreign runtime {other} is still present")); }
    binary(&root.join(node), runtime)?;
    for file in ["package.json", "dist/src/index.js", "client/dist/index.html", "node_modules/sqlite3/build/Release/node_sqlite3.node"] {
        if !root.join(file).is_file() { return Err(format!("incomplete host: missing {file}")); }
    }
    addons(&root.join("node_modules"), runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, sync::atomic::{AtomicUsize, Ordering}};
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(runtime: Runtime) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let root = std::env::temp_dir().join(format!("tb-runtime-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir(&root).unwrap();
            let (platform, arch, node) = match runtime { Runtime::MacArm64 => ("darwin", "arm64", "node"), Runtime::WindowsX64 => ("win32", "x64", "node.exe") };
            fs::write(root.join("runtime-receipt.json"), serde_json::json!({"platform": platform, "arch": arch, "sdk": "standalone-no-feishu"}).to_string()).unwrap();
            for file in ["package.json", "dist/src/index.js", "client/dist/index.html", "node_modules/sqlite3/build/Release/node_sqlite3.node"] {
                fs::create_dir_all(root.join(file).parent().unwrap()).unwrap(); fs::write(root.join(file), b"fixture").unwrap();
            }
            let bytes = header(runtime);
            fs::write(root.join(node), &bytes).unwrap();
            fs::write(root.join("node_modules/sqlite3/build/Release/node_sqlite3.node"), bytes).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn header(runtime: Runtime) -> Vec<u8> {
        let mut bytes = vec![0u8; 128];
        match runtime {
            Runtime::MacArm64 => { bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]); bytes[4..8].copy_from_slice(&0x0100_000cu32.to_le_bytes()); }
            Runtime::WindowsX64 => { bytes[..2].copy_from_slice(b"MZ"); bytes[60..64].copy_from_slice(&64u32.to_le_bytes()); bytes[64..68].copy_from_slice(b"PE\0\0"); bytes[68..70].copy_from_slice(&0x8664u16.to_le_bytes()); }
        }
        bytes
    }
    #[test]
    fn matching_platforms_pass_and_cross_target_reuse_fails() {
        for (runtime, target, foreign) in [(Runtime::MacArm64, "aarch64-apple-darwin", "x86_64-pc-windows-msvc"), (Runtime::WindowsX64, "x86_64-pc-windows-msvc", "aarch64-apple-darwin")] {
            let fixture = Fixture::new(runtime);
            validate(&fixture.0, target).unwrap();
            assert!(validate(&fixture.0, foreign).unwrap_err().contains("receipt"));
            for unsupported in ["x86_64-apple-darwin", "aarch64-pc-windows-msvc", "universal-apple-darwin", "x86_64-unknown-linux-gnu"] { assert!(validate(&fixture.0, unsupported).is_err()); }
        }
    }
    #[test]
    fn a_relabelled_receipt_cannot_hide_foreign_node_or_addons() {
        let fixture = Fixture::new(Runtime::WindowsX64);
        fs::write(fixture.0.join("node.exe"), header(Runtime::MacArm64)).unwrap();
        assert!(validate(&fixture.0, "x86_64-pc-windows-msvc").unwrap_err().contains("node.exe"));
        fs::write(fixture.0.join("node.exe"), header(Runtime::WindowsX64)).unwrap();
        fs::write(fixture.0.join("node_modules/sqlite3/build/Release/node_sqlite3.node"), header(Runtime::MacArm64)).unwrap();
        assert!(validate(&fixture.0, "x86_64-pc-windows-msvc").unwrap_err().contains("node_sqlite3.node"));
    }
    #[test]
    fn missing_or_malformed_receipt_and_mixed_host_are_rejected() {
        let fixture = Fixture::new(Runtime::MacArm64);
        fs::write(fixture.0.join("node.exe"), header(Runtime::WindowsX64)).unwrap();
        assert!(validate(&fixture.0, "aarch64-apple-darwin").unwrap_err().contains("foreign runtime"));
        fs::remove_file(fixture.0.join("node.exe")).unwrap();
        fs::write(fixture.0.join("runtime-receipt.json"), b"not JSON").unwrap();
        assert!(validate(&fixture.0, "aarch64-apple-darwin").is_err());
        fs::remove_file(fixture.0.join("runtime-receipt.json")).unwrap();
        assert!(validate(&fixture.0, "aarch64-apple-darwin").is_err());
    }
    #[test]
    fn wrong_architecture_truncated_headers_and_missing_host_payload_fail() {
        let fixture = Fixture::new(Runtime::WindowsX64);
        let mut bytes = header(Runtime::WindowsX64); bytes[68..70].copy_from_slice(&0xaa64u16.to_le_bytes());
        fs::write(fixture.0.join("node.exe"), bytes).unwrap();
        assert!(validate(&fixture.0, "x86_64-pc-windows-msvc").is_err());
        fs::write(fixture.0.join("node.exe"), b"MZ").unwrap();
        assert!(validate(&fixture.0, "x86_64-pc-windows-msvc").is_err());
        fs::write(fixture.0.join("node.exe"), header(Runtime::WindowsX64)).unwrap();
        fs::remove_file(fixture.0.join("dist/src/index.js")).unwrap();
        assert!(validate(&fixture.0, "x86_64-pc-windows-msvc").unwrap_err().contains("dist/src/index.js"));
    }
}
