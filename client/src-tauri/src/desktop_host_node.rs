use std::{path::Path, process::Command};

/// The executable and entrypoint come from the native-owned bundled runtime.
pub fn command(node: &Path, entry: &Path) -> Command {
    let mut command = Command::new(node);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        // Tauri returns verbatim (\\?\) resource paths. Node 24's main-entry
        // realpath fails on them before loading our bootstrap diagnostics.
        // Only the native-owned main script needs this; module resolution and
        // host runtime/identity checks retain their existing behavior.
        command.arg("--preserve-symlinks-main");
    }
    command.arg(entry).env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
    command
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::{fs, io::Write, path::PathBuf, process::Stdio, time::{SystemTime, UNIX_EPOCH}};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let directory = std::env::temp_dir().join(format!("tarobot-node-{}-{nonce}", std::process::id())).join("主机 with spaces");
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
        fn script(&self, body: &str) -> PathBuf {
            let file = self.0.join("entry.mjs");
            fs::write(&file, body).unwrap();
            fs::canonicalize(file).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(self.0.parent().unwrap()); }
    }
    fn node() -> PathBuf {
        std::env::var_os("TAROBOT_TEST_NODE").map(PathBuf::from).unwrap_or_else(|| "node.exe".into())
    }

    #[test]
    fn verbatim_main_path_retains_host_arguments_and_piped_input() {
        let fixture = Fixture::new();
        let entry = fixture.script("let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(process.argv.slice(2).join('|') + '|' + input));");
        assert!(entry.as_os_str().to_string_lossy().starts_with(r"\\?\"));
        let directory = fs::canonicalize(&fixture.0).unwrap();
        for arguments in [
            &["desktop-host", "status"][..],
            &["desktop-host", "resume"][..],
            &["desktop-host", "start"][..],
            &["hub", "service", "installer-stop", "--state-dir"][..],
        ] {
            let mut child = command(&node(), &entry)
                .args(arguments).arg(&directory).current_dir(&directory)
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
                .spawn().unwrap();
            child.stdin.take().unwrap().write_all(b"null").unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success(), "{arguments:?}: {}", String::from_utf8_lossy(&output.stderr));
            assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), format!("{}|{}|null", arguments.join("|"), directory.display()));
            assert!(output.stderr.is_empty());
        }
    }

    #[test]
    fn verbatim_main_path_preserves_child_failure_diagnostics() {
        let fixture = Fixture::new();
        let entry = fixture.script("process.stderr.write('HOST_COMMAND_FAILURE'); process.exitCode = 23;");
        let output = command(&node(), &entry).output().unwrap();
        assert_eq!(output.status.code(), Some(23), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(output.stderr, b"HOST_COMMAND_FAILURE");
        assert!(output.stdout.is_empty());
    }
}
