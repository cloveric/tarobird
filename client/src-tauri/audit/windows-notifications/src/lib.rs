// Type-check the actual production modules without requiring a Windows linker or SDK.
#![allow(dead_code)]
#[path = "../../../src/notifications/state.rs"]
mod state;
#[path = "../../../src/notifications/windows_payload.rs"]
mod windows_payload;
#[cfg(target_os = "windows")]
#[path = "../../../src/notifications/windows.rs"]
mod windows;
#[cfg(target_os = "windows")]
#[path = "../../../src/notifications/windows_identity.rs"]
mod windows_identity;

#[cfg(target_os = "windows")]
#[path = "../../../src/saved_file_quarantine.rs"]
mod saved_file_quarantine;
