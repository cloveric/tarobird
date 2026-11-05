//! `tarobot-desktop-updater --config <file> --app-version <x.y.z> --app-bundle <.app>
//!  --resources-dir <host runtime> --host-state-dir <app data> --work-dir <scratch>`
//! One process per App, owned by Electron main. Stdout carries only protocol
//! lines; stderr carries nothing (credentials, paths and Host output stay here).
use std::sync::Arc;
use tarobot_desktop_updater::{
    config::{Args, Provider, Settings},
    server,
    service::{Emit, Service},
    vault::Vault,
};

fn vault(settings: &Settings) -> Option<Arc<dyn Vault>> {
    let Provider::Github(Ok(config)) = &settings.provider else { return None };
    #[cfg(feature = "lab")]
    {
        let _ = config;
        let path = std::env::var_os("TAROBOT_UPDATER_LAB_VAULT")?;
        Some(Arc::new(tarobot_desktop_updater::vault::LabFile(path.into())))
    }
    #[cfg(not(feature = "lab"))]
    Some(Arc::new(tarobot_desktop_updater::vault::Keychain::new(&config.repository, &config.client_id)))
}

/// A certificate-signed updater serves only the main executable of its own
/// App, and only that sealed App: its configuration (feed and signing key),
/// install target and Host runtime cannot come from anywhere else.
/// Returns the launcher whose requests alone are served (`None`: unsigned)
/// and whether the stored GitHub credential may be used. Certificate-signed
/// builds allow it only for the production App, not an inspectable acceptance
/// App. Unsigned local builds use the normal OS Keychain access controls;
/// they do not claim the sealed-production launcher boundary.
#[cfg(target_os = "macos")]
fn launch_guard(args: &Args) -> Result<(Option<tarobot_desktop_updater::launch_guard::AuditToken>, bool), &'static str> {
    use tarobot_desktop_updater::launch_guard::{self as guard, Launch};
    let Launch::Verified { bundle, requirement, launcher, production } = guard::verify("Contents/Resources/native/tarobot-desktop-updater")? else { return Ok((None, true)) };
    guard::bound(&args.app_bundle, &bundle, "")?;
    guard::bound(&args.config, &bundle, "Contents/Resources/native/update-config.json")?;
    guard::bound(&args.resources_dir, &bundle, "Contents/Resources/host")?;
    guard::verify_sealed(&bundle, &requirement)?;
    Ok((Some(launcher), production))
}

fn main() {
    let args = match Args::parse(std::env::args_os().skip(1)) {
        Ok(args) => args,
        Err(_) => std::process::exit(2),
    };
    #[cfg(target_os = "macos")]
    let (launcher, credential) = match launch_guard(&args) { Ok(launch) => launch, Err(_) => std::process::exit(77) };
    #[cfg(target_os = "macos")]
    let authorized = move || launcher.as_ref().is_none_or(tarobot_desktop_updater::launch_guard::sent_by);
    #[cfg(not(target_os = "macos"))]
    let authorized = || true;
    let settings = match Settings::load(&args.config) {
        Ok(settings) => settings,
        Err(_) => std::process::exit(2),
    };
    #[cfg(target_os = "macos")]
    let vault = if credential { vault(&settings) } else { None };
    #[cfg(not(target_os = "macos"))]
    let vault = vault(&settings);
    // Opened before anything else: the installer handoff waits on exactly this process.
    #[cfg(windows)]
    let parent = tarobot_desktop_updater::windows_handoff::parent();
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => std::process::exit(2),
    };
    let (handoff, refused) = runtime.block_on(async move {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
        let events = sender.clone();
        let emit: Emit = Arc::new(move |offer, event| {
            let _ = events.send(serde_json::json!({"event": "progress", "offerId": offer, "data": event}).to_string());
        });
        let service = Arc::new(Service::new(args, settings, vault, emit));
        let input = tokio::io::BufReader::new(tokio::io::stdin());
        let refused = server::run_authorized(service.clone(), input, tokio::io::stdout(), sender, receiver, authorized).await;
        (service.take_handoff(), refused)
    });
    if refused { std::process::exit(77); }
    #[cfg(not(windows))]
    let _ = handoff;
    #[cfg(windows)]
    if let Some(installer) = handoff {
        tarobot_desktop_updater::windows_handoff::launch(&installer, parent);
    }
}
