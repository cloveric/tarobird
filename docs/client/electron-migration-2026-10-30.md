# Electron desktop migration

Latest source audit: [Kimi findings independently reviewed by Codex and Opus 5.5](electron-kimi-audit-2026-10-30.md), following the [DeepSeek review](electron-deepseek-audit-2026-10-30.md). Current App 1.0.121 / Host 0.1.466 source fixes are unpublished. The owner has paused publication and local installation until a new explicit release request. Windows runtime remains explicitly deferred. Historical checkpoints below do not override this hold.

Status: **desktop implementation and follow-up compatibility fixes are in place.
Windows execution is deferred at the owner's request (2026-10-30); production
activation remains open. The Windows deferral is not a passing result and does
not block independently scoped Mac work.
Not released or installed over the owner's App**. The default desktop build/dev/release commands
now use Electron. The historical foundation checkpoint below describes the
initial state; the current extension and evidence are recorded first.

The [final implementation, acceptance receipts and remaining gates](electron-migration-acceptance-2026-10-30.md) supersede the intermediate evidence below.

## Current implementation and acceptance

- The existing React UI uses an explicit desktop bridge. Browser and Capacitor
  paths remain supported; Electron does not impersonate Tauri globals.
- Main owns the window, tray, protocol activation, single instance, shortcuts,
  autostart, notifications, permission prompts, attachment save/open/reveal,
  screenshot and transactional updater. Native identity, pinned transport and
  canonical Host control remain Rust. Bundled Node remains an independent Host.
- The read-only legacy reader opens the old origin in WKWebView/WebView2 before
  HostApp mounts. It exports a bounded, installation-bound authenticated logical
  snapshot; main verifies all parts and blobs, then Chromium imports with durable
  receipts. Source databases are retained; outbox IDs and attachment bytes are
  preserved. A missing/invalid source never silently becomes a fresh identity.
- On macOS the bare reader has an **embedded Info.plist**. A real persisted-source
  test disproved the assumption that another executable in Contents/MacOS would
  automatically inherit the outer bundle identity. Without the embedded identity
  it read an empty store. The reader now checks its bundle ID before opening the
  store. There is no nested duplicate App or second LaunchServices registration.
- Legacy non-exportable WebCrypto keys preserve their records but explicitly fence
  those hosts for re-pairing. Native Keychain/Credential Manager references keep
  their existing service and installation binding. A new signed Mac core has the
  same designated signing requirement as the previous App; actual production
  credential use is not inferred from that comparison.
- Follow-up signed-fixture testing reproduced a cross-executable Mac Keychain
  deletion failure despite successful reading and signing. Shared exact-item
  deletion fixes it; the real disposable-key read/sign/delete/post-delete checks
  passed. Windows now has installer and persistent WebView2 content acceptance
  entries, with explicit incomplete results for unexecuted scopes. See Phase 6
  of the acceptance document for the remaining runtime boundary.
- Mac updater tests cover signature rejection, bounded extraction, Host draining,
  cancellation, rollback and restart recovery. Windows retains NSIS identity,
  custom install directory, notification shortcut and uninstall/reset behavior.
  Its updater hands off to a separate installer helper. Windows execution on a
  real machine remains a release gate; cross-compilation is separate evidence.
- Opus found and fixed legacy Windows autostart duplication, stale Mac LaunchAgent
  recovery and opening a saved document after an external edit. The Windows
  transient CLI is owned by a kill-on-close Job Object with silent breakaway, so
  the detached canonical Host is outside its lifetime.

Current isolated evidence retains each package's exact source binding. The
Phase 6 Mac package has clean-source metadata; earlier Phase 5 packages were
dirty acceptance builds. None is a production release receipt:

| Boundary | Evidence | Remaining boundary |
| --- | --- | --- |
| Real old WebView → Electron | Persistent WKWebView seed, native export/HMAC verification, packaged Chromium import; pairing, draft, 150 KB File and one original outbox ID preserved | Existing customer installation and Windows WebView2 |
| Full Mac entrypoint | New default build produced a complete package; bundled Host start/local pairing, close-hide/activate, legacy fence and teardown passed | Clean release candidate and production replacement |
| Native Mac UI | CUA observed real window, setup, connected isolated Host, pairing entry, settings version and quit; test Host then stopped and its key retired | Production replacement |
| Mac signing | Developer ID acceptance package passed strict signature and foreign addon loading; native credential reader's designated requirement matches old App | Actual existing-user credential access; final reader notarization passed |
| Final Mac artifacts | Final DMG mounted; both actual updater extraction paths passed; all 30 signed targets checked | App notarization/staple/Gatekeeper passed for acceptance package; production release pending |
| Windows | Full Windows installer built and extracted; all 23 PE payloads passed runtime dependency checks; native runtime tests linked | Run installer/update/uninstall/notifications/autostart on Windows |
| iOS/Android/web | Shared source still compiles; native/mobile branches retained | Physical-device regression where shared adapters changed |

## Building and release credentials

Install dependencies with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; the pinned Electron
runtime is downloaded to the explicit `.noindex` cache by the packaging tool.
Do not run the Electron npm postinstall or extract Electron.app into node_modules.
Use Node 24, Rust, and cargo-xwin/LLVM for Windows cross-builds. Windows packaging
requires NSIS; the helper plugin is downloaded from its pinned upstream release
and checked by byte length and SHA-256 before use.

```sh
export TAROBOT_DESKTOP_OUTPUT=/absolute/output.noindex/new-build
export TAROBOT_ELECTRON_CACHE=/absolute/cache.noindex/electron
export TAROBOT_DESKTOP_TARGET=/absolute/cache.noindex/desktop-targets
npm run desktop:build --prefix client -- --development --platform darwin --arch arm64
# Use a short explicit profile: macOS Host control sockets have a path limit.
export TAROBOT_DESKTOP_DEV_PROFILE=/short/path.noindex/dev
npm run desktop:dev --prefix client
```

Production builds require a clean `TAROBOT_SOURCE_COMMIT`. Mac additionally needs
`APPLE_SIGNING_IDENTITY`, `TAROBOT_APPLE_TEAM_ID`, `TAROBOT_NOTARY_PROFILE` and,
when a custom keychain holds the identity/profile, `TAROBOT_SIGNING_KEYCHAIN`.
Signed updates retain the existing `TAURI_SIGNING_PRIVATE_KEY` format and
`TAROBOT_UPDATE_PUBLIC_KEY`; the cryptographic format does not select the shell.
Private GitHub updates use `TAROBOT_GITHUB_REPOSITORY` and
`TAROBOT_GITHUB_CLIENT_ID`; a public feed may instead set `TAROBOT_UPDATE_URL`.
Windows production without signed updates is explicitly supported; it does not
pretend that an unsigned installer has an authenticated automatic-update feed.

The hosted Mac workflow prepares an ephemeral runner-only keychain with secrets
`APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_NOTARY_PRIVATE_KEY`, and variables `TAROBOT_APPLE_TEAM_ID`,
`APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`. It deletes that keychain afterwards.
These Apple CI values were **not configured** in the repository when checked;
only the existing updater signing secret and GitHub update variables existed.
No signing credentials have been uploaded or copied into Git by this migration.
Local signing remains independently available. CI billing and missing hosted
credentials must be reported separately from local test results.

## Historical foundation checkpoint

## Implementation

`client/src-desktop-core/` is a standalone Rust helper. It reuses the existing
installation binding, keychain, Ed25519 action format, pinned TLS verifier,
canonical Host directory resolution and fixed bundled Node launcher. The
Tauri-dependent transport/controller orchestration is adapted to bounded JSONL.
Neither its executable paths nor its credential service can be chosen by a
renderer request. Four launch arguments are mandatory. `--host-state-dir`
means the **App data root**, not its `host` child.

`client/electron/` implements the corresponding Electron main process and
sandboxed preload boundary. A renderer receives a versioned `tarobotDesktop`
interface, without a fake Tauri global, Node objects or arbitrary IPC access.
Only the owned main frame at `tarobot://app/index.html` can invoke native
commands. Main assigns RPC IDs and socket channels. Each document gets its own
helper; navigation, destruction and crashes retire its authority and pending
results. A preload-only nonce is issued after main-frame navigation commits;
old documents cannot use the new generation while a load is in progress or
after Chromium reuses a frame object. Events are checked against the active
document and channel.

The main process bounds in-flight requests, pipe writes and incremental JSONL
reads. Rust additionally enforces slot/credit limits, request argument schemas,
certificate binding, fixed local Host actions and protocol framing. Only main
may invoke `helper_info` or `net_reset`.

Static resources use an explicit custom scheme, realpath confinement, CSP and
MIME checks. Widget resources have a separate origin and receive no preload
capability. Popups, arbitrary navigation, webviews, unpinned renderer network
requests and unimplemented permission requests are denied. Permission UX must
be implemented before connecting the shipping UI; a denied or missing feature
is not treated as successfully migrated.

`client/scripts/electron-runtime.mjs` downloads the pinned Electron runtime,
checks its published package checksums and extracts it under a physical
`.noindex` cache. The preload bundler and acceptance launcher also require
`.noindex` output roots. They never default to production App or Host state.
Do not invoke `electron/install.js` or an unconfigured `npx electron`: those
may extract a development `.app` inside `node_modules`.

## Protocol

Request: `{id, command, args}`. Response: `{id, result}` or
`{id, error: {code, message}}`. Native error codes retain the existing transport
and local-controller vocabulary. Socket events are
`{event: "transport", document, channel, payload}`. HTTP reads return
`{data: "<base64>"}` with at most 256 KiB decoded bytes; an empty string is EOF.

Limits: 12 MiB request line; 1 MiB Rust response; 6 MiB + 1 KiB Rust event
(escaped 1 MiB WebSocket frame); 7 MiB main-process receive line; 256 in-flight
RPCs; two request-line limits of queued pipe bytes. Socket ACK/credit rules
remain enforced by Rust. A malformed native response closes the helper rather
than being interpreted as a successful command.

## Verification at the foundation checkpoint

- 35 Node tests pass: sender/frame/origin isolation, process-only command
  rejection, framing/bounds, exact error propagation, timeout and lifecycle
  handling, document/channel ownership, physical path and `.noindex` checks,
  session policy and CSP.
- The **actual Electron runtime**, its sandboxed preload and the compiled Rust
  helper pass 13 integration checks. These include HTTP readback through the
  renderer/main/Rust/TLS path; rejection of a substituted certificate; socket
  open/message/ACK/close; Widget exclusion; initial-module bootstrap, module
  worker loading with the correct MIME/CSP, reload and old-lease rejection.
  The TLS fixture uses a disposable local Hub and its own CA. It does not
  use the owner's Host, real conversations or model accounts.
- Three real POSIX process lifecycle scenarios pass: graceful completion of
  an in-flight fake Host command, forced helper-group termination and helper
  crash. The temporary CLI exits and its detached fake service survives.
  Renderer authority is revoked immediately; an in-flight Host command gets
  up to 190 seconds to finish before forced cleanup. These checks do not prove
  Windows process ownership or real service-update recovery.
- Opus independently implements and checks the helper: 39 Rust unit tests and
  6 binary/TLS integration tests pass. The OS-keychain case is ignored by
  default, then was run separately against a disposable service and cleaned
  up. This proves its own entries work; it **does not** prove access to entries
  created by the shipping signed App.
- After fixing the shared test-directory race, the focused native-identity
  filter passes 6 cases with 8 test threads, including the added concurrency
  case. This does not rerun the previously passing full native suite.
- Rust clippy and Windows x64 cross-compilation pass. Windows runtime behavior
  has not been exercised. The release helper builds for macOS arm64.
- Existing Host build (463 modules) and client TypeScript/Vite build pass.
  The existing Capacitor keyboard static/dynamic import warning remains.

The shared keychain permit is process-wide; its tests must not race each other.
The reused native-identity tests also exposed a temporary-directory collision.
Their test-only fixture now adds an atomic sequence and retries collisions;
its concurrent-directory test checks 128 simultaneously retained fixtures.
The new crate still runs keychain cases serially because they share a deliberate
single-operation permit. No shipping Tauri behavior changes.

Opus independently reproduced and rechecked the navigation gap, module-worker
MIME and orphan-CLI fixes. It also reproduced the original 130-second upload
timeout breaking unrelated sockets. The corrected HTTP deadline exceeds Rust's
300-second limit; per-request cancellation and bounded late-response retirement
preserve unrelated connections. Its shortened-deadline real TLS probe confirms
the cancelled slot is released while a socket and another HTTP request work.
Helper-failure recovery UI remains a required gate before frontend integration:
the current low-level adapter reports failure and does not silently reload a
page that might contain unsaved work.

The final narrow Opus review found no blocking P0/P1 issue **for this isolated
foundation checkpoint**. It verified bounded bootstrap retry/pagehide fencing,
case/Unicode/symlink Widget path rejection and the test-directory repair
(40 parallel runs without a collision). The UI recovery, interrupted-navigation,
signed keychain and Windows gates remain open. Bootstrap error-envelope
normalization is a small follow-up for the frontend adapter; its current
not-committed retry also recognizes Electron's error prefix.

## Remaining release gates

| Boundary | Required before replacement |
| --- | --- |
| Existing identity | Signed helper reads an old signed-App test key with the expected access policy; refusal never silently creates another device |
| App data | Logical WebKit IndexedDB/settings/outbox export and Chromium import, resumable receipts and rollback; no copying engine database files |
| Canonical Host | Same old/new directory decisions, existing Host PID/identity reuse and directory-conflict refusal on real installations |
| Shared frontend | Replace 21 direct Tauri integration points through an explicit desktop adapter while preserving mobile/web behavior |
| Native features | Notifications/actions/badge, permissions, attachment save/open/quarantine, screenshot, clipboard, drag/drop, context menus, focus/IME, window geometry, autostart, deep links, tray and single instance |
| Updates/installers | Transactional update/drain/signature/rollback, macOS signing/notarization and Windows installer transitions |
| Compatibility | Fresh install and upgrade/rollback checks on macOS and Windows; physical iOS/Android regression where shared UI changes |
| Lifecycle | Main/helper/CLI process termination and long in-flight Host actions without orphan processes or false completion |

The historical foundation did not introduce the production entrypoint or switch defaults; the current implementation above now does.
The embedded-browser product UI is subsequent work after desktop compatibility.

## Running isolated checks

Use Node 24+ and the installed Rust toolchain. Root and client dependencies must
already be installed. The standalone helper has its own `Cargo.lock`.

```sh
npm --prefix client run test:electron
CARGO_TARGET_DIR=/absolute/cache.noindex/desktop-core cargo test --manifest-path client/src-desktop-core/Cargo.toml --locked -- --test-threads=1
node client/electron/tests/runtime.smoke.mjs \
  --lab /absolute/acceptance.noindex/electron \
  --cache-root /absolute/cache.noindex/electron \
  --helper /absolute/cache.noindex/desktop-core/debug/tarobot-desktop-core
npm run build
npm --prefix client run build
```

The native runner writes `electron-runtime-verification.json` only after all
checks pass, including whether production state or the installed App was used.
A successful foundation test is not a release, installed upgrade or migration
completion receipt.

## Design references

Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
requires validating IPC senders and limiting privileged APIs. Its
[contextBridge contract](https://www.electronjs.org/docs/latest/api/context-bridge)
supports a narrow copied interface without exposing `ipcRenderer` or event
objects. The [protocol API](https://www.electronjs.org/docs/latest/api/protocol)
supports a secure standard custom scheme for storage and bundled resources.
The [ESM startup guidance](https://www.electronjs.org/docs/latest/tutorial/esm)
distinguishes awaited pre-ready initialization from ready-time work; the
acceptance entrypoint schedules window creation after readiness without a
top-level `await app.whenReady()` cycle.

CLI impact: the existing headless CLI remains the Host implementation. The
helper invokes its fixed bundled entrypoint and preserves the existing local
controller proof; it does not create an Electron-only Host or new user CLI.
