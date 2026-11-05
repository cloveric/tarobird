//! Signed desktop updates for the Electron shell. GitHub credentials, release
//! downloads and bundle replacement stay in this process. Electron main only
//! relays opaque flow/offer IDs and the public progress contract.
//!
//! The release policy, credential rules, request rules, keychain serializer
//! and macOS backup/Host pause are the Tauri updater's own files, included
//! unchanged so both shells accept and install exactly the same releases.
#[path = "../../src-tauri/src/github_updates_policy.rs"]
pub mod policy;
#[path = "../../src-tauri/shared/github_update_credential.rs"]
pub mod credential;
#[path = "../../src-tauri/shared/github_update_net.rs"]
pub mod net;
#[path = "../../src-tauri/src/device_keychain.rs"]
pub mod device_keychain;
#[path = "../../src-tauri/shared/native_identity.rs"]
pub mod native_identity;
#[cfg(target_os = "macos")]
#[path = "../../src-tauri/shared/macos_update_core.rs"]
pub mod macos_core;
#[cfg(target_os = "macos")]
#[path = "../../src-tauri/shared/macos_launch_guard.rs"]
pub mod launch_guard;

pub mod archive;
pub mod config;
pub mod manifest;
pub mod server;
pub mod service;
pub mod signature;
pub mod transport;
pub mod vault;
#[cfg(windows)]
pub mod windows_handoff;
