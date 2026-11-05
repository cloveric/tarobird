# Mac in-app updates

The `com.tarobot.client` identity uses a separate `*-tarobot-v` channel. Legacy
`com.tarocub.client` installations keep their old channel and require a one-time
installer transition; never replace old release assets with new-ID packages.
See [the transition checklist](../release-checklist.md).

## User behavior

The Mac private distribution uses Settings → Application updates. Sign in to
GitHub with an account that can read the configured private repository, check
for updates, confirm Download and install, then restart TaroBot after installation.
The first bootstrap upgrade is necessary for older DMG-only installations:
an already-installed binary cannot gain an updater from a server setting alone.

Downloads do not stop work. After the archive's pinned Minisign signature and
signed version pass verification, the App waits up to five minutes for local
tasks and unanswered question cards to settle. Waiting can be canceled. New
queued work remains persisted. Installation does not answer questions, approve
tools, interrupt an active task, clear data, or create a new host identity.

The updater pauses only its bundled App-owned Hub under the shared desktop
start lock. A separately selected standalone CLI runtime or managed CLI service
continues running. A stopped local host remains stopped. A successful update
resumes the bundled host and checks its PID, version, identity and record counts
before displaying Installed. The window still needs an explicit restart.

## Architecture and trust

- `DesktopUpdates.tsx` and `update-controller.ts` expose download, wait, install,
  and host-recovery stages. Confirmation uses the existing application dialog.
- Native `github_updates.rs` keeps OAuth tokens and updater objects out of the
  WebView. GitHub Device Flow needs a public client ID, not a client secret in
  the application. Credentials and refresh tokens stay in the OS Keychain;
  refresh rotation is serialized with logout and supports legacy stored tokens.
- GitHub OAuth's `repo` scope is broader than read-only. The updater itself only
  reads the configured repository's releases/assets and account identity; OAuth
  authorization must still present GitHub's actual scope to the user. Expiring
  access tokens stay enabled. No access token is embedded in the build/feed.
- `macos-tarobot-v<version>` releases, `macos-tarobot-latest.json`, and `darwin-aarch64` archives
  are separate from the Windows channel. A DMG cannot be selected as an updater
  artifact. Currently only Apple Silicon is packaged and verified.
- `macos_update.rs` keeps a same-volume sealed App backup, invokes the private
  `desktop-update` child, uses the native transactional archive installer, validates the
  resulting bundle ID/version/seal, and resumes the Hub. Known install failures
  restore the previous App before resuming it. State databases are never rolled
  back over a possibly migrated schema.
- `src/hub/desktop-update.ts` shares existing drain, exact-PID guarded stop,
  service selection and restart APIs. EOF cancels waiting or resumes a paused
  host; no renderer-supplied state or executable path is accepted. If recovery
  cannot be confirmed, an error and retained App backup replace a success claim.

A sudden process/power failure during filesystem replacement can still require
manual recovery from the retained `.tarobot-update-*` backup. The updater does
not claim transactional recovery across power loss. If the new host cannot
start, its possibly migrated database stays intact for diagnosis. The default
public-feed updater is not this private Mac orchestration path.

The [2026-10-17 audit](day-commit-audit-2026-10-17.md) adds a preparation marker
before copying the App. The next update attempt cleans only marked preparations
for the same App whose owner process is confirmed exited. Beginning replacement
removes the marker and syncs the directory first. Unmarked legacy/recovery copies,
live processes, other Apps and ambiguous process checks are preserved. The native
helper also strips `NODE_OPTIONS`/`NODE_PATH` like normal Hub launches, and its
ready timeout includes lock admission, draining and process exit.

## Build and publication

Configure repository variables `TAROBOT_GITHUB_CLIENT_ID` and
`TAROBOT_UPDATE_PUBLIC_KEY`; store `TAURI_SIGNING_PRIVATE_KEY` and, if encrypted,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as release secrets. Keep the signing key in
a durable protected backup outside the checkout. Changing it without a key
migration prevents existing Apps from accepting future releases.

`npm run desktop:macos --prefix client` builds the shared standalone host, UI,
matching Node/SQLite, sealed `.app`, bootstrap `.dmg`, and signed `.app.tar.gz`.
Missing update settings fail before building. `--unsigned-development` is an
explicit development escape hatch, not a distributable auto-update build.
Production Electron builds require Developer ID signing and a notarization
profile; ad-hoc signing is confined to explicit development builds. Signing and
notarization do not replace an OS permission grant or Keychain authorization.

`.github/workflows/macos-updates.yml` builds and verifies the Mac package.
Publication is opt-in and verifies signature, signed version, source commit,
private repository, numeric release/asset IDs, SHA-256 and complete asset set
before making the draft visible. It reads the published assets back and leaves
other platform channels unchanged. The generic release's latest pointer is not
changed. `publish-macos-update.mjs` accepts `--notes-file` for release notes and
repeatable `--file` arguments for the matching bootstrap DMG and CLI archive.
Those files are also uploaded and checksum-verified before publication. The Mac
workflow builds, clean-installs, packs and extracts the matching CLI package.

CLI impact: no new user-facing host capability is introduced. The internal
`desktop-update` command coordinates native App replacement using the shared
headless lifecycle; normal `tarobot update` remains independent. A shipped
host-affecting release must include the matching standalone package under the
repository release checklist.

## Developer ID signing

Electron packages are signed inside-out by `electron-package.mjs` using
`electron-signing-policy.mjs`. Do not run the historical Tauri re-signing
routine on an Electron bundle: it removes required Chromium JIT rights.

| Code | Entitlements |
| --- | --- |
| Bundled Host Node | `cs.allow-jit`, `cs.disable-library-validation` |
| Electron main App | `cs.allow-jit`, `device.camera`, `device.audio-input` |
| Chromium helper Apps | `cs.allow-jit` |
| Rust helpers, addons and remaining Mach-O | none |

The bundled Node is first on the Host's engine `PATH`. DeepSeek Harness and other
`#!/usr/bin/env node` engines, MCP servers and project commands load npm native addons
that other developers signed ad hoc. With library validation enabled, macOS refused them
("mapping process and mapped file have different Team IDs"). This broke DeepSeek
Harness in the Developer ID builds 1.0.98 and 1.0.99. Upstream Node ships with this
exception; we keep `allow-jit`, add only library validation, and do not grant
debugging, DYLD environment or unsigned-memory exceptions.

Unlock the release keychain privately and run the default
`npm run desktop:macos --prefix client` entry with the variables and explicit
`.noindex` paths in [the migration guide](electron-migration-2026-10-30.md).
`electron-macos-artifacts.mjs` verifies signatures and exact entitlements,
checks a foreign ad-hoc Node addon, notarizes/staples the App and mounts the DMG.
It creates a metadata-free tar archive, then extracts the exact archive through
both the installed Tauri updater algorithm and the new Rust updater before
strict signature read-back and minisign signing. BSD tar extraction alone can
hide AppleDouble entries that break the real updater.

The old `macos-signing.mjs` signing command remains only for historical Tauri
packages. It is not part of the Electron release entry point.

## Verification boundaries

Focused tests cover signed Mac archives, version/tampering refusal, independent
platform channels, publication read-back, cancellation, guarded stop, retained
CLI/stopped hosts, missing records and restart errors. Native Rust tests cover
bundle restoration, OAuth expiry and the GitHub selection policy. Browser
tests cover login, confirmation and progress; they are not native installation
acceptance.

`macos-update-audit` is an opt-in native acceptance binary, excluded from normal
builds. It uses the same Tauri installer, App backup and host pause components
against an external-volume App copy and synthetic host state. Its explicit
loopback-only HTTP feed is test-only and does not change production TLS policy.
Record actual results and remaining GitHub OAuth/production-install acceptance
separately in the delivery notes.

Temporary native build and verification directories must follow the
[unindexed artifact/cleanup policy](../macos-artifact-retention.md). The Mac
publisher invokes guarded retirement only after successful asset read-back.
