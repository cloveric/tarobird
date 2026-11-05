/// A convenience shortcut must never make the window or tray unavailable.
/// Backend errors can contain platform details; log only this fixed message.
pub fn register<E>(attempt: impl FnOnce() -> Result<(), E>, warn: impl FnOnce(&'static str)) {
    if attempt().is_err() {
        warn("Global shortcut unavailable; use the window or tray menu.");
    }
}

/// Logging this optional failure is optional too: a closed stderr pipe must
/// not turn an unavailable shortcut into a failed application startup.
pub fn warn(mut output: impl std::io::Write, message: &str) {
    let _ = writeln!(output, "{message}");
}
