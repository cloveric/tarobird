//! Native core for the Electron desktop shell, run as one helper process per
//! trusted WebContents. See `opus-initial-review.md` in the migration lab for
//! the JSONL protocol; stdout carries protocol lines only.
pub mod config;
pub mod desktop_host;
pub mod identity;
pub mod protocol;
pub mod server;
pub mod transport;
#[cfg(target_os = "macos")]
#[path = "../../src-tauri/shared/macos_launch_guard.rs"]
pub mod launch_guard;
#[cfg(windows)]
mod control_job;
