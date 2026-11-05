use std::{process::ExitCode, sync::Arc};
use tarobot_desktop_core::{
    config::Config,
    desktop_host::DesktopHost,
    identity::{Identity, KeyringVault},
    server::{serve_authorized, Services},
    transport::Transport,
};

/// The Keychain service of production device keys (Tauri and Electron).
#[cfg(any(target_os = "macos", test))]
const PRODUCTION_DEVICE_SERVICE: &str = "com.tarobot.client.device";

/// Production device keys only ever serve the production App: an acceptance
/// App is inspectable even when its helper carries the credential identifier.
#[cfg(any(target_os = "macos", test))]
fn service_allowed(service: &str, production_launcher: bool) -> bool {
    production_launcher || service != PRODUCTION_DEVICE_SERVICE
}

// Startup failures write one fixed code to stderr; stdout stays protocol-only.
fn main() -> ExitCode {
    let config = match Config::parse(std::env::args_os().skip(1)) {
        Ok(config) => config,
        Err(code) => { eprintln!("{code}"); return ExitCode::from(64); }
    };
    // Before any Keychain access: a certificate-signed helper serves only the
    // main executable of its own App, and only that App's Host runtime.
    #[cfg(target_os = "macos")]
    let launcher = {
        use tarobot_desktop_core::launch_guard::{self as guard, Launch};
        let launch = guard::verify("Contents/Resources/native/tarobot-desktop-core").and_then(|launch| match launch {
            Launch::Verified { production, .. } if !service_allowed(&config.keyring_service, production) => Err(guard::UNVERIFIED),
            Launch::Verified { bundle, launcher, .. } => guard::bound(&config.resources_dir, &bundle, "Contents/Resources/host").map(|_| Some(launcher)),
            Launch::Unsigned => Ok(None),
        });
        match launch { Ok(launcher) => launcher, Err(code) => { eprintln!("{code}"); return ExitCode::from(77); } }
    };
    let Ok(runtime) = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() else {
        eprintln!("helper_runtime_unavailable");
        return ExitCode::from(70);
    };
    let transport = match runtime.block_on(async { Transport::new() }) {
        Ok(transport) => Arc::new(transport),
        Err(code) => { eprintln!("{code}"); return ExitCode::from(70); }
    };
    let identity = Identity::new(Arc::new(KeyringVault::new(config.keyring_service)), config.state_dir);
    let host = DesktopHost::new(identity.clone(), config.resources_dir, config.host_state_dir);
    let services = Arc::new(Services { identity, transport, host });
    #[cfg(target_os = "macos")]
    let refused = runtime.block_on(serve_authorized(services, tokio::io::stdin(), tokio::io::stdout(),
        move || launcher.as_ref().is_none_or(tarobot_desktop_core::launch_guard::sent_by)));
    #[cfg(not(target_os = "macos"))]
    let refused = runtime.block_on(serve_authorized(services, tokio::io::stdin(), tokio::io::stdout(), || true));
    // Blocking credential calls and Host children cannot hold the exit open.
    runtime.shutdown_timeout(std::time::Duration::from_secs(1));
    if refused { eprintln!("native_launch_unverified"); return ExitCode::from(77); }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_production_app_reaches_production_device_keys() {
        assert!(service_allowed(PRODUCTION_DEVICE_SERVICE, true));
        assert!(!service_allowed(PRODUCTION_DEVICE_SERVICE, false), "an inspectable acceptance App must not reach production keys");
        assert!(service_allowed("com.tarobot.client.device.dev-0123456789abcdef0123", false), "acceptance Apps keep their own dev service");
        assert!(service_allowed("com.tarobot.client.device.dev-0123456789abcdef0123", true));
        assert!(!service_allowed("com.tarobot.client.device", false));
    }
}
