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
`stable` and bounded named/LTS alias chains; missing, looping or unsupported
aliases are not guessed. It does not put all installed Node versions on PATH.

Discovery and the settings API read manager files and directories without
running login shells, interactive profiles, installers or engine programs.
New Bot still refreshes its model catalog through the existing model-discovery
code, which can invoke a detected CLI; no Bot task or restart is submitted. Shell-only custom paths,
unsupported selectors and nonstandard installations can use the manual path.
Windows keeps its existing automatic discovery and gains the same manual
setting/API. Existing service manifests retain their captured environment.

The layouts follow the upstream [nvm usage](https://github.com/nvm-sh/nvm#usage)
and [fnm alias implementation](https://github.com/Schniz/fnm/blob/master/src/alias.rs).
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
