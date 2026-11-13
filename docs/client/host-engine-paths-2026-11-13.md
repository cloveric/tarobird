# Host engine discovery and manual paths

Issue [#34](https://github.com/cloveric/tarobird/issues/34) reports engines that
work in a terminal but disappear from the desktop Host catalog after restart.
The missing search locations are confirmed in source and isolated fixtures;
the reporter's exact installation and restart sequence remain unverified.

## Behavior

- Settings → Engine programs shows the selected Host's executable detection,
  effective path, selection source and search directories. New Bot has the
  same recovery controls under “Engine missing? Check CLI paths”. Detection
  checks file presence and execution permissions, not sign-in or CLI health.
- A manual absolute path takes precedence over that Host's executable
  environment variable. Clearing it restores the environment variable or
  normal detection. Other engines, config directories and credentials stay
  unchanged. Paths are never shell expressions or command lines.
- Saved paths apply when managed Bot workers start. Existing workers keep
  their processes and environment until an idle restart; saving does not
  interrupt tasks. The settings survive Host restarts and state backups.
- Only the Host owner can read or change paths. Saves validate the target,
  check the read revision under a file mutex and recheck authorization before
  the atomic rename. Request receipts make retries idempotent. App and CLI
  verify the saved revision by reading it back; an unknown outcome needs a
  read, not an automatic new write. Audit records omit executable paths.
- Invalid settings do not silently select a different executable. Existing
  workers continue; new launches wait for the settings file to be repaired.
  Owner API responses use `503 engine_settings_unavailable`; App, CLI and doctor
  explain how to preserve and inspect the original file. Failed restart attempts
  retain the previous worker error log instead of replacing it with a repeated
  settings warning. Recovery does not delete or automatically rebuild the file.

## Discovery boundary

`host-cli/environment.ts` is shared by foreground Hosts, desktop-launched Hosts,
detached services and generated service environments. Native desktop helpers
bootstrap the bundled Node; the shared Host then adds the manager fallbacks.
No Rust path list or mobile-native code needs a separate copy of this logic.

On macOS/Linux, discovery retains the existing search order and appends
existing Volta/Bun bin directories, asdf/mise shims, fnm's default alias and
the one nvm version selected by its default alias. Explicit inherited PATH
selections precede these fallbacks. Standard manager-root environment variables
are honored when present. The nvm reader supports numeric versions, `node`,
`stable` (nvm's alias for `node`, the newest installed version) and bounded
named/LTS alias chains; missing, looping or unsupported aliases are not
guessed. It does not put all installed Node versions on PATH. Without
`FNM_DIR`, fnm's base directory is the first that exists of the XDG data
directory (`~/.local/share/fnm`, also on macOS), the legacy `~/.fnm`, and on
macOS `~/Library/Application Support/fnm`; a directory fnm itself would not
use is not searched.

Discovery and the settings API read manager files and directories without
running login shells, interactive profiles, installers or engine programs.
New Bot still refreshes its model catalog through the existing model-discovery
code, which can invoke a detected CLI; no Bot task or restart is submitted. Shell-only custom paths,
unsupported selectors and nonstandard installations can use the manual path.
Windows keeps its existing automatic discovery and gains the same manual
setting/API. Existing service manifests retain their captured environment.

The layouts follow the upstream [nvm usage](https://github.com/nvm-sh/nvm#usage),
[fnm alias implementation](https://github.com/Schniz/fnm/blob/master/src/alias.rs)
and [fnm base directory order](https://github.com/Schniz/fnm/blob/master/src/directories.rs).
This change upgrades no dependencies or engine CLIs.

## Entry points and verification

- Owner API: `GET/PUT /api/settings/engines`, capability `engines.settings.v1`.
- CLI: `tarobird engines status`, `engines set` and `engines reset`, using the
  same authenticated owner API. See [operator guide](../host-cli.md).
- Contracts: `client-protocol/engine-settings.ts`; private persisted state:
  `runtime/host-engine-settings.ts`; revision/receipt writes:
  `hub/engine-settings.ts`; launch propagation: `hub/bot-manager.ts`.
- Focused regressions: `host-engine-discovery`, `host-engine-settings`,
  `host-engine-path`, `hub-bot-manager`, `host-cli-*`, `gateway-environment`.
  Fixtures cover minimal-PATH foreground/detached processes, worker restore,
  unchanged running workers, explicit overrides, invalid paths, concurrency,
  authorization, receipts and damaged settings.
- Browser regressions: `engine-settings`, `new-bot-catalog`, `creation`,
  `settings-language`, `settings-lifecycle`. These cover desktop/phone widths,
  English/Chinese, themes, validation, lost replies and Enter-key routing.

Source, fixture process and Chromium evidence are separate from an installed
App release, physical Windows/macOS startup and the reporter's own machine.
This implementation publishes no release and does not change the owner's
installed App or saved Host settings.

## Review follow-up

Independent engine and UI reviews were checked against source and isolated
reproductions before applying changes. New Bot preserves a still-available
engine, model, effort and approval choice across path saves. Dirty or pending
path saves prevent creation; an uncertain Bot creation freezes path edits until
its idempotent retry settles. Configuring another engine does not silently
replace the user's selected engine. If a refreshed catalog no longer offers the
selected model or effort, the form asks for a new selection and retains the
approval preference.

The path editor ignores IME confirmation keys, maintains keyboard focus and
uses the existing secondary button style. Error recovery remains visible after
cancel or clear failure. Role/capability loss clears cached private settings and
the unsaved-draft guard. Leading/trailing whitespace is rejected by the owner
API instead of being accepted by detection and failing during process launch.

Regressions include the former failures: API error classification and unchanged
invalid/future-format files, preservation of worker stderr after restart,
selection and stricter permissions, pending writes, IME Enter, focus/cancel,
visible reread controls, and role changes during editing. Browser checks use
isolated Chromium Hosts; they do not establish installed-App or physical-device
acceptance. No dependency, release or live Host settings change is included.

## Audit follow-up (2026-11-13)

A post-1.3.1 audit reproduced seven defects in isolated fixtures before the
repairs below. Each has a regression that failed on the previous source.

- **fnm location.** Discovery looked only in macOS Application Support (or
  XDG on Linux). It now follows fnm's own order, so a current macOS install in
  `~/.local/share/fnm` and a legacy `~/.fnm` are found.
- **nvm `stable`.** It was resolved to the highest even major. It is nvm's
  alias for `node`, so the newest installed version is selected.
- **New Bot re-detection.** A completed read of the path panel (opening it,
  "re-detect" or "read again") now reloads the engine list when availability
  differs, or when the list itself had failed to load, keeping a
  still-available engine/model choice. A newly installed CLI no longer
  requires closing and reopening the dialog. While a creation result is
  unconfirmed ("retry create"), such a read does not reload the list: the
  frozen request and the form stay as submitted.
- **Unsaved path draft.** While a draft blocks creation, the form says so
  beside the create button, including when the path section is collapsed.
- **First engine read failure.** A path saved before the engine list was
  ever read no longer freezes the placeholder choice; the engine's default
  model, effort and approval are applied when the list arrives.
- **Manual restart with damaged settings.** A stopped Bot's manual restart
  returns `engine_settings_unavailable` instead of "Hub is stopping"; the App
  shows the existing repair guidance for it. The worker log notice and the
  automatic retry remain.
- **Doctor fallback.** With an invalid terminal environment, doctor still
  applies the saved manual paths, and reports damaged settings (no engines,
  repair hint) together with the invalid variable name.

### Manual paths to interpreter scripts

A manual path may point to a script whose first line is `#!/usr/bin/env node`
(the usual npm global layout under nvm/fnm). Detection checks only that the
file exists and is executable, so it reports the CLI as detected even when
the Host's worker PATH has no `node`; the Bot then fails at launch. The Host
does **not** add the script's directory to PATH: the owner selected one file,
and that directory also holds other globally installed programs which would
become implicitly runnable. The supported remedies are to select the version
as the manager's default (so discovery adds it), add the interpreter's
directory to the Host environment PATH, or point the manual path at a
standalone binary or a wrapper with an absolute interpreter. A read-only
warning for an unresolved interpreter is a possible later addition; it is not
part of this repair.

### Follow-up verification

- Negative regressions failed first on 86c5913: 9 Host cases (`host-engine-discovery`,
  `host-cli-doctor-environment`, `host-engine-settings`) and 4 Chromium cases
  (`engine-settings`). A fifth Chromium case covers the unconfirmed-creation
  guard; it fails on the repair without that guard, since 86c5913 never
  reloads on a read. After the repair, `engine-settings` passes 21 cases
  (the 16 existing ones unchanged), and `host-engine-path`, `new-bot-catalog`,
  `operations` and `creation` pass.
- The fnm order was read from upstream source; no fnm or nvm binary was run.
  Windows discovery is unchanged and was not exercised. No dependency,
  release, installed App or live Host setting is part of this follow-up.

### UI recovery and reused-panel follow-up

The path panel is reused in Settings and New Bot. Save/clear feedback now stays
inside the engine card that initiated the operation, including after cancelling
an unconfirmed save. Failed re-detection keeps its recovery control at the foot
of the list. Keyboard focus returns to that control or the affected engine;
read-back is still required before another write after an uncertain outcome.

The reused panel now carries its own theme-token warning styles, spacing and
phone touch sizes rather than depending on the Settings container. Its New Bot
entry and path actions have 44 px phone targets, with 16 px input text. Existing
desktop action sizes and palettes are retained. New Bot directs supported Hosts
to in-place path checking; older Hosts retain the reopen guidance.

The additional Chromium regressions first failed on the previous build. They
cover lower-card clear/save failures, cancel and read-back, failed re-detection,
keyboard focus and New Bot phone controls. Disabled engine-option assertions
now check the option's native `disabled` property: the label-wrapped option
locator otherwise resolves its enabled state through the parent select, which
both hid unavailable-option regressions and caused a false failure.

This is App presentation and interaction only. The headless CLI, Host settings
API, persisted paths, authorization, idempotency and worker restart policy are
unchanged; no CLI command changes are needed. Chromium viewport checks do not
establish installed-App, mobile keyboard or physical-device acceptance. This
follow-up does not publish a release or change an installed App.

Verification for this UI follow-up: client translation/type/build checks and
the Host build passed; the 36 Chromium cases in `engine-settings`,
`new-bot-catalog` and `creation`, plus 22 `host-engine-settings` / `host-engine-path`
guard tests, passed. Independent review covered six additional Settings/New Bot
viewport, locale and theme combinations with failure injection and keyboard
checks. This retains the physical-device boundary above.
