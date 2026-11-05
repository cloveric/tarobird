#[path = "../src/optional_shortcut.rs"]
mod optional_shortcut;

#[test]
fn occupied_shortcut_does_not_abort_the_remaining_setup_or_expose_error_details() {
    let mut warnings = Vec::new();
    let mut continued = false;
    let mut setup = || -> Result<(), &'static str> {
        optional_shortcut::register(|| Err("private backend details / secret"), |message| warnings.push(message));
        continued = true;
        Ok(())
    };
    assert!(setup().is_ok());
    assert!(continued);
    assert_eq!(warnings, ["Global shortcut unavailable; use the window or tray menu."]);
}

#[test]
fn available_shortcut_is_registered_once_without_warning() {
    let mut calls = 0;
    optional_shortcut::register(|| { calls += 1; Ok::<(), ()>(()) }, |_| panic!("unexpected warning"));
    assert_eq!(calls, 1);
}

#[test]
fn occupied_shortcut_and_broken_log_pipe_still_allow_setup_to_continue() {
    struct ClosedPipe;
    impl std::io::Write for ClosedPipe {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> { Err(std::io::ErrorKind::BrokenPipe.into()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    optional_shortcut::register(|| Err(()), |message| optional_shortcut::warn(ClosedPipe, message));
    // Reaching the next setup step must not depend on stderr accepting writes.
    let mut log = Vec::new();
    optional_shortcut::register(|| Err(()), |message| optional_shortcut::warn(&mut log, message));
    assert_eq!(String::from_utf8(log).unwrap(), "Global shortcut unavailable; use the window or tray menu.\n");
}
