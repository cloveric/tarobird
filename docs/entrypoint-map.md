# Entrypoint Map

[1.3.1 corrected rebuild](client/release-1.3.1-preflight.md) records the unified
patch scope, installed-dependency provenance correction and Android replacement.
[The unified download page](releases/1.3.1-verification.md#november-12-unified-download-page)
retains 1.3.1 platform update channels; the page itself does not migrate installed updaters.

[1.3.0 preflight](client/release-1.3.0-preflight.md) records the full stable
release scope, public desktop updates, dependency compatibility and disposable
Windows upgrade acceptance. Publication and installed-device receipts remain
separate.

[Duo scope](client/iphone-duo-scope-2026-11-10.md) keeps expanded-window keyboard,
ADHD and spacing changes out of ordinary iPhone portrait and landscape layouts.

[Repository migration](repository-migration.md) defines the clean private
`cloveric/tarobird` snapshot, archived legacy repository, retained installed-client
update URLs and first-release prerequisites. The migration publishes no Release;
all future release titles and notes are English.

[TaroBird governance](tarobird-governance-2026-11-04.md) records the brand PR merge,
display-name compatibility, upload privacy gates and unified product versioning.
See [privacy](repository-privacy.md) and [version policy](versioning.md) before
pushing main/PR branches or preparing a release.

[1.1.1 release verification](releases/1.1.1-verification.md) records the first current-version releases in the new private repository, actual updater OAuth download/signature checks, TestFlight readback and separate installed-device acceptance boundaries.

[1.2.1 scoped patch](client/release-1.2.1-preflight.md) records the desktop
pre-ready exit fix, affected-platform release and retained validation boundaries.

[1.2.0 preflight](client/release-1.2.0-preflight.md) records the cross-host
authorization release, synchronized upstream integrations, Rust build minimum,
TaroBird distribution names and separate platform acceptance scopes.

[Installer branding](client/artifact-branding-2026-11-05.md) defines TaroBird
artifact and App names, fresh Windows installation paths and the retained
existing-install/data boundaries.
The ready primary Mac instance repairs only an enabled older same-product login
entry to its installed executable; writes preserve other fields and serialize
with the user's setting changes. No login job is started or stopped. Regressions:
Electron `autostart`, `lifecycle`; see the installer branding guide above.
`scripts/check-macos-installation.py` adds read-only installed-copy/login-item
checks and duplicate runtime-dependency reporting; package-icon validation
alone does not cover a second installed App. Tests: `test_macos_installation.py`.

[1.1.1 preflight](client/release-1.1.1-preflight.md) records the current runtime/toolchain updates, compiler API compatibility, narrow iOS title repair and separate release acceptance boundaries.

[1.1.0 dependency inventory](client/release-1.1.0-dependency-inventory.md) records
the requested foundation upgrades, ACP and notification adaptations, Node
minimum for compatible CLI staging, native pins and validation boundaries.

[1.0.130 release verification](releases/1.0.130-verification.md) records the
same-source Mac/Android/CLI and TestFlight publication, the Windows x64 manual
installation preview, current Opus review, retained first-run failures and
subsequent retakes, and separate installed-device acceptance boundaries.

[Post-1.0.129 joint audit](client/post-1.0.129-audit-2026-11-04.md) records the
additional fullscreen/navigation and empty-persona repairs, Opus review, and
source/browser/native evidence boundaries.

[1.0.129 release verification](releases/1.0.129-verification.md) records the fullscreen repair, same-source Mac/Android/CLI and TestFlight publication, current Opus review, completed local Mac installation/window/connection checks, and pending installed canvas/PPT acceptance.

[1.0.129 release preflight](client/release-1.0.129-preflight-2026-11-03.md) covers
the scoped Design/PPT fullscreen repair and its separate installed acceptance.

This file is the source of truth for codebase navigation when modifying this repository.

[WebKit test isolation](client/playwright-keychain-isolation.md) prevents the
macOS test browser from repeatedly prompting for the owner's login keychain.
`client/playwright.config.ts` uses a pre-worker environment guard inherited by
the WebKit config and CLI browser selection; disposable macOS CI retains real
WebKit coverage. Specs do not override the selected engine. Production identity,
App/Host/CLI behavior and native keychain security are unchanged. Regressions:
`client/scripts/playwright-keychain-guard.test.mjs` (no browser launch).

[1.0.128 release verification](releases/1.0.128-verification.md) records the
Design/PPT release, source-bound App/CLI artifacts, retained initial failures and
the separate publication, local installation and skill-invocation gates.

[1.0.124 release verification](releases/1.0.124-verification.md) records the frozen
source, published App/CLI artifacts, TestFlight read-back and native acceptance limits.

The [2026-11-01 follow-up audit](client/deepseek-followup-audit-2026-11-01.md)
records DeepSeek findings independently reviewed by Opus 5.5 and the implementer,
including browser/Workbench lifecycle, screen authorization, native geometry,
queue barriers, OAuth and artifact-retention repairs and their verification limits.

Desktop build/dev/release commands use Electron. `client/electron/main.mjs`
selects production or explicit isolated paths before Chromium starts;
`desktop-bridge.ts` routes the shared React UI without impersonating Tauri.
`client/electron/` owns trusted-frame IPC, window/tray lifecycle, permissions,
notifications, file grants and helper lifetime. `src-desktop-core/` retains Rust
identity, pinned transport and canonical Host control; `src-desktop-native/`
retains OS notifications/autostart. `src-desktop-updater/` reuses the update
policy and transactional install logic from the shared Rust modules.

`electron/lifecycle.mjs` clears global shortcuts on exit only after Electron is
ready. A rejected second instance can quit before that point; it must exit
without calling ready-only APIs. Lifecycle regressions cover early exit,
asynchronous quit preparation and normal shortcut cleanup. This is shared
desktop behavior; mobile Apps and the headless Host/CLI are unaffected.

Windows taskbar unread counts use `electron/windows-unread-badge.mjs` through
`DesktopServices`: red/white 16-DIP overlays, multiple display scales, `99+` for
large counts and removal at zero. The bundled PNG atlas is generated by
`scripts/render-windows-unread-badges.mjs` from the existing Sarasa font. Packaging
must retain that atlas beside the main bundle. macOS/Linux badges and the
headless CLI are unaffected. The service/lifecycle regression and Electron
native-image checks cover routing, image decoding and scale representations;
native Windows taskbar appearance remains a separate acceptance check.

The Windows main window keeps native caption controls and shows only the
TaroBird title. Its menu bar is hidden by default and available with Alt;
`electron/lifecycle.mjs` supplies consistently localized Windows menu labels
while preserving native editing/window roles and accelerators. macOS/Linux
menu layouts and headless CLI behavior are unchanged. Lifecycle tests cover
both menu languages; Windows native Alt/menu and caption appearance require
separate installed-device acceptance.

Before connecting a legacy profile, `legacy-reader.mjs` launches the read-only
WKWebView/WebView2 exporter (`src-tauri/legacy/`), main authenticates its logical
snapshot, and `DesktopMigrationGate.tsx` imports it into Chromium. The source
is retained. `src-tauri/` remains for this compatibility reader and historical
regressions, not the shipping desktop shell. A source migration is not an
installed release: see [acceptance and remaining native gates](client/electron-migration-2026-10-30.md).

Remote Mac screen/control (#99) uses `client/electron/screen-service.mjs` for
App-level target lifetime and `screen-viewer.mjs` for document-scoped viewing.
`src/hub/remote-screen.ts` owns grants/leases, and `remote-screen-sockets.ts`
provides independent bounded media/control channels. Shared contracts live in
`src/client-protocol/remote-screen.ts`, `screen-wire.ts`, and `screen-keys.ts`;
`tarobot screens` manages the same policy through `src/host-cli/screens.ts`.
See [implementation and outstanding real acceptance](client/remote-screen-2026-10-31.md).
`screen-host-control.mjs::desktopScreenTicket` resolves the same canonical Host
directory as the native core before using the owner-only control socket;
`screenServiceTicket` accepts a resolved Host directory. Do not pass the App
parent directly to the socket reader. Screen status/retry and user-click
permission requests are separate IPC operations; none implicitly grants a
viewer. `ConnectionPanel` provides a selected-Host viewer fallback for network,
preferences and ADHD entry points. `RemoteScreenSettings` reads the GUI device's
Hub status, and reads native status only after `useDesktopLocalHost` confirms
the selected Host is this Mac. Regressions: Electron `screen-host-control`,
`screen-service`, `desktop-services`; root `screen-service-hub`; browser
`screen-settings`, `remote-screen`, `local-relay`. See
[readiness and permission repair](client/remote-screen-readiness-2026-10-31.md).
`RemoteScreenSettings` keeps readiness/viewing above the separate system-permission
and device-grant controls. Its device-access shortcut only expands/focuses the
current GUI device; it never grants access. See [settings layout and regression
boundaries](client/remote-screen-settings-ui-2026-10-31.md).
The Electron desktop conversation header has a separate “View screen” shortcut
beside Workbench, with a selected-accent open state. It opens the current
Workspace's Host viewer without granting access or starting capture; the viewer
explains missing grants/service/capture permission and links to that Host's
Connection settings. Phone/web headers do not offer this desktop-only viewer.
This is an App entry/presentation change; the existing `tarobot screens` CLI
and Host authorization contracts are unchanged. See [shortcut verification](client/remote-screen-entry-2026-11-03.md).
The viewer toolbar distinguishes in-App expansion from full screen and preserves
the select arrow gutter across theme load order. See
[toolbar presentation verification](client/remote-screen-toolbar-2026-11-03.md).
The compact viewer has element-owned fullscreen (`use-screen-fullscreen.ts`) and
open-time quality (`screen-quality.ts`), negotiated with both Host and target.
Quality changes retire the old session before opening another; no control lease
survives. See [controls, quality and verification](client/remote-screen-controls-2026-11-03.md).
`electron/tests/screen-controls.smoke.mjs` validates native/HTML fullscreen under
production App permission policy with a synthetic viewing fixture.
The [fullscreen close repair](client/remote-screen-fullscreen-close-2026-11-04.md)
waits for both macOS transitions and HTML exit before removing the viewer; close
failures remain retryable and old close callbacks cannot remove a new Host view.
The [responsiveness review](client/remote-screen-efficiency-2026-11-10.md) preserves
the final pointer position within the existing 32 ms movement budget, with
lease/stream-scoped cancellation and measurements only on sent movements.
Isolated Electron copy/decoder verification is `electron/tests/screen-viewer.smoke.mjs`;
it captures no desktop and posts no native input.

`npm --prefix client run test:electron` runs the main/preload contract tests.
`electron/tests/packaged.smoke.mjs`, `packaged-migration.smoke.mjs` and the real
Electron/TLS runner use explicit `.noindex` packages and isolated state.
Platform CI also runs native core/addon/updater tests; browser tests alone do not
prove OS permissions, installer handoff or existing-user data migration.
Temporary Mac Apps, Electron output/cache/target roots and post-publication
retirement follow [unindexed artifact storage](macos-artifact-retention.md):
`scripts/macos-artifact-workspace.mjs`, `cleanup-macos-artifacts.py` (owner-hold,
activation, build-activity and six-hour guards) and the publisher's
`finalize-macos-artifacts.mjs`. Regressions: `scripts/test_cleanup_macos_artifacts.py`,
`scripts/macos-artifact-paths.test.mjs`, `windows-update-publish`, `host-cli-package`.
`scripts/windows-acceptance.mjs` runs the disposable Windows installer scopes;
`scripts/desktop-persisted-migration-audit.mjs` covers persistent WKWebView or
WebView2 content through the native reader. Development-only Windows reader
activation is constrained by `electron/migration-acceptance.mjs`; production
rejects that switch. Signed Mac credential retirement has a separate real
Keychain fixture in `electron/tests/macos-credential-compat.smoke.mjs`.

Electron upload/save encoding uses `desktop-base64.ts` only at the desktop
call sites; mobile/Tauri retain their existing paths. The explicit native
`electron/tests/transport-codec.smoke.mjs` checks real byte round trips,
file quarantine and helper recovery. See [measured latency and stability
follow-up](client/electron-latency-stability-2026-10-30.md) for reproduction,
test-environment limitations and the held release boundary.

Claude CLI API-error assistant envelopes are separated from real answer text by
`codex/claude-errors.ts`, used by both Claude adapters. Preserve the diagnostic
until terminal failure/exit without marking a failed-before-output turn partial.
`core/errors.ts` renders host-local sign-in instructions. See
[authentication recovery and regression evidence](client/claude-auth-recovery-2026-10-30.md).
Regressions: `claude-stream-adapter`, `claude-adapter`, `error-classification`,
`claude-stream-adapter-retry`, `core-element-stream`, `core-card-renderer`.

The [outgoing-message latency investigation](client/send-latency-investigation-2026-10-28.md)
records the link-preview sweep blocking the send/auth queue, its partial-index repair,
the dispatch-time tombstone history scan and its per-message lookup repair,
and source/regression evidence. The follow-up isolates increased burst-publication
load from the prior streaming optimization and distinguishes route RTT from shared
Host queue waits. Installed/native and physical-device acceptance remain separate.
The [Kimi / Opus cross-review](client/kimi-opus-latency-review-2026-10-28.md)
independently confirms both query repairs, verifies that the installed bundle still
lacks them, and separates remaining candidates from proven bottlenecks.

Use it before changing:
- App/Gateway and headless CLI message flow
- desktop/mobile attachment and conversation UI
- retired-adapter and persistent compatibility boundaries
- bus / delegation flow
- state or config handling
- usage / budget / audit behavior
- file delivery behavior

The [attachment-before-text investigation](client/artifact-text-latency-2026-10-28.md)
separates native model/CLI waiting from Host publication and client rendering.
It records an unresolved upstream delay, not a product latency repair.

Repository privacy, sanitized examples and local/CI secret scanning: [repository privacy](repository-privacy.md).

Search routing: `runtime/search-routing.ts` resolves private provider keys and
explicit empty-value semantics for both App and headless workers.
`runtime/native-search-mcp.ts` plans additive Claude/Codex MCP injection;
Kimi ACP and DeepSeek bridge use the same credential gate. Native defaults and
user-owned MCP/plugins remain intact. `runtime/search-mcp-entry.ts` is shared by
`tarobot search-mcp` and `scripts/search-mcp.mjs`.
See [Search MCP setup and defaults](search-mcp.md) and
[verification](client/search-mcp-routing-2026-10-28.md). Focused regressions:
`search-routing`, `native-search-mcp`, engine factory/adapters, `bot-capabilities`,
`integration-tools`, gateway instructions and the Search MCP server suite.
The [post-audit review](post-audit-updates-2026-10-29.md) also covers the
Claude/Codex managed-search catalog and the Scrapling installer: validate
Python first and align the installed Skill before optional browser setup.
Regressions: `bot-capabilities` and `scrapling-installer`.

## Native application identity (2026-10-28)

`client/capacitor.config.ts`, Android Gradle/Java package roots, iOS App/share
bundle IDs and App Group, and Tauri's identifier use `com.tarobot.client`.
`client/src-tauri/shared/native_identity.rs` resolves the new default or the
existing legacy Host in place for desktop startup, updater drain and the Windows
launcher. `src/host-cli/paths.ts` applies the same policy on macOS/Linux;
Windows admission also checks old package shadow directories. Conflicting or
redirected roots fail closed. Explicit CLI selection remains available.
`fresh_install.rs` and NSIS hooks cover both native roots when the user explicitly
chooses reset; they back up state and do not resurrect installation keys.
Regression boundaries: `host-cli-entry`, `windows-host-directory`, native Rust
identity/reset/updater tests, Android unit/build, iOS release-plan/simulator.
See [migration and release gates](client/native-app-identity-2026-10-28.md).
The [post-audit review](post-audit-updates-2026-10-29.md) adds separate
`<platform>-tarobot-v` release discovery, the legacy Windows NSIS publisher
namespace, actionable probe refusals and the actual reused desktop path in
`doctor --json`. `windows-state-probe`, updater policy/publication and Android
unit tests cover these source boundaries; installed transitions remain separate.
[APNs topic routing](client/apns-topic-routing-2026-10-29.md) is shared by
`client-protocol/push.ts`, `hub/push/providers.ts`, `hub/push/worker.ts` and the
Hub registration/rotation APIs. The native App identifier and Host allowlist
gate client enable, maintenance and readiness repair. Regressions:
`hub-push-apns-topic`, `hub-push-rotation`, `apns-topic`, browser
`system-push-native`, `notification-readiness` and `native-events`.

[List avatar states](client/avatar-agent-state-2026-10-30.md) describes the
working/done/failed/needs-you avatar motion and badges in desktop and phone
lists, the `replies` activity projection and the eye-detection fallback.
Regressions: `client-agent-state`, `client-avatar-face` and browser
`avatar-agent-state`. `avatar-motion.ts` shares the device-local `animatedAvatars`
setting between list surfaces; `appearance.ts`, `storage.ts` and `host-registry.ts`
preserve it through startup and reload. It does not disable general UI motion.
[Working avatar motion](client/avatar-working-motion-2026-10-31.md) records the
slow sway, reading eyes and typing bubble that replaced the working hop.
[PR 100/101 integration](client/avatar-pr100-pr101-merge-2026-10-31.md) records
the combined validation and deterministic unread-state test setup.
[PR 105 integration](client/avatar-pr105-merge-2026-11-01.md) records the done
resting-hop phase correction, CI prerequisites and merge validation.
[Active-task projection](client/avatar-active-task-2026-10-31.md) keeps running
avatars active after newer questions/receipts, with an indexed cache upgrade.

## Read Order

The [UI PR 87–92 integration review](client/ui-pr-87-92-review-2026-10-26.md)
records fitted-card streaming safeguards, host/unread metadata alignment,
image-count preview ordering, validation and cache-refresh boundaries.

The [October 23 revision audit](client/day-revision-audit-2026-10-23.md)
records the second review of the day's mobile, image, side-conversation,
group-input and ADHD changes, confirmed corrections, independent Opus
dispositions, CLI impact and the limits of source/browser validation.
The [1.0.106 release audit](client/release-audit-1.0.106-2026-10-23.md)
records the subsequent independent review, host-address clarification,
video and side-recording fixes, and release verification boundaries.

The [discussion recovery audit](client/group-discussion-recovery-2026-10-23.md)
records composer Stop/paused sends, visible topic and note receipts, `@`
completion and per-run allowed speakers. `groups.discussion.recovery.v1` gates
selected participants, atomic note-and-resume/retry, paused topic replacement
and directed single-Bot replies in automatic modes.
The [human-behavior group audit](client/group-human-audit-2026-10-24.md) covers
both start entries, durable dialog receipts, shared speaker selection, unexpected
mention syntax, run-note resend, and phone composer/attachment layout.
The [held-input follow-up audit](client/group-held-input-audit-2026-10-24.md)
covers correction refresh before queue claim, immediate paused settlement when
only held inputs remain, forwarded reply guards, and internal fence variants.

`gateway/group-discussion-output.ts` separates internal `group_stance` blocks
from visible streamed/final output before Core records cards and journals. Position
validation remains separate and fails closed. See [position output repair](client/group-stance-visibility-2026-10-23.md);
regressions: `gateway-group-discussion-output`, `gateway-group-discussion`, and
browser `group-discussion` (internal positions).

Group conversation modes: `hub/group-discussions.ts` owns durable speaking order,
completion, consensus and controls; `gateway/group-discussion.ts` owns the
bounded turn context and structured position parsing. They use ordinary
per-Bot group sessions and queues, separately from Agent Bus. The App uses
`GroupSettings.tsx`, `GroupDiscussionOptions.tsx` and `GroupDiscussionBar.tsx`;
`host-cli/groups.ts` calls the same authenticated Hub APIs. See
[group discussion modes](client/group-discussion-2026-10-20.md) and
[parallel replies](client/group-parallel-replies-2026-10-22.md). Parallel mode
uses `HubStore.sendMessageInTransaction` for default human recipients, the
existing per-Bot queues and sessions, and no discussion scheduler.
`client/src/group-composer-send.ts` routes main-composer discussion sends through
the same start API and persists pending receipts across reloads. Active-run notes
use `/discussion/:runId/notes` with an exact-run check, exposed by `groups note`
in the CLI. The additive `groups.discussion.composer.v1` capability gates notes
and quoted starts on older Hosts. Saved recipients never override discussion
order; ordinary/parallel addressing remains separate. After uploads and cache
reads, the App checks that the observed group mode/run still matches the send
intent; changed context retains the draft for an explicit retry. Durable pending
receipts still replay their original request. `group-composer-intent.ts` binds a
main-group draft to an edit identity and its original note target. Text and this
small identity share the existing batched settings transaction; typing does not
rewrite attachment bytes. Clearing/retyping identical text creates a new intent,
while an unchanged draft replays its exact pending request across reload or mode
changes. Ended-run notes need an explicit rebind before becoming new discussions.
Malformed send state requires checking the conversation and a deliberate reset;
failed post-send draft cleanup is reported separately from delivery. Local file
quota failures retain the existing direct-send path; identity/CAS failures block
sending, and temporary text-save failures can be retried without losing edits.
Internal discussion receipts are excluded from user draft counts/previews.
See [draft intent audit and regression evidence](client/group-composer-intents-2026-10-23.md).
CLI notes accept either a text file
or attachments, including attachment-only notes. The shared-file index excludes
internal scheduler inputs, as do both history search APIs; their copied resources
still reach each Bot, while
readers see the original sharing message and its own deletion state.
Ordinary-group offline delivery caches authenticated mode metadata separately
from drafts and carries an optional revision guard through the outbox to the
same Host send transaction. See [offline delivery and compatibility](client/group-offline-delivery-2026-10-23.md).
Regressions: `hub-group-parallel`, `hub-group-discussion`, `hub-group-discussion-recovery`,
`gateway-group-discussion`, client `group-discussion` and `group-discussion-contract`,
`host-cli-group-discussion`, existing queue/recovery/group/Agent Bus suites;
browser `group-discussion`, `group-settings`, `topics`, `topic-actions`,
`mobile-conversation-actions` and ADHD group layout.

Start here for most changes:
1. App host entrypoint: `src/index.ts` → `src/hub/cli.ts` → `src/gateway/worker.ts`
2. Shared engine and turn flow: `src/core/engine-factory.ts`, `src/core/message-handler.ts`, `src/runtime/bridge.ts`
   [2026-10-24 DeepSeek/Opus verification and repairs](client/deepseek-opus-audit-2026-10-24.md) records accepted findings, rejected claims and test boundaries.
   App side capability negotiation in `client/src/side-capability.ts` distinguishes
   explicit old-Host request rejection from transient failure; tests:
   `client-side-capability` and browser `side-conversation`.
3. The narrow submodule that owns the behavior
4. The matching focused test file in `tests/`

For deeper system context, then read:
- `docs/architecture-notes.md`
- `docs/state-model.md`
- `docs/security-boundaries.md`
- `docs/bus-protocol.md`
- `docs/event-model.md`
- `docs/change-rules.md`
- `docs/release-checklist.md`
- `docs/kimi-engine-notes.md` — verified Kimi CLI/ACP behavior, implementation consequences, and known gaps.
- `docs/kimi-capability-matrix.md` — Kimi vs Codex vs Claude release contract, including explicit protocol gaps.
- `docs/deepseek-harness-engine.md` — DeepSeek Harness host architecture, verified capability matrix, recovery invariants, and limits.

The [2026-11-12 CLI compatibility pass](cli-compatibility-2026-11-12.md) covers
AGY explicit early-termination receipts, asynchronous DeepSeek projection startup
and disposal, and Kimi terminal-login guidance. It records real rc.1/rc.2 and Kimi
2.5.3 probes and the still-unavailable AGY side-query/Kimi steering interfaces;
native terminal features do not automatically advertise App capabilities.

The [2026-10-15 comprehensive audit fixes](comprehensive-audit-fixes-2026-10-15.md)
record approval/turn fencing, workflow settlement, parallel-run cancellation,
transport bounds, CLI update recovery, legacy fixes and pending native gates.
The [2026-10-28 comprehensive audit](comprehensive-audit-2026-10-28.md) records
the independent Opus 5.5 review, confirmed fixes, rejected findings, partial
broad-suite results and focused validation; source completion is separate from
App installation and physical-device acceptance.
The [subsequent confirmed-bug pass](bugfix-review-2026-10-15.md) records goal
questions, run-card stop recovery, historical focus, registry/pool integrity,
link previews, Kimi task terminal ownership and their regression evidence.
The [2026-10-17 commit audit](client/day-commit-audit-2026-10-17.md) covers the
day's 31 commits, cross-Bot transfer/metadata/audit/source fixes, safe message
actions, Mac preparation backup cleanup and independent Opus review boundaries.
The [2026-10-18 independent DeepSeek/Opus audit](independent-audit-2026-10-18.md)
records report dispositions, timeout propagation, queued-answer cancellation,
private-network reconciliation, update recovery, bounded history/sync, attachment
retirement, native-event and build-environment repairs, and validation limits.
The [Codex process visibility repair](client/codex-process-visibility-2026-10-18.md)
records native child lifecycle/collaboration capture, exact-turn ownership,
bounded structured reports, recent fallback excerpts, capability-gated latest
and earlier journal pages, and desktop/phone/ADHD process-reader validation.
Follow-up regressions: `codex-agent-states`, `codex-agent-presentation`,
`run-journal-tail`, `app-server-adapter`, `hub-server`, `run-presentation` and
browser `codex-activity` / `run-details-refresh`.

The [background/reader follow-up audit](client/background-reader-audit-2026-10-17.md)
records virtualized attachment-reader retention, loaded-original reconnect safety,
scoped notification semantics and personal-delete/run-file attribution boundaries.

The [2026-10-19 Fable/Opus review](audits/2026-10-19-fable-review.md) records
confirmed repairs, report disagreements, attachment drag/drop routing, retained
transport compatibility, and remaining native/security design boundaries.

## Standalone transport boundary

- `src/core/`: shared queues, session dispatch, cancellation, cards/approvals, cron,
  delivery and ASR. SDK clients and transport lookup are not defaults.
- `src/gateway/`: App channel, protocol, tools and explicit platform policy.
- Retired `src/lark/`, `src/telegram/`, legacy CLI and SDK packages have been removed.
- ZIP input: `runtime/zip-archive.ts` preserves raw entry names until it can
  apply UTF-8 flags or CRC-verified Unicode Path metadata. Legacy names use
  UTF-8, Chinese GB18030, then CP437 fallback. Decoded path collisions, unsafe
  paths, symlinks, encryption and extraction limits fail with specific bilingual
  messages. `runtime/file-workflow.ts` removes partial extraction but retains
  the original upload and failed workflow record. This shared Host preparation
  applies to App and headless entry points; it does not execute archive files.
  Regressions: `file-workflow-zip`, `core-service-shared-rules`,
  `file-workflow-pdf`, `file-workflow-store`.
- Shared reply/attachment types and formatting live in `src/runtime`; injected artifact delivery lives in `src/core/shared/artifact-delivery.ts`.
- [Retirement scope, test mapping and validation](adapter-retirement-2026-10-21.md) supersede historical adapter references later in this map. Old routing/card/state identifiers are still current schema, not an active transport.
- `scripts/check-standalone-graph.mjs`: checks all host and dynamically loaded
  engine-helper entrypoints for reverse transport imports.
- [Migration contract and evidence](standalone-core.md).
- [Neutral names and legacy-read boundaries](neutral-naming.md): shared `Core*` symbols, `state/instance-config`, `core/shared` directives/commands, `tools/tool-*`, and old-state compatibility.

## macOS App replacement and running Host compatibility

Ordinary macOS `desktop-host start/resume` reuses the guarded
`hub/desktop-update.ts` handoff when the App bundle is newer than its running,
App-managed Host. `client-protocol/desktop-runtime.ts` owns version/capability
policy; independent CLI/OS-managed runtimes are retained. Native proof failures
and runtime incompatibility have separate client diagnostics. See
[DMG runtime recovery](client/dmg-host-runtime-recovery-2026-10-20.md) for safety,
CLI boundaries, pending native acceptance and verification limits. Regressions:
`desktop-runtime-policy`, `desktop-runtime-controller`, `desktop-runtime-drain`,
`desktop-update`, `desktop-host`, `desktop-recovery-intent`,
`local-controller-recovery`, `local-host-recovery`, native error diagnostics,
browser `native-transport`, root/client builds and translation checks.

## Windows physical Host directory admission

`host-cli/windows-state-admission.ts` owns the shared physical-view and package-context gate for desktop, CLI, initialization and service/runtime handoff. `host-launcher/src/storage_probe.rs` is the read-only native probe, also reused by native desktop/reset entry points. `hub/cli.ts` holds the path admission lease, and `hub/server.ts` holds the identity lease for the lifetime of the Hub. `host-cli/directory-recovery.ts` owns read-only recovery plan/hash verification; it does not migrate or merge state. `local-controller.ts` reuses native proof at boot and recovery, while `HostApp.tsx` publishes verified pool state and scoped diagnostics.

See [Windows state and recovery contract](client/windows-host-directory-2026-10-19.md). Regressions: `windows-host-directory`, `directory-recovery`, `local-controller-recovery`, all `host-cli-*`, desktop-host/native bootstrap tests, `hub-server` and browser `network-cache` / `native-transport`; root/client builds and Windows native cross-compilation. Native MSIX execution requires real Windows acceptance and must be reported separately.

## Temporary side conversations

Desktop single direct chats expose the optional `conversations.side.v1` capability.
`client/src/use-side-conversation.ts` and `SideConversation.tsx` use the same
`hub/side-sessions.ts` → `gateway/side.ts` → `core/side-sessions.ts` lifecycle as
`host-cli/side.ts`. `Bridge.openSideSession` borrows an existing native session
without creating or rebinding the parent; the native adapter determines support.
Current Codex sides negotiate `tools=1` / `tools: "inherited"` to use networking,
search and configured native tools with the Bot sandbox. Legacy callers keep a
read-only fork; other engines advertise their actual native tool limits. Side
actions require a new side request; inherited tasks remain reference context.
No side transcript enters the Hub journal or client cache. Shared budget, usage,
audit and turn-pool helpers still apply. Phone, tablet, ADHD, group and read-only
views have no entry point. See [behavior and acceptance](client/side-conversations-2026-10-22.md).
Side panels retain per-conversation memory state and a low-frequency lease while
viewing another chat. Explicitly revealing an existing side panel requests input
focus without recreating its context or clearing its draft; passive return from
search keeps the search trigger's focus. Attachment admission is Hub-owned; `core/side-attachments.ts`
verifies private copies and native adapters deliver files according to their
capabilities. The CLI uses the same path with repeatable `side ask --file`.
[Composer input parity](client/composer-input-parity-2026-10-23.md) records the
shared desktop attachment/paste/recording controls, temporary recording receipts
and opt-in side audio negotiation.
The empty side-panel introduction and prompt suggestions use secondary text
colours; actual questions and answers retain their reading contrast. This is
App presentation only, with no Host or CLI behavior change.
The side-panel header shows its title and actions without the context/tool
explanatory subtitle. This copy-only change is CLI-not-applicable.
The side composer reuses `useComposerSize` and the composer wrapper so its idle
outline and send button align with the main input. The Esc hint occupies toolbar
space. The side Stop control also uses the main composer’s `composer-stop`
classes and `CircleStop` glyph, sharing theme, hover and disabled styling; its
side-only cancellation handler and accessible label are preserved. This is App
presentation only, with no Host or headless CLI behavior change. [Alignment and validation](client/side-composer-alignment-2026-10-23.md).
The desktop side panel can expand into the remaining window space instead of
stopping at a fixed maximum width. Pointer and keyboard resizing share the CSS
bounds that reserve room for navigation and the main conversation. Window resize
clamps the visible width without discarding the chosen width or draft; double-click
resets it. Browser `side-conversation` covers wide dragging and narrow layouts.
Native desktop opening additionally grows the window to the right to preserve
main-chat width, moving left only if needed to fit the current monitor work area.
The main header keeps its base inset across the wide-screen breakpoint so its
avatar/title do not shift when a side panel adds window width; see
[header-position regression](client/side-header-stability-2026-10-31.md).
`use-side-window-expansion.ts` and `side-window-expansion.ts` serialize ownership
across mounted Hosts and restore the original width of an auto-expanded normal
window, preserving later position/height changes. Fullscreen,
maximized, insufficient-space and unavailable-native-API cases retain the existing
split; browser tabs retain their current layout. Closing holds the main width until
both the native shrink and renderer resize settle, with bounded failure cleanup.
[Close behavior and verification](client/right-panel-close-2026-10-31.md).
After expansion, outer-window width changes are allocated to the right panel,
preserving the current main-chat width. Internal divider changes remain explicit
allocation changes. The lease owns a temporary Electron minimum width and clears
it before restoring the frame or retiring the App document. See
[right-edge resizing](client/right-edge-panel-resize-2026-10-31.md).
[Geometry and acceptance](client/side-window-expansion-2026-10-26.md).
Workbench reserves its dock while initialization or its lazy component is pending.
Native resize mode reads hold the last chat allocation until confirmation, with
bounded cleanup; size observation follows replacements and visible cached docks.
See [opening and resize stability](client/workbench-opening-stability-2026-11-03.md).

Opening now keeps the main width and defers panel visibility/focus and its entry
animation until native geometry resolves and the WebView reaches that width.
Browser `side-window-opening` covers delayed resize, split fallback and cancellation;
see [opening-order repair](client/side-window-opening-2026-10-29.md).
The opening deadline also covers unanswered native IPC, releases stale expansion
intent, and handles late reads/resizes and close-before-response; see the
[post-audit repair](post-audit-updates-2026-10-29.md).
This is App presentation only; Host APIs and headless CLI behavior are unchanged.
Supported Codex sides additionally negotiate `delivery=1` / `delivery: true`.
`gateway/side-delivery.ts` binds shared App file tools to the current temporary
exchange, uploads through the normal authenticated attachment API, and returns
ephemeral `deliveries` instead of publishing parent messages. The CLI returns
the same output metadata. See [side image delivery](client/side-image-delivery-2026-10-26.md)
for lifecycle, compatibility and validation. Other native engines retain their
advertised side capabilities.
Regressions: `core-side-sessions`, `bridge-side-sessions`, `hub-side-sessions`,
`host-cli-side`, native adapter side suites and browser `side-conversation`.

## Headless host CLI

**Ongoing parity rule:** every App/host feature change must assess its CLI impact.
Host capabilities use the same core/API and remain available without a desktop
window; required command entry points, help, tests and releases evolve together.
Document a reason for UI-only exceptions. See [AGENTS.md](../AGENTS.md#desktop-mobile-and-cli-evolve-together)
for the binding project rule and [release checks](release-checklist.md#cli-parity-and-release-gate)
for acceptance.

The [2026-10-14 joint day audit](client/daytime-audit-2026-10-14.md) covers
CLI cancellation/drain, service receipt hashes, package launcher validation,
instance-lock admission, Bot deletion/recovery, onboarding and reading gestures.
Regression additions include `host-cli-day-audit`, `host-cli-package`,
`host-cli-node-inspection`, `instance-lock-admission`, `process-epoch`, browser `message-following`,
and the existing network/run/delete suites listed in that audit.

- `bin/tarobot.mjs` → `src/index.ts` → `src/host-cli/cli.ts`; `tarobot host` is an alias.
- `attachments.ts`: owner `tarobot attachments list [--conversation ID [--sort size|time] [--offset N]]` and `attachments delete (--ids ID,ID | --conversation ID) --yes`, the same Hub API as File Center › 附件管理.
- `environment.ts` shares engine search paths across detached service startup, foreground Hub workers and installed-service manifests; `host-engine-path` covers minimal GUI PATH and named CLI overrides.
- `engine-discovery.ts` appends selected version-manager fallbacks; `runtime/host-engine-settings.ts` applies private Host paths at worker launch. Owner `GET/PUT /api/settings/engines`, Settings → Engine programs and `tarobird engines status|set|reset` share revision-checked, idempotent settings. Existing workers keep their environment until an idle restart. See [discovery, path settings and verification boundaries](client/host-engine-paths-2026-11-13.md); regressions: `host-engine-discovery`, `host-engine-settings`, `host-engine-path`, browser `engine-settings`/`new-bot-catalog`.
- `paths.ts` and `setup.ts` select the same desktop host identity; a legacy Hub is never silently merged.
- `service-manager.ts` owns launchd/systemd/Task Scheduler, desired state and exact runtime selection. `update.ts` freezes Node with JavaScript, stages schema-compatible revisions and takes offline snapshots.
- `client.ts` authenticates an explicit host-scoped local controller through Hub control and the signed WebSocket protocol. `management.ts`, `network-cli.ts`, `network-transfer.ts` reuse Bot/device APIs and signed membership transitions. Phones retain independent network scope.
- `hub/service.ts`, `hub/bot-manager.ts`, `gateway/worker.ts` coordinate drain; accepted work and bus continuations finish, new user work and cron wait.
  The optional adapter/Bridge `hasPendingNativeWork()` lifecycle read keeps Claude
  background tasks, native continuation/stop fences, result reviews and public
  deliveries inside that idle barrier. It reuses native state and the existing
  `worker` blocker, with no new wire enum. [Native background drain](client/native-background-drain-2026-10-24.md).
  Before draining an older Host, `host-cli/lifecycle.ts` waits for known dispatched
  inputs, foreground replies and active background cards through a read-only
  snapshot; cancellation never starts drain, and age alone does not release work.
- Required checks: `host-cli-*`, `desktop-host`, `hub-supervision`, `hub-state-backup`, `windows-host`, `cron-scheduler` plus full pre-complete gate. Real service lifecycle and multi-host/mobile acceptance are separate from unit tests.
- [Operator guide](host-cli.md) and [update/rollback contract](host-cli-update.md).

- Cross-host Bot messages: `host-cli/bot-messages.ts` → `hub/bot-messages.ts` and `bot-message-transport.ts`; shared queue/upload APIs, signed peer passports and explicit target grants. `client-protocol/bot-messages.ts` owns source metadata; Gateway preserves it into the Core queue-only branch. Tests: `hub-bot-messages`, `hub-bot-message-transport`, `host-cli-bot-messages`, `gateway-async-questions`, queue/auth regressions. [Design and acceptance](client/cross-host-bot-messages-2026-10-17.md). Agent Bus stays local.
  Wait remains pending while recorded replies bound to that input have active
  foreground/background run phases; optional `activeReplies` does not change the
  queue, acknowledgement or idempotency contracts.
  Collaboration replies stay in the delegated conversation and are read with
  `messages wait`; normal reports do not need a second `send` or reciprocal ack.
  CLI waits back off to six seconds without resending. Local write admission
  rechecks the source turn inside the target transaction; remote sends recheck
  immediately before exchange. `BotMessageDisclosure.tsx` folds only Bot-origin
  input presentation, leaving source/preview visible and reply/queue behavior
  unchanged. Tests also include `host-cli-bot-message-wait`, `gateway-dispatch`
  and browser `bot-message-source`. [Scope and checks](client/collaboration-stability-2026-11-10.md).


- Local direct-message grant UI: `client/src/BotMessageGrants.tsx` in Settings
  and `BotMessageGrantsControl.tsx` from Bot settings (preselecting that Bot),
  `client-protocol/bot-message-grants.ts`, and `BotMessages.readGrants/updateGrants`
  reuse existing grants with atomic signed updates and conflict/readback checks.
  CLI `messages grants` reads the same state. Both snapshots exclude internal
  `worker` Bots and their grant edges by role; dispatchers and ordinary Bots
  remain selectable. Stored worker grants and task history are retained, and
  the existing snapshot validation rejects edits to hidden endpoints. This does
  not modify Agent Bus or task lifecycle. [Scope and verification](client/bot-message-permissions-2026-10-19.md).
  Regressions: `hub-bot-message-grants`, existing Bot-message/auth/CLI tests,
  browser `bot-message-grants`/settings and native device-action signing checks.

- Cross-host message grant settings: `client/src/CrossHostMessageGrants.tsx` is
  the Cross-host scope of the same Settings/Bot-settings entry. The receiving
  Host owns `GET/POST /api/bot-messages/cross-host-grants`; the existing signed
  device-action proof covers the complete command. The old loopback CLI write
  endpoint remains restricted. `messages grants --cross-host` reads the same
  snapshot; existing `allow/revoke` records are reused without migration.
  Authenticated App connections provide source Bot names through
  `bot-message-hosts.ts`; the UI never publishes a peer Bot directory or grants
  network membership. Without a connected source, the owner can enter an exact
  Bot ID with an explicit unverified-name explanation. Internal workers stay
  out of selectors. Removed peers and deleted recipients retain revocable
  records. Save/readback uncertainty never resubmits a change automatically.
  Regressions include the cross-host grant policy/proof tests, existing
  Bot-message/CLI tests and browser `bot-message-grants` (local and cross-host).
  Browser and isolated Hub evidence does not establish installed mobile or
  physical cross-machine acceptance. [Owner workflow and boundaries](client/cross-host-message-permissions.md).

- Visual Agent Bus workspaces: `client/src/AgentBusPanel.tsx`, `AgentBusList.tsx`
  and `AdhdBoard.tsx` provide the desktop configuration, saved workspace list and
  member panes. `AgentBusSlots.tsx` renders editable per-slot tasks and the
  read-only run division; `agent-bus-view.ts` owns role copy and draft comparison.
  `AgentBusFlow.tsx` and `agent-bus-flow.ts` render the run's bounded,
  interactive participant topologies without changing the scheduler.
  `host-cli/agent-bus.ts` supplies headless parity; both clients use
  `client-protocol/agent-bus.ts` and the shared `collaboration-prepare.ts` rules.
  `hub/agent-bus.ts` owns definitions, run snapshots, durable coordinator queue
  admission and member records. `gateway/agent-bus.ts` observes the existing
  `core/bus.ts` delegation and Crew workflows; it does not replace the local Bus
  scheduler or add cross-host routing. Required regressions: `hub-agent-bus`,
  `gateway-agent-bus`, `host-cli-agent-bus`, `collaboration-task`, prompt queue,
  Gateway transport/recovery, original delegation/Crew, and browser
  `agent-bus-workspace`, `adhd-board`, `collaboration-setup`, `delegation`.
  [Design, CLI examples and verification](client/agent-bus-workspace-2026-10-18.md).
  [Issue #103 independent audit](client/agent-bus-issue-103-audit-2026-11-01.md)
  covers durable goal/command classification in the Hub queue, shared engine
  prompt boundaries, Crew member preflight and bounded retries of explicit
  capacity admission refusals. These use the same Host/core paths from App and
  CLI; uncertain results and timeouts are never replayed.
  [Opus human-operation audit and repairs](client/agent-bus-human-audit-2026-10-24.md)
  covers real five-engine execution, permission/draft boundaries, record binding
  recovery, Unicode admission, deleted members and concrete AGY effort presets.
  [Long turns and per-stage tasks](client/agent-bus-stage-tasks-2026-10-19.md)
  covers `bus/bus-http.ts`, trusted Gateway instruction injection, v3 worker
  gating and schema 19. Regressions: `bus-client-timeouts`,
  `agent-bus-instructions`, plus the existing Gateway/Hub/CLI workflow suites.
  [Follow-up execution and interaction audit](client/agent-bus-followup-audit-2026-10-19.md)
  covers delivery receipts, default record recovery and exploratory editor
  regressions. `agent-bus-real-runtime` exercises the production UI, Hub, queue,
  Gateway and Bus HTTP with scripted model output in Chromium and WebKit.
  [Independent DeepSeek/Opus review and verified repairs](client/agent-bus-independent-audit-2026-10-18.md)
  adds cancellation, record identity, request replay and permission recovery
  regressions, including `agent-bus-audit-boundaries`.
  [Hands-on Opus interaction audit and repairs](client/agent-bus-interaction-audit-2026-10-18.md)
  covers actual browser journeys, cancellation feedback, actionable configuration
  validation, stale confirmations, board navigation and delayed-send focus ownership.
  [Bus return scrollbar repair](client/agent-bus-return-scrollbars-2026-10-18.md)
  bounds the configuration fieldset's hidden legend inside the dock; includes
  native macOS WebView evidence and desktop breakpoint/scroll/draft regressions.
  [Bus draft confirmations](client/agent-bus-draft-dialog-2026-10-18.md) gives
  leave/reload prompts compact layouts, safe keyboard defaults and accessible
  descriptions, with theme and draft-retention browser checks.
  [Bus sidebar group](client/agent-bus-sidebar-group-2026-10-18.md) places saved
  Buses in the conversation list below filters, using the ordinary folder
  heading and shared scrolling while retaining host-scoped navigation.
  [Bus name field](client/agent-bus-name-field-2026-10-18.md) separates the
  required name input from the panel heading and puts validation beside the
  field and Create/Save action.
  [ADHD long queue scrollbar follow-up](client/adhd-long-queue-scrollbars-2026-10-18.md)
  distinguishes the installed Bus-return defect from queue length, and covers
  long queue scrolling, editing and Bus navigation in ordinary chat and ADHD.
  [Bus desktop UI polish](client/agent-bus-product-polish-2026-10-18.md) covers
  participant hierarchy, reachable member editing, mode-switch draft retention,
  research-limit validation and actionable run preparation.
  [Bus transport residue audit](client/agent-bus-transport-audit-2026-10-18.md)
  covers Core-owned command interfaces, transport-specific reply splitting,
  Mini guidance and retained protocol/state compatibility. Regressions:
  `core-bus-transport`, `gateway-bus`, shared command and Markdown tests.

## Main Entrypoints

- macOS overlay title bar: `client/src/desktop-window-chrome.ts` and its CSS
  reserve system-button space and mark shell drag regions; `DesktopMenu.tsx`
  opts popovers out. `main.tsx` disposes native listeners on hot reload. Tests:
  `client/tests/desktop-window-chrome.test.ts`, browser `desktop-window-chrome`
  in Chromium/WebKit. [PR review and native limits](client/macos-window-chrome-2026-10-26.md).
  Electron region exclusions are scoped to handles: see the
  [scrolling/history overlap fix and native acceptance limits](client/mac-header-drag-2026-10-31.md).
  Small settings dialogs use local movement and suspend Electron shell handles
  while modal: see [settings dialog drag routing](client/settings-dialog-drag-2026-10-31.md).
  Fixed Host notices exclude their own rectangle from dragging while actionable;
  see [close-control repair and acceptance limits](client/host-notice-close-2026-11-04.md).
  Browser `desktop-migration-startup` also checks dismissal across recovery polls.
  Presentation only; Host and headless CLI are unchanged.

- iOS packaging: `client/scripts/ios-build.mjs` and `ios-release-plan.mjs` build
  fresh Capacitor assets, synchronize App/share-extension versions, and validate
  simulator bundles or exported TestFlight IPA signatures/entitlements. Tests:
  `npm run test:ios-release --prefix client`; native compilation remains the
  `ios-compile` workflow gate. [Build and acceptance guide](client/ios-build.md).
  Client distribution only; no host API or headless CLI behavior changes.

- Windows full desktop hosting: `client/scripts/windows-build.mjs` and
  `scripts/prepare-desktop-host.mjs` bundle Windows Node/SQLite and the standalone
  Hub. `desktop_host.rs` owns native paths and installer shutdown;
  `hub/service.ts` uses authenticated Windows named pipes. `engine-process.ts`
  handles PATHEXT/npm launchers and private pipes; Bot workers stop via parent IPC.
  Windows and Mac share welcome/pairing/local-device-invite controls.
  Tests: `windows-host`, `desktop-host`, `hub-supervision`, engine adapter suites,
  browser `native-transport`, and `scripts/verify-desktop-host.mjs` run with the
  packaged Node on the target OS. [Changes and acceptance](client/windows-full-host-2026-10-13.md).
  `client/src-tauri/build/desktop_runtime.rs` rejects mixed or wrong-architecture
  host resources before packaging, including receipt/Node/addon checks. The
  generic desktop workflow prepares full darwin-arm64 and win32-x64 runtimes.
  Run `client/scripts/desktop-runtime-audit.mjs` for isolated guard fixtures;
  [packaging guard and CI boundaries](client/desktop-runtime-gate-2026-10-14.md).
  Native startup/cache recovery and guarded uninstall/reinstall are documented
  in [Windows fresh install](client/windows-fresh-install-2026-10-16.md).
  `fresh_install.rs` owns the installer-only Known Folder backup helper;
  `native-shell.js` runs before cached renderer scripts. Their isolated tests
  and final-EXE checks do not replace native Windows acceptance.
  [Windows startup diagnostics](client/windows-startup-diagnostics-2026-10-16.md)
  tracks the still-unresolved 1.0.75 native failure and the code-only bootstrap
  error marker (`runtime/startup-error.ts`, `desktop_host_error.rs`).
  [Windows runtime fixes](client/windows-runtime-fixes-2026-10-16.md) records
  the reproduced first-identity fsync failure, static-CRT service launcher,
  `windows-state-sync` regressions and final-installer PE dependency gate.
  [Windows native entrypoint repair](client/windows-native-entrypoint-2026-10-16.md)
  records Node's pre-bootstrap failure on verbatim Windows script paths.
  `desktop_host_node.rs` shares the Windows main-entry launch option across
  desktop IPC and installer shutdown, with real bundled-Node Rust regressions.
  [Private Windows GitHub updates](client/windows-github-updates.md) connects
  `DesktopUpdates.tsx`/`github-update-backend.ts` to native `github_updates.rs`
  and pure policy/lifecycle tests. `windows-build-plan.mjs` selects signed
  updater builds; manifest/publication helpers bind signatures and private assets
  to one numeric draft-release ID. Tests: updater browser/controller,
  `windows-update-*`, native GitHub policy and lifecycle audits.
  [Mac in-app updates](client/macos-github-updates.md) shares the private GitHub
  provider, with separate Mac release assets, native bundle recovery and a
  guarded `desktop-update` child that pauses/resumes only the App-owned Hub.
  Tests: `desktop-update`, `macos-update-build`, shared signed-manifest/publish
  suites, browser `updates*`, and the isolated `macos-update-audit` binary.
  `client/scripts/macos-signing.mjs` is the Developer ID signing/verification
  step (Node-only library-validation exception, foreign-addon load check). Tests:
  `macos-signing`. `client/scripts/macos-macho-linkedit.mjs` strips Mac Rust
  binaries with Apple strip and gates every bundled Mach-O string table's
  alignment (#15). Tests: Electron `macho-linkedit`, `build-plan`.
  `scripts/verify-macos-recovery.mjs` runs packaged old/new Mac hosts against
  external synthetic state, including corruption and quarantined-state recovery.
  [Mac recovery laboratory](client/macos-recovery-lab-2026-10-16.md) records
  native-versus-simulated boundaries and the remaining Mac fresh-start UI gap.

- Android in-app updates: `AndroidUpdates.tsx` and `android-update-controller.ts`
  use the native `AndroidUpdaterPlugin`, `AndroidUpdateService` and
  `AndroidUpdatePolicy`. GitHub credentials/downloads stay native; APK digest,
  package, signer and version are rechecked before Android installer confirmation.
  Tests: `AndroidUpdatePolicyTest`, isolated `AndroidUpdaterTest`, browser
  `android-updates` / `android-updates-ui`, and existing desktop update suites.
  [Build, security boundaries and acceptance](client/android-github-updates.md).
  Phone distribution only; no new headless CLI command or Hub permission.

- Attachment save/share: `client/src/attachment-export.ts` separates saving,
  sharing and external readers. `AttachmentPreviewHeader.tsx` exposes the three
  phone actions. `document-preview.css` draws them below the file name as
  content-width outlined capsules, 32px inside 44px touch targets, and moves
  them onto the name's row from 560px. Sent files and drafts share this header.
  This is client presentation only, with no host or headless CLI change.
  Android `AttachmentSaverPlugin` / `AttachmentDownloads` write
  verified public Downloads copies; iOS `AttachmentSaverPlugin.swift` exports
  through the document picker. Tests: browser `file-actions`, `mobile-file-export`,
  `desktop-export`; Android `AttachmentSaveTest` on an isolated `.downloadtest`
  application ID. [Behavior and evidence](client/attachment-save-share-2026-10-12.md).
  Android saves return a content URI and persist a private receipt scoped by
  paired Hub public key, device ID and attachment ID (`android-saved-attachment.ts`).
  `AttachmentSaverPlugin.getSaved` validates the local file on mount/foreground;
  `openSaved` accepts only completed or revalidated receipts, grants read-only
  access and opens the saved copy without another download. APKs expose Install APK,
  request per-app unknown-source permission only on that tap, and continue into
  Android's installer after permission returns. Cancellation remains retryable.
  Tests: browser `android-saved-file`, `mobile-file-export`, `file-actions`;
  native `AttachmentSavedOpenTest`, `AttachmentSavedRestoreTest` and
  `AttachmentSaveTest` on `.downloadtest`.
  [APK open fix and release](client/release-1.0.72-2026-10-16.md).
  [Saved-file recovery and verification](client/saved-attachment-recovery-2026-10-17.md).
  Inline images use `AttachmentImage.tsx` and `image-export.ts` to expose save
  and native share directly in their full-screen viewer. `use-attachment.ts`
  retains the authenticated original Blob with its connection/attachment scope;
  export does not re-encode the thumbnail. The toolbar overlays the full canvas,
  uses safe insets for its controls and hides on a single tap. Tests: browser `image-export`,
  `message-images`, `attachment-message-actions`, `host-previews`,
  `mobile-file-export`. [Image save fix](client/image-save-2026-10-15.md).

- Offline shell build: `client/vite.config.ts` builds the service-worker cache
  manifest after Vite removes CSS-only JS chunks. Every listed URL must be an
  emitted file; one missing asset rejects the entire installation. Regressions:
  browser `cards` (offline attachments) and `offline-recipients` (desktop/phone).

- [Queued answers and restart recovery](client/question-queue-recovery-2026-10-16.md):
  `core/question-feedback.ts` and `core/card-actions.ts` update the owning async
  answer receipt; `gateway/channel.ts` and `gateway/service.ts` sweep old runs
  after replay acknowledges a cached input receipt. Tests: `gateway-async-questions`,
  `gateway-run-recovery`, browser `async-answer-feedback` and `run-stop-recovery`.
  [Visible answer follow-ups](client/async-answer-progress-2026-10-18.md): Gateway
  injects the shared run-card factory into card-choice turns; admitted App queue
  notices remain compact and task-cancellable. The pending-prompts panel still
  owns only pre-dispatch edits. Browser coverage includes phone, desktop and ADHD.
  [Core queue status presentation](client/queue-notice-presentation-2026-10-19.md):
  `client-protocol/queue-notice.ts` binds waiting notices to their source task;
  `client/src/QueueNotice.tsx` presents waiting/cancelled/interrupted states without
  inventing a run. `hub/store.ts` settles orphan notices on worker attachment.
  Regressions: `queue-notice`, `gateway-async-questions`, `gateway-run-recovery`,
  browser `async-answer-feedback`, `prompt-queue` and `run-stop-recovery`.

- [Queued reply source visibility](client/queued-reply-source-2026-10-17.md):
  `client/src/BotReplySource.tsx` shows each ordinary Bot response's persisted
  source, including late replies arriving after newer queued prompts. It shares
  existing locate-message behavior and preserves forwarding/background sources.
  Reply-source excerpts use inline-size containment within the message width:
  long text cannot enlarge a fitted receipt's grid column in WebKit. The source
  stays one line with ellipsis and a visible locate arrow; original message text,
  persisted ownership and source navigation are unchanged. Browser regression:
  `queued-reply-source` (including WebKit, ordinary/ADHD/phone long receipts),
  `quoted-reply`, `user-reply-status`; `porcelain-followups` retains phone hit areas,
  and `card-layout` retains stable streamed-card widths.
  Presentation only; Hub queue semantics and headless CLI remain unchanged.

- Native async questions: `core/async-user-input.ts` normalizes Codex title-only
  questions and null options; `core/delivery.ts` presents the shared question
  form and deduplicates native events. `core/card-actions.ts` owns answer
  confirmation, steering versus queue admission, retries and cancellation.
  `core/bus.ts:isLarkRunActive` identifies the originating ordinary turn even
  while it is attached to a background Goal or promoted after that Goal ends.
  Codex native goal controls, state retention and Claude command framing are
  documented in [native goal alignment](native-goal-alignment.md). Existing
  Codex controls bypass the ordinary queue only for the still-bound session;
  creation and other engines retain normal admission. Regression suites:
  `core-native-goal`, `core-goal-control-races`, `codex-goal-native`,
  `bridge-goal-sessions`, `claude-native-goal`, `core-claude-native-goal` and
  `run-presentation`; browser `goal-native-ui`. Claude command framing and
  native evidence parsing live in `codex/claude-stream-adapter.ts` and
  `codex/claude-native-goal.ts`. A turn-end presentation hint is carried outside
  the strict v1 run summary; it never changes the native goal state.
  `/goal` watcher events are presented by `core/commands.ts` with queue-only
  answers; stopping an attached ordinary turn preserves the surviving goal's
  own question. `QuestionForm.tsx` keeps device-scoped drafts and existing
  outbox behavior. DeepSeek gives repeated question text unique presentation
  keys while returning native question IDs, and reuses session approval grants
  only for a live owner. Regressions: `deepseek-harness-adapter`.
  Tests: `gateway-async-questions`, `gateway-workflows`, `gateway-card-states`,
  browser `questions` and opt-in `live-codex-async`.
  Codex blocking goal approvals/questions use the watcher's exact live native
  turn ID and cancellation lifetime in `codex/app-server-adapter.ts`; unresolved
  or retired ownership fails closed. Approval mode and native policy are
  unchanged. Tests: `codex-goal-approvals`, `app-server-adapter`,
  `codex-user-input`, `codex-mcp-elicitation`, `codex-permissions`.
  Empty MCP tool-consent forms preserve only the offered native persistence
  choices in `codex/codex-mcp-elicitation.ts`; the shared question card returns
  the explicit choice as `_meta.persist`, with no local permission cache.
  Opt-in browser acceptance: `live-codex-consent` (real Codex, synthetic MCP).
  [Consent mapping and evidence](client/codex-computer-use-consent-2026-11-12.md).
  [Behavior and evidence](client/async-questions-2026-10-12.md).
  Claude background-question receipts use `core/question-feedback.ts` and the
  adapter's host-local `onAnswerProgress` observer; retained approval callbacks
  preserve the App profile. [Cause, behavior and limits](client/question-feedback-2026-10-14.md).
  Regressions: `claude-stream-adapter`, `gateway-workflows`, `gateway-card-states`;
  browser `claude-card-continuity` and `questions`.

- Sent image previews: `client/src/AttachmentImage.tsx` and `message-images.css`
  bound long-image thumbnails and provide full-width scrolling previews.
  Bot images retain their original aspect ratio, including mixed captioned card
  galleries and consecutive image blocks; their full composition fits within
  the available column and a 320px height bound.
  User uploads use small single-image bounds and compact two-column galleries;
  filenames remain accessible without a separate line in the chat.
  [Sent thumbnail sizing and original-byte evidence](client/sent-thumbnails-2026-10-13.md).
  `Content.tsx` groups consecutive image blocks without changing stored content.
  Regressions: browser `message-images`, `attachment-message-actions`,
  `attachment-composer`, `card-layout`, `safe-area`.
  [Behavior and evidence](client/message-images-2026-10-12.md).
  [Bot image ratios and video covers](client/media-thumbnails-2026-10-16.md).
  The shared `ImageViewer.tsx` uses an opaque full canvas with overlaid header
  and bottom controls. Touch taps on the image or empty canvas toggle controls
  at any zoom, leaving the viewer open; a mouse click closes only on the empty
  canvas outside the image. Double-tap and double-click on the image still
  zoom/reset. Mouse clicks on the image also toggle controls without refitting.
  Close, system Back and Esc remain available. Input type, not viewport width, selects
  the rule. Drag, pinch, long press and a tap that stops inertia never dismiss;
  toolbar actions, keyboard interactions and gallery changes cancel pending taps. Native phones
  hold one immersive canvas for the lifetime of the viewer; toggling controls
  no longer toggles system bars or resizes the photo. Android reports separate
  viewer-only safe insets for the overlay controls, including hidden/transient
  bars and cutouts. Phone controls are icon-only with
  accessible names and 44px targets; desktop keeps action text. Browser
  `image-export`, `message-images`, `host-previews`, `safe-area` cover safe
  insets, original-byte exports, long-image scrolling and focus restoration.
  [Phone viewer polish](client/image-preview-toolbar-2026-10-16.md).
  [Stable native canvas and verification](client/image-viewer-stable-canvas-2026-10-26.md).
  Idle image canvases have no compositor transform; only active swipe feedback
  adds a temporary translation. Full-size images request synchronous presentation
  while thumbnails remain asynchronous. Native draft checks sample painted pixels
  across reopen, not only image load/dimensions.
  [Draft paint and queue hover verification](client/phone-queue-draft-preview-2026-10-26.md).
  `image-gallery.ts` scopes navigation to one message; `ImagePreview.tsx` selects
  its authenticated original. `LocalImagePreview.tsx` gives image file blocks,
  file lists and drafts the same reader. `use-image-view.ts` handles touch swipes
  at fit size, anchored double-tap/pinch zoom, pan inertia, ordinary wheel panning,
  modified-wheel zoom and resize anchors. Long images can switch width/whole fit.
  `image-viewer-fullscreen.ts` owns browser/Tauri fullscreen and native bar leases.
  Save/share
  uses the selected original, while `AttachmentImage.tsx` retains pending export
  locks across modal closure. Tests: unit `client-image-gallery`; browser
  `image-gallery`, `image-export`, `message-images`, `media-thumbnails`,
  `attachment-message-actions`, `host-previews`, `safe-area`.
  [Gestures, scope and verification](client/mobile-image-gestures-2026-10-17.md).
  New geometry/native unit checks and browser `image-viewer` /
  `image-viewer-opus-regressions-20261023` cover the shared viewer; the isolated
  `image-viewer-native-build.mjs` fixture exercises its actual macOS WebView.
  [Joint review and native acceptance limits](client/image-viewer-2026-10-23.md).
  `ImageViewer.tsx` also owns image context actions and copy shortcuts;
  `image-clipboard.ts` writes full-resolution PNG with user-gesture-safe deferred
  conversion. `DesktopMenu.tsx` accepts a dialog portal target to keep its menu
  above modal images. Tests: browser `image-context-menu`, `image-viewer`,
  `native-context-menu`, `message-context-menu`.
  [Copy behavior and verification limits](client/image-context-menu-2026-10-23.md).
  Message thumbnails (`AttachmentImage.tsx`) offer the same 复制图片 and save
  actions on desktop right-click, plus 放到白板 when a Workbench is available;
  regression `image-whiteboard-menu`.
  Tap behavior changes are client presentation only, with no Host/CLI or protocol
  change. Regressions: `image-viewer`, `image-gallery`,
  `image-viewer-opus-regressions-20261023`, `image-context-menu`.

- File type icons: `client/src/FileTypeIcon.tsx`, `file-kind.ts` and
  `file-type-icon.css` provide local, color-and-letter document icons for sent
  attachments, conversation files, drafts and rich reference previews. Known
  final extensions take precedence over generic upload MIME; MIME fills missing
  extension hints. This is presentation only and does not change preview/export
  validation. Regressions: `client-message-preview`, browser `document-preview`,
  `pdf-preview`, `attachment-composer`, `conversation-files`, `file-actions`.

- Draft attachments: `client/src/AttachmentDraft.tsx`, `DraftAttachmentPreview.tsx`
  and `attachment-draft.css` provide a compact scrollable tray and local previews
  without sending. Shared readers/export remain in `attachment-export.ts` and
  the document/media readers. Regressions: browser `attachment-composer`,
  `chat-drafts`, `keyboard`, `hold-to-talk`, `persistent-drafts`.
  [Behavior and evidence](client/attachment-drafts-2026-10-12.md).

- Conversation details: `client/src/ConversationDetails.tsx` separates chat, shared Bot settings and collapsed host tools. `ConversationDetailsFrame.tsx` preserves return navigation; `CreationDialog.tsx` isolates nested cancellation. Tests: `conversation-details`, `settings-lifecycle`, `native-back`, `group-settings`, `safe-area`. [Behavior and verification](client/conversation-details-2026-10-12.md).
  Sidebar-owned dialog stacks use a stable portal so combined-row activity reordering
  cannot remove native modal state. See [avatar/sidebar repair](client/avatar-sidebar-modal-2026-10-25.md);
  regressions: `bot-avatar-library`, `bot-context-menu`, `conversation-avatars`,
  `conversation-context-actions`, `conversation-folders`, `native-back`.

- Conversation session settings: `client/src/ConversationPanel.tsx` and
  `conversation-settings.css` separate described common actions from collapsed
  advanced recovery. Compaction choices match `core/shared/engine-commands.ts`;
  detach/reset explanations match `core/shared/session-commands.ts`. Tests:
  browser `conversation-settings`, `review-recovery`, opt-in
  `live-session-model` and `live-claude-binding`.
  [Behavior and verification](client/session-settings-2026-10-12.md).

- Bot deletion: `BotSettings.tsx` / `DeleteBotControl.tsx` expose an owner-only,
  named confirmation on phone and desktop. `DELETE /api/bots/:id` goes through
  `BotManager.delete` and the transaction in `HubStore.deleteBot`; schema 14
  tombstones revoke worker admission, preserve identity/history/files, stop the
  supervised worker and prevent create retries or restart from reactivating it.
  Direct chats and groups without Bots are archived; surviving group/topic
  members remain. Client directories retain deleted names only for history.
  Regressions: `hub-bot-delete`, `hub-bot-manager`, `hub-server`,
  `hub-state-backup`, browser `bot-delete`, `bot-name`.
  [Behavior and acceptance](client/bot-delete-and-composer-2026-10-14.md).

- Bot display names: `client/src/BotNameControl.tsx` opens from `BotSettings.tsx`
  on desktop and mobile. Owner-only `GET/PUT /api/bots/:id/name` persists the name
  in Hub metadata and broadcasts `bot.status`; compare-and-set prevents stale
  edits from replacing another device's name. The Bot may be offline; the Hub
  must be connected. Tests: `hub-bot-name`, `hub-server`, browser `bot-name`.
  [Behavior and verification](client/bot-name-2026-10-13.md).

- Bot persona editing: `client/src/PersonaControl.tsx` opens from
  Bot settings and conversation details. `client-protocol/persona.ts` and
  `runtime/persona-settings.ts` own bounded, revision-checked owner edits to the
  Bot-owned `workspace/AGENTS.md` persona section; `runtime/bot-instructions.ts`
  preserves other rules, migrates and archives legacy `agent.md`, and supplies
  an exact file reference through Bridge private turn guidance. Engine creation
  no longer injects legacy persona text. Hub routes and Gateway calls carry no
  arbitrary file path; `bots persona` uses the same owner API from the CLI.
  [Behavior, migration and verification](client/persona-agents-2026-11-04.md).
  Phone Me/search layout remains in `MobileHome.tsx` / `mobile-im.css`.
  `appearance.ts` syncs Android's `AppearancePlugin` / `NativeAppearance` canvas.
  Tests: `persona-settings`, browser `persona-mobile-polish`, Android
  `AppearanceTest` with an isolated `.appearancetest` app ID.
  [Behavior and evidence](client/persona-mobile-polish-2026-10-12.md).
  Shared `CreationDialog` starts at its heading unless a caller requests a
  specific control; close buttons keep keyboard focus indicators without an
  opening ring. Native dialog containers suppress their own outline when focus
  returns from a child such as LAN/Tailscale settings; controls keep their
  keyboard indicator. Regression: browser `local-relay` at phone/desktop widths.
  [Dialog focus and verification](client/dialog-focus-2026-10-13.md).
  Keyboard indicators share `--focus`; the selected Monochrome accent and
  own-message bubble ink supply its contrast-aware colour. See [focus colours
  and readback](client/keyboard-focus-accent-2026-10-30.md). Component focus
  rules must use this token rather than the neutral action `--accent`.
  `focus-intent.ts` preserves pointer/keyboard intent across dialog return and
  window activation so restored buttons do not acquire a pointer focus ring.
  Regression: browser `settings`, `persona-mobile-polish`, `attachment-composer`.
  [Settings return focus and verification](client/settings-focus-return-2026-10-13.md).
  `styles.css` disables the browser's native tap overlay at the document root,
  covering process details, recorded changes, nested controls and portaled dialogs.
  CSS pressed states, keyboard focus and text selection remain separate.
  This replaces image/home/attachment-specific exceptions; Host and CLI are unaffected.
  [Shared touch feedback and verification](client/shared-tap-feedback-2026-10-26.md).
  Desktop native activation: `src-tauri/src/window_activation.rs` restores the
  existing main window on macOS `RunEvent::Reopen` and through the shared tray,
  shortcut and notification entry. Main close hides; auxiliary close destroys.
  `client/scripts/window-activation-audit.mjs` exercises real LaunchServices
  reopen events, hide/minimize cycles and unchanged WebView draft/document state
  in an isolated app. Host/CLI and mobile behavior are unchanged.
  [Window restoration and acceptance](client/desktop-window-activation-2026-10-15.md).
  Android `MainActivity` also restores the canvas after configuration callbacks
  and window focus changes; `AppearanceTest` covers Home/return, rotation,
  system theme changes, native dialogs and keyboard dismissal.
  [System-bar regression and evidence](client/android-system-bars-2026-10-12.md).
  Production CSS can shorten `#ffffff` to `#fff`; `syncThemeColor` expands it
  before native validation/contrast calculation. The native startup regression
  seeds saved web preferences and a stale native canvas, then launches the
  packaged app without manually calling the appearance bridge.
  [Startup root cause and installable fix](client/android-bars-startup-2026-10-13.md).

- Desktop Bot conversation folding: `client/src/ConversationList.tsx` renders
  independent leading disclosures and folded unread/attention summaries;
  `bot-conversation-folds.ts` retains local host/device-scoped choices over
  remounts/reloads, without changing conversation selection or execution.
  Explicit Bot identity/create actions unfold; activity never does. Styling is
  in `bot-conversation-folds.css`; browser coverage is `bot-conversation-folds`
  and `bot-context-menu` in Chromium/WebKit. CLI has no corresponding local
  presentation surface. [Behavior and verification](client/bot-conversation-folds-2026-10-24.md).
  Bot rows reserve one trailing action column, including Chancellor rows without
  a create button; source-host badges precede the count. Bot/group section headings
  have no total count.
  See [count alignment](client/sidebar-count-alignment-2026-11-02.md).
  Ordinary Bot-list group disclosures use the local fold store with a separate
  `tarobot-collapsed-group-topics-v1` namespace, scoped by paired host/device.
  ADHD starts each visit with group topics collapsed. `AdhdBoard.tsx` owns the
  visit's expanded group keys (host/registration/group), so search, host grouping,
  pinning and activity cannot reset manual choices during that visit. Leaving
  and entering again or reloading starts collapsed without changing ordinary
  sidebar preferences, selected panes, unread state or drafts. Search reveals
  matching children temporarily; clearing it restores the current visit's choice.
  A collapsed ADHD group summarizes pending questions/approvals from its live
  topics; expanding or searching moves those indicators to the actual topic rows.
  Pinned topics stay reachable under the group because the ADHD inbox does not
  have the ordinary Bot tree's separate pinned-topic section. `adhd-topic-attention`
  covers live retirement, search, parent requests and pin/unpin in both browsers.
  Independent [post-1.0.115 UI audit](client/day-ui-audit-2026-10-27.md).
  Regressions: `adhd-board` (mode entry, selected topic, drafts, search, updates,
  reload, host regrouping and identical IDs across hosts), `bot-conversation-folds`
  (ordinary storage, including unavailable/invalid storage).
  This is local App presentation only; no Host state, sync protocol or CLI change.
  ADHD's white reading plane also removes nested reply-card and composer
  shadows (idle/focused) in Porcelain and Monochrome, with an accent frame on
  the focused pane. Ordinary chat and drag feedback remain separate. The existing
  `adhd-board` flat-surface regression includes real replies and focused inputs.
  ADHD's indented topic count uses a pale accent tint with readable text; nested
  topic rows have compact spacing, independently of full inbox-row density.
  [Topic hierarchy](client/adhd-topic-hierarchy-2026-10-26.md).
  `porcelain-details.css` preserves the selected-row border around a folded
  current Bot's status dot instead of overriding it with the sidebar plane;
  `bot-conversation-folds` checks that boundary in light and dark themes.

- Personal conversation folders: `client/src/ConversationFolders.tsx` shares
  folder creation, management, moves and collapsible sections between the Mac
  conversation layout and phone inbox. `client-protocol/conversation-folders.ts`
  and `hub/conversation-folders.ts` own user/Hub-scoped, revision-checked metadata;
  authenticated HTTP edits and socket snapshots synchronize devices. Existing
  Bot grouping and session isolation do not change. Tests: `hub-conversation-folders`,
  browser `conversation-folders`, `sidebar-layout`, `mobile-conversation-actions`,
  `mobile-im`. [Behavior and verification](client/conversation-folders-2026-10-13.md).
  `mobile-im.css` inherits phone typography without resetting component text
  colors, preserving inverse primary labels inside folder dialogs. Browser
  `conversation-folders` checks empty/filled forms across every palette and both
  themes. [Button contrast repair](client/folder-button-2026-10-13.md).
  `connection.ts` and `storage.ts` treat authenticated folder snapshots as
  authoritative after backup rollback, while fencing late same-session updates.
  Folder dialogs follow the visible host/inbox rather than hidden mounted views.
  Phone folder headings reuse `useConversationHold` for an action sheet with
  move-up/down, move-to-top and rename; desktop headings expose the same actions
  through right-click or Shift+F10. Ordinary taps still collapse/expand; system
  “未分组” can move but cannot be renamed. The folder
  browser journey covers release-click suppression, scroll/cancel, sync/reload
  and cleanup when navigating or changing layouts.
  Desktop folder/section context menus expose “管理分组”, including through
  an empty-directory context menu; phones retain their list-options entry. `FolderOrderEditor.tsx` / `folder-order-drag.ts` combine touch,
  mouse and keyboard sorting (including Unfiled) with create/rename/delete in
  that manager. Each row's More button reveals move/edit actions; unsaved order
  survives the manager's own edits. Hub revisions guard
  complete-order writes; `conversation-folders.reorder.v1` gates older hosts,
  with a readable explanation instead of a disabled entry. `unfiledIndex` is optional
  user-scoped metadata, carried through the existing cache/socket snapshots.
  `conversation-folders` covers drag cancellation, auto-scroll, cross-device
  sync, reload, concurrent edits and offline/older-host controls.
  [Unified manager and CLI impact](client/unified-folder-manager-2026-10-16.md).
  Folder pinning adds `pinnedFolderIds` and the capability
  `conversation-folders.pin.v1` to the same personal metadata and API. Heading
  menus and manager actions share it; pinned folders sort before ordinary ones,
  including on older clients. `host-cli/folders.ts` provides `folders list/pin`.
  Regressions: `hub-conversation-folders`, `host-cli-folders`, `host-cli-entry`,
  `hub-server`, browser `conversation-folders` and the layout/mobile suites above.
  [Pin semantics and acceptance](client/folder-pinning-2026-10-22.md).
  Conversation multi-select uses `ConversationBulkSelection.tsx` across the
  desktop directory, ADHD and phone inbox; right-click/long-press exposes 多选.
  `hub/conversation-batch.ts` owns atomic archive/restore/move/create-and-move and durable
  per-user request receipts, gated by `conversations.batch.v1`. It reuses
  `HubStore.updateConversationInTransaction` and
  `ConversationFolders.changeInTransaction`; ordinary folder edits cannot submit
  internal batch variants. Restore additionally requires `conversations.restore.v1`.
  `host-cli/conversations.ts` exposes local/archive/restore/move without changing
  cross-Bot `conversations list`. Restoration checks ownership, archived parents
  and deleted Bots; it preserves sessions without automatically resuming work.
  Regressions:
  `hub-conversation-batch`, `host-cli-conversations`, `client-conversation-bulk`,
  existing folder/backup/Host suites, browser `conversation-bulk`,
  `mobile-conversation-actions`, `conversation-folders` and `adhd-board`.
  [Selection, recovery and compatibility](client/conversation-multiselect-2026-10-24.md)
  also records accent checkmarks, compact confirmation, explicit archive/move
  retry labels and short-screen footer visibility from the October 28 follow-up.
  The Host privately retains ordinary order while pins exist, so unpin restores
  the row's ordinary position. The manager also rebases unpinned rows without
  discarding pending peer moves. [Unpin repair](client/folder-unpin-order-2026-10-23.md).
  Desktop moves are available in both sidebar context menus and the chat header's
  More menu. `conversation-folders` covers create-and-move, newly created choices,
  draft/selection retention, reload, group/topic scope and offline disabling.
  Selected-chat recovery uses a pending hint scoped to pairing/cache generation;
  `multiple-hosts`, `local-reset` and `sidebar-layout` cover stale writes and
  immediate close/reload. [Audit evidence](client/joint-opus-audit-2026-10-13.md).

- Two-level conversation pins: `storage.ts` keeps independent device-local
  `pins` and `globalPins` with atomic per-row writes. `conversation-inbox.ts`
  projects globally pinned topics separately from their parent aggregates.
  `GlobalPinSection.tsx`, `ConversationList`, `CombinedSidebar`, `HostApp` and
  `MobileHome` put a single global section above ordinary groups; shared ADHD
  navigation follows the same rules. Local pinning does not change Host folder
  assignments or sessions. [Behavior and verification](client/global-conversation-pins-2026-10-28.md).

- Phone inbox actions: `client/src/useConversationHold.ts` owns the delegated
  touch hold, movement/cancellation and native text-menu suppression for list
  rows and editable folder headings. `MobileConversationActions.tsx` resolves the held host and live
  conversation, reuses confirmed removal/rename and device-local pins. The
  phone Me tab opens `PreferencesPanel` directly at notifications and displays
  push prerequisites separately from reminder intent. Browser regressions:
  `mobile-conversation-actions`, `mobile-im`, `conversation-context-actions`,
  `settings-notifications`. [Behavior and delivery limits](client/mobile-list-actions-2026-10-12.md).

- Reading size: `client/src/FontSizeSlider.tsx` preserves a native accessible
  range for keyboard/assistive changes while gating pointer updates on horizontal
  intent. Touch-down, vertical scroll and cancelled pending gestures cannot
  overwrite the device preference. Phone settings cards have 16px inner gutters.
  [Slider and spacing verification](client/font-slider-2026-10-13.md). Tests:
  browser `theme-font-size`, `settings-language`; native `PairingJourneyTest`
  with `fontSettings=true`. [Regression evidence](client/theme-font-size-2026-10-12.md).
  CLI type/color refinement lives in `cli-typography.css`, with bundled JetBrains
  Mono Latin and Sarasa Chinese fonts and inherited Markdown table sizes.
  [Dark-only CLI and wider Latin](client/cli-dark-readable-2026-10-28.md) resolves
  CLI to dark in `appearance.ts` without overwriting other palettes' saved mode.
  Regressions: `cli-typography`,
  `markdown-tables`, `palettes`, native `cliTypography=true`.
  [Font, contrast and size evidence](client/cli-typography-2026-10-12.md).
  Direct message prose in `brand-theme.css` uses the same chosen size as Bot
  reply cards. `theme-font-size` compares user/plain Bot/card text across
  themes and viewport sizes. Monochrome light own-message bubbles use the
  approved neutral gray with matching dark text, quotes, links and code tokens
  in `palette-tokens.css`; theme previews share those tokens. This is App-only
  presentation with no CLI behavior change; `palettes` covers contrast and modes. [Size parity evidence](client/message-type-size-2026-10-13.md).

- Interface density: `client/src/LayoutDensityPicker.tsx` selects compact,
  standard or spacious geometry independently of reading size. `layout-density.css`
  owns layout tokens; `MobileHome.tsx` passes real avatar sizes so group collages
  remain bounded. The device preference is normalized in both storage readers
  and mirrored through `appearance.ts` before rendering. No viewport zoom or
  safe-area scaling. Unset/invalid density defaults to Compact on native mobile
  and phone-width web, Standard on desktop; valid saved choices take precedence.
  The settings picker uses a bounded 360px control and a miniature two-row
  preview, without a page-sized heading. Desktop pointer controls are 32px high;
  touch controls retain 44px targets. This presentation-only change has no CLI
  or Host impact and does not change the density tokens used by real lists.
  Browser regressions: `layout-density`, `theme-font-size`,
  `sidebar-layout`. [Behavior and verification](client/layout-density-2026-10-13.md).
  iPhone readability adjustments are explicitly scoped to the startup iOS
  platform attribute and matching Avatar sizes. Android and desktop/browser
  retain their previous Compact geometry, including settings previews and
  narrow desktop windows; the regular desktop sidebar has separate tokens.
  Single-image drafts use a thumbnail without the duplicate file header;
  phone composer focus uses a quiet border. [Scope and browser evidence](client/phone-inbox-composer-2026-10-23.md).
  `ios-adaptive.css` also fits the iOS bottom navigation to its density row
  without reducing the gesture inset. [Navigation regression and evidence](client/ios-bottom-navigation-2026-11-05.md).
  The iPhone keyboard shell, edge-back gesture, safe-area fixes and client-local
  render/read/write coalescing are documented in the
  [iPhone UI audit and native acceptance](client/iphone-ui-audit-2026-10-23.md).
  Fast phone navigation and always-enabled App motion live in
  `motion.ts`, `use-scene-motion.ts`, `motion.css`, `appearance.ts` and both
  preference readers. They preserve virtual message geometry and pointer targets,
  and yield to input without delaying navigation. The App animation switch and
  system-triggered animation suppression were removed; animations stay enabled
  across desktop, Android and iPhone, including for old saved off values. See
  [always-on animation behavior](client/always-on-animations-2026-10-28.md).
  Pointer-induced focus must retain paused scene geometry until click dispatch;
  keyboard focus still settles immediately. See the 1.0.123 preflight regression.
  Regressions: browser `always-on-motion`, `mobile-motion`,
  `native-back`, `keyboard`, `message-background-scroll`, `mobile-im`, settings,
  image reader and ADHD pane reordering. See [behavior and evidence boundaries](client/mobile-motion-2026-10-23.md).

- macOS device-key prompts: `client/src-tauri/src/main.rs` reads device keys from
  `com.tarobot.client.device`; `device_keychain.rs` keeps blocking OS access off
  the network executor and prevents overlapping prompts. Ad-hoc update identity
  and the remaining Developer ID signing requirement are documented in
  [keychain authorization](client/macos-keychain-prompts.md).

- Bot permissions: `state/permission-options.ts` owns per-engine choices and
  legacy mode mappings; `runtime/permissions-settings.ts` performs owner-routed,
  revision-checked config updates. `client-protocol/permissions.ts` is the shared
  contract; `PermissionControl.tsx` and `PermissionSelect.tsx` expose it from
  creation, Bot settings and conversation details. Actual requests still use
  the shared approval cards and engine-native scopes. Regressions:
  `permissions-settings`, `hub-bot-manager`, native adapter tests; browser
  `permissions`, `creation`, `cross-device`. [Defaults and limitations](permissions.md).
  Execution reads validate permission fields before compatibility salvage
  (`state/engine-config-error.ts`, `engine-config-safety` tests). Gateway settings
  use `gateway/activity.ts` to include delegated work and pending approvals.
  Client permissions and effort share `bot-settings-request.ts` for cancellation,
  bounded saves and Bot/connection-scoped responses (`settings-lifecycle`).
  [Joint Opus 5.5 review and regressions](client/joint-opus-review-2026-10-12.md).

- Attachment reply/forward controls: phone text and attachments share
  `MessageActionSheet`, opened by `useMessageHold`; no attachment action footer
  is reserved. Image/file/video primaries support hold without opening their
  viewer; author/time also opens the sheet for audio-only messages while native
  playback and seek controls retain their gestures. Desktop keeps its existing
  message toolbar. Browser `attachment-message-actions` and `message-images`
  cover batches, forwarded original bytes and layout transitions.
  [Phone menu unification](client/phone-message-menu-2026-10-26.md) records the
  removed footer, media gesture boundaries and desktop scope.
  [Phone action deduplication](client/mobile-attachment-action-dedup-2026-10-16.md).
  `Content.tsx` / `file-delivery.css` combine a Bot's caption and consecutive
  files into one delivery card. Original message
  blocks and attachment identities stay intact for quote/forward and downloads.
  Browser `attachment-message-actions`, `file-actions` and `document-preview`
  cover grouped documents, narrow layouts, themes and file operations.
  Desktop document cards group icon/name/size with the receipt above a compact
  operations area, keeping preview/save and open/reveal together through narrow
  pane wrapping. Caption text shares the surface without a separate divider.
  Phone, conversation-file lists and video layouts retain their existing main
  structure. `file-actions` checks real card widths, themes, focus and touch
  targets. [Current document layout](client/file-card-layout-2026-10-28.md).
  [Saved footer layout and verification](client/saved-file-footer-2026-10-19.md).
  Bot image captions also share one card with adjacent image blocks or a plain
  gallery card, without rewriting history or merging interactive cards. Browser
  `media-thumbnails` and `attachment-message-actions` cover proportions and actions.
  [Image caption repair](client/image-caption-bubble-2026-10-17.md).
  [Desktop action deduplication](client/attachment-action-dedup-2026-10-13.md).
  `ForwardMessage.tsx` defaults direct-chat
  delivery to its Bot, leaves group recipients explicit, and searches Bot names.
  Regression: `hub-forwarding`, `gateway-service`; browser
  `attachment-message-actions`, `message-context-menu`, `message-actions`,
  `message-hold`, `conversation-files`. Opt-in `live-quoted-media` verifies actual
  engine reads from these controls. [Evidence](client/attachment-actions-2026-10-12.md).
  Forward dialogs follow the cached source and reconcile changing recipients;
  quoted drafts validate the source again after attachment upload. Regressions:
  browser `forward-lifecycle`, `forward-picker`, `reference-draft-lifecycle`.
  Sent user quotes and forwarded sources share the message's own bubble through
  `App.tsx` / `Content.tsx` / `quoted-reply.css`, including mobile and ADHD panes.
  Regressions: browser `forwarded-message`, `quoted-reply`.
  [Forwarded bubble repair](client/forwarded-message-bubble-2026-10-18.md).
  The forward picker omits source previews but retains source lifecycle checks;
  destination avatars use the active connection and topics inherit group images.
  [Lifecycle audit](client/flow-audit-2026-10-12.md).

- Conversation attachments: `src/hub/conversation-files.ts` and
  `src/client-protocol/conversation-files.ts` own the membership-scoped, paginated
  message attachment list. `client/src/ConversationFiles.tsx` is reached from
  the desktop/phone chat ellipsis, reuses `Content.tsx` preview/save, and can jump
  to a source message. This is separate from workspace file inventory.
  Media preview: `MediaReader.tsx` and inline audio in `Content.tsx`. Desktop
  voice chrome is owned by `InlineAudioControls.tsx`; native phone controls stay
  independent. See [desktop voice controls](client/desktop-inline-audio-2026-10-27.md). Browser
  `media-playback` verifies actual decode, play/pause/seek and close behavior;
  Android `MediaPlaybackTest` uses an isolated `.mediatest` App and shared synthetic
  fixtures. [Playback evidence](client/media-playback-2026-10-12.md).
  `client-protocol/attachment-mime.ts` shares delivery MIME hints with Gateway
  file/video sends. `attachment-export.ts` recovers absent/generic media MIME
  for historical files and drafts without changing stored bytes or rendering
  executable content. Regressions: `gateway-voice`, `gateway-app-tools`,
  `gateway-service`; browser `media-playback`, `attachment-safety`.
  [Generic media recovery](client/generic-media-preview-2026-10-16.md).
  Sent and draft desktop video previews opt their inner `.file-preview` panel
  into `dialog-drag.ts` through `AttachmentPreviewHeader.tsx`; the full-screen
  dialog/backdrop stays fixed. Only header space starts a drag; playback controls
  and header buttons keep their own actions. Browser `media-preview-drag`
  covers playback continuity, bounds, resizing, drafts and touch exclusion.
  [Behavior and validation](client/video-preview-drag-2026-10-16.md).
  `VideoThumbnail.tsx` / `video-thumbnail.ts` add inline video covers and duration
  to chat file cards. Visible small files use the authenticated attachment path;
  larger videos reuse an explicit preview's bytes. One passive job runs at a
  time, with cancellation and bounded connection-scoped cover caching. Browser
  `media-thumbnails` verifies real frame pixels, mixed image ratios, playback,
  original downloads, and large/unsupported-file fallbacks in both engines.
  `MediaReader.tsx` reuses those covers for the opening video poster, with an
  icon-free loading fallback and original video geometry. See
  [video preview poster repair](client/video-preview-poster-2026-10-23.md).
  Tests: `hub-conversation-files`, `hub-download`, `hub-link-preview`; browser
  `conversation-files`, `document-preview`, `attachment-safety`.
  [Behavior and native evidence](client/conversation-files-2026-10-12.md).

- Desktop ADHD board: `client/src/HostApp.tsx` owns the mode and connection pool;
  `AdhdBoard.tsx` hosts independent `Workspace` pane presentations keyed by
  host/registration/conversation. The third `SidebarLayoutSwitch` option reuses
  `ConversationList`/`CombinedSidebar` with sibling checkboxes. `adhd-board-state.ts`
  validates device-local layout and independent text/column settings. Expanded
  iPhone boards cap selection and legacy restore at two panes; iPad/desktop keep
  twelve. `viewport.css` and `ios-adaptive.css` size only the outer chat/ADHD
  shell, never nested `conversation-pane` shells. Browser `adhd-ios-phone` covers
  native overlay containment, capacity and retained drafts. `viewport.ts` reveals
  the entire active iOS ADHD composer inside its grid when the keyboard opens,
  focus moves or the window resizes; single-chat/non-iOS exclusions remain.
  `ios-adaptive.css` owns the card input-size floor and outer toolbar top inset.
  Browser `adhd-keyboard` exercises the actual viewport controller with native-
  shaped events, lower rows, split resize, tall keyboards and input/Send hit tests;
  see [Duo/iPad pane repair](client/iphone-duo-scope-2026-11-10.md#adhd-pane-containment-and-device-limit-2026-11-12).
  `HostRegistry`
  commits legacy layout and display records atomically. `connection.ts` supplies command subscribers
  and per-conversation invalidation, retaining global receipt watermarks.
  Tests: `adhd-board-state`, `client/tests/adhd-connection`, browser `adhd-board`
  in Chromium and WebKit, plus the normal conversation/draft/queue journeys.
  This is presentation-only; no separate CLI command or host capability is
  added. [Design and verification](client/adhd-board-2026-10-17.md).
  Porcelain/Monochrome ADHD uses light-gray workspace/toolbar and near-white
  pane headers around pure-white chats in light mode; dark mode uses the theme's
  canvas, surface and chat colors. The focused pane has a full accent frame,
  using Monochrome's optional mark color or the palette accent. Border width and
  pane geometry stay fixed. The opaque conversation child clips to the inner
  frame radius so its background cannot wash out the curved border.
  Resting borders/corners, shadow-free reading surfaces,
  ordinary sidebar separator removal and temporary drag lift are preserved.
  Unfocused attention keeps its top edge; it cannot override the focused frame.
  [Current surface decision](client/adhd-surfaces-2026-10-28.md) supersedes the
  previous white workspace and header-number-only focus treatment.
  Compact display selects retain shared theme chevrons with reserved text space;
  pointer focus is quiet while keyboard focus remains visible. Browser `adhd-board`
  covers clearance, input intent and saved preferences. See [display controls](client/adhd-display-selects-2026-10-26.md).
  ADHD message portraits are hidden and their gutter is reclaimed in narrow
  and expanded panes. Author names/timestamps remain visible, including group
  conversations; pending/replying dots move beside the author name and honor
  reduced motion. Sidebar and header identities retain their own existing rules;
  ordinary desktop/phone messages retain default/custom portraits. Browser
  `adhd-board` covers these boundaries in light/dark/CLI layouts, mode switches,
  group authors, and phone chat.
  Leaving through a sidebar mode or Return to chat opens the focused pane's
  exact host registration and conversation/topic. The target is captured before
  draft/Bus guards wait, then checked against current host and directory state;
  an empty or unavailable selection retains ordinary-chat fallback behavior.
  [Selection handoff and regression evidence](client/adhd-return-selection-2026-10-23.md).
  `sidebar-resize.css` applies the same document-local width and splitter to
  both shell types, hides the picker scrollbar without disabling scrolling,
  and retains the normal inbox's Bot labels. Browser `sidebar-resize` and
  `adhd-board` cover reset, bounds, mode switches and draft preservation.
  [Sidebar follow-up](client/adhd-sidebar-notification-preview-2026-10-17.md).
  In the minimum-width inbox container, ADHD pending question/approval words
  become a compact marker so the conversation title remains readable. Its row
  accessible name and tooltip retain the state; wider sidebars keep the words.
  Browser `adhd-topic-attention` covers both themes and resizing back to text.
  Ordinary chat and ADHD share the `.search-box` skin and layout-switch spacing;
  mode changes keep the field, icon, input baseline and mode buttons aligned.
  The ADHD clear action fits inside that fixed-height field without moving the
  directory. Search still submits host history in ordinary chat and filters
  conversation/Bot names in ADHD; accessible labels and query ownership remain
  distinct. Browser `adhd-board`, `sidebar-resize` and `search` cover the related
  navigation, draft, resize and search paths. This is App presentation only,
  with no Host API or headless CLI change.
  Each pane exposes conversation-scoped history search, sharing `history-search`
  and existing virtual navigation. Optional filters fold in narrow panes; pane
  controls, draft ownership and running tasks remain intact. `search-message-highlight`
  paints located words without DOM/clipboard mutation or whole-bubble frames,
  including one-time positioning inside long replies. Browser `adhd-search`,
  `adhd-board`, `search`, `message-focus` and `deletion-result-sync` cover this
  path. [Issue #74 design and validation](client/adhd-pane-search-2026-10-26.md).
  Pane headers use one inline row with a numbered reorder handle and a separate
  priority status slot. Container queries stay on the header.
  [Single-line header](client/adhd-single-line-header-2026-10-17.md).
  `adhd-pane-drag.ts` uses board pointer capture for numbered handles and blank
  header space, avoiding native HTML drag interception. Fixed grid slots drive
  pointer-following panes, animated neighbour movement and a drop placeholder;
  gaps retain the preview, while leaving the board cancels. `prepareReorder`
  snapshots every pane's reading/editor scroll position before both pointer and
  keyboard moves; a layout effect restores it and animates the final placement.
  [Pointer/native reorder](client/adhd-pointer-reorder-2026-10-18.md).
  [Header dragging and motion](client/adhd-header-drag-motion-2026-10-18.md).
  Read receipts follow each visible pane's latest-message edge independently of
  keyboard focus. Inner message scrolling does not chain into the board. Browser
  `adhd-board` covers unfocused receipts, offscreen history, live typing, long
  streaming replies and both scroll boundaries.
  [Reading and native scope](client/adhd-reading-2026-10-17.md).
  `WorkspaceFooter.tsx` shares the ordinary inbox's profile, host workspace and
  settings entries with the board. `AdhdWorkspaceTools.tsx` opens the existing
  host tools without mounting a hidden chat; the scope follows the focused pane
  (or the previously active host on an empty board). Tool overlays escape the
  sidebar and retain their host registration. The board hides its scrollbar
  without disabling scroll or clipping the last composer. Browser `adhd-board`
  covers footer actions, nested network connection settings, host-scoped file
  requests, draft preservation and classic-scrollbar geometry.
  [Workspace tools and viewport](client/adhd-workspace-tools-2026-10-17.md).
  The shared footer's personal-avatar button uses a quiet keyboard-focus fill,
  with no detached portrait ring; focus restoration and keyboard activation
  remain intact. [Avatar focus regression](client/footer-avatar-focus-2026-10-26.md).
  `SidebarLayoutSwitch` similarly uses a quiet fill and underline for keyboard
  focus, keeping the selected mode separate; Tab does not activate another mode.
  [Windows outer-scrollbar investigation](client/adhd-windows-scrollbars-2026-10-19.md)
  adds per-frame Bus transition/expanded-pane checks at three device pixel
  ratios; the reported Windows native issue remains unverified and unresolved.

- History-search context: `client/src/App.tsx` gives both layouts a dedicated
  search header naming its host-wide or current-conversation scope, without
  conversation actions/details. Desktop header search and Cmd+F/Ctrl+F target
  the current conversation; sidebar and phone inbox search target all chats.
  `history-search.ts` owns queries/pagination and rejects out-of-scope responses.
  `SearchExcerpt.tsx` / `search-highlight.ts` mark literal matches using the
  applied query, not unsubmitted filter edits. Preview cleanup falls back to
  the original excerpt if it would hide a match; only React text nodes are used.
  Tests: `client-search-highlight`, browser `search` / `deletion-result-sync`.
  Existing `search` and `mobile-im` journeys check result navigation and return
  behavior. [Original context fix](client/search-context-2026-10-12.md),
  [conversation search](client/conversation-search-2026-10-13.md).

- Conversation entry and reading: `client/src/App.tsx` keys virtual heights by
  message ID, disconnects hidden chats, and measures the tail before displaying
  its final position. A DOM-only tail observer compensates Markdown layout
  without re-entering React measurement inside ResizeObserver. Explicit history
  reading and search/reference targets keep their anchors. Tests: browser
  `conversation-entry`, `message-reading`, `message-refresh`,
  `message-send-continuity`, `outbox-refresh`, `search`, `keyboard`,
  `multiple-hosts`, `stream`. [Behavior and verification](client/conversation-entry-2026-10-13.md).
  Notification/search/reference location retains `focused-message` as an anchor
  marker but no longer draws an outline around the entire message body. The
  base and branded styles both omit that decoration; control-level keyboard
  focus and search-result word highlights remain unchanged. Browser
  `message-focus` covers notification routing at phone/desktop widths, light/dark
  palettes, new replies during history reading and returning to the latest
  message. This is App presentation only; Host/CLI behavior is unchanged.
  Passive following writes the current tail directly instead of starting an
  index-navigation reconciliation that can outlive a swipe. Portal gestures
  belong to their own readers and do not change chat-follow state.
  Touch reading pauses follow-to-end before live layout writes; returning to
  the actual bottom must follow a downward reading intent, not mere proximity.
  `RunPresentation.tsx` restores process position after the initial rows commit,
  without rewriting scrollTop on live journal refreshes. Regressions:
  `message-reading`, `run-details-refresh`, `conversation-entry`, `composer-size`,
  `outbox-refresh`. [Touch behavior and acceptance](client/touch-reading-2026-10-14.md).
  `reading-scroll.ts` preserves the iOS reading anchor during row measurement
  and transfers the logical offset back without a post-gesture jump. Host-pool
  cache notifications and run/question subscriptions are scoped;
  `ConversationMessageContent.tsx` retains reference memoization. Regressions:
  `message-background-scroll`, reading/following, conversation-entry, question/
  stop, host, quoted/forwarded and attachment suites. [Background output and
  iPhone scrolling](client/iphone-background-scroll-2026-10-23.md) records
  reproduction, render counts and the physical-device boundary.
  On non-iOS readers, `reading-scroll.canAdjust` skips a row correction while
  an explicit native scroll has not yet reached the virtualizer's offset
  observer. This prevents stale correction coordinates from undoing a location
  jump. iOS deferred-origin compensation is unchanged.
  Accepted immediate non-iOS navigation also reports its written position via
  the public offset observer before a stale clamped correction can replay.
  Clamped restores, smooth scrolling and compensation writes remain native.
  Deterministic coverage:
  `client-reading-scroll-platform`; browser coverage: `adhd-board`,
  `message-focus`, `message-background-scroll`, `iphone-image-scroll`.
  `image-dimensions.ts` retains bounded, connection-scoped decoded geometry for
  virtualized `AttachmentImage` remounts and already-mounted lazy occurrences.
  `iphone-image-scroll` covers mixed image galleries, fast history reading,
  separate-chat streaming and touch release. See
  [image history stability and limits](client/iphone-image-scroll-2026-10-24.md).

- Product identity: the owner-selected phoenix (2026-11-04, replacing the
  fox ahead of the TaroBird rename) is defined by
  `assets/brand/brand-identity.json`; `BrandScenes.tsx` keeps the `BrandMark`
  for pairing, welcome, loading and recovery, and text-only `BrandName` for the
  main, ADHD and Agent Bus sidebars. Personal Bot avatars remain independent.
  `scripts/generate-app-icons.mjs` produces desktop/Capacitor/browser icons,
  iOS launch marks, Android notification and themed monochrome resources.
  Android's launch theme uses its checked adaptive launcher directly.
  `assets/brand/generated-icons.json` covers every generated destination.
  `scripts/verify-release-icons.py --source` verifies source coverage and alpha;
  its package modes verify final macOS/Windows/Android payloads. The separately
  approved `launcher-art.png` is the byte-identical selected
  `alternates/phoenix-lean.png` close-up on warm light gray;
  Windows uses a rounded tile with transparent corners, while macOS status items retain the separate flat
  line-style side-view bird `tray-macos.svg` rendered at 36px and displayed at 22pt by Electron.
  This Mac menu-bar sizing is presentation only; other platform icons and the
  headless CLI are unchanged.
  Android monochrome/notification icons and CLI-style App scenes separately
  still use the retired fox silhouette `fox-monochrome.svg`, so Mac
  status-item refinements do not alter them.
  Android extends edge pixels into its adaptive motion field, with all four
  seams checked. Its close-up maps into the central 72dp viewport; both eyes are
  checked inside the 66dp safe circle.
  The original Bot avatar and scene/launch marks
  remain separate. This launcher-only refresh has no Host/CLI behavior impact.
  [Brand sources and regeneration](../assets/brand/README.md).
  `scripts/render-brand-preview.mjs` renders the GitHub social cover and an
  asset contact sheet. README capture scripts use disposable demonstration
  Hubs; historical design/audit screenshots are not rewritten. Cover-only and
  product-composition rendering use `scripts/render-readme-art.mjs` with
  `--covers-only` or `--products-only`; capture provenance is in
  `assets/product/README.md#fox-brand-refresh-2026-10-25`. The subsequent
  documentation-only orange refresh selects the existing `white-orange` palette
  and `pastel-fox` for the leading demo Bot; App defaults remain unchanged
  ([scope](../assets/product/README.md#orange-documentation-refresh-2026-10-25)).
  Product-example frames and demo stages use neutral light gray, keeping orange
  in the fox and interface accents; the original UI captures remain unchanged.
  Regressions: browser `brand-wordmark`, `pairing-design`, `palettes` and the
  source icon checker. Browser/asset checks do not imply an installed release.
  [Fox brand change and verification](client/fox-brand-2026-10-25.md);
  [phoenix icon change](client/phoenix-brand-2026-11-04.md).
  `render-readme-bot-network.mjs` generates the English/Chinese Bot network
  illustrations using fictional roles; provenance is in `assets/product/README.md`.
  The [homepage capture record](../assets/product/README.md#homepage-structure-and-motion-refresh-2026-11-04)
  covers the restored section order, bilingual conversation-first desktop/phone
  recordings, later browser/canvas demonstrations, distinct Bot portraits and
  privacy-reviewed documentation frames. PPT appears only in the feature list.
  This changes no App, Host or CLI behavior.

- Composer IME confirmation: `client/src/App.tsx` checks both `isComposing` and
  the WebKit IME key code before Enter-to-send, and excludes held-key repeats.
  Desktop Command+Enter on macOS and Alt+Enter on Windows insert a newline at
  the selection, preserving native undo where supported; Shift+Enter remains
  available, and the former Option+Enter alias is retained for compatibility.
  Browser `composer-ime` covers Latin/Chinese confirmation, modified newline
  shortcuts, undo, draft persistence and the next ordinary Enter;
  [native checks and remaining boundaries](client/composer-ime-2026-10-11.md).
  Composer sending uses an icon-only up arrow with a stable accessible name
  and queue-aware tooltip. [Send-button verification](client/send-icon-2026-10-13.md).

- Bot model marks: `client/src/model-brand.ts`, `BotName.tsx` and `bot-name.css`
  resolve the current model before engine defaults, render locally bundled
  monochrome logos, and omit unknown explicit aliases. `BotReferences` and
  cached Bot metadata stay scoped to the owning host. Gateway transport reads
  bounded public configuration after commands/calls and on heartbeat, while
  the authenticated Hub socket broadcasts changed metadata only. Tests:
  `model-brand`, `gateway-model-status`, `gateway-service`, `gateway-cards`,
  `gateway-recovery`; browser `model-brands`, `multiple-hosts`, `mobile-im`,
  `forward-picker`, `group-settings`.
  [Behavior and update requirements](client/model-brand-icons-2026-10-12.md).
  Phone chat headers omit the duplicate Bot name and model mark beside the
  conversation title; Bot browsing stays in More and conversation details.
  Desktop/ADHD headers and phone list identities keep their existing display.
  This is presentation-only, with no Host or headless CLI behavior change.
  Android/browser phone activity sits next to the workbench action with full-size
  touch targets; iOS keeps its separate adaptive status threshold.
  See [compact phone header](client/phone-chat-header-2026-10-31.md).

- Antigravity App capabilities: `src/codex/antigravity-models.ts` parses the
  installed CLI's `agy models` variants and display labels with bounded cached
  discovery. New App Bots prefer `gemini-4-argon-medium` only when advertised;
  saved Bots are unchanged, and older catalogs without labels remain supported.
  CLI uses the same catalog and explicit `--model` IDs; see [Argon usage](host-cli.md#agy-的-gemini-4-argon).
  Hub Bot
  creation and `runtime/effort-settings.ts` share model-specific effort choices;
  unknown/default models use only default effort. Provider rejection becomes
  `engine-settings`, an actionable non-retryable error, without raw stderr.
  Tests: `antigravity-models`, `antigravity-adapter`, `hub-bot-manager`, `host-cli-management`, `effort-settings`,
  `error-classification`; browser `creation`, `effort`, `error-feedback`.
  [Native recovery and validation](client/antigravity-startup-2026-10-11.md).

- App channel identity: `gateway/agent-instructions.ts` refreshes the TaroBot
  client identity for native/fallback and resumed turns. The private
  `deepseek-harness-host.ts` patch disables DSH's conflicting Web GUI surface
  prompt without changing shared CLI settings or actual Feishu policy.
  Tests: `gateway-app-tools`, `gateway-service`, `gateway-environment`,
  `deepseek-harness-adapter`, `deepseek-harness-host`; opt-in
  `live-deepseek-app-identity`.
  [Diagnosis and native validation](client/app-channel-identity-2026-10-12.md).

- DeepSeek writer handoff: `codex/deepseek-harness-adapter.ts` retries only an
  explicit, same-session `session/writer-held` refusal before create/admission,
  keeping the original request identity and aborting the wait on Stop. Unknown
  receipts are never replayed. `runtime/error-classification.ts` maps exhausted
  recovery to actionable busy feedback. Tests: `deepseek-harness-adapter`,
  `error-classification`; opt-in `live-deepseek-writer-recovery`.
  [Incident and native validation](client/deepseek-writer-recovery-2026-10-12.md).

- Claude model presets: `src/state/instance-config.ts` provides the shared
  `claude-opus-5-5[1m]` default and `xhigh` effort to the Hub Bot catalog and
  model commands. Explicit saved models remain unchanged. Tests:
  `hub-bot-manager`, `instance-config`, `core-engine-command-rules`,
  browser `creation`; [Opus 5.5 correction](client/opus55-model-2026-10-11.md).

- Relay quota isolation: `src/relay/{protocol,server,tunnel,tunnels,sources}.ts`
  transports observed source metadata over negotiated mTLS control v2 and binds
  it to the exact loopback TCP stream before opaque TLS forwarding.
  `src/hub/{cli,server,auth}.ts` wires the registry and separates unknown-device,
  known-device and failure budgets with bounded capacity. Tests:
  `relay`, `relay-sources`, `hub-auth-isolation`, `hub-foundation`, `multi-relay`,
  `hub-tls-identity`; [upgrade and limits](client/relay-source-isolation.md).
  Dedicated IP endpoints accept a completed no-SNI ClientHello; domain routes
  still require their exact name. `relay` covers trusted IP TLS and rejection
  boundaries. [Live deployment and phone setup](client/ip-relay-2026-10-12.md).
  `socket-lifecycle.ts` drains the peer's remaining readable side on clean close
  without truncating queued writes, releasing completed HTTPS connection quotas.
  Tests: `relay`, `relay-socket-lifecycle`;
  [cellular report and cleanup evidence](client/relay-connection-recovery-2026-10-18.md).

- Hub rejection auditing: `src/hub/audit.ts` bounds detailed samples and batches
  rejection counts independently of attacker-selected IDs and source strings.
  `HubServer` flushes aggregates periodically and on shutdown; backups flush
  before snapshotting. `HubMaintenance.pruneAudit` separates rejection and
  trusted-event retention quotas; `dailyBackup` rotates only its own named
  snapshots after successful publication. Tests: `hub-audit-retention`,
  `hub-maintenance`, `hub-server`, `hub-foundation`, `hub-request-revocation`,
  `hub-state-backup`. [Report disposition](client/review-disposition-2026-10-11.md).

- Client-only builds: `client/tsconfig.json` starts from the UI source and follows
  its shared protocol imports, rather than compiling every Node-only protocol
  helper. `src/client-protocol/bots.ts` owns the shared Bot creation contract;
  clients must not import the Hub process manager for these types. Verify a
  clean checkout with only `npm ci --prefix client`, then the client build.

- Historical catch-up: `client/src/connection.ts` coalesces cache-view
  invalidation while replaying stored events. `ClientCache.apply` still commits
  each event with its cursor; completion and transport-state changes publish
  the remaining prefix, and live replies remain immediate. Browser checks:
  `message-refresh`, `handshake`, `snapshot`, `stream`, `outbox-refresh` and
  `message-send-continuity`. [CI evidence and open failures](client/browser-ci-2026-10-11.md).
  [Cross-device catch-up audit](client/sync-catchup-audit-2026-10-22.md) measures
  the full-journal snapshot metadata scan, serial conversation/receive queues
  and eight-message receipt window. `scripts/benchmark-sync-catchup.mts` uses
  isolated signed clients with explicit processing/ACK delay parameters; browser
  `cross-device` verifies message/file completeness separately from latency.
  [Catch-up repair](client/sync-catchup-repair-2026-10-22.md):
  `hub/message-activity{,-sql}.ts` owns transactional derived activity and bounded
  backfill; `snapshot.delta.v1` merges only changed messages;
  `sync.conversations.v1` releases completed conversations independently.
  `hub/server.ts` bounds receipts by count and bytes; `connection.ts` / `storage.ts`
  preserve staged atomic commits and expose actual completion progress. Tests:
  `hub-message-activity`, `hub-server`, deletion/revocation/backup; browser
  `snapshot`, `cross-device`, `activity-order`, `message-send-continuity`.

- Connection liveness: `client/src/connection.ts` uses monotonic heartbeat time
  and probes again after missed UI ticks before retiring a socket. Normal
  timeout and route-failover limits remain in place. Node frame decoding in
  `src/client-protocol/fragments-node.ts` uses native bytes with the shared
  reader's strict Base64/length/hash validation. Tests: `client-fragments`,
  `hub-server`, `gateway-recovery`, `bot-dashboard`; browser `host-concurrency`,
  `dashboard`, `routes`, `multi-vps`, `snapshot`, `performance`.
  [Load recovery evidence](client/connection-load-recovery-2026-10-11.md).
  `src/gateway/transport.ts` bounds the local worker's WebSocket upgrade (10s)
  and application-ready handshake (15s), then checks protocol pongs every 30s.
  These probes bypass model execution and metadata IO; a missed pong reconnects
  the socket with the existing durable outbox IDs, not a new model invocation.
  Old socket callbacks cannot admit input after a reconnect/stop boot barrier.
  Metadata reads have a 2s deadline and late reads cannot replace newer status;
  new publications wait for the latest replay, including after another reconnect.
  Tests: `gateway-liveness`, `gateway-metadata-timeout`, `gateway-delivery-recovery`,
  `gateway-transport-limits`, `gateway-scoped-transport`, `host-engine-path`.

- Host recovery: `HostApp.tsx` / `local-controller.ts` periodically request native
  `resume`; it respects disabled/client-only state and uses the shared local host
  core. `hub/bot-manager.ts` backs off to 1–5 minute probes after repeated worker
  exits. `gateway/worker.ts` closes admission before waiting for other cleanup;
  a failed worker exits after cleanup, and lifecycle logs preserve fatal evidence.
  `hub/cli.ts`, `hub/desktop.ts` and `hub/server.ts` refresh opted-in LAN/Tailscale
  TLS listeners under the existing host identity. An unavailable additional
  endpoint cannot stop the primary listener; custom endpoints remain untouched.
  `state/file-mutex.ts` applies explicit wait deadlines to both in-process queues
  and cross-process locks without allowing a timed-out waiter to run later.
  Tests: `local-host-recovery`, `desktop-recovery-intent`, `host-recovery-lifecycle`, `hub-supervision`,
  `gateway-restart-loop`, `hub-network-recovery`, `desktop-host`, `file-mutex`;
  browser `network-cache`, `desktop-host-name`.
  [Incident evidence and validation boundaries](stability-audit-2026-10-16.md).

- TLS identity proof: `src/client-protocol/tls-identity.ts`, `src/hub/auth.ts`
  and the public HTTPS-only `/api/tls-identity` route in `src/hub/server.ts`
  bind a fresh client nonce to the actual local TLS leaf via the Hub identity.
  `tests/hub-tls-identity.test.ts` covers a trusted-certificate terminating
  proxy, normal passthrough, SNI and proof boundaries. Desktop integration uses
  `client/src-tauri/src/transport/{core,mod}.rs` and `client/src/transport.ts`:
  actual-peer proof, pinned reqwest HTTP/WS upgrade, bounded IPC streams and
  cancellation. Pairing requires a trusted key; CSP prohibits WebView fallback.
  Tests: Rust `pinned_transport`, browser `native-transport`, plus handshake,
  routes, pairing, uploads, downloads, file-actions, local-reset and stop.
  Mobile and full native-container acceptance remain required.
  Mobile device signing is separate: `client/src/native-device.ts`,
  Android `DeviceIdentity` / `DeviceKeyStore` / `DeviceIdentityPlugin` and their
  Swift counterparts. Only public identities and signatures cross IPC. Native
  migration retains existing IDs/keys and the fixed app-lock preference; the
  generic secure-storage plugin is absent. Tests: `device-action-signing`,
  Android `DeviceIdentityTest`, `client/scripts/mobile-identity-audit.mjs`.
  [Mobile key boundary and remaining device gates](client/mobile-native-identity-2026-10-11.md).
  Reinstall authorization: iOS `DeviceKeyStore.swift` and desktop
  `device_installation.rs` encrypt device keys with a random installation key
  held in app data; iOS excludes that key from backup. Native sign/signAction
  reject old installations and unbound remote keys. `desktop_host.rs` migrates
  only through the existing trusted local-controller proof. Windows full reset
  retires the installation key from recovery backups; Android excludes both
  cloud backup and device transfer. `connection.ts` stops retry/outbox on
  `device_pairing_required` without inventing a Host revocation. Tests: native
  identity audit, Rust `device_installation`/`fresh_install`/`desktop_host`,
  browser `native-transport`. See [scope, one-time re-pairing and remaining
  device gates](client/reinstall-pairing-2026-10-28.md).
  `client/src/connection-verification.ts` maps native verification failures into
  localized pairing/reconnect guidance. `Pairing.tsx` normalizes pasted public
  keys and rejects malformed SPKI before networking; `RoutesEditor.tsx` and
  `RouteFields.tsx` preserve each route's failure label. `native-transport`
  browser cases cover both languages, safe failover and failed-pair key cleanup.
  Strict first-device enrollment uses `src/client-protocol/pairing-invites.ts`,
  `hub/pairing-invites.ts`, and `HubAuth.pairInvited`. Owner APIs at
  `/api/devices/invites` issue/list and `/revoke` closes invitations. All App
  generators share `ConnectionInviteCode.tsx`; `tarobot pair`, `devices invites`
  and `devices revoke-invite` call the same API. Native local controller
  bootstrap and already-paired route repair retain their existing trust paths.
  No public HTTP call may route to the trusted in-process `HubAuth.pair` helper.
  Regressions: `hub-pairing-invites`, `client-pairing-invites`, `host-cli-management`,
  `hub-server`, `relay`; browser `pairing-strict`, `pairing-recovery`,
  `pairing-pending-cas`, `pairing-wizard-invite`, `pairing`, `device-invite`, `native-transport`.
  See [invitation lifecycle and upgrade boundaries](client/rotating-pairing-invites-2026-10-26.md).
  `client/src/pairing-link.ts` owns QR payload encoding/validation independently
  of the scanner UI, so protocol tests do not load dialog styles through TSX.
  Opt-in actual macOS WebView/IPC audit: `client/scripts/native-transport-audit.mjs`
  builds `client/src-tauri/audit/native_runtime.rs` only with the audit feature.
  It uses isolated TLS peers, in-process CA trust, and no installed-app changes.
  Document startup eagerly claims a native lease; rotation/reset retires old
  allocations. Hidden-window transport requires the desktop background policy.
  [Desktop implementation and limited evidence](client/desktop-native-transport-2026-10-05.md).
  Ordinary universal r28 native UI pairing, Keychain reconnect, saved drafts,
  file picker/preview/save, quotes and revocation were exercised separately:
  [product acceptance and memory boundary](client/native-product-2026-10-11.md).
  `client/src-tauri/src/optional_shortcut.rs` keeps shortcut registration failure
  nonfatal; its Rust injection test does not reserve a user's shortcut.
  `client/scripts/native-audit-runner.mjs` bounds cleanup of its own child group;
  Node tests cover SIGTERM-resistant children and surviving descendants.
  `useVoiceRecorder.ts` pins completed encoder output to the originating draft;
  `voice-draft-lifecycle` covers navigation, cancellation and delayed encoding.
  `HoldToTalk.tsx` / `hold-to-talk.css` own phone press-to-talk, upward cancellation,
  elapsed time and theme-aware recording feedback. `voice-meter.ts` samples the
  actual microphone through a silent Web Audio analyser; no simulated activity.
  Only an explicit release in the original visible chat sends the new audio;
  existing text/files remain drafts. `hold-to-talk` covers real browser encoding,
  silence, gestures, permission races, interruption, failed uploads and layout.
  See [hold-to-talk acceptance](client/hold-to-talk-2026-10-12.md). Waveform readiness must not change panel geometry;
  [startup stability regression](client/voice-waveform-stability-2026-10-13.md)
  samples both phone entry points through permission and AudioContext state changes.
  [Unread and recording accents](client/mobile-unread-recording-accent-2026-10-27.md)
  separates red phone avatar counts from accent-coloured tab totals and recording
  waveforms/timers; cancellation retains its warning red. Desktop sidebar unread
  indicators use small red dots, including collapsed Bots/folders and ADHD,
  regardless of palette or optional accent. Real counts remain in hover/accessible
  labels; read state, phone number badges/tab totals and Host/headless CLI behavior
  are unchanged.
  Regression: `porcelain-details`, `hold-to-talk` and `palettes` browser journeys.
  `ShareInbox.tsx` / `share-drafts.ts` keep edited share text, target and Bot
  choices in the originating pairing's `ClientCache`. The protocol-only schema
  is `src/client-protocol/share-drafts.ts`; files and delivery pins stay native.
  Revision checks fence stale sends, retirement fences delayed saves, and the
  native item's 24-hour expiry also bounds the edited copy. Browser tests:
  `share-drafts`, `share`, `persistent-drafts`, `steering-draft`, `host-workspace`.
  Android `ShareInboxExpiry.java` uses published creation time so delivery-pin
  rewrites cannot restart retention; `ShareInboxExpiryTest` covers that rewrite,
  the expiry boundary and malformed/unpublished fallback. See the
  [joint lifecycle audit](client/joint-opus-audit-2026-10-13.md).
  Android: `client/android/app/src/main/java/com/tarobot/client/HubTls.java`,
  `HubSocket.java`, `HubTransport.java`, `HubTransportPlugin.java`, and `client/src/native-network.ts`.
  The shared mobile adapter drops rejected listener-registration promises so a
  later reconnect can retry, while concurrent hosts still share registration.
  Tests: `mobile-network`, `android-transport`; [scope and receipts](client/mobile-bridge-recovery-2026-10-05.md).
  `HubSocket` binds bounded decoding and close receipts to the same pinned TLS
  factory; see [WS limits/cancellation evidence](client/android-socket-bounds-2026-10-05.md).
  Isolated JVM audit: `client/scripts/android-transport-audit.mjs`; bridge contract:
  `client/e2e/mobile-network.spec.ts`. These are not APK/device acceptance.
  [Android implementation and limits](client/android-native-transport-2026-10-05.md).
  iOS: `client/ios/App/App/HubTLS.swift`, `HubTransport.swift`,
  `HubTransportPlugin.swift`, registered by `ShareInboxPlugin.swift` and the
  Xcode project. Isolated real Foundation audit: `client/scripts/ios-transport-audit.mjs`;
  the Capacitor SDK bridge contract is covered for both phone platforms in
  `client/e2e/android-transport.spec.ts`. Local URLSession cancellation is not a
  confirmed peer close; its events conservatively keep `clean: false`.
  [iOS implementation and native-device limits](client/ios-native-transport-2026-10-05.md).
  [Active-relay audit and remaining release blocker](client/tls-identity-2026-10-05.md).

- Provider error feedback: `src/runtime/error-classification.ts` distinguishes
  model content-policy rejection from process failure, auth refresh and transient
  backend errors. Model-capacity feedback in shared Core and `message-renderer`
  describes a temporarily busy provider, not exhausted account quota or local
  storage. Content-policy rejection returns a non-retryable Bus category; App/Gateway and shared Core
  render localized guidance. `src/state/audit-log.ts` preserves the category
  when reading localized audit details. Tests: `error-classification`,
  `bus-handler`, `core-reactions`, `audit-log`; browser `error-feedback`
  checks both clients, persisted messages, reload and subsequent input.
  [Upstream parity audit](client/upstream-parity-2026-10-05.md).

- Mobile IM navigation: `client/src/MobileHome.tsx`, `mobile-im.css`,
  `mobile-shell.css`, integrated by `App.tsx` / `HostApp.tsx`. Phones use a
  full-page inbox and Messages / Bots / Me tabs; desktops retain the sidebar.
  Cross-host rows carry host IDs; group rows aggregate active-topic activity;
  hidden chats do not mark read. Native Back honors menus before inbox/root.
  Settings can return focus explicitly to the More trigger. Tests: browser
  `mobile-im`, `native-back`, `host-workspace`, `topics`, `settings`,
  `settings-language` on Chromium and WebKit. Design and acceptance:
  [Mobile IM](client/mobile-im-2026-10-04.md).
  Bot directory rows open all live conversations for that Bot. Scoped lists
  reuse the Messages titlebar for the Bot name and Back action, with no extra
  selector row. Host+Bot scope composes with search and unread/attention/group
  filters. `MobileInboxState` keeps scope and independent Bot-directory search
  in the device shell so chat/host round trips retain the scoped list and scroll.
  Group topics remain folded into their parent; Native Back clears scope before
  leaving the inbox. [Bot browsing](client/mobile-bot-conversations-2026-10-12.md).
  Phone attachment entry: `AttachmentPicker.tsx` owns the external Plus button's
  camera / photos / files sheet and one persistent, synchronously configured
  native file input. App feeds all choices through the existing caption/upload
  flow. Scope epochs reject late results after chat or host changes (including
  leaving and returning); cancel and dismissal retain the draft. `viewport.css`
  constrains the new composer row while the keyboard is open. App observes the
  reading viewport itself so keyboard/composer resizing follows the tail only
  when the user has not opted into history. Rotation preserves pending picks;
  only destination changes invalidate their epoch. Tests:
  `attachment-composer`, `host-workspace`, `keyboard`, `voice`, `steering`,
  `uploads`, `settings-language`. [Design and boundaries](client/attachment-menu-2026-10-05.md).
  Desktop file drop: `attachment-drop.ts` routes the window's HTML File gesture
  into one registered draft. A single chat also accepts drops over the sidebar
  and title area; ADHD requires the exact pane, and a side panel owns its drops
  even when disabled. `AttachmentDropFeedback.tsx` names the destination, uses
  the accent color and shows rejection reasons inside an active modal. Host/chat
  changes cancel an in-flight gesture; drag leave, Escape and a hover heartbeat
  retire stale decoration. Files enter the existing draft/picker/upload flow and
  require Send. Non-file drags and the QR importer's drop handler retain ownership.
  Keep native `dragDropEnabled: false`: this path receives browser File objects,
  without a native pathname reader or new filesystem grants. CLI-not-applicable:
  this is GUI input convenience; shared attachment APIs and CLI behavior do not change.
  Tests: `attachment-drop-feedback` (Chromium disk-backed drag pipeline),
  `attachment-composer`, `side-conversation`, `qr-scanner`, `attachment-safety`
  (Chromium/WebKit). [Verification and native limits](client/attachment-drag-drop-2026-10-28.md).
  Focus-driven local draft revalidation accepts file appends while Send still
  waits for readiness; failed-read recovery replays against the pre-edit base.
  Drop notices clear independently of send/network errors. Regressions:
  `attachment-drop-feedback`, `persistent-drafts`, `attachment-composer`,
  `voice-draft-lifecycle`. See [focus and first-drop recovery](client/attachment-focus-drop-2026-11-10.md).
  Desktop attachment menu: `AttachmentPicker.tsx` adds a native-only screenshot
  choice; `desktop-screenshot.ts` turns bounded PNG IPC results into ordinary
  draft files. `screenshot.rs` restricts capture to the focused main window,
  serializes captures, restores the window and cleans private temporary files.
  macOS uses interactive screencapture with screen-recording permission; Windows
  uses `screenshot_windows.rs` (DPI-aware Win32 region selector over a bounded
  virtual-desktop snapshot). Nothing reads/replaces the clipboard or sends a
  message. Scope epochs also fence search, host/chat round trips and unmount.
  Tests: `desktop-screenshot`, `attachment-composer` on Chromium/WebKit; Rust
  `screenshot::tests`; Windows cross compilation. Opt-in `screenshot-audit`
  exercises real native IPC without a Hub or credentials. Native capture success
  remains separate from mocked browser acceptance. [Capture and validation](client/desktop-screenshot-2026-10-13.md).
  `mobile-shell.css` keeps the phone Plus button free of tap overlays, filled
  hover/open states and shadows. Toolbar focus does not outline the entire
  composer; keyboard focus remains on the control. `attachment-composer`
  covers touch return across palettes and keyboard return.
  [Tap feedback](client/plus-tap-feedback-2026-10-13.md).
  Phone debugging with Opus 5.5: ordinary selection follows the conversation
  tail; message-targeted jumps retain their anchor. HostApp owns the unified
  inbox query/filter and per-tab scroll refs. Phone history search has a
  dedicated header and all close/back paths return to the inbox. Regression
  coverage also includes mixed attachments, recorded voice, steering, history
  pagination and long-message recovery. See
  [mobile debugging](client/mobile-debug-opus55-2026-10-04.md).
  MobileHome is lazy-loaded; inbox previews resolve names against each host's
  Bot directory, with cached names offline. Virtual-list ResizeObserver work is
  animation-frame deferred. Shared phone journey helpers live in
  `client/e2e/fixtures/mobile.ts`; `fixtures/vite.ts` owns isolated test caches.
  Full browser regression, Opus follow-up and phone-shell resource receipts:
  [full mobile regression](client/mobile-full-regression-2026-10-04.md).
  Opus interaction refinement groups phone actions, disambiguates archives and
  explains steering/stop. `settings-language` checks English narrow action-row
  bounds as well as document overflow. [Rendered QA](client/interaction-polish-qa-2026-10-04.md).
  Phone message actions use `MessageActions.tsx`; App owns exact source and focus
  lifetimes. `message-export.ts` shares host/message-scoped export state with
  desktop `Content.tsx`. Tests: `message-actions`, `delegation`, `host-workspace`.
  [Message action QA](client/message-actions-qa-2026-10-04.md).
  Phone hold-to-act: `useMessageHold.ts` delegates touch gestures with live
  message/host identity, movement and lifecycle cancellation, release-click
  suppression and a temporary tail-follow pause. Phone messages have no redundant
  More button: holding the bubble opens `MessageActions.tsx`; the focusable message
  row also supports Enter, Space, Shift+F10 and assistive activation. Closing the
  sheet returns focus to the source row. `nativeHoldHaptic` leaves Android's native
  long-press feedback as the sole owner, while iOS retains one App impact.
  [Single-entry interaction and evidence](client/message-hold-simplification-2026-10-16.md).
  The sheet retains its selectable text view. `Content.tsx` makes
  the mobile filename/icon a primary preview button with a separate save action;
  desktop keeps its existing controls. Tests: `message-hold`, `message-actions`,
  `file-actions`, `pdf-preview`, `keyboard`, `stream`, `host-workspace`, plus
  opt-in `live-quoted-media` (real native CLI reads quoted attachments).
  [Acceptance and boundaries](client/message-hold-2026-10-05.md).
  The same regression pass fixed collaboration-send draft cleanup: compare the
  saved prompt, not its generated `/ask` or `/fan` command, after the receipt.
  The existing revision and cache-match guards preserve newer/unsent drafts;
  browser `delegation` checks successful-send cleanup and failed-send offline reload.
  Native session follow-up: `src/runtime/session-manager.ts` generates a fresh
  logical ID only without an existing binding, preventing DeepSeek `/reset`
  from reopening old history. Phone detach must recover the group's own context
  and native ID. Coverage: `session-manager`, `bridge`, `gateway-session-binding`,
  and opt-in `live-session-model` / `live-claude-binding`. See
  [native session acceptance](client/native-session-mobile-2026-10-04.md).
  Native goal completion/stop: `src/codex/app-server-adapter.ts` retains owned
  final turns, fences retired and unresolved native IDs, and replays deferred
  goal notifications. `deepseek-harness-adapter.ts` fences goal clear/cancel
  against new foreground admission; native session-wide cancellation is skipped
  when ordinary work is already admitted. `src/core/commands.ts` preserves the
  actual final answer instead of replacing it with goal metadata. Tests:
  `app-server-adapter`, `engine-audit3-fixes`, `deepseek-harness-adapter`,
  `bridge-goal-sessions`, `core-goal-flow-fixes`, `core-service-compat`; opt-in real
  browser `live-goal`. [Native goal evidence and limits](client/native-goal-2026-10-04.md).
  DeepSeek ordinary stop uses `deepseek-app-plugin.ts` / `deepseek-app-tools.ts`
  on the private inherited pipe: exact inbox identity or native current-turn
  origin, including `agent/inbox/claimed` before async prompt assembly. Prompt
  admission stays observable through user cancellation. Unconfirmed stops use
  `EngineCancellationUnconfirmedError` and explicit App/Gateway feedback.
  Tests: `deepseek-app-tools`, `deepseek-harness-adapter`, `core-reactions`,
  `error-classification`; real `live-goal` queued-stop.
  [Evidence and boundaries](client/deepseek-message-stop-2026-10-04.md).
  DeepSeek budget accounting: `deepseek-goal-usage.ts` contributes a durable
  native projection keyed by goal ID and owning input source; ordinary/background
  turns are excluded. Budget pause runs on the private native pipe with CAS and
  origin checks, preserving an ordinary turn that has already taken over.
  Tests: `deepseek-goal-usage`, `deepseek-app-tools`, `deepseek-harness-adapter`,
  `core-goal-flow-fixes`; opt-in `live-deepseek-goal-budget`.
  [Accounting scope and native evidence](client/deepseek-goal-budget-2026-10-04.md).

- Shared turn steering: `src/core/message-handler.ts` distinguishes native
  rejection from an uncertain receipt. Unknown admission never queues a replay;
  target identity is rechecked around async lookups. Tests: `core-steer`,
  `gateway-steering`, `core-audit3-fixes`.
  [Receipt behavior](client/lark-steer-receipts-2026-10-04.md).

- Connection and delivery review (2026-10-04): `client/src/connection.ts` separates
  cache revisions from route probes, retains HTTP during planned renewal, uses
  optional Hub `ready.serverTime`, and refreshes notification state with stale-read
  guards. `notifications.changed` targets the same user for conversation mute and
  the same device identity for device preferences. `src/hub/server.ts` gives Stop
  and bounded command completion independent authenticated paths after ready,
  including snapshot catch-up. `src/gateway/channel.ts` and the optional
  `releaseMessageAdmission` hook in `src/core/message-handler.ts` preserve per-chat
  order only until normal queue admission, without serializing entire model turns.
  `ShareInbox.tsx` / `share-controller.ts` and native share stores pin recipients
  and reject archived targets. Reproductions, tests and open limits:
  [dual self-review](client/self-review-2026-10-04.md).

- `client/src/host-registry.ts`, `client/src/host-connections.ts`, `client/src/storage.ts`
  Multiple independent runtime-host foundation: identity-keyed registry, fixed
  per-host caches, legacy import, recoverable retirement and a view-independent
  connection pool. `HostApp.tsx` now owns normal App pairing, host selection,
  unified Bot/group navigation and recoverable per-host removal. Workspace views
  keep their original connection/cache during background uploads; host changes
  finish recording and close hidden modals. `RuntimeHost.tsx` labels the host in
  creation, file and capability panels; Settings explains the host/device scope
  next to each relevant group. Notification payloads/deep links
  carry the public-key-derived host ID; ambiguous legacy links are rejected.
  Browser push uses a separate worker scope per host. Android UnifiedPush uses
  `unifiedpush-controller.ts` queues plus a persisted `UnifiedPushRegistry.java`
  with per-host identities and connector generations. Tests: browser `unifiedpush`
  / `unifiedpush-native`, Java `UnifiedPushRegistryTest`. Review and boundaries:
  [Android multi-host push](client/unifiedpush-multiple-hosts.md). Native device
  delivery and two physical computers remain acceptance gates.
  Client cache retirement is explicit (`ClientCache.isClosed`); a retired
  connection stops retrying without deleting identity, drafts or outbox. Local
  preparation/signing failures do not penalize transport routes. Ordinary chat
  history/outbox use conversation-scoped revisions; `coalesced-reader.ts` bounds
  HostApp directory refreshes to one running read plus one dirty refresh.
  Passive image/audio leases (`passive-attachments.ts`, `use-attachment.ts`,
  `LinkPreview.tsx`) share per-host downloads with three network slots and a
  750 ms last-consumer grace; explicit saves retain independent cancellation.
  Tests: `client/tests/connection-startup`, `passive-attachments`,
  `coalesced-reader`; browser `stability`, `stability-attachments`,
  `stability-history`, `stability-memory`, `image-gallery`, `message-refresh`,
  `outbox-refresh`, `handshake`, `adhd-board` and download recovery suites.
  [Repairs, measurements and native limits](client/stability-repair-2026-10-21.md).
  Native/push listener lifecycle: `listener-scope.ts`, `native.ts` and
  `notifications.ts` share one effect-owned scope in `App.tsx` / `HostApp.tsx`.
  Independent setup, at most eight settled-failure attempts, retained-event and
  disposal fences, safe registration cleanup, and one-time startup intent avoid
  blocked resume, stale jumps and cross-listener cleanup reentry. Tests: browser
  `native-events`, `host-workspace`, `host-push`, `native-back`,
  `settings-notifications`, `unifiedpush-native`, `handshake`.
  [Evidence and SDK boundaries](client/native-events-2026-10-11.md).
  Desktop `tauri://focus` also resumes the host pool through the same scoped
  listener lifecycle, preserving healthy connections. Unit contract:
  `client-desktop-foreground`; [native recovery observations and limits](client/desktop-foreground-2026-10-11.md).
  `connection.ts` gives foreground probes one bounded grace period until real
  traffic returns; duplicate foreground/online signals cannot retain a silent
  socket indefinitely or repeatedly cancel a pending handshake. Foreground wakes
  also wait for a closed socket's received frames to drain; queued old pongs do
  not refresh liveness. Android retires idle HTTP connections before the Hub and
  keeps bounded receive backpressure while JavaScript is suspended. Regression:
  `client/tests/connection-foreground-recovery.test.ts` and the native JVM audit;
  [investigation and device limits](client/android-foreground-recovery-2026-10-29.md).
  iOS uses the same bounded receive-credit wait without a ten-second JavaScript
  receipt cancellation. An iOS-only five-second foreground probe detects silent
  open sockets without changing steady heartbeats or interrupting handshakes.
  Tests: the Foundation transport audit, connection foreground regressions and
  browser `connection-notice`, `native-events`, `native-transport`;
  [reproduction and device limits](client/ios-foreground-recovery-2026-11-10.md).
  `MobileHome.tsx` exposes connection recovery and explains
  filtered direct chats even when groups remain. Browser `inbox-recovery`,
  `handshake`, `routes`, `offline-recipients`, `sidebar-layout`, `mobile-im` and
  `safe-area` cover recovery, retained drafts, filtering and layout.
  [Phone inbox recovery and evidence](client/inbox-recovery-2026-10-17.md).
  Android FCM registration uses `firebase-push.ts` and the request-bound
  `UnifiedPushPlugin.registerFirebase` instead of retained token/error broadcasts.
  `FirebaseTokenOperations.java` shares an explicit SDK Task with bounded consumers,
  waits for it before device-wide deletion, and atomically fences destroyed Owners.
  `clearUnifiedPush` holds the global operation barrier through all device cleanup.
  Tests: `unifiedpush-native` (26), related native-events/settings/host-push/local-reset,
  JVM `FirebaseTokenOperationsTest` (10). This is not APK or provider acceptance;
  SDK-owned background auto-refresh and rotation sync remain separate boundaries.
  [FCM receipts and limits](client/android-fcm-registration-2026-10-11.md).
  Phone system notification presentation: `NotificationSettings.tsx` shows reply,
  file and attention events; advanced transport settings are collapsed by default.
  `src/hub/push/model.ts` keeps scoped unknown/partial updates neutral and avoids completion claims for interrupted/foreground-partial/stopped
  runs. `src/hub/push/preview.ts` now supplies a bounded conversation/Bot heading
  and final reply or attachment excerpt in the existing v1 body. Android
  `NotificationMessage.java` recognizes that format with old-Hub fallbacks;
  `TaroCubNotifications.java` supplies a redacted lock-screen public version.
  These previews expose bounded conversation content to configured providers;
  they exclude reasoning, tool logs and collapsed process panels.
  Tests: `hub-push-preview`, `hub-push`, `hub-push-rotation`, browser `notification-readiness` /
  `settings-notifications`, JVM `NotificationMessageTest`.
  [Checks and real-delivery gates](client/message-notifications-2026-10-14.md).
  [Preview behavior and compatibility](client/adhd-sidebar-notification-preview-2026-10-17.md).
  Device invitation presentation (2026-10-28): `NetworkManager` uses regular
  overview labels and aligned connection statuses; `DeviceInviteCode` keeps a
  compact scan-first flow. `PairingCode`, `qr-hold.ts` and `qr-photo-save.ts`
  provide a cancellable QR long-press menu and native Photos/MediaStore export,
  with truthful receipts and the existing file saver on desktop. Pairing APIs,
  invitation expiry and separate approval remain shared with the CLI.
  Tests: `qr-device-save`, browser `qr-photo-save`, `device-ui-layout`,
  `device-invite`; JVM `QrPhotoImageTest`.
  [Design and native acceptance boundaries](client/device-invite-design-2026-10-28.md).
  Device notification choices (2026-10-27): `NotificationSettings.tsx` uses
  accepted-state switches for master consent, reply/file/attention categories and
  preview privacy, with collapsible quiet hours and compact healthy diagnostics.
  `customization: true` gates new options; `device_notification_options` keeps
  them out of legacy strict preference JSON. Shared
  `client-protocol/notification-content.ts` classifies and previews both Hub push
  and desktop notices; the worker rechecks queued choices and desktop resolves
  consent/privacy again immediately before native IPC. System settings are routed
  through `notification-system-settings.ts` and fixed native destinations.
  Tests: `notification-content`, `hub-notification-options`,
  `connection-independent-sync`, browser `notification-design`,
  `notification-readiness`, `settings-notifications`, `desktop-notifications`.
  [Design, compatibility and acceptance](client/notification-design-2026-10-27.md).
  [Desktop permission recovery](client/desktop-notification-permission-2026-10-28.md)
  covers denied-permission guidance, settings actions and installed-Mac read-back.
  macOS notification ownership: `client/src-tauri/src/notifications/` installs a
  retained UNUserNotificationCenter delegate before Builder, validates scoped
  targets, buffers one latest click with compare-and-ACK receipts, queries actual
  permissions, and cancels per-host in-flight submissions during cleanup.
  `desktop-notifications.ts` consumes the inbox through accepted routes and bounded
  recovery; Rust Instant age / JS monotonic request bounds preserve newer user
  intent without wall-clock ordering. Input and ready observers belong to the same
  synchronous scope even when native listen is pending. Tests: `desktop-notifications`
  (38 browser cases, including request/read failure separation and permission-timeout recovery), Rust `notifications::` (17); shared protocol fixture under
  `src-tauri/fixtures/`. [Implementation, review and OS limits](client/desktop-notifications-2026-10-11.md).
  Windows `windows.rs` uses own-AUMID WinRT toasts and actual Setting; strict
  `windows_payload.rs` activation goes into the native Inbox before WebView setup.
  `windows_identity.rs` and `windows/installer-hooks.nsh` reuse and verify the
  installed shortcut, stamp a VT_CLSID stub and clean history on owned uninstall.
  JS show/clear queues plus native Operations permits and document generations
  fence late sends/clears across reload; Mac query cleanup callbacks retire on exit.
  Cross-target module checker: `src-tauri/audit/windows-notifications/`.
  [Implementation, reviews and Windows build limits](client/windows-notifications-2026-10-11.md).
  [Ordinary r38 macOS acceptance](client/native-r38-2026-10-11.md) records actual
  background notification banner delivery. Native clicks, Windows delivery/installer
  and physical-phone acceptance remain gates.
  Storage v5 isolates
  temporary snapshot staging per cache handle and preserves committed history.
  Storage v8 indexes message status so startup recovers active IDs without
  loading historical bodies. Draft-file encoding caches only pending reads.
  `storage-memory` verifies v7 migration, bounded active-ID reads and large-file
  draft persistence; see [allocation fixes and native limits](client/storage-performance-2026-10-11.md).
  `conversation-messages.ts` serializes history refreshes across revisions and
  repeated activation, with connection-scoped pending reads and recoverable
  errors. Browser `message-refresh` covers coalescing, final content, retry and
  late success/failure. `host-previews` covers notification-driven preview
  teardown; [evidence and boundaries](client/message-refresh-performance-2026-10-11.md).
  `conversation-outbox.ts` bridges committed message ACKs to delayed history
  with connection/conversation-scoped receipts, retaining fast pending feedback.
  `ClientCache.removeOutbox` returns only committed removed entries; card ACKs
  and explicit discard do not wait for a user-message row. Browser
  `message-send-continuity` covers slow reads, hidden returns, retry/discard,
  deleted messages, host isolation and transaction/reset failures. Atomic
  `retryFailed` cannot recreate a discarded entry; per-socket receive failure
  retains message outbox items until a successful reconnect/sync/ACK. The same
  suite reproduces both failures and verifies recovery without duplicate sends.
  [Evidence and multi-window boundary](client/message-send-continuity-2026-10-11.md).
  `outbox-refresh` additionally covers continuous-stream read starvation,
  passive shared-IDB pages without sender ACKs, late/failed history reads,
  hidden raw observations and actual pending-row viewport behavior.
  `HubConnection.outboxRevision` fences committed local queue changes while
  ordinary revisions coalesce; `refreshCache()` establishes an observation-local
  history watermark without reconnecting. `App` observes the pending container
  as well as the viewport while respecting history reading.
  `subscribeOutboxQueued` records only committed local IDs while their chat is
  visible; hidden/unobserved background sends do not accumulate UI receipts.
  Missing IDs retire only at a fresh successful history watermark or ACK, so
  another window's earlier removal cannot discard a delayed hidden ACK. A
  no-op atomic retry still refreshes stale failure feedback.
  `message-reading` controls real Markdown Worker delivery while measuring the
  first visible message's screen position. App's virtualizer compensates rows
  entirely above that anchor in either scroll direction, accounts for the intro
  before the list and skips hidden viewports. Visible-row growth is not shifted;
  the virtualizer retains its iOS touch deferral. Plain pending prose shares the
  final paragraph width/wrapping. Browser iPhone-UA checks do not certify device
  inertia or the dependency's existing `touchcancel` handling.
  [Refresh/scroll follow-up and scope](client/outbox-refresh-2026-10-11.md).
  Browser tests: `host-workspace`, `host-push`, `multiple-hosts`, `host-concurrency`,
  `handshake`, `local-reset`, `questions`, `stream`, `snapshot`, on Chromium and
  WebKit. Push-scope tests substitute provider APIs; they are not delivery receipts. Review and boundaries:
  [multiple runtime hosts](client/multiple-runtime-hosts.md).

- App explicit steering: `src/gateway/steering.ts`, `src/client-protocol/steering.ts`,
  Hub `/api/conversations/:id/steer`, `client/src/Steering.tsx` and composer controls.
  Ordinary App messages queue except for explicitly native-capable Claude in-flight
  plain text (see Engine / Provider Layer); explicit steering is run-scoped and never replayed as
  a normal delivery. Behavior, capability matrix and acceptance: [App steering](client/steering.md).
  Tests: `gateway-steering`, `gateway-command-parity`, browser `steering` / `stop`,
  opt-in real Codex/DeepSeek `live-steering`. DeepSeek also pins the ordinary
  source RPC and native turn on its private pipe, observes the pre-step signal,
  and removes unclaimed steering at abort/end; no global session steer fallback.
  Headless delivery status: `host-cli/steering.ts` maps persisted rejection,
  non-adoption and uncertainty to nonzero CLI exits without changing JSON or
  automatically retargeting/requeueing. Bot collaboration follow-ups use the
  ordinary `messages send/wait` path. See [delivery receipts](client/bot-delivery-receipts-2026-10-30.md);
  regression `host-cli-steering-delivery` covers real CLI/Hub/Gateway and
  late adoption readback, alongside `host-cli-tasks` and Bot-message suites.
  Native boundary: `live-deepseek-steer-boundary`; queued-goal rejection in
  `live-goal` queued-stop. [Evidence](client/deepseek-steering-2026-10-04.md).

- Claude input during an owned background-result review uses the opt-in
  `claude.native-input.review.v1` target and the existing steering transcript.
  `GatewayChannel.dispatchNativeTurn` creates a real new Core turn; adapter
  UUID evidence transfers ownership while old background cards remain readonly.
  See [review input, compatibility and validation](client/claude-background-input-2026-10-25.md).
  Tests: `claude-review-input`, `claude-review-core`, `claude-review-roundtrip`,
  `gateway-native-review-input`, `hub-native-review-input`; browser `claude-review-input`.
- Claude ordinary native input: `client-protocol/native-input.ts` adds negotiated
  `claude.native-input.v1` progress to the existing steering transcript. Gateway
  `input.progress` is journaled; `/conversations/:id/inputs/:messageId` controls the
  original author-scoped input without another delivery. `NativeInput.tsx` and
  `native-input-request.ts` separate admission, dequeue and model response from
  execution completion, and gate send-now / atomic withdrawal. Stable draft/control
  IDs survive reloads. CLI parity is `steer send --mode message` and
  `steer send-now|cancel --message`. See [2.1.309 protocol and limits](client/claude-native-input-2026-10-24.md).
  Tests: `gateway-native-input`, `client-native-input`, `gateway-scoped-transport`,
  browser `claude-native-input`, opt-in `live-claude-native-input`. Existing queues,
  rich input, explicit steering and other engines retain their paths.
  The [visible send choice](client/claude-send-choice-2026-10-24.md) exposes native
  input versus durable next-turn delivery beside the composer; `ClaudeSendChoice`
  and `use-claude-send-choice` own only UI intent, with browser `claude-send-choice`
  covering scope, focus, queue controls and uncertain-native-send protection.
  Codex reuses that selector with **queue as the default**. Its separate
  `use-codex-send-choice` binds an explicit supplement to the selected task;
  idle/new targets reset it even with a draft, while unknown status retains
  intent and requires a fresh target-checked preflight. Rich/workbench input
  stays queued. `steering-request` persists bound Codex retry identities separately
  from native input, so switching to queue or reloading cannot duplicate an
  uncertain supplement. Queue recovery checks an old ID only after authoritative
  status proves its task ended; accepted old receipts never masquerade as a
  supplement delivered to a newer task. Other engines/groups keep their explicit
  input lifecycle. Browser `codex-send-choice` and unit
  `client-steering-request` cover these boundaries. This is App routing and
  presentation; existing Host steering/queue APIs and CLI commands are unchanged.
  [Compact phone accessories](client/phone-composer-tools-2026-10-24.md) share the
  native task entry and selector row while retaining background-progress
  locators and independent queue controls. Stop impact is shown on demand.
  On ordinary native phone windows below 600px without a task bar, the pending
  preview and selector now share one row; without a queue entry, explanatory
  text opens the existing help. Larger text can wrap the controls. Task/dock and
  native expanded-window layouts retain their existing rows. Counts and the
  phone stop control follow theme accents. See [phone send-mode row](client/phone-send-mode-row-2026-11-11.md).
  Desktop/browser Codex direct chats have a separately scoped capsule row in
  `codex-desktop-composer.css`, enabled by the presentation-only
  `is-codex-direct` marker. It excludes native iOS/Android and conversation panes,
  preserving background-progress layout and all existing send/queue handlers.
  Simple Codex task entries can share the row. Browser
  `desktop-codex-composer` covers long previews, Chinese/English, window and
  Workbench constraints, help/queue access and draft retention. See
  [desktop Codex presentation](client/desktop-codex-composer-2026-11-12.md).
  The typing field and touch targets keep their existing sizes. This is App
  presentation only; Host queue semantics and headless CLI are unchanged.
  A background-group locator and native task manager share the send-choice row
  when their full content fits, without a full-width panel frame or an internal
  divider. Narrow panes wrap whole controls; counts and 44px phone targets stay
  readable. Compact send choices use a pale theme-accent selection, retaining
  keyboard focus and high-contrast outlines. The composer has no persistent
  stop-impact notice; its confirmation explains the affected work. Host execution
  and headless CLI are unchanged.

- App pending prompts: `src/client-protocol/prompt-queue.ts`, `src/hub/prompt-queue.ts`,
  `src/hub/server.ts` and `src/hub/store.ts` own durable pre-dispatch order, text edits,
  cancellations, per-message pause/resume, atomic dispatch fencing and revision/request-ID checks.
  New workers also negotiate `prompt-queue.pull.v1`: Hub wakes a conversation;
  Gateway reserves its shared Core execution slot and claims the latest head
  only when that slot starts. See [unified pending prompts](client/unified-pending-queue-2026-10-22.md)
  for async-answer ordering, live-only pull RPCs, recovery and CLI parity.
  `src/gateway/transport.ts` negotiates `prompt-queue.v1`; unsupported workers keep
  their legacy dispatch path. `client/src/PromptQueue.tsx` provides the desktop panel
  and full-screen phone page. Phone refresh sits in the title bar; the static
  introduction and reorder receipts take no visible row. The persistent live
  region, offline/errors and queue controls remain; desktop layout stays separate. `PromptQueueContextMenu.tsx` lets desktop and ADHD
  queue rows locate their exact source bubble through App's existing message
  locator, retaining composer/edit drafts; menus resolve live message IDs and
  stay inside the queue dialog's top layer. [Queue location](client/queue-message-location-2026-10-24.md).
  Each queue row also exposes an accent-colored straight right-arrow button in its
  header on phone, desktop and ADHD, with no visible text label. It shares the
  context-menu locator and resolves
  the canonical message ID in the current snapshot, not the row number/preview.
  Navigation stays available for cached history while offline and never sends
  or changes a queued prompt. [Visible source action](client/queue-source-button-2026-10-28.md).
  Regression: browser `prompt-queue-trace`, existing `prompt-queue`,
  `prompt-queue-drag` and `message-focus`.
  Header up/down-to-line buttons move a queued message directly to the queue
  front/end through the existing validator/receipt path; command barriers and
  revision conflicts remain enforced. The endpoint button is disabled when
  already there. [Move to front/end](client/queue-move-front-2026-10-31.md).
  #104 per-message pause is Host-owned (`deliveries.queue_paused`, schema 25).
  Pause retains position and skips that input while later eligible inputs run;
  Start resumes at the retained position without interrupting a running input.
  Both push/legacy claim and pull take respect the hold, including command flush.
  Snapshot `capabilities.pause` gates App controls against older Hosts; the wire
  state remains queued with an optional paused flag. Desktop/ADHD right-click and
  phone long-press share the same canonical-ID action as the visible button.
  CLI `queue pause|resume` shares authorization, CAS and receipt handling.
  Regression: `hub-prompt-queue-pause`, `hub-prompt-queue`, `host-cli-queue`,
  `hub-state-backup` and browser `prompt-queue-pause` plus queue/drag/trace.
  See [pause semantics and acceptance](client/queue-pause-104-2026-11-03.md).
  `client/src/prompt-queue.css` gives cancellation
  confirmation a separate surface, an outlined Keep button and a theme-primary
  confirmation button; desktop controls are compact and phone targets stay 44px.
  On non-hover devices the queue trigger keeps the theme's subtle grey surface
  before and after returning from its dialog, so sticky hover never changes it.
  The phone queue trigger spans its available row, including short attachment
  previews; the next-message text yields to the trailing chevron. Its height and
  separate task/send-choice row stay unchanged. This App-only layout has no CLI
  or Host behavior change.
  `client/src/prompt-queue-drag.ts` owns handle-only mouse/touch/pen reordering:
  cards follow the pointer, variable-height neighbours make space, and a short
  placement animation shares ADHD's motion policy. Fixed slots own hit testing;
  edge scrolling and release send only one revision-checked move. The preview
  survives a slow save until the authoritative snapshot; snapshot preparation
  preserves visual positions before React reorders the DOM. Queue/viewport changes
  cancel stale gestures. Keyboard-accessible Up/Down buttons share the placement
  animation. Browser `prompt-queue-drag` covers this path and reduced motion.
  Native steering remains a separately queried
  capability. `client/src/prompt-queue-request.ts` bounds queue/steering waits even
  when native IPC acknowledges cancellation late; late results cannot revive them.
  `src/host-cli/queue.ts` uses the same authenticated API. Schema 15
  preserves the dispatch boundary across restart and rejects unsafe downgrades.
  [Capability matrix and behavior](client/prompt-queue-2026-10-14.md).
  Regressions: `hub-prompt-queue`, `host-cli-queue`, `client-prompt-queue-request`, Gateway/Hub recovery and
  browser `prompt-queue`, `steering`, `stop`.

- `client/src/brand-theme.css`, `client/src/BrandScenes.tsx`, `client/src/Avatar.tsx`
  Phone attachment action spacing stays inside the complete touch targets;
  see [PR 64 integration and review](client/attachment-action-gap-2026-10-25.md).
  Browser `porcelain-followups` measures the visible gap and actual hit targets.
  Palette tokens: `client/src/palette-tokens.css`; choices: `client/src/palettes.ts`.
  Studio sheet and motion refinement: edge-aligned desktop reading surface, aligned
  accent states, lighter bubble sheen, compact phone message spacing and grouped
  settings. Motion stays on controls and overlays; virtual message rows and
  streamed text retain their existing positioning.
  Desktop timeline edges have no fade mask, keeping message text and delivery
  receipts opaque beside the composer. This is App-only styling; CLI behavior is unchanged.
  Native Grok-referenced interaction pass: `ReplyActivity.tsx` adds a localized
  inline streaming-reply status with a visibility-aware halo. The chat header
  keeps the title, direct-chat Bot name and activity on one row; names ellipsize
  on phones, while multiple-host runtime location keeps its own row. Command
  menus anchor to the input edge and phone sheet triggers retain their open state. See
  [Opus design and verification](client/grok-native-motion-2026-10-11.md).
  Header reply activity and the composer's running/queued controls use the
  selected conversation's full message index, rather than its last eight rows.
  Later deliveries cannot hide a still-running reply. The index is memoized with
  message/selection changes; forwarded copies and mirrored Bus records do not
  count as ordinary replies. Browser `user-reply-status`, `mobile-im`, `stop`,
  `steering` and `agent-bus-workspace` cover the presentation boundaries. See
  [long-running reply activity](client/reply-header-activity-2026-11-04.md).
  Message avatars use three small typing dots below the picture: static while
  pending, gently fading while streaming, removed on completion or disconnect.
  Custom pictures and default mascots receive the same treatment without rings
  or glows. Reduced motion leaves a static marker; message geometry is unchanged.
  [Reply marker and verification](client/reply-avatar-status-2026-10-13.md).
  Rendered Opus review corrections keep unread counters solid across devices
  and restrict inbox press transitions to background colour. Phone message actions
  now use hold-to-open instead of the historical 44px More button. Desktop actions
  share the author/time row to avoid a blank toolbar below every bubble;
  hover/focus leaves virtual row measurements unchanged. See
  [compact desktop messages](client/message-spacing-2026-10-13.md).
  Desktop toolbar visibility uses hover or keyboard-visible focus, rather than
  any focus left by a mouse click on a message/run. Existing focus-intent state
  preserves dialog return and keyboard actions without pinning two toolbars.
  Tests: `message-actions-hover`, `message-actions`, `message-context-menu`,
  `message-hold`. [Focus repair and boundaries](client/desktop-message-hover-2026-10-26.md).
  `message-action-hover.ts` delegates one pointer-owned desktop toolbar; mouse
  movement retires prior keyboard ownership, and old bars hide immediately.
  Only scrolling the hovered row's ancestors clears its pointer ownership;
  another ADHD pane or side log following a reply does not hide its actions.
  Browser `adhd-search` covers two live panes and retained quote access.
  [Mixed-input and image-message follow-up](client/message-toolbar-exclusive-2026-10-26.md)
  records the reproduced gap, scope and verification boundaries.
  Desktop timeline/composer use a fixed 28px pane inset; individual Bot rows
  retain their bounded reading width. [Message alignment](client/message-inset-2026-10-13.md).
  Browser regression:
  `message-actions` checks desktop target edges and phone sheet/focus lifetimes in both engines.
  [Opus design and rendered review](client/premium-qa-2026-10-05.md).
  Opus follow-up hierarchy, phone filter and settings-control refinement:
  [current rendered evidence](client/refinement-qa-2026-10-05.md).
  Six additive Porcelain palettes share pure white light-mode surfaces and
  separate accent scales; the four classic families keep their existing IDs.
  Monochrome (`mono`) with explicit light mode is the first-run default, even
  on a dark-mode OS. The HTML shell, early appearance mirror, preference defaults
  and unset CSS fallback agree. Explicit saved palette/light/dark/system choices
  still win; this is App presentation only, with no Host or headless CLI change.
  Settings groups them by family. Regression: `palettes` verifies rendered
  contrast, white surfaces, phone layout, migration and reload persistence.
  `porcelain-details.css` refines Porcelain/Monochrome surfaces, menus, settings
  and attachment tiles. Compact desktop control sizes require a fine pointer
  with hover; expanded iOS windows retain touch targets. `porcelain-details`
  covers dark pressed contrast, system-dark controls, touch geometry, forced
  colors and three-image containment, alongside `media-thumbnails`.
  Topic-directory search uses one outer field, like Forward; the nested input
  stays transparent, including focus. Dark rich-card selects use surface-alt and
  a subtle border, including system dark. Conversation settings titles and close
  labels share the entry wording. Presentation-only: no Host or headless CLI change.
  [PR review and verification](client/porcelain-details-review-2026-10-25.md).
  A summary with its own SVG chevron declares `data-disclosure-icon`; generic
  dialog/settings disclosure fallbacks must exclude it and its native marker
  stays hidden. Plain summaries retain their fallback indicator. Browser
  regressions count rendered SVG/pseudo/native indicators, including the
  shipping Porcelain styles. [Duplicate-arrow audit](client/disclosure-icons-2026-10-26.md).
  The optional Monochrome accent defaults to `none`; both preference readers
  normalize unknown values and the appearance mirror carries the selection.
  Light warm gray (`warm-gray`, 浅暖灰) is an additional choice beside Graphite
  and Oat. Its swatch, enabled solid controls and phone aggregate use the same
  light fill as first-run setup, with dark labels in light/dark/system modes.
  Reply/status text and chart colours retain readable deeper warm tones. It uses
  the existing device-local preference persistence, with no
  default or Host/CLI change. Setup/settings primary buttons keep their fixed
  light warm grey fill independently of this selection.
  Sage (`sage`, 鼠尾草绿) likewise uses a pale grey-green swatch, solid fill
  and phone aggregate with dark ink across light/dark/system modes. Readable
  text/chart tones, other palettes and fixed warm setup buttons remain separate.
  See [accent controls](client/mono-accent-controls-2026-10-26.md).
  Text markers and working signals have separate contrast mixes; forced colors
  retain a native selected radio. The combined UI PR audit also preserves touch
  card targets, keyboard recipient focus and visible forwarding destinations,
  and checks narrow operations cards with long names. See
  [batch integration and verification](client/ui-pr-batch-review-2026-10-26.md).
  The caption/attachment follow-ups keep mobile action targets in normal flow
  and give split inline links and quoted code page colours. Audio retains its
  bubble action colours. `porcelain-followups` verifies actual hit-testing and
  contrast, including fold controls;
  both Porcelain specs run in Chromium and WebKit. Presentation-only: Host and
  headless CLI paths are unchanged.
  [Follow-up review](client/porcelain-followups-review-2026-10-25.md).
  Additive Monochrome (`mono`, 黑白) uses inverse own-message bubbles and neutral
  reply cards in light/dark/system modes. Document syntax has its own contrast
  scale; recording controls use the primary foreground/background pair.
  [Monochrome theme and verification](client/monochrome-2026-10-12.md).
  Opt-in Terminal (`cli`) and Pixel (`pixel`) change typography, message
  geometry, input chrome and common icons. CLI is dark-only; Pixel retains
  light/dark/system modes. `expressive-themes.css` supplies the palette tokens;
  `ExpressivePreview.tsx` draws a single dark CLI tile and paired light/dark
  tiles for other expressive palettes. `MobileHome.tsx` supplies optional icon names. The existing
  appearance pipeline persists the choice and synchronizes native system bars.
  The CLI composer uses a Return glyph for Send; other palettes keep their up
  arrow. This presentation change has no host or headless CLI effect.
  Regression: `palettes` covers contrast, draft retention, phone targets,
  insets, forced colors and returning to Porcelain Teal.
  [Opus redesign and verification](client/cli-pixel-themes-2026-10-12.md).
  Terminal-family TTY (`tty`), Paper (`paper`) and Agent (`agent`) styles are
  separate palettes in `terminal-themes.css` (loaded after `cli-typography.css`;
  no `cli` selectors). Regressions: `palettes`, `terminal-themes`,
  `run-formatting`, `theme-font-size`. Presentation-only; no host or CLI change.
  [Styles and verification](client/terminal-themes-2026-10-17.md).
  [Pure white palettes and verification](client/white-palettes-2026-10-11.md).
  Four original Opus-designed light/dark families and their acceptance evidence:
  `docs/client/color-palettes-opus55.md`.
  Opus-led professional workspace theme: neutral surfaces, one accent, compact
  Bot/chat and group/topic navigation, functional motion, action-led welcome
  and pairing scenes. Custom avatars retain precedence over the mascot defaults.
  Design: `docs/client/professional-ui-opus55.md`; current browser evidence,
  motion/contrast checks and acceptance limits:
  `docs/client/professional-ui-acceptance.md`.
  Grok Bot is the explicit current visual quality reference. Follow-up refinement:
  `docs/client/grok-ui-opus55.md`; rendered comparison and acceptance: `design-qa.md`.
  Current Opus 5.5 visual and mobile-motion refinement: `docs/client/atelier-opus55-2026-10-04.md`;
  final rendered QA: `design-qa.md`; model/build/browser evidence: `docs/client/evidence/atelier-20261004.json`.
  `client/src/conversation-preview.ts` cleans navigation-only paired-bold excerpts
  while preserving code, URLs and source messages; test: `client-conversation-preview`.
- Desktop progressive disclosure (2026-10-11): `client/src/DesktopMenu.tsx`
  (shared popover), `desktop-menu.css` (component owned), `brand-theme.css` (layout),
  `App.tsx` sidebar/header/composer, `HostApp.tsx` (`multiHost`, `addHost`),
  `GroupTopics.tsx` `TopicSwitcher`. One create menu, a footer 工作台 menu,
  clickable identity and `ConversationDetails.tsx` directory, compact group recipients; desktop Steer/Stop show in the composer
  only while a reply is detected (idle fallbacks in More). On phones, Bot activity
  keeps the input layout fixed: an empty draft swaps Send for Stop in the same
  slot, while text/files keep Send available for queuing. More always offers
  Steer/Stop. `composer-busy` checks activity transitions at 320/390/1360px with
  empty, single-line and multiline drafts. Live Stop uses theme surface/text
  tokens for its normal, hover and pressed states; this styling has no host or
  headless CLI effect. Phone details are a full
  page, and `useComposerSize.ts` grows drafts without observing streaming tokens.
  Its out-of-flow textarea measures draft height without collapsing the focused
  field, which otherwise shifts WebKit's message viewport during typing. Browser
  `composer-size` covers attachment/plain drafts, latest/history reading positions,
  newlines, wrapping, the six-line cap and shrinking after deletion.
  The main desktop composer keeps its additional inset above the editor only;
  the toolbar retains its original bottom spacing. Phone and compact ADHD
  composers retain their existing insets. Main desktop draft text follows the
  chosen reading size without the extra enlargement, including narrow windows
  with a mouse/trackpad. Native mobile and compact pane typography keep their
  separate rules. The wide main desktop editor shifts text slightly upward by
  redistributing its existing vertical padding; total editor/toolbar geometry,
  font sizes, side panes and compact ADHD/phone inputs stay unchanged. Existing
  terminal prompt glyphs follow the same text offset. `composer-size`,
  `composer-busy`, side-input alignment and `terminal-themes` cover it.
  This is a
  presentation-only adjustment, with no headless CLI or Host behavior change.
  The default composer keeps Plus/voice/send, with Bot selection in a sheet.
  Current implementation and verification: [IM upgrade](client/im-upgrade-2026-10-11.md).
  Feature routes and e2e navigation updates:
  [design receipt](client/desktop-simplification-2026-10-11.md).
  Offline cold-start names: `App.tsx` shares the cached navigation directory
  between desktop and phone; `startup` guards the display name and offline state.
  [Native/browser reproduction and multi-host verification](client/desktop-offline-2026-10-11.md).
  The group composer also uses this cached directory for offline recipient and @
  choices, filtered by conversation membership. Connection startup restores the
  durable queue count. Browser regression: `offline-recipients`;
  [manual native/browser evidence and recovery limitation](client/offline-recipients-2026-10-11.md).
- Sidebar conversation rename (2026-10-11): `ConversationList.tsx` offers a
  pointer/keyboard context menu (right-click, Shift+F10) and F2. `DesktopMenu.tsx`
  portals pointer menus and clamps them to the viewport. `RenameConversation.tsx`
  selects the existing title, uses the row's own Hub connection, and waits for
  the durable rename receipt. `HostApp.tsx` closes hidden-workspace menus.
  Regression: `client/e2e/conversation-rename.spec.ts` (both browser engines).
  [Native verification and release](client/conversation-rename-2026-10-11.md).
- Conversation draft previews (2026-10-16): `DraftPreview.tsx` projects the
  existing host-scoped `ClientCache` drafts into desktop and phone list rows.
  Draft text takes precedence over activity; attachment/quote-only drafts have
  short labels, and folded groups include the topic name. IndexedDB v9 adds
  key-only rich-draft indexes, avoiding attachment-byte reads in list observers.
  It does not alter activity ordering, unread state or host/CLI capabilities.
  Regression: `chat-drafts`, `persistent-drafts`, `activity-order`,
  `mobile-attention`. [Behavior and verification](client/draft-list-preview-2026-10-16.md).
- Sidebar conversation actions (2026-10-12): `ConversationList.tsx` adds local
  pin/unpin and recoverable deletion beside rename. `RemoveConversation.tsx`
  confirms the existing archive operation and waits for durable Hub state.
  Pins use an atomic host-cache update; deletion preserves sessions and memory.
  `App.tsx` no longer restores an archived last chat on startup. Initial pairing
  defers sidebar, reset and QR UI; chat-only empty states live in `ChatEmpty.tsx`.
  Valid historical chats with no Bot members remain selectable in their own
  section instead of producing an undefined Bot avatar; `native-events` covers
  this cached-data boundary.
  Regression: `conversation-context-actions`, `conversation-settings`,
  `conversation-rename`, `bot-context-menu`, `topics`, `startup`, `local-reset`,
  `pairing-design`. [Scope and acceptance](client/conversation-context-actions-2026-10-12.md).
- Archived conversations (2026-10-17): `ArchivedConversations.tsx` shares explicit
  View record / Restore actions between phone Me, desktop Workspace and ADHD
  host tools. Restore waits for durable cache confirmation on the owning Hub;
  disconnected, non-creator and deleted-Bot states explain disabled restoration.
  Existing recoverable deletion semantics remain unchanged. Browser regressions:
  `conversation-context-actions`, `conversation-settings`, `mobile-im` and
  `adhd-board`. [Behavior and verification](client/archive-actions-2026-10-17.md).
  `conversation-unread.ts` keeps page/Dock/tray totals scoped to live roots and
  their live topics while retaining archived unread history for restoration.
  Both HostApp and standalone Workspace use it. See [Dock badge correction](client/dock-unread-2026-10-28.md);
  regressions: `client-conversation-unread` and browser `unread-badge`.
  The shared dialog uses its own row-action CSS; retired sidebar archive button
  rules must not size the dialog close button. The same browser suites cover
  horizontal titles, right-aligned close actions and narrow-screen overflow.
- Group context settings (2026-10-12): `ConversationList.tsx` gives root groups
  their own menu, including the avatar/title/expand control. `GroupSettings.tsx`
  also opens from desktop/phone details and edits the clicked host without
  changing the selected chat. `PUT /api/groups/:id/settings` delegates to
  `HubStore.updateGroup`: creator/grant checks, compare-and-swap metadata,
  atomic inherited topic membership, and pending-work removal protection.
  Existing IDs, topic titles, sessions, history and user notification settings
  are preserved. Regression: `hub-group-settings`, `group-settings`,
  `conversation-context-actions`, `conversation-rename`, `topics`.
- Sidebar Bot actions (2026-10-12): `ConversationList.tsx` owns the Bot-row
  context menu. `BotSettings.tsx` uses that row's Hub connection and existing
  avatar/effort controls, without requiring a first conversation. `HostApp.tsx`
  routes Skills/MCP and runtime-status commands to the clicked host and Bot;
  `OperationsPanel.tsx` distinguishes dashboard and collaboration entry views.
  Regression: `bot-context-menu`, `conversation-rename`, `message-context-menu`,
  `effort`, `operations`, `collaboration` (Chromium/WebKit).
  [Native verification and scope](client/bot-context-menu-2026-10-12.md).
- Sidebar portrait layout (2026-10-12): `ConversationList.tsx` uses 40px parent
  portraits; `brand-theme.css` aligns child chat text with Bot names and centres
  the hierarchy guides below portraits. Phone home retains its independent 48px
  layout. [Visual measurements and acceptance](client/sidebar-avatars-2026-10-12.md).
- Desktop text context menus: `client/src/native-context-menu.ts`, installed by
  `main.tsx`, replaces default WebView search/speech/services with native text
  editing commands. Component-owned menus win; browser/mobile remain unchanged.
  Regression: `native-context-menu`, `conversation-rename`, `message-hold`.
  [Native menu acceptance](client/native-context-menu-2026-10-11.md).
- Desktop message actions (2026-10-12): `client/src/MessageContextMenu.tsx`
  delegates right-click and Shift+F10 from the message viewport to live message
  IDs. Reply, forward, copy and selected-text copy reuse existing App actions.
  Editable cards keep native editing menus; phone keeps the existing long-press
  sheet. `DesktopMenu` can let an action own focus and dismisses point menus on
  source-row clicks, scroll and resize. `useComposerSize` defers width-driven
  height writes outside ResizeObserver delivery to avoid WebKit resize loops.
  Regression: `message-context-menu`, `message-actions`, `message-hold`,
  `conversation-rename`, `native-context-menu`, `composer-ime`,
  `message-send-continuity`. See [native acceptance and release boundaries](client/message-context-menu-2026-10-12.md).
- Bubble text selection (2026-10-23): `client/src/message-text-selection.ts`,
  delegated from `Content.tsx`, bounds desktop double-click selection to one user
  bubble, reply card or native answer's prose. Editable/code/link interactions,
  phone hold actions and portal readers retain their owners. No global selection
  listener or message/layout mutation. `message-text-selection.css` excludes
  message metadata, status/action rows and code/table controls from selection
  and native copy/paste while retaining authored prose. Regression: `message-selection`,
  `message-context-menu`, `message-hold`. Pure App presentation; CLI not applicable.
  [Behavior and verification boundaries](client/message-bubble-selection-2026-10-23.md).
- Selected list copying (2026-10-27): `message-selection-clipboard.ts` projects
  complete selected Markdown list items into numbered/indented plain text and
  semantic clipboard HTML. `main.tsx` installs a narrowly scoped copy-event
  handler; `MessageContextMenu.tsx` captures the same payload before menu focus
  changes. No selectionchange listener, live DOM marker mutation or new shortcut.
  Partial-only selections, editors, portal readers and phone's raw-text selection
  sheet retain native copying. Whole-message copying still reads original blocks.
  Regression: `message-selection`, `message-context-menu`, `native-context-menu`.
  [Rules and validation](client/list-selection-copy-2026-10-27.md).
  Pure App clipboard behavior; headless CLI and stored message content unchanged.
- `tests/helpers/codex-acceptance.ts`
  Real Codex fixture teardown: native archive restricted to the run's exact
  temporary workspaces, after worker shutdown, with pagination and read-back
  confirmation. Used by the `client/e2e/live-*` Codex scenarios; tests:
  `codex-acceptance-cleanup`. See `docs/client/acceptance-session-cleanup.md`.
- `client/src/QuestionForm.tsx`, `src/core/card-actions.ts`
  Gateway-only versioned question metadata and native question UI: visible
  choices, multi-step navigation, custom answers, validation and durable outbox
  recovery. Existing engine callbacks and Feishu rendering are retained.
  Tests: `gateway-cards`, `gateway-card-states`; browser `questions`, `cards`,
  `cross-device` and opt-in `live-codex-input`. See
  `docs/client/native-question-experience.md` for evidence and remaining limits.
  On touch-first devices, `brand-theme.css` keeps a selected question option's
  single border, subtle fill and native checked indicator; it removes the
  extra inset stroke and enclosing focus ring. Keyboard input focus remains
  visible and mouse-first desktop styling is unchanged. This is App-only
  presentation with no Host, answer-submission or CLI behavior change.
  Question navigation focuses during the DOM commit using an incrementing state
  revision. Do not defer focus with RAF or use a ref-only request: both can steal
  focus from later typing, especially repeated same-step actions. Quiet-connection
  / delayed-draft fixture coverage and real CLI phone verification with Opus 5.5:
  [live mobile debugging](client/live-mobile-2026-10-04.md).
- `client/src/question-draft.ts`, `client/src/QuestionForm.tsx`, `client/src/storage.ts`
  Native-question drafts are scoped to the message/request/question schema and
  current device identity. Pending outbox answers load before controls unlock;
  resolved/changed forms are pruned in message/snapshot transactions. Browser
  regressions: `questions`, `cards`, `cross-device`, `local-reset`, `snapshot`,
  `stream`, `long-messages`, `topics`. These drafts are local and never auto-submit.
- `src/hub/cli.ts`, `src/hub/server.ts`
  Opt-in client Hub bootstrap, device trust, event sync, attachments and local
  service commands. See `docs/client/architecture.md` and the acceptance ledger
  at `docs/client/implementation-status.md` before treating this as a release.
  Shutdown rejects new HTTP/upgrade work, disconnects tracked TCP peers (including
  incomplete HTTP bodies and TLS handshakes), then drains accepted HTTP tasks
  before closing SQLite. Concurrent close callers share the same completion.
  Tests: `hub-shutdown`, `hub-tls-identity`, `hub-server`, `hub-download`,
  `hub-request-revocation`, `hub-supervision`.
- `src/hub/auth.ts`, `src/hub/server.ts`, `src/hub/attachments.ts`
  HTTP body/queue/response trust checks, atomic pairing/revocation actor checks
  and cancellable attachment downloads. The raw session validator requires an
  already-owned database queue; do not recursively enter `serial`.
  Tests: `hub-request-revocation`, `hub-foundation`, `hub-server`, `hub-push`,
  `hub-avatars`, `hub-collaboration`, `hub-file-center`; broad browser regression.
  Evidence and limits: [in-flight HTTP revocation](client/http-revocation.md).
- `src/hub/store.ts`, `src/hub/server.ts`, `src/hub/attachments.ts`
  Realtime mutation transaction guards and device-checked private socket output.
  Network writes supply the raw transaction guard; trusted store callers may
  omit it. Tests: `hub-socket-revocation`, `hub-server`, `hub-forwarding`,
  `hub-request-revocation`, `hub-foundation`; browser stream/snapshot/recovery,
  stop, forwarding, creation, topics, cards, and broad paired-device regression.
  Boundaries: [realtime revocation](client/socket-revocation.md).
  `clientSocket` buffers bounded metadata until `ready` and tolerates unavailable
  optional folder metadata without rewriting it. `hub-handshake-metadata` covers
  handshake interleavings and corrupt folder records.
- `src/hub/server.ts:instanceSocket`
  Authentication continuations and queued instance frames belong to their live,
  non-rejected socket. A disconnected authentication candidate cannot register
  itself online or replace a healthy worker. Tests: `hub-instance-lifecycle`,
  `hub-server`, `hub-socket-revocation`, `gateway-service`.
  [Joint audit and reproduction](client/joint-opus-audit-2026-10-13.md).
- `src/hub/bot-manager.ts`, `src/hub/file-center.ts`, `src/hub/google-export.ts`,
  `src/gateway/receipts.ts`, `src/ui/file-inventory.ts`
  Management admission after manager/file queues, OAuth, preparation and receipt
  I/O. Denied restarts preserve retry state; admitted external operations finish
  durable bookkeeping. Tests: `hub-control-revocation`, `hub-bot-manager`,
  `hub-supervision`, `hub-file-center`, `gdocs`, `gateway-recovery`,
  `ui-file-inventory`, existing HTTP/socket revocation; browser creation,
  collaboration, effort, file center and operations/restart flows.
  See [management admission boundaries](client/control-revocation.md).
- `client/src/connection.ts`, `client/src/storage.ts`
  Ordered signed Hub handshake before accepting application frames, plus
  identity-bound persistence of authenticated device revocation. Reload retains
  the recovery reason and cached history without reconnecting a known revoked
  identity; socket close drains already-received frames before reconnecting so a
  slow cache write cannot discard a signed revocation. Ordinary revocation
  notices reconnect to obtain a fresh signed denial before persistence; a closed
  handshake cannot reactivate transport after cache writes. Local reset
  removes the marker and fences stale writes. Browser
  tests: `handshake`, `pairing`, `local-reset`, `routes` on Chromium and WebKit.
- `src/client-protocol/auth-status.ts`, `src/hub/auth.ts`, `src/hub/server.ts`,
  `client/src/identity.ts`, `client/src/connection.ts`
  Negotiated signed denial for devices revoked while offline; pinned Hub key,
  current nonce and signing-domain verification before persistent recovery.
  Tests: `hub-foundation`, `hub-server`, `hub-socket-revocation`,
  `hub-request-revocation`, `client-protocol`; browser `handshake`, `pairing`,
  `local-reset`. See [offline revocation](client/offline-revocation.md).
- `src/hub/avatars.ts`, `src/client-protocol/avatars.ts`, `client/src/Avatar.tsx`
  Personal/Bot/root-conversation avatars, authenticated PNG storage, CAS revisions,
  lazy `AvatarEditorDialog.tsx` crop/library editor and cross-device/offline rendering.
  `AvatarEditor` catches optional editor chunk failures locally and retains the
  chat/draft; browser `bot-avatar-library` also covers unavailable chunks.
  `src/client-protocol/bot-avatar-catalog.ts` keeps the stable historical mascot
  catalog and the shared active selection/shuffle pool.
  The 2026-11-05 retirement of `mini-corgi` and `mini-croissant` removes them
  from selection, shuffle and future assignment while preserving historical IDs,
  packaged images and existing saved avatars. [Verification](client/avatar-retirement-2026-11-05.md).
  `hub/bot-avatar-default.ts` assigns the first Bot on a fresh Host `pastel-fox`,
  then samples active entries for later managed/CLI-registered Bots. It
  checks all other Bot rows, including deletion tombstones, and persists the
  choice atomically with creation in SQLite metadata. Re-pairing a device or
  deleting the last visible Bot does not reset first creation; rollback does.
  The optional `defaultAvatar` field follows the authenticated Bot directory and
  its offline cache. Existing unassigned Bots keep the original 36-entry mapping;
  saved PNG overrides still win. `AvatarProvider` uses the owning Host's live or
  cached directory, including the mobile lists, so cold offline reloads retain
  the selected default. [Default assignment, active library and compatibility](client/bot-avatar-defaults-2026-10-25.md).
  The 27 choices added on 2026-10-18 and 81 added on 2026-10-25 extend the library
  to 144 historical IDs. The 2026-10-26 retirement removes 21 from selection and
  both random paths, leaving 123 active; historical IDs, assets and existing
  assignments stay intact. [Latest asset verification](client/avatar-additions-2026-10-25.md).
  `bot-avatar-images.ts` loads transparent WebP cutouts from the owner's new sheets.
  The requested v2 replacement changes automatic defaults; uploaded or saved PNG
  overrides remain authoritative. The editor preserves alpha through save/sync.
  Default group avatars derive a maximum nine-member collage from the owning
  host's conversation cache. `AvatarProvider` receives that host's existing
  conversation directory; membership and Bot picture revisions update the
  collage without generating/storing another image. Topics inherit the root
  group. Custom group images still win. Browser `avatars`, `group-settings` and
  `forward-picker` cover membership, cross-host identity, custom overrides,
  topic inheritance and cached offline rendering.
  [Group portrait behavior](client/group-avatars-2026-10-12.md).
  Direct conversations use the existing `group` namespace, gated by
  `conversation-avatars.v1`; only their creator may edit them. `ConversationAvatar`
  separates list/header identity from Bot message authors. Mobile hold and desktop
  conversation-layout menus use `ConversationAvatarDialog` with the clicked host
  provider. Browser `conversation-avatars` covers edits, restoration, old hosts,
  equal IDs across hosts, offline cache and optional-chunk recovery.
  [Conversation avatar behavior](client/conversation-avatars-2026-10-13.md).
  Source edits and reproducible crops: `assets/bot-mascot-sources/` and
  `scripts/crop-bot-mascots.py`. Tests:
  `bot-avatar-catalog`, `hub-bot-avatar-default`, `hub-bot-manager`, `hub-avatars`,
  `hub-server`, `hub-state-backup`, `host-cli-management`; browser `avatars`, `bot-avatar-defaults`, `bot-avatar-library`,
  `creation`, `startup` on Chromium and WebKit.
  [Identity contract and validation](client/bot-avatar-library-2026-10-12.md).
  [Transparent mascot replacement](client/mascot-avatars-2026-10-12.md).
- `src/hub/network.ts`, `client/src/DeploymentGuide.tsx`
  Explicit TLS-only public host listeners, host/relay setup guidance, generic
  direct routes and QR deployment descriptions. See `docs/client/host-deployment.md`.
  Tests: `multi-relay`, `relay`, `hub-server`; browser `deployment`, `multi-vps`,
  `routes`, `qr-scanner` on Chromium and WebKit.
- `src/relay/tunnels.ts`, `src/client-protocol/routes.ts`, `client/src/RouteFields.tsx`
  Multiple warm VPS tunnels, backward-compatible config, ordered client failover,
  per-route cooldowns and idle switchback. A disconnected client may retry a
  health/key-verified cooldown route when no healthy alternative is available;
  background switchback still honors cooldowns. Idle switchback carries its
  verified target into the next authenticated connection instead of repeating
  the cold-start race; queue reads recheck traffic, socket generation and route
  edits before closing the active connection. Client-only, no CLI command or host
  protocol change. Tests: `connection-switchback`, `multi-relay`, `relay`,
  `hub-route-monitor`; browser `crash`, `multi-vps`, `routes`, `uploads`, `qr-scanner`.
- `src/hub/event-history{,-sql}.ts`, `src/hub/storage-space.ts`
  Schema 22 bounds reclaimable full message-update replay history with durable
  floors and compact activity coverage. Expired cursors use exact snapshots
  (full, or covered deltas for capable clients); per-page checks recover pruning races. New databases reclaim incrementally;
  existing file conversion requires explicit offline `hub compact`. Configuration,
  CLI impact, backup independence and limits: [event history retention](hub-event-history-retention.md).
  Tests: `hub-event-history`, `hub-server`, `hub-message-activity`,
  `hub-maintenance-tick`, `hub-state-backup`, `host-cli-entry`,
  `connection-independent-sync` (failed conversation outbox remains fenced).

- `src/hub/state-backup.ts`, `src/hub/maintenance.ts`
  Existing online database/attachment exports and offline full Hub state bundles.
  Online database backups cross the existing writer barrier, then run VACUUM INTO
  on an independent read-only snapshot (including committed WAL data), so the
  copy does not occupy the main Hub queue. Tests: `hub-maintenance`.

  Full restore preserves identity and managed Bot state at the absent original
  path; validates hashes, keys and attachment receipts; refuses running instances.
  A completed official restore rotates `meta.sync_lineage` without a schema
  version change. Negotiated `sync.lineage.v1` binds each cached conversation
  cursor to its restored timeline and forces an atomic replacement on mismatch;
  socket-scoped tokens fence queued writes from the discarded timeline. Legacy
  snapshot clients replace history on every reconnect to a restored Hub, while
  delta-only clients receive an explicit update requirement. Ordinary unrestored
  Hubs and CLI management connections retain their existing behavior. See
  [restore sync lineage](client/restore-sync-lineage-2026-10-23.md).
  Tests: `hub-state-backup`, `hub-maintenance`; browser `live-backup` is opt-in
  real Codex acceptance with device trust and native session continuity.
- `src/hub/backup-settings.ts`, `client/src/BackupSettings.tsx`, `src/host-cli/backups.ts`
  Owner-scoped automatic database backup retention, shared by Settings → Data &
  backups and `backups status/configure`. Default 1 UTC calendar day; zero disables
  and prunes only owned automatic snapshots. Policy updates and snapshot pruning
  share a lock; writes recheck authorization, revisions and idempotency receipts.
  The minute maintenance scheduler notices same-day policy changes. Manual/full
  backups and upgrade recovery copies are independent. Tests: `backup-settings`,
  `hub-maintenance`, `hub-state-backup`; browser `backup-settings` at phone and
  desktop widths in Chromium/WebKit. This setting is engine-independent.
- `src/hub/bot-manager.ts`, `src/gateway/worker.ts`
  Owner-scoped client Bot creation and supervised Gateway-only workers, using
  the existing TaroCub configuration, Bridge, session, queue and card handlers.
  Tests: `hub-bot-manager`, `gateway-service`, browser `creation`.
  `gateway-recovery` covers atomic retirement of interrupted run/approval cards,
  multi-Bot isolation and ordered journal recovery. Browser `live-worker` is
  explicitly opt-in real-engine acceptance (`TAROCUB_LIVE_ENGINE`, default Codex)
  for UI creation, session-preserving restart and a killed worker after real text
  has streamed to paired desktop/phone contexts; it is skipped in the ordinary browser suite.
  Standalone boot/teardown uses the original restart-loop guard as well:
  `gateway-restart-loop` injects real SIGKILL/fatal/cleanup failures, and browser
  `restart-guard` exercises the visible recovery pause and fresh local commands.
  `gateway/control.ts` validates managed-worker IPC restart requests/receipts.
  `hub-supervision` covers the rolling crash budget, live IPC failures, confirmed
  restart receipts and restore-safe request deduplication; browser `managed-restart`
  checks a production worker, HTTP replay and truthful operation errors.
- `src/hub/collaboration.ts`, `src/client-protocol/collaboration.ts`, `client/src/CollaborationPanel.tsx`
  Owner-only native Bus settings for Hub-managed Bots: reciprocal permission
  visibility, parallel/ordered chain/verifier and five-role research crew.
  Strict read/write, shared native config mutex, revision conflicts and a commit
  trust recheck preserve unrelated state and never return secrets. Service apply
  uses the existing idle restart operation; listener status is not an effective
  configuration assertion. Tests: `hub-collaboration`; browser `collaboration`.
  `client/src/collaboration-task.ts` prepares explicit reciprocal relationships
  with revision checks and stable idle-restart receipts; it never sends a task.
  Tests: `collaboration-task`; browser `collaboration-setup` (real isolated workers).
  Opt-in `live-crew` (`TAROCUB_LIVE_CREW=1`) exercises five actual native engines,
  UI reciprocal grants/roles, phone cancellation and a completed group workflow.
- `src/hub/file-center.ts`, `src/client-protocol/file-center.ts`, `client/src/FileCenter.tsx`
  Owner-only file inventory and shared annotations. Hub supplies registered Bot
  roots to the existing `src/ui/file-inventory.ts` scanner; client requests cannot
  supply paths. One cancellable scan, revision-aware polling and optimistic label
  writes serve desktop/phone. Original Console labels import once for indexed
  units; App labels then belong to the Hub. Tests: `hub-file-center`,
  `ui-file-inventory`, `ui-config-api`, `hub-state-backup`; browser `file-center`
  covers two-device conflicts, saving/unsaved-draft guards and both themes.
- `src/hub/attachment-admin.ts`, `src/client-protocol/attachment-admin.ts`, `client/src/AttachmentManager.tsx`
  File Center › 附件管理 (`attachments.admin.v1`, owner only): per-conversation
  attachment space, list by size/time, and real deletion. Deletion retires the
  attachment (`retired_attachments`) and `HubAttachments.purge` removes the blob
  and chunks at once under the maintenance lock; the row and message reference
  stay so messages render 附件已删除 (`attachment_deleted`, 410). Attachments in
  a message a Bot has not finished (`deliveries.status='pending'`) are refused.
  Daily GC sweeps bytes an interrupted purge left. CLI: `tarobot attachments`.
  Message updates may retain their existing deleted-file references, allowing
  card retirement/Bot deletion to settle; they cannot add a retired file to a
  new message or reintroduce a reference removed by an earlier update. Downloads
  and new forwards remain blocked even when physical purge must retry. Existing
  forwarded copies retain their independent lifetime. File Center clamps an
  emptied page to the last remaining page.
  Attachment details reserve a separate action area below the scrolling content;
  selection and delete confirmation cannot cover file rows or pagination.
  Browser `attachment-manager` checks the scrollport boundary, last-row selection,
  confirmation/cancel and pagination at desktop, narrow-window and phone sizes.
  This layout correction does not change Host/CLI deletion or permission rules.
  Client small-attachment cache writes recheck deletion/cancellation inside the
  IndexedDB write transaction; late downloads cannot restore a deleted cache
  entry. Large-attachment disk copies serialize their capacity checks across
  windows while preserving shared preview leases and per-entry locking.
  [Behaviour and limits](client/attachment-manager-2026-11-07.md). Tests:
  `hub-attachment-admin`, `hub-bot-delete`, `host-cli-attachments`; browser
  `attachment-manager`, `attachment-cache-deletion`, `attachment-disk-cache`.
- `src/runtime/bot-capabilities.ts`, `src/client-protocol/capabilities.ts`, `client/src/CapabilitiesPanel.tsx`
  Owner-only Skills/MCP metadata inventory, bound to the selected host and Bot.
  Its host disclosure shows the current runtime host name (profile/network fallback),
  retaining the full identity fingerprint inside. Names do not change host identity.
  Reads native configuration without starting CLIs, exposing credentials or claiming
  live connection/loading status. Managed offline reads use Bot-local scope only.
  Tests: `bot-capabilities`, `gateway-operations`; browser `capabilities`.
  `client/src/capability-groups.ts` groups exact same-name Skills for display only,
  retaining source-specific status, descriptions and help drafts; MCP/Host/CLI
  entries remain unchanged. Filters match individual sources before group counts
  and pagination. Tests: `client-capability-groups`; browser `capability-groups`.
  Coverage and explicit unsupported sources: [Skills and MCP](client/skills-mcp.md).
- `client/src/CapabilityHelpDialog.tsx`, `client/src/CapabilitiesPanel.tsx`
  Capability configuration handoff: editable message preview, an idempotently
  created direct conversation and a local draft. No automatic send or installation.
  Retries retain one action ID; old dialog completions cannot navigate a new dialog
  or host. Browser regressions: `capability-help`, `capability-help-lifecycle`.
- `client/src/IntegrationRecommendations.tsx`, `client/src/NewBot.tsx`
  Optional Qwen3-ASR 0.6B and Tavily + Brave guidance after the first native-local
  Bot creation; later access through Skills & MCP. Native host identity, rather
  than route shape, determines locality. Reuses the editable capability draft
  handoff without automatic installation, downloads or credential submission.
  The persisted handoff also refreshes an already-selected first conversation
  and invalidates earlier empty composer reads; regression: delayed first-setup
  draft in `integration-recommendations`.
  CLI uses the existing integration tools; no Host API change. Browser regression:
  `integration-recommendations`, plus `creation` for controller-only exclusion.
  [Flow and platform limits](integrations.md#首次本机-bot-的可选建议).
- `client/src/attention.ts`, `client/src/MobileHome.tsx`, `client/src/storage.ts`
  Mobile pending-question/approval filter, incrementally projected from actionable
  native cards. Includes nonarchived group topics and exact-message navigation,
  isolates hosts and backfills older caches. A queued response remains pending until
  the host updates its card. Browser regression: `mobile-attention`.
- `src/runtime/bot-dashboard.ts`, `src/client-protocol/dashboard.ts`, `client/src/BotDashboard.tsx`
  Owner-only Bot dashboard: sampled shared runtime activity, saved configuration
  and session counts, scheduled tasks/history, latest persisted crew stages, and
  UTC daily/monthly usage. Missing measurements stay unknown. The overview and
  dashboard read usage without repairing state; valid last-good fallback is labeled.
  `runtime/cron-snapshot.ts` is shared with the original CLI dashboard, and
  `state/cron-store.ts` owns shared timezone/legacy reminder normalization.
  Tests: `bot-dashboard`, `dashboard`, `cron-store`, `gateway-operations`;
  browser `dashboard` checks desktop/phone, themes, locales and offline refresh.
  Large cron snapshots validate in yielding batches, with a per-read schedule
  cache. `client/src/DashboardCronList.tsx` searches all records, pages the visible
  list and mounts history on expansion. Synthetic scale and concurrent phone-stop
  evidence: [dashboard and inventory performance](client/dashboard-scale.md).
- `src/runtime/diagnostics.ts`, `src/hub/diagnostics.ts`, `client/src/DiagnosticsPanel.tsx`
  Read-only owner diagnostics: Bot audit/timeline files plus retained rotations,
  and Hub security/operation audit rows. The bounded-memory reader reuses original
  event schemas, redaction and timeline summary rules. Gateway reads its own
  instance; Hub-owned Bot logs also remain readable while that worker is offline.
  Hub history uses one independent read-only WAL snapshot per Hub, with bounded
  batches and a separate reader queue. HTTP disconnect cancels the scan; response
  authorization is still rechecked. Filters and stable pagination are validated
  in `client-protocol/diagnostics.ts`.
  Tests: `diagnostics`, `audit-log`, `timeline-log`, `gateway-operations`;
  browser `diagnostics` verifies paired desktop/phone history and filtering.
- `src/gateway/service.ts`, `src/gateway/channel.ts`
  Independent App Gateway sharing the Core bridge/runtime.
  `src/core/channel-profile.ts` selects rendering limits without loading a
  retired transport runtime. Tests: `gateway-service`, `gateway-cards`, `gateway-recovery`.
- `tests/setup-gateway-guard.ts`, `tests/helpers/gateway-no-feishu.cjs`
  Global Gateway-suite guard rejects real Feishu SDK calls and subprocesses,
  except exact guarded crash/restart fixtures and their compiler helper. Durable
  per-suite receipts fail tests even when errors are swallowed. Self-tests:
  `no-feishu-guard`; [scope and evidence](client/gateway-test-isolation-2026-10-11.md).
- `src/gateway/session-binding.ts`, `CoreChannelLike.prepareConversation`
  Applies a Hub binding selection once inside the native conversation queue,
  preserving the destination's previous session for `/detach`. Durable strict
  receipts prevent old metadata from undoing reset/resume after reconnect.
  Hub schema 9 adds an operation identity; legacy unbound metadata requires
  reselection, and uncertain writes never replay automatically. Tests:
  `gateway-session-binding`, `gateway-service`, `hub-state-backup`; browser
  opt-in `live-session-model` covers memory/persona, isolated groups and native
  resume/detach/reset on paired clients.
- `src/core/card-actions.ts` (`stopCoreConversation`, `renderCoreConversationStop`)
  Shared cancellation/acknowledgment for `/stop`, run-card stop and Gateway
  composer stop. Cancels the current controller and pending attachment burst,
  terminalizes burst inputs, preserves queued turns and other conversations.
  Hub dispatches group stops concurrently and independently of stalled command
  RPCs, retaining session/member authorization. Tests: `core-audit3-fixes`,
  `core-service-compat`, `core-card-callback-security`, `gateway-service`, `hub-server`;
  browser `stop` verifies both devices, queue/topic isolation and local latency.
- `src/runtime/turn-cancellation.ts`: authorized App stops use a bounded process
  cleanup grace in Claude and both Antigravity paths; other channels and runtime
  shutdown retain their defaults. Tests: `turn-cancellation`, `process-tree`,
  `claude-stream-adapter`, `antigravity-adapter`; opt-in browser `live-stop`
  observes all five real CLIs and verifies same-session recovery. See
  [native stop acceptance](client/native-stop.md) for measurement boundaries.
- `src/gateway/commands.ts`, `src/gateway/group-mode.ts`, `src/core/commands.ts`, `src/core/config-card.ts`
  Explicit disposition of every canonical command, native App help/status and
  per-Bot per-conversation group reply mode. Gateway cannot change Feishu access
  or invoke its scope API through these commands/cards. Test:
  `gateway-command-parity`; browser `command-parity` verifies both devices.
  Group reply overrides use a separate validated Bot state file; explicit mention
  mode beats the instance default and old positive overrides remain readable.
- `src/core/command-cards.ts`, `src/core/commands.ts`, `client/src/Content.tsx`
  App command results use native cards. `/usage` separates metered/unmetered
  requests, reported totals, UTC update time and engine limitations; missing
  telemetry is never synthesized as a zero-token turn. The shared command
  helper wraps `/help`, `/model`, `/effort` and similar replies only on Gateway.
  Existing Bot text messages reuse card typography on read, preserving authored
  line breaks without migrating history or changing copy/forward source data.
  Tests: `command-result-cards`, `gateway-command-parity`; browser
  `command-cards`, `command-parity`, `cards`, `card-layout`, `message-reading`,
  `markdown`. Persisted legacy text/card envelopes remain readable.
- `src/core/delivery-recovery.ts`, `src/state/delivery-obligation-store.ts`, `src/state/delivery-body-store.ts`
  Shared safe final-response recovery, selected by destination before claim;
  Gateway's boot barrier replays old publications and recovers generated replies
  before retiring interrupted input. Large Gateway final/background replies use
  checksum-verified bodies outside the small ledger index. Tests:
  `gateway-delivery-recovery` (real SIGKILL), `delivery-body-store`,
  `core-delivery-recovery`, `delivery-obligation-store`, `hub-state-backup`;
  browser `final-recovery` verifies complete long replies on two devices. Full functional review:
  `docs/client/functional-parity-audit.md`.
- `src/client-protocol/fragments.ts`, `src/client-protocol/fragments-node.ts`
  Negotiated long-message framing, ordered SHA-256 reassembly, and paced socket
  writes shared by Hub/Gateway and the browser connection. Canonical message
  bodies stay complete. Browser reassembly uses `base64.ts`, shared with large
  share/image/screenshot/Design payloads: native `atob` validation and one output
  allocation, with no per-byte iterator callback. Node's injected Buffer decoder
  is unchanged. Tests: `base64`, `client-fragments`, `hub-server`, `gateway-recovery`,
  browser `long-messages`, `stream`, `snapshot`.
- `src/gateway/environment.ts`, `src/gateway/bus.ts`, `src/gateway/media.ts`
  Standalone worker shared environment loading, opt-in authenticated Bus lifecycle,
  and per-message ASR status cards. Media routing remains in the shared Core/ASR
  pipeline; credentials never travel to the client. Tests: `gateway-environment`,
  `gateway-bus`, `gateway-voice`, `asr-cloud-routing`.
- `src/runtime/integration-environment.ts`, `integrations/`, `scripts/integration-assets.mjs`
  Private TaroBot integration config, portable Qwen/Tingwu installers and strict
  release asset allowlist (also used by the desktop Host). Local ASR settings
  are resolved at factory creation after worker environment loading. Tests:
  `gateway-environment`, `integration-environment`, `integration-assets`,
  `qwen-asr`, `tingwu-installer`. See [setup](integrations.md).
- `client/src/VoiceMicButton.tsx`, `client/src/HoldToTalk.tsx`, `client/src/useVoiceRecorder.ts`
  Recording lifecycle, cancellation, microphone release and draft audio preview.
  The phone mic supports tap-to-switch and long-press recording without replacing
  the captured pointer target. `voice-presentation.ts` removes generated recording
  names from new ASR cards and the presentation of old cards. Regressions:
  `voice-presentation`, `gateway-voice`; browser `hold-to-talk`, `voice-card`,
  `voice-draft-lifecycle`. See [mobile inbox and voice QA](client/mobile-inbox-voice-2026-10-12.md).
  Small pre-hold movement cancels the hold timer but preserves a browser-accepted
  tap; interrupted/held gestures cannot also open voice mode. `voice-mic-button`
  covers online/offline touch and click suppression. See the [tap diagnosis and
  repair](client/voice-mic-tap-2026-10-28.md).
  `client/src/VoiceTranscript.tsx` folds long completed/partial/stopped ASR card
  bodies to five lines on desktop and mobile, with keyboard-accessible expand/
  collapse controls. The 2,000-character receipt cap, full Bot input and canonical
  copy/forward data stay unchanged. Browser `voice-card` covers both viewport
  sizes in Chromium/WebKit; see [transcript folding](client/voice-transcript-folding-2026-10-22.md).
  Browser `voice` verifies real encoding/playback in Chromium and WebKit.
  Android's manifest must declare both RECORD_AUDIO and MODIFY_AUDIO_SETTINGS:
  Capacitor denies WebView audio capture if either permission is missing.
  `RecordingPermissionTest` exercises the installed native permission callback
  after RECORD_AUDIO is granted, in an isolated `.voicetest` package without
  opening a microphone. See [Android recording permission](client/android-recording-permission-2026-10-12.md).
- `client/e2e/live-voice.spec.ts`, `fixtures/voice-observer.mjs`: explicit
  `TAROCUB_LIVE_VOICE=1` for real phone recording / Qwen / native Kimi / paired
  playback; separate `TAROCUB_LIVE_VOICE_CLOUD=1` for real 905-second Tingwu audio
  and exact-object remote cleanup read-back. No user microphone or real calls
  in default runs. [Voice acceptance](client/live-voice-2026-10-04.md).
- `client/src/back-navigation.ts`, `client/src/NativeBackNavigation.tsx`
  Android Back listener outside pairing/lock, with visible dialog precedence,
  guarded settings/detail navigation and root backgrounding. Closing ShareInbox
  retains mounted drafts/transfers. Tests: browser `native-back`, `settings`,
  `effort`, `share`, `file-center`, `operations`, `attachment-composer`, `voice`.
  Physical Android Back/keyboard/gesture acceptance remains separate; see
  [native Back navigation](client/native-back-navigation.md).
- `client/src/PreferencesPanel.tsx`, `client/src/SettingsParts.tsx`,
  `client/src/NotificationSettings.tsx`, `client/src/RoutesEditor.tsx`
  Settings categories, local language/appearance, host-scoped profile and device
  controls, notification prerequisites and saved-route status. Host management
  preserves the unsaved-route discard guard. UnifiedPush success text requires a
  confirmed registration. Browser checks: `settings`, `settings-language`,
  `settings-notifications`, `palettes`, `pairing`, `unifiedpush-native`.
  Actual Opus 5.5 implementation, visual review and verification receipts:
  [Settings usability and language](client/settings-ux-opus55-2026-10-04.md).
- Phone settings pages: `CreationDialog.mobilePage` / `settings-dialog.css`
  cover device/network, Bot, conversation/group and their configuration subpages.
  A stable body preserves forms through rotation; the phone Back bar stays above
  the scrolling body. `PreferencesPanel` / `ConnectionPanel` share the same
  portrait-or-touch layout rule. Safe-area and keyboard sheet clamps exclude
  these pages; confirmations and action menus stay compact. Tests:
  `settings-fullscreen`, `device-ui-layout`, `mobile-settings`,
  `group-settings-phone`. [Scope and verification](client/settings-fullscreen-2026-10-28.md).
- Phone runtime/capability pages: `SettingsPageHeader.tsx` / `settings-page.css`
  make `OperationsPanel.tsx` and `CapabilitiesPanel.tsx` fill the safe viewport,
  with a persistent back bar and independent content scrollports. Desktop keeps
  dialog sizing. Native Android owns its system insets; browser/iOS consume the
  shared CSS tokens once, including touch landscape and keyboard resize. Runtime
  Back returns through records/dashboard/collaboration before leaving the page,
  preserving unsaved-change guards. Resize observation keeps the focused field
  inside its own scrollport; returning after rotation restores the same-workspace
  Me entry. Tests: browser `safe-area`, `capabilities`,
  `operations`, `collaboration`, `dashboard`, `diagnostics`, `delegation`,
  `restart-guard`, `conversation-details` (16 journeys per engine pass in Chromium
  and WebKit; root/client builds pass). Browser inset simulation is separate from
  physical-device acceptance and an updated native installer.
- `src/gdocs/cli.ts`
  Desktop-app OAuth and Google Docs CLI; Hub exports/status are owner-scoped.
  `gdocs configure` imports a private managed copy; `auth --client-file` persists
  the same import. CLI directory selection shares `resolveHostDirectory` with
  the App/host CLI. `src/gdocs/settings.ts` owns legacy fallback, managed imports
  and local-only authorization status; `errors.ts` maps provider/config errors
  to public codes without credentials. `client/src/GoogleDocsSettings.tsx` adds
  status and setup guidance to desktop General settings; mobile General settings
  directs users to complete setup in the host's desktop app. Native iOS/Android
  keep this guidance at wide widths too. Authorization still starts in the host
  terminal. `google-docs-errors.ts` supplies shared localized
  export/status failures. Tests: `gdocs`, `gdocs-setup`, `hub-control-revocation`,
  browser `google-docs-setup` and `message-actions` in Chromium/WebKit.
  [Configuration and error acceptance](client/google-docs-setup-2026-10-30.md).
- `client/src/`
  React UI, IndexedDB/outbox, signed connections and dual-route switching.
  Product visual hierarchy, palette, compact attachment and motion refinement:
  [Opus design and rendered acceptance](client/premium-design-qa-2026-10-05.md).
  Compact run-card typography and native reading verification:
  [Reading cards](client/reading-cards-2026-10-11.md).
  Core browser checks: palettes, mobile-im, keyboard, file-actions, creation,
  message-actions, settings, topics, startup and performance.
  `Sidebar.tsx` and `sidebar-resize.css` provide the desktop window splitter.
  Its width is document-local, shared across hosts, and never saved as a user
  preference. Browser `sidebar-resize` covers dragging, keyboard, bounds,
  cancellation, host switching and fresh-launch defaults.
  Its 1px hover/focus/drag stroke follows the selected Monochrome accent mark
  (neutral when none is selected), and the palette accent in other themes.
  [Desktop splitter acceptance](client/sidebar-resize-2026-10-13.md).
  Side chat and workbench share the same 1px accent rule and preserve their
  larger drag targets; see [panel divider alignment](client/panel-divider-accent-2026-10-31.md).
  `SidebarLayoutSwitch.tsx` selects the default Bot tree or flat conversation
  list; `sidebarLayout` is a device preference shared across host workspaces.
  `conversation-inbox.ts` shares phone ordering and group/topic aggregation
  with `ConversationList.tsx`. `CombinedSidebar.tsx` combines host directories
  by default; the small “按主机分组” checkbox opts into host sections through
  the device-local `sidebarGroupByHost` preference (default false). Host labels
  appear once per branch, and rendered slices retain their owning connection.
  Both Bot views share `buildBotRows`; the cache ranks message changes by Hub
  event time. `snapshot.activity.v1` adds a negotiated content timestamp for
  offline recovery without changing frames sent to older snapshot clients.
  Tests: `hub-server`, `hub-link-preview`; browser `activity-order`, `snapshot`,
  `stream`, `sidebar-layout`.
  Browser `sidebar-layout` covers persistence,
  drafts, narrow layouts and host-scoped actions. Conversation-row Bot names
  and model marks sit immediately after the title, as on phones; short titles
  do not stretch, while long titles keep ellipsis and narrow-side-bar behavior.
  [Desktop sidebar layouts](client/sidebar-layout-2026-10-13.md).
  `SidebarListOptions.tsx` shares desktop grouping/offline preferences through
  folder-name context menus, Bot menus and section/Host heading menus. No search
  or Host-heading ellipsis remains. `FolderListOptions` owns one stable manager
  per directory and resolves the clicked connection, including same-ID folders
  on different Hosts. Empty directory space and Shift+F10 retain access without
  adding a toolbar row; phone controls and mixed recency ordering are unchanged.
  The existing device preferences, Host APIs and CLI rules are unchanged.
  See [desktop list options](client/desktop-list-options-2026-10-28.md); browser
  `desktop-list-options`, `sidebar-layout`, `conversation-folders`,
  `porcelain-details` and `adhd-board`.
  `MobileListOptions.tsx` puts phone Messages list preferences and host-scoped
  folder management behind the filter-row overflow button. It reuses existing
  preferences and `FolderManager`; desktop controls remain unchanged. See the
  October 26 follow-up in [phone host grouping](client/mobile-host-grouping-2026-10-16.md).
  `MobileHome.tsx` shares the optional `sidebarGroupByHost` preference (default
  false), retaining host-scoped custom folders and labeling each branch once.
  `conversation-inbox.ts:folderSectionHosts` keeps phone and desktop combined
  lists consistent when only some hosts have folders: other populated hosts get
  an implicit Unfiled heading rather than source labels on individual rows.
  Regressions: `sidebar-layout`, `mobile-im`, `conversation-folders`,
  `host-source-badges`. [Phone host grouping](client/mobile-host-grouping-2026-10-16.md).
  `showDisconnectedBots` defaults false on both clients. The device-local
  checkbox uses `conversation-inbox.ts:navigationItems` to filter Bot rows and
  direct chats by both host connectivity and Bot presence, preserving groups,
  canonical history, pins, unread state and open drafts. An established host's
  transient disconnection retains its last visible Bots for five minutes through
  `HubConnection.state.navigationGraceUntil`; retries cannot extend that display-only
  deadline. Expiry notifies all views, including after foreground resume. Explicit
  Bot offline status, close and revocation take effect immediately. Tests:
  `client/tests/host-visibility-grace`, browser `inbox-recovery`, `sidebar-layout`.
  Explicit suspended-host
  history uses a host-scoped `viewingHistory` exception without persisting the
  preference or restoring connection authority. Empty conversation prompts count
  hidden conversations, not unrelated offline Bots, and keep online creation
  available. Tests: `sidebar-layout`, `private-network`, `mobile-im`,
  `host-source-badges`. Offline-history browser fixtures explicitly opt in through
  `fixtures/mobile.ts:showDisconnectedBots`; presence tests retain the default.
  [Disconnected Bot visibility](client/disconnected-bot-visibility-2026-10-17.md).
  Universal Mac development build and native performance boundaries:
  [macOS build](client/macos-build.md). Android prerequisites and license/device
  boundaries: [Android build](client/android-build.md).
  Browser acceptance uses `client/e2e/`; exclude it from root Vitest collection.
  `review-recovery` covers paired-device binding recovery, target-Bot controls,
  durable bounded outbox retries, failed card actions, FIFO and manual removal.
  `outbox-failure.ts` recognizes definitively unavailable card actions as local,
  nonblocking failures without permitting retries or clearing other errors.
  Regressions: `client-outbox-failure`, `review-recovery`, `message-send-continuity`,
  `outbox-refresh`, `questions` and `cross-device`.
  [Expired card recovery and validation limits](client/expired-card-action-2026-10-20.md).
  `live-claude-binding` is opt-in real-Claude empty-destination binding/detach
  acceptance; `live-session-model` checks the corresponding real-Codex lifecycle.
- `client/src/DelegationDialog.tsx`, `BotReferences.tsx`, `bot-references.ts`
  Human-readable collaboration selection and display, using original stable IDs
  and message/outbox commands. Exact known managed references are annotated in
  prose without changing source, code, links or paths. Duplicate names receive
  ID suffixes, and the Hub-scoped name cache survives offline reload. The dialog
  validates refreshed target eligibility and keeps task text in the device draft.
  Per-task participants/order are capability-gated, with a final fresh permission
  check and legacy-plan change guard. Inline settings preserve the task, and
  the phone dialog owns its safe-area viewport with a fixed send footer.
  [Collaboration flow and acceptance](client/collaboration-workflow-2026-10-14.md).
  Tests: `client-bot-references`; browser `delegation`, `markdown`, `startup`,
  `creation` and opt-in real-model `live-bus`.
- Reply formatting parity: `client/src/CodeBlock.tsx` and `code-block.css` share
  language labels, accessible copy feedback and toolbar clearance between
  Markdown and raw run details. `RunPresentation.tsx` reuses `.card-text` for
  legacy typography and theme coverage. `core/card-renderer.ts` retains App
  headings/math while keeping CJK emphasis repair; Feishu normalization remains
  unchanged. Tests: `gateway-cards`, `core-card-renderer`; browser `run-formatting`,
  `palettes`, `markdown`, `run-presentation`, `message-reading`.
  [Audit and acceptance](client/reply-formatting-2026-10-14.md).
  `reply-typography.css` opts authored Bot prose into modest heading sizes and
  semibold emphasis. Native/legacy/plain replies, side answers and reply readers
  share it; process records, task descriptions and user messages retain their
  own styles. Terminal heading grids and saved body/ADHD sizes remain intact.
  Tests: browser `run-formatting`, `theme-font-size`, `background-run`.
  [Reply hierarchy and boundaries](client/reply-typography-2026-10-24.md).
  Explicit `text`/`txt`/`plaintext` fences soft-wrap without changing source
  whitespace or copied text; code, diagrams and unknown types retain columns.
  Tests: browser `plaintext-blocks` (Chromium and WebKit).
  [Plain-text wrapping and type boundary](client/plaintext-wrapping-2026-10-24.md).
- `client/src/MarkdownText.tsx`, `markdown-jobs.ts`, `markdown.worker.ts`, `markdown-parser.ts`
  `MarkdownTable.tsx` and `markdown-table.css` retain intrinsic, prose-bounded
  column widths inside local horizontal scrollports. Wide/tall tables open a
  shared native dialog with a sticky header and the live sanitized table tree;
  thumbnails remain passive. Phone readers own their full safe-area viewport.
  Desktop tables use a compact type scale and pane-relative prose bounds;
  native phone sizing and saved reading preferences remain independent.
  Tests: browser `markdown-tables`, `markdown`, `card-layout`, `message-actions`
  and `message-reading`. [Table reading acceptance](client/markdown-tables-2026-10-12.md).
  [Desktop table density](client/table-reading-density-2026-10-24.md).
  External Markdown images use `markdown-image.ts` to become explicit links,
  never passive image requests. Uploaded attachments keep their authorized
  preview path. `client/scripts/mobile-csp.mjs` runs after Capacitor copy/sync
  and installs the native WebView policy without changing browser networking.
  Tests: `markdown-images`, `mobile-csp`; browser `mobile-content-policy`.
  [Content policy and native acceptance boundary](client/mobile-content-policy-2026-10-11.md).
  All message lengths share the bounded parser worker; the first view does not
  evaluate Markdown/math/highlight dependencies. Worker errors preserve escaped
  text. Cleaned output chunks carry SHA-256 fingerprints so the UI retains trees
  without their serialized transport copies. Native digest batches are bounded
  to eight, with a per-chunk pure-JS fallback. Infrastructure failures preserve
  the waiting queue for bounded recovery. Owner budgets isolate repeated slow
  parses across revisions; constructor or distinct-owner failures open a shared
  circuit that streaming/remounts cannot reset. A successful explicit formatting
  retry resumes latest mounted circuit jobs without resending messages. Parser
  rejection and isolated owners stay local; dispose cancels active parsing.
  `markdown-math.ts` and `markdown-highlight.ts` load only for matching parsed
  content, preserving transform order and complete output. Optional imports
  have a five-second timeout and two-attempt per-engine budget, independent of
  shared Worker failures. Explicit retry releases affected mounted history;
  skipped replies cannot consume a newer retry budget. Single-dollar parsing
  uses `markdown-math-boundaries.ts` for unambiguous delimiters:
  ordinary dollar amounts stay prose while real inline/display math remains
  available. Tests: `markdown-currency`, `markdown-images`; browser `markdown`,
  `markdown-dependencies`, `markdown-tables`, `cli-typography`.
  `markdown-cjk-strong.ts` relaxes double-asterisk boundaries between punctuation
  and CJK letters, so `**结论。**后文` renders emphasis without inserted spaces.
  Native micromark pairing retains escapes, code, links, math and incomplete
  streaming text. This is App rendering only; stored text and CLI output stay
  unchanged. Parser and Worker regressions live in browser `markdown`.
  [Currency typography and compatibility](client/markdown-currency-2026-10-17.md).
  `markdown-link-boundaries.ts` separates CJK sentence punctuation and following
  prose from GFM bare web links before URL encoding. Explicit Markdown targets,
  Unicode URL letters, encoded punctuation and code retain their meaning.
  Question cards share this parser. Tests: `client/tests/markdown-links.test.ts`
  and browser `markdown`. [Link boundary verification](client/markdown-link-boundaries-2026-11-05.md).
  ES-module Worker chunks
  are included in the offline precache. Browser tests: `markdown-dependencies`, `markdown`,
  `markdown-worker-lifecycle`, `markdown-recovery`, `markdown-recovery-app`,
  `markdown-worker-profile`, `markdown-memory`
  (Chromium inspector only), `startup`, `performance`, `hub`, `card-layout` and
  `cards`. [Memory evidence and native boundary](client/markdown-memory-2026-10-11.md);
  `card-layout.ts` honors fill-width buttons along the cross axis inside vertical
  columns, keeping queue actions equally wide instead of label-sized. The real
  queue constructor is included in the card gallery and production reading fixture.
  [bounded recovery and actual App checks](client/markdown-recovery-2026-10-11.md).
  Streaming jobs can publish completed append-only prefixes while newer input
  parses; replacement generations and disposed owners retain strict fences.
  Display chunks group up to 100 roots/about 250 tree nodes without splitting
  semantic blocks. `MarkdownText` adds at most two new chunks per animation
  frame and cancels obsolete paints. Themes, quotes and file captions account
  for the chunk wrapper. Tests: `markdown-paint`, `markdown-volume`,
  `markdown-worker-lifecycle`, `markdown-dependencies`, `performance` and the
  existing reading/focus/following suites. [Evidence and native limits](client/streaming-markdown-stability-2026-10-21.md).
  Gateway run finalization in `src/core/card-renderer.ts` retains the matching
  streamed answer's element ID. This keeps its parsed Markdown and DOM nodes
  when process panels fold, avoiding a whole-answer fallback/remount. Feishu
  terminal IDs are unchanged. Tests: `gateway-cards`, `core-card-renderer`;
  browser `performance`, `stream`, `message-reading`, `markdown`. Long CJK Bot
  paragraphs use ordinary wrapping in `brand-theme.css`, avoiding WebKit's
  paragraph-wide line-break optimization. [Browser evidence and open gates](client/browser-ci-2026-10-11.md).
  Run cards use the preserved `config.streaming_mode` field (including false
  after completion) to retain a bounded reading-column width across reasoning,
  tool panels and folding. Ordinary receipts still hug their content.
  Tests: browser `stream`; [Mac width acceptance](client/stream-width-2026-10-13.md).
- `client/src/LinkPreview.tsx`, `src/client-protocol/links.ts`
  URL extraction/choice and message previews with local reading folds. The
  composer defaults to cards; title/card preference is device-local in General
  settings (`PreferencesPanel`, `storage`, `host-registry`), without per-send
  style buttons. Pending drafts follow the setting; sent style persists through
  sync and forwarding. Legacy per-draft style remains readable but does not
  override the device preference. Unavailable metadata has visible fallback copy.
  `src/hub/link-previews.ts` persists asynchronous metadata and scoped covers;
  `src/hub/public-web.ts` checks and pins public DNS on each redirect with bounded reads.
  Tests: `hub-link-preview`, `hub-server`, browser `link-preview`,
  `settings-language`, `persistent-drafts`.
- `client/src/AttachmentDraft.tsx`, the composer in `client/src/App.tsx`
  Combined text/image/file drafts, local thumbnail lifecycle, mixed clipboard
  text insertion and atomic message enqueue after all uploads complete.
  Tests: `gateway-service`, browser `attachment-composer`, `uploads`, `share`.
  `composer-paste.ts` / `composer-clipboard-image.ts` also accept inline HTML
  raster images and focused Electron clipboard images when no event file is
  available. `electron/clipboard-image.mjs` bounds and scopes native reads;
  clipboard URLs and private formats are not opened. Tests: browser
  `composer-paste`, Electron `clipboard-image`; see
  [clipboard intake and Windows acceptance limits](client/clipboard-image-paste-2026-11-10.md).
- `src/hub/config.ts`, `src/hub/attachments.ts`, `client/src/files.ts`
  Hub-owned `maxFileBytes`, authenticated limit negotiation, shared upload checks,
  and native share-inbox policy caching. Tests: `hub-upload-limits`, `hub-server`,
  browser `uploads`, native `ShareInboxStoreChecks`.
- `src/hub/attachment-response.ts`, `client/src/downloads.ts`, `HubConnection.blob`
  Authenticated single-range downloads with immutable validators, complete-file
  SHA-256 checks, cancellation and reconnect/failover recovery. Pairing-scoped
  `client/src/download-checkpoints.ts` journals complete ranges across reloads,
  with storage generation fencing, bounded retention and no partial export. File
  cards show progress; image/audio loads share pending requests across rerenders.
  Tests: `hub-download`, existing `hub-request-revocation` / `hub-server`; browser
  `download-validation`, `download-checkpoints`, `downloads`, local reset,
  multiple hosts, attachment composition and offline cache.
  `client/src/download-buffer.ts` spills explicit file-card downloads above 16 MiB
  into private origin storage when supported. `HubConnection.file` returns owned
  leases, so a preview close does not delete a concurrent save's bytes. Cross-tab
  Web Locks protect active scratch files and worker reads. `main.tsx` also sweeps
  abandoned scratch on unpaired startup and reset recovery, without deleting a
  different window's active bytes. File-card disk paths
  use a 256 MiB aggregate resume budget, trimming older larger prefixes without
  refreshing expiry. `browser-download.ts` negotiates a one-use Service Worker
  response from `service-worker-downloads.js`; verified bytes stream in 1 MiB
  slices, then scratch is removed. Older/absent workers select RAM before assembly.
  Reserved expired worker URLs return 204 from the Hub instead of SPA HTML.
  Scratch write failures clean up and preserve a valid checkpoint, without an
  in-memory retry. Small files/unsupported WebViews and automatic image/audio
  loads retain their compatibility path. Browser `download-buffer` exercises real
  persistent Chromium/WebKit storage, cleanup, leases, fallback and stream retry.
  `browser-download` saves 512 MiB twice after a separate 256 MiB journal,
  verifies both hashes and empty scratch directories, and tests client isolation,
  duplicate prepare, replay rejection, Unicode filenames and unpaired cleanup.
  Scope and acceptance: [download recovery](client/resumable-downloads.md).
  Native HTTP EOF/reset failures are normalized by `transport.ts` for bounded
  range recovery. `use-attachment.ts` offers manual failed-image retry; thumbnail
  and full-screen reader states never display raw endpoint errors. Tests:
  `native-transport`, `download-validation`, `image-recovery` (both engines).
  [Image recovery and verification](client/image-download-recovery-2026-10-17.md).
- Excel attachment reading: `SpreadsheetPreview.tsx`, `spreadsheet.worker.ts`
  and `spreadsheet-data.ts` provide bounded local XLSX/XLSM/XLS reading with sheet
  tabs and paged tables. Native `AttachmentOpenerPlugin` and its dedicated
  FileProvider hand a read-only cached copy to an Android reader; iOS uses its
  document share sheet. Shared preview/export also covers draft attachments.
  Tests: `client-spreadsheet`, `client-docx-archive`; browser `spreadsheet-preview`,
  `mobile-file-export`, `desktop-export`, `document-preview`; Android
  `AttachmentOpenPolicyTest` / `AttachmentOpenTest`.
  [Limits and acceptance](client/spreadsheet-preview-2026-10-12.md).
- Lightweight Word/Markdown attachment reading: `DocumentReader.tsx`,
  `DocxPreview.tsx`, `docx.worker.ts`, `docx-archive.ts`, `document-html.ts` and
  `document-preview.css`; document conversion is lazy, local and resource bounded.
  `safe-area.css` makes sent and draft file previews fill the safe viewport on
  phones and rotated touch screens, with a fixed header and separate reader
  scrolling. It consumes system insets once, honors Android native padding and
  follows the keyboard viewport. Long filenames occupy at most two header lines.
  Tests: `client-docx-archive`; browser `document-preview`, `pdf-preview`,
  `file-actions`, `file-preview-fullscreen`, `safe-area`.
  [Size and native acceptance](client/document-preview-2026-10-11.md).
- `client/src/attachment-export.ts`
  Desktop selected-file export advances by confirmed native write counts;
  invalid/no-progress results fail and every opened handle is closed. Native
  string errors become actionable save errors. Filename truncation preserves
  Unicode characters and stays below common UTF-8 filename limits. Browser
  download and mobile cache/share exports retain their own platform boundaries.
  Optional stage/delivery callbacks distinguish choosing, writing, preparing and
  sharing from a confirmed save or platform handoff. Share cancellation is neutral;
  retained cache copies older than 24h are swept on the next export, not by a timer.
  `Content.tsx` renders one file phase in the active card or modal HTML preview,
  with retry, download-only cancellation, focus containment and phone touch targets.
  Attachment cards label their in-app reader action Preview, including accessible
  names, to distinguish it from opening a saved file in the system default app.
  Confirmed desktop saves retain the user-selected path in the current file card
  and offer Open file and Show in folder in the preview and chat.
  Desktop saved-file actions align beneath the preview/save action area;
  see [alignment and layout verification](client/saved-file-action-alignment-2026-10-27.md).
  `src-tauri/src/saved_file.rs` checks the native save-dialog filesystem grant
  before opening a regular file with the default app or selecting it in
  Finder/Explorer. Both actions serialize, retain the save receipt on failure,
  and clear stale paths before another save. No parent-directory grant or shell
  command is used. Browser/iOS handoffs have no asserted saved path; Android's
  confirmed public-save URI is checked separately by its native receipt registry.
  `saved_file_quarantine.rs` applies macOS quarantine to the granted file before
  writing attachment bytes. Tests inspect OS metadata without opening/executing
  files; Windows Mark-of-the-Web is not implemented by this helper.
  Tests: `file-actions`, `desktop-export`, `attachment-safety`, `download-validation`, `downloads`.
  IPC fault injection is not native save-dialog or physical-device acceptance.
- `client/src/PdfReader.tsx`, `PdfPreview.tsx`, `pdf-preview.css`
  Lazy local PDF canvas/text-layer reader inside the file preview modal. PDF
  actions and scripting are not instantiated. `client/pdf-assets.ts` bundles
  matching parser support files; Hub static delivery recognizes `.mjs` and
  `.wasm` without relaxing the script CSP. The modal dismisses a backdrop click
  only when that pointer also started outside the reading panel, preserving
  text selection dragged outside. Tests: `hub-static-assets`; browser
  `pdf-preview`, `file-actions`, `startup` on Chromium and WebKit. Browser
  acceptance does not certify an older or physical native WebView.
- `client/src/ForwardMessage.tsx`, `client/src/MessageReference.tsx`
  Message quoting/navigation and forwarding target selection. Durable forwarding
  lives in `src/hub/store.ts`, `src/hub/attachments.ts` and the shared protocol;
  Gateway input preserves nested attachments and treats forwards as reference text.
  The composer renderer shows explicit user quotes and forwarding provenance;
  ordinary Bot `replyTo` associations remain internal, without a redundant quote
  above every answer. Keep those associations for retry and delivery bookkeeping.
  Sent user replies render their `MessageReference` inside `MessageContent`'s
  single bubble (`quoted-reply.css`), with a compact expandable preview. Only
  presentation changes: one message ID, original text blocks and `replyTo` stay
  unchanged; forwarded provenance remains separate. No host/CLI change is needed.
  Browser `quoted-reply` covers actual sends, nesting, narrow screens, theme
  contrast, expansion, origin navigation and deleted sources. See
  [quoted reply presentation](client/quoted-reply-2026-10-14.md).
  `RichMessagePreview.tsx` / `message-preview.ts` render bounded, read-only
  Markdown thumbnails for sent quotes, composer quotes and the forward picker.
  Tables, lists and code keep their formatting; attachment chips and authorized
  image thumbnails stay separate from clipped prose. Expansion never runs card
  actions or opens external links. Full forward payloads and attachment access
  are unchanged. `MarkdownText` shares its worker parser with this read-only mode;
  `use-attachment.ts` owns the shared authenticated image URL lifecycle.
  Tests: `client-message-preview`, `hub-forwarding`, `hub-server`, `gateway-service`,
  browser `message-actions` (desktop/mobile rich previews and forwarding).
- `src/client-protocol/search.ts`, `HubStore.search` / `searchPage`,
  `client/src/history-search.ts` and search in `client/src/App.tsx`
  Literal history search, membership/conversation/Bot/date/attachment filters, bounded input
  and independent readonly WAL connections. Paged search uses 50 bounded excerpts
  and timestamp/ID cursors bound to the applied query, conversation scope and user.
  Desktop chat headers expose current-conversation search and Cmd+F/Ctrl+F;
  sidebar and phone inbox search remain host-wide. Pending search UI
  is cancellable; older pages cannot replace a newer query. Tests: `hub-search`,
  `hub-server`, browser `search`/`hub`/`native-back`/`local-reset`; synthetic benchmark:
  `scripts/benchmark-hub-search.mjs`. See `docs/client/history-search.md`.
- `client/src/GroupTopics.tsx`, `client/src/ConversationList.tsx`
  Group/topic hierarchy, topic directory/search and archived-history navigation.
  `TopicActions.tsx` exposes rename and recoverable deletion from each directory
  row; `App.tsx` offers the same actions in the current topic's phone/desktop
  menu. Shared `RenameConversation`/`RemoveConversation` await durable cache
  updates. Removal targets the clicked topic ID, returns to the parent only when
  removing the selected topic, and preserves sibling chats, drafts and bindings.
  Existing Hub conversation IDs remain the session/message boundary. Browser
  checks: `topic-actions`, `topics`, `conversation-rename`,
  `conversation-context-actions`, `native-back`, `creation`, `cross-device`.
  [Acceptance and package boundaries](client/topic-actions-2026-10-12.md).

## Shared command and delivery paths

- `src/gateway/commands.ts` and `src/core/commands.ts`: App command dispatch.
- `src/core/shared/session-commands.ts`: `/reset`, `/resume`, `/detach`.
- `src/core/shared/engine-commands.ts`: `/compact`, `/context`, `/ultrareview`.
- `src/core/shared/delegation-commands.ts`: `/btw`, `/ask`, `/fan`, `/chain`,
  `/verify`; `src/bus/delegation-plan.ts` resolves explicit members. Completed
  stages survive later failure, and partial failures retain an error outcome.
- `src/core/shared/board-commands.ts`, `mini-bus-commands.ts`: board/mini workflows.
- `src/core/message-handler.ts`, `src/core/runtime.ts`: queues, run ownership,
  steering, cancellation and terminal bookkeeping.
- `src/core/card-actions.ts`, `card-renderer.ts`: authenticated card actions,
  approvals and shared run-card state.
- `src/core/delivery.ts`, `delivery-recovery.ts`: final-response delivery and
  recovery with injected channel ports.
- `src/core/shared/artifact-delivery.ts`: bounded legacy-tag fallback and
  injected attachment delivery; file authorization and receipt behavior remain.
- `src/tools/tool-registry.ts`, `tool-executor.ts`: registered tool definitions,
  schemas, execution and audit receipts.
- `src/tools/send-file-tool.ts`: structured `send.file`, `send.image`,
  `send.batch` dispatch through the shared artifact-delivery port.
- `src/tools/cron-add-tool.ts`, `cron-management-tools.ts`: validated current-chat
  cron add/list/remove/toggle/run, sharing CronStore and the scheduler.
- `src/core/shared/cron-tags.ts`, `tool-tags.ts`: compatibility directives and
  registered tool-call blocks; they are not network transport entry points.
- `src/core/shared/turn-bookkeeping.ts`: shared audit, budget and usage handling.

The old Telegram polling/webhook and Lark WebSocket/fleet entrypoints are
retired; see [scope and regression mapping](adapter-retirement-2026-10-21.md).

## Shared Runtime Helpers

- `src/runtime/bridge.ts`
  Shared engine turn orchestration, stable runtime-instruction merging, session resolution, approvals, and provider result handling.
  Conversations sharing a native session expose input capability, steering and
  input control only to the turn owning that session in this process. Confirmed
  native aliases retain ownership during a provisional first turn; another
  conversation waits for release without cancelling the owner. Tests:
  `bridge-shared-session`, `bridge-turn`, `gateway-native-input`.

  Stream output is forwarded without awaiting recovery observers first, so
  standalone whitespace and tool receipts cannot overtake preceding text.
  See [fragment ordering regression](client/stream-fragment-order-2026-10-23.md).
- `src/runtime/engine-recovery.ts`, `src/codex/turn-retry.ts`
  Bounded transient-failure recovery using adapter-confirmed native terminal/admission
  receipts. Bridge retains session ownership and releases worker capacity during
  backoff; the production factory records failed usage and rechecks budget before
  each continuation. `engine_retry` events use the existing run summary/journal
  protocol on desktop/mobile. CLI shares the same execution path; wait timeouts
  do not cancel it. See [recovery boundaries and verification](client/transient-engine-recovery-2026-10-22.md).
  When continuation is withheld, preserve the adapter's known provider category
  in localized errors and distinguish unfinished work from receipt conflicts in
  timeline diagnostics. See [failure-cause repair](client/recovery-failure-cause-2026-10-28.md);
  regressions: `engine-recovery`, `bridge-retry`, Core/Gateway recovery suites.
  Codex yielded commands can be reconciled through exact native item reads
  before continuation. The original runtime deadline and session lock remain;
  unknown tools/child work still block replay. See [pending-command recovery](client/engine-recovery-pending-tools-2026-10-30.md).
  Additional regressions: `codex-retry-tools`, `app-server-adapter-retry`.
- `src/codex/turn-instructions.ts`
  Renders request-scoped private guidance into the current prompt without changing persistent worker settings or fingerprints.
- `src/runtime/bridge-turn.ts`
  Shared usage recording and budget threshold logic.
- `src/codex/claude-session-usage.ts`
  Converts Claude's native session-cumulative cost to per-result deltas. A hashed
  session/workspace baseline is saved before publishing a cost, with a file mutex,
  high-water marks and bounded duplicate IDs. Unknown or failed writes stay
  unmetered; existing usage history is not migrated. Tests: `claude-session-usage`.
- `src/runtime/turn-lock.ts`
  Per-session exclusion for user turns and cron turns.
- `src/runtime/turn-pool.ts`
  Active turn accounting used by shutdown/restart safety.
- `src/runtime/cron-scheduler.ts`
  Scheduler ownership, failure accounting, disable policy, and cron dispatch.
  Refreshes reject stale snapshots; execution bookkeeping and automatic disable
  are revision-scoped. `tests/cron-concurrency.test.ts` covers rescheduling during
  execution and excludes overlapping work until bookkeeping finishes.
- `src/runtime/error-classification.ts`
  Stable operator-facing error categories and retry guidance.
- `src/runtime/audit-events.ts`
  Shared best-effort audit append helper.
- `src/runtime/timeline-events.ts`
  Shared best-effort timeline append helper.
- `src/bus/bus-handler.ts`
  Shared bus execution path; do not duplicate usage/budget/audit logic in `index.ts`.
  `bus-server.ts` supplies a per-request abort signal when an unfinished response
  loses its connection. Gateway forwards it to the shared Bridge; normal response
  close and other concurrent calls are unaffected. Cancellation is non-retryable,
  with interrupted timeline status and retained already-reported usage. Tests:
  `bus`, `bus-handler`, `gateway-bus`; opt-in browser `live-bus` exercises configured
  real workers from a paired desktop/phone group.

## State And Config

- `src/state/board-service.ts`
  Shared Board application boundary and typed domain errors used by channel handlers; Phase 2 also exposes board selection/settings, events, comments, attachments, claims, dispatch, review, import/export, repair, and GC to future surfaces.
- `src/state/sqlite-kanban-repository.ts`
  Instance-local SQLite schema, transactional state persistence, legacy `board.json`
  migration, fail-closed sentinel, permissions, and diagnostics.
- `src/state/board-store.ts`
  Board domain behavior and compatibility facade behind `BoardService`; owns lifecycle transitions, CAS/idempotency, event append, lease recovery, dispatch policy, redaction, and attachment validation.
- `src/state/instance-config.ts`
  Telegram-side `config.json` read/write and normalization.
- `client/src/App.tsx`, `client/src/MobileHome.tsx`, `client/src/HostApp.tsx`,
  `client/src/BotSettings.tsx`, `client/src/RenameConversation.tsx`
  Phone chat-menu rename and Bot settings; Bot-list/search settings also work
  without an existing chat. Cross-host actions keep the target host identity,
  group settings explicitly choose a Bot, and metadata renames retain drafts
  and bindings. Browser regression: `mobile-settings`, `mobile-im`,
  `bot-context-menu`, `conversation-rename`, `conversation-settings`.
  See [mobile settings](client/mobile-settings-2026-10-12.md).
- `src/runtime/effort-settings.ts`, `src/client-protocol/effort.ts`, `client/src/EffortControl.tsx`
  Chat-header Bot-wide effort picker; engine/model options reuse the shared
  validator. Owner-only Hub/Gateway calls, config mutex and revision conflicts,
  live Bot metadata sync, no chat messages or session resets. Tests:
  `effort-settings`, native adapter config regressions; browser `effort`.
  Scope, defaults and application timing: [Chat effort](client/effort-settings.md).
  Antigravity 1.2.16 xhigh uses the shared config/adapter level list; mobile
  cross-device and process-boundary evidence:
  [effort follow-up](client/antigravity-effort-2026-10-04.md).
- Existing Bot model selection: `client/src/ModelControl.tsx` opens from
  `BotSettings.tsx` and desktop `ComposerModelControls.tsx` (model and effort
  shortcuts beside Send in ordinary chats, hidden in ADHD panes); `client-protocol/model.ts` / `runtime/model-settings.ts`
  implement owner-only `GET/PUT /api/bots/:id/model` via Gateway. Model and effort
  share the config mutex, revision and Hub operation queue, update live metadata,
  and leave sessions/active turns intact. `runtime/model-catalog.ts` shares
  creation choices and per-engine compatibility, including host-discovered AGY.
  `tarobot bots model ID [--model M --revision REV --effort E]` uses the same API.
  CLI discovery has one four-second deadline across initialization and all
  catalog pages, leaving time for settings reads/writes within the Hub's
  ten-second Bot RPC. Model and effort entry points use the same discovered
  effort restrictions, including cold-cache writes and models without effort.
  Regressions: `model-settings`, `model-discovery-settings`, `host-cli-model`, `effort-settings`,
  `hub-bot-manager`; browser `model-settings`, `effort`, `settings-lifecycle`.
  [Behavior and verification](client/model-settings-2026-10-16.md).
  [Desktop composer shortcuts](client/desktop-composer-model-controls-2026-10-22.md)
  now use anchored one-click menus in `ComposerModelControls.tsx`, with the same
  model API and host-advertised effort choices. Full dialogs remain in Bot settings.
  Groups require one explicit reply target. Browser regression: `composer-model-controls`
  and ADHD composer layout. [Quick selection and acceptance](client/composer-quick-model-2026-10-23.md).
  [Model families and effort](client/model-effort-selection-2026-10-19.md)
  covers shared `client/src/model-selection.ts`, grouped host-advertised AGY
  variants, exact-ID submission and family-specific levels in creation/settings.
  Additional regression: `client-model-selection` and browser `creation`.
  [Codex 6.1 presets](client/codex61-models-2026-10-20.md) documents the shared
  exact-ID catalog and model-specific extended effort used across App and CLI.
- Claude per-Bot Chrome integration: `client/src/ClaudeChromeControl.tsx` in
  Bot settings, `client-protocol/chrome.ts` and `runtime/chrome-settings.ts`,
  owner-only `GET/PUT /api/bots/:id/chrome` via Gateway. `tarobot bots chrome ID
  [--enabled on|off --revision REV]` uses the same API. Atomic config updates
  retain sessions; both Claude adapters reload the flag, explicitly launch
  `--chrome`/`--no-chrome`, and restart persistent workers only between turns.
  Pending background work blocks a new turn when the Chrome policy changed.
  Tests: `chrome-settings`, `host-cli-chrome`, `claude-stream-adapter`,
  `claude-adapter`; browser `chrome-settings`, `settings-lifecycle`.
  [Design and native verification](client/claude-chrome-2026-10-17.md).
- `src/state/session-store.ts`
  Bound chat-to-session records.
- `src/state/file-workflow-store.ts`
  Archive / attachment workflow state.
- `src/state/usage-store.ts`
  Usage accumulation, validation, corruption quarantine, and last-good recovery.
  Settled per-path write tails are released without dropping a newer queued write;
  daily/monthly history is preserved. Tests: `usage-store`, `cron-native-crash`.
- `src/state/runtime-state.ts`
  Poll/update watermarks and runtime recovery state.
- `src/state/cron-store.ts`
  Durable cron task records and cross-process writes.
- `src/state/instance-lock.ts`
  Single-owner process lock and stale-lock recovery (`recoveredStale` = crash signal).
- `src/state/delivery-obligation-store.ts`
  Durable delivery-obligation ledger for final replies (pending → attempting → delivered/failed; boot-time sweep).
- `src/runtime/restart-loop-guard.ts`
  Unclean-boot circuit breaker that skips boot recovery during a crash/respawn loop.
- `src/state/file-mutex.ts`
  Cross-process mutex used by durable state stores. Local filesystems only;
  process birth is rechecked during waits, unknown owners are never age-stolen.
- `src/state/process-epoch.ts`
  Advisory boot/process identity and stable Windows machine identity. No shared
  state across cloned hosts or separate container PID namespaces. Tests:
  `process-epoch`, `file-mutex`, `file-mutex-release`, `instance-lock-admission`.
- `src/state/audit-log.ts`
  Audit event persistence.
- `src/state/timeline-log.ts`
  Structured turn/event persistence.

See `docs/state-model.md` before changing on-disk semantics.

## Engine / Provider Layer

Claude input/task parity: `client-protocol/engine-tasks.ts`,
`gateway/engine-tasks.ts`, existing conversation steering, Hub task routes and
`host-cli/tasks.ts` / `host-cli/steering.ts` share bound native tasks and at-most-once stop receipts.
`client/src/EngineTasks.tsx` owns the visible-pane task list; `steering-request.ts`
retains uncertain input IDs.
The task dialog uses one constrained `.engine-tasks-body` scrollport for the
list, notices and recovery controls, with its title and bulk-action footer
outside. An unconstrained nested list must not trap touch overscroll.
Browser `engine-tasks-scroll` checks phone/landscape/desktop scrolling and
accessible last-row controls; see [scroll repair](client/engine-task-dialog-scroll-2026-10-24.md).
App menu and `/tasks` open requests are consumed once on display so returning
from another conversation or history search cannot reopen a closed task dialog.
Browser `task-list-navigation` covers the phone/desktop navigation boundary.
`steering-outcome.ts` and the negotiated
`steer.outcome` durable RPC update original receipts; `gateway-scoped-transport`
covers rollback-safe journal retirement. Explicit `tasks recover --token --yes`
is limited to one unconfirmed native stop fence and has an App confirmation.
`canStartQueuedTurn` checks that fence before `queue.take`, retaining editable Hub
prompts until native confirmation/recovery. `gateway-queue-fence` covers blocked
edit/reorder/cancel and resume; native wait covers a fence opening after claim. Runtime opt-in controls ordinary in-flight text;
other engines retain explicit steering/queued sends. Scoped cards preserve a
display-only task label and short public results. See
[behavior and validation](client/claude-interaction-parity-2026-10-23.md).
Regressions: `gateway-engine-tasks`, `host-cli-tasks`, `client-steering-request`,
Claude native controls, steering, scoped presentation and browser
`engine-tasks` / `claude-interaction` / existing stop, steering and scoped readers.
Opt-in real-model checks: `live-stop` and `live-claude-interaction`.

Claude scoped process journals use `client-protocol/run.ts` for bounded scope
metadata and `runs.scopes.v1`, `gateway/channel.ts` for independent primary and
scoped writers, and `hub/run-journal.ts` for opt-in merged reads. The additive
`run_journal_scoped` table keeps strict v1 payloads and scope metadata separate;
schema 15 and the original journal remain readable by older Hubs. The shared
headless host uses the same RPC, storage, recovery and authorization paths.
`RunPresentation.tsx` labels scopes in event order, keeps background reports
read-only, and refreshes terminal details for at most 10 seconds, again on the
journal completion acknowledgement, or on manual refresh. Tests: `run-scopes`, `gateway-run-recovery`, `gateway-run-writer`,
`hub-server`, `hub-state-backup`, and browser `run-scopes`, `run-details-refresh`.
[Contract and compatibility matrix](client/claude-scoped-process-2026-10-15.md).

The [2026-10-14 conversation isolation audit](client/context-isolation-audit-2026-10-14.md)
tracks recovered Claude task notifications, parent/child event fences, explicit
background-result ownership, one-shot foreground filtering and Kimi ACP
session/approval/question checks. Regressions: `claude-stream-adapter`,
`claude-adapter`, `claude-app-mcp`, `kimi-acp-adapter`, plus all five adapter,
session, Gateway, Bus and scoped App-tool suites listed in the audit.

- `src/runtime/bridge.ts`
  High-level bridge behavior and access control. Persists engine-confirmed session
  bindings even when the native ID equals the provisional ID; one-off overrides
  remain unbound. Tests: `bridge`, `session-manager`.
- `src/codex/process-adapter.ts`
  Codex one-shot process adapter.
- `src/codex/app-server-adapter.ts`
  Codex streaming/app-server adapter and the default Codex runtime.
- `src/codex/codex-user-input.ts`, `src/codex/codex-mcp-elicitation.ts`
  Validate native Codex questions and standard MCP forms, preserve native IDs and
  typed answer values, and require explicit confirmation for empty MCP forms.
  The app-server adapter owns request/turn/child cancellation; shared
  `core/card-actions.ts` renders the questions for Gateway and retained compatibility profiles.
  Tests: `codex-user-input`, `codex-mcp-elicitation`, `app-server-adapter`,
  `core-service-compat`; opt-in browser `live-codex-input` uses real native requests.
- `src/codex/codex-permissions.ts`
  Validates native extra filesystem/network profiles without dropping constraints;
  approved responses use an immutable copy of exactly the displayed profile.
  The app-server adapter owns scope, cancellation and correlated decision results.
  Shared approval details are fenced literal JSON. Tests: `codex-permissions`,
  `app-server-adapter`, `core-approval-scopes`; opt-in browser
  `live-codex-permissions` checks real native allow/deny/stop from a paired phone.
- `src/codex/claude-adapter.ts`
  Claude CLI adapter.
- `src/codex/adapter.ts`, `src/core/card-renderer.ts`
  Native approval events preserve optional tool call identity; the shared run
  renderer correlates approval/start/result without duplicate pending rows.
  Claude, Codex app-server, Kimi and Harness provide their native IDs. Tests:
  `core-card-renderer` and the four adapter suites; opt-in browser `live-tools`
  exercises real Claude/Kimi and a temporary local MCP endpoint through paired clients.
- `src/core/approval-scopes.ts`, `src/core/card-actions.ts`
  Present native approval lifetimes declared by adapters, hide unavailable
  choices and reject forged or textual requests for an unsupported scope.
  Kimi one-time consent cannot select ACP's persistent option. Tests:
  `core-approval-scopes`, native adapter suites; browser `cross-device` covers
  session/whole-turn/persistent cards and the synchronized decision receipt.
- `src/codex/claude-stream-adapter.ts`
  Claude streaming adapter, including CLI partial-message subscription, incremental
  text/thinking, completion deduplication and partial control-frame suppression.
  Foreground, subagent and task-notification routing remain separate.
  Monitor `<event>` envelopes without terminal status are progress: silent
  expiry reviews do not create chat replies or complete tasks. See the Monitor
  follow-up in `client/context-isolation-audit-2026-10-14.md`.
  Tests: `claude-stream-adapter`, `core-card-renderer`.
- `src/codex/kimi-acp-adapter.ts`
  Persistent Kimi ACP worker, session configuration/loading, streaming event mapping,
  approvals/questions, cancellation, compact support, and background-task lifecycle mapping.
- `src/codex/kimi-models.ts`
  Bounded, allowlisted discovery of native Kimi model IDs, names, effort choices
  and model-specific defaults from `KIMI_CODE_HOME/config.toml`. Shared by the
  App/CLI model catalog and ACP adapter; no provider secrets reach clients.
  New Bots follow native effort defaults; existing explicit overrides remain.
  See [Kimi model settings](client/kimi-model-defaults-2026-10-24.md).
  Tests: `kimi-models`, `kimi-acp-adapter`, `model-settings`, `effort-settings`,
  `instance-config`, `hub-bot-manager`, `host-cli-model`, `client-model-selection`,
  and the Kimi case in `client/e2e/model-settings.spec.ts`.
- `src/codex/kimi-hook-relay.ts`
  Kimi 0.32+ observer-hook plugin registration and authenticated loopback relay. It accepts
  task lifecycle plus `TurnStarted`/`Stop`/`StopFailure`/`Interrupt` events so Kimi 0.33
  task-origin review turns can be retained; `SessionHeartbeat` is deliberately ignored.
- `src/codex/kimi-workspace.ts`
  Atomic managed-block synchronization for Kimi workspace instructions.
- `src/codex/deepseek-parent-guard.ts`
  Child-only Node preload tying the private DSH Host lifetime to its bridge;
  real parent SIGKILL and SIGTERM-ignoring child tests in `deepseek-parent-guard`.
- `src/codex/deepseek-assistant-stream.ts`
  Validated Harness 0.2 process-local assistant frames/reconnect prefixes.
  Separate from durable journal cursors; adapter reconciles authoritative final
  text and preserves foreground/Goal claims. Tests: `deepseek-assistant-stream`,
  `deepseek-harness-protocol`, `deepseek-harness-adapter`.
- `src/codex/deepseek-harness-protocol.ts`
  Official Harness HTTP RPC and authenticated Remote-mux client, session
  follow/control compatibility mapping, schema validation, handler-error
  containment, reconnect generations, and request timeouts.
- `src/codex/deepseek-harness-host.ts`
  Private per-instance `dsh web` lifecycle, isolated `DSH_HOME`, permissions,
  crash diagnostics, backoff, and safe process shutdown.
- `src/codex/deepseek-harness-adapter.ts`
  DeepSeek session/stream/tool mapping, approvals/questions, compact/context,
  steering, native Goals, background jobs, and ordered reconnect recovery.
  The specific malformed provider tool-argument diagnostic is classified as
  `engine-tool-input`, preserving audit identity and requiring result review
  instead of restart or automatic replay. See [incident and regression evidence](client/deepseek-tool-input-error-2026-11-03.md).

If a bug smells like auth, stale session, engine CLI output shape, or provider-specific formatting, inspect these modules before patching Telegram code.

## Modification Rules

- Prefer changing the narrowest module that owns the behavior.
- Do not add new command logic back into `delivery.ts`.
- Do not duplicate usage, budget, or audit logic across shared command modules and Bus handlers.
- When changing file delivery, keep all engine response formats and shared channel delivery paths working.
- When changing state semantics, update `docs/state-model.md` if the authoritative behavior changes.
- When changing trust boundaries or file access behavior, update `docs/security-boundaries.md` if the effective boundary changes.

## Test Map

Run focused tests before wider validation:

- App ingress and lifecycle: `tests/gateway-service.test.ts`,
  `tests/gateway-command-parity.test.ts`, `tests/gateway-recovery.test.ts`.
- Shared service behavior: `tests/core-service-compat.test.ts` and the `core-*`
  card, delivery, approval, recovery and cron suites. These use explicit fake
  ports and retain historical schema fixtures without a transport SDK.
- Commands: `tests/shared-session-commands.test.ts`,
  `shared-engine-commands.test.ts`, `shared-delegation-commands.test.ts`,
  `shared-board-commands.test.ts`, `shared-mini-bus-commands.test.ts`.
- Attachments: `tests/artifact-delivery.test.ts`, `tests/send-file-tool.test.ts`,
  `tests/gateway-file-policy.test.ts`, `tests/gateway-delivery-recovery.test.ts`.
- Engine/usage/state: `tests/bridge.test.ts`, `tests/kimi-acp-adapter.test.ts`,
  `tests/kimi-hook-relay.test.ts`, `tests/deepseek-harness-adapter.test.ts`,
  `tests/cron-scheduler.test.ts`, `tests/instance-lock.test.ts`,
  `tests/runtime-state.test.ts`, `tests/usage-store.test.ts`.
- Collaboration: `tests/bus-handler.test.ts`, `tests/bus.test.ts`,
  `tests/gateway-bus.test.ts` and `tests/host-cli-bot-messages.test.ts`.
- Import/runtime boundaries: `tests/transport-retirement.test.ts`,
  `tests/no-feishu-guard.test.ts`; `npm run build` enforces the source graph.

All retained tests run in the normal `npm test` suite. There is no legacy-suite
mode and no optional SDK installation prerequisite. Then run `npm run build`
and the client build. Before a broad refactor or release-like merge, also read
`docs/change-rules.md` and `docs/release-checklist.md`.

## Inline interactive widgets

`client-protocol/widget.ts` owns the versioned card envelope and readable fallback.
`client-protocol/report.ts` validates fixed report data; `runtime/widget.ts` validates bounded HTML and parses scripts without executing
model code. `client/src/Report.tsx` renders typed reports without guest execution. `gateway/app-widget.ts`, `app-tools.ts` and `channel.ts` publish native
receipts; `core/delivery.ts` handles `send.widget` for compatibility engines.
`gateway/widget-guidance.ts` and `agent-instructions.ts` own proactive selection,
authoring/theme rules and on-demand procedures. HTML is the default for new
visuals; structured report requires an explicit user request. Native tools v8
carry this advice; persisted v1-v7 contracts retain exact hashes and receive the
current policy through standing/on-demand guidance. Existing report messages,
validation and rendering remain unchanged. CLI help follows the same policy. See [HTML-default policy and compatibility
verification](client/widget-html-default-2026-10-31.md).
Frozen Codex tools remain stable;
Claude and DeepSeek expose the new native tool. `host-cli/widgets.ts` and the Hub's
conversation widget route share validation and transactional user publication.
`client/src/Widget.tsx`, `widget-document.ts`, `public/widget-sandbox.html` own the
isolated renderer; Tauri `widget_sandbox.rs` provides its fixed shell. iOS uses the
App-compiled `WidgetMessageGuard.swift` (including with prebuilt SwiftPM). Capacitor's
sync/copy hooks enforce native main-frame restrictions and legacy Android fallback.
See [contract and acceptance](client/inline-widgets-2026-10-22.md) and the
[joint audit and fixes](client/inline-widgets-audit-2026-10-22.md), plus the
[efficiency and stability audit](client/inline-widgets-performance-2026-10-22.md)
and [OpenClaw source comparison](client/inline-widgets-openclaw-reference-2026-10-22.md). Regressions:
`widgets`, `gateway-app-tools`, `gateway-service`, Claude/DeepSeek App tools,
`hub-server`, CLI entry/history, native/mobile policy; browser `inline-widget`,
`widget-performance`, `widget-cpu-isolation`, `inline-report`, opt-in `live-inline-widget`; Rust widget protocol and isolated `widget-audit`.
`widget-runtime/{worker,viewer}.js` separates virtual-DOM script execution from the trusted renderer;
`widget-quarantine.ts` prevents confirmed failed source from automatically rerunning.
See [data report and CPU containment contract](client/inline-widgets-cpu-containment-2026-10-22.md).
`client/src/chart-palette.css` owns four theme-specific series tokens shared by
fixed reports and `widgetTheme`. Original series order, matching legend/inspector
samples and continuous dashed paths preserve identity through local interaction.
See [theme chart colours and compatibility](client/chart-theme-colors-2026-10-26.md).
Regressions: `widgets`, `reports`, browser `inline-report-palette`, `inline-report`
and `inline-widget` in Chromium/WebKit. Hardcoded historical HTML is not recoloured.
Monochrome's optional accent highlights the main series beside three stable
neutral references; no accent and Graphite use grayscale. Data-scoped emphasis
covers the leading metric, selected report controls and timeline nodes. `widgetTheme`
maps those roles to existing guest tokens, and `Widget.tsx` observes accent-only
changes without restarting the guest. Other App surfaces/status colours stay
unchanged. Tests: `inline-report-palette`, `inline-widget`, `reports`, `widgets`.
See [Monochrome data accents](client/mono-chart-accent-2026-10-26.md).

`runtime/widget-policy.ts`, `hub/widget-settings.ts` and
`client-protocol/widget-settings.ts` own the host-wide generation switch.
`gateway/app-tools.ts` chooses frozen v3 for new disabled sessions and denies
stale v4/v5 calls without resetting history; Hub publication guards serialize with
settings changes. `client/src/WidgetSettings.tsx` under General and
`host-cli/widget-settings.ts` use the same owner API and verified read-back.
See [scope and measured prompt cost](client/widget-settings-2026-10-22.md).
Regressions: `widget-settings`, `widgets`, `gateway-app-tools`, `gateway-service`,
`app-server-adapter`, `host-cli-entry`; browser `widget-settings` in Chromium/WebKit.

`client/src/widget-compose.ts` binds user-activated widget handoff to the owning
conversation's ordinary composer; it appends a draft and never sends or steers.
The Worker/viewer/relay use a bounded request/result path. Custom controls and
fixed reports share the existing theme and publication entrypoints. See
[general interactive widgets](client/interactive-widgets-2026-10-25.md) and the
[second OpenClaw/mobile audit](client/interactive-widgets-mobile-parity-2026-10-25.md).
`widget-state-lifecycle.ts` and `use-widget-state-selection.ts` own bounded
terminal state acknowledgements before normal App/ADHD/workspace navigation;
permission loss still discards immediately. `widget-repair.ts` builds explicit
diagnostic drafts without sending. Regressions: `client-widget-state-lifecycle`,
`widgets`; browser `widget-state-lifecycle`, `widget-mobile-parity`, `widget-controls`
and `widget-cpu-isolation`, plus physical iPhone keyboard/gesture evidence.

## App platform contract and native tools

- `src/gateway/agent-instructions.ts`: independent short App rules and on-demand capability procedures. Core instructions and platform policy are explicitly injected for the App channel.
  Enabled Claude Chrome sessions refresh the browser guide before execution or
  delegation, including keyword-free follow-ups. Recovery distinguishes a
  running process from an open window and a verified browser connection;
  legacy sessions receive the same bounded procedure without native tools.
  Tests: `chrome-recovery-guidance`, `gateway-app-tools`, `search-routing`.
  See [Chrome recovery scope](client/claude-chrome-recovery-2026-11-12.md).
- `src/gateway/service.ts`: binds capability callbacks to the authenticated conversation and turn lifetime, adds task guidance, and reports native delivery receipts to the shared follow-up guard.
- `src/gateway/app-tools.ts`: native file/capability execution, permission-aware path and credential preflight, cancellation, tool registration records and durable send receipts. `core/file-send-policy.ts` defaults effective full access to external paths, honors explicit zero and rechecks saved permissions for single, batch and legacy delivery. Tests: `gateway-file-policy`, `gateway-app-tools`, `gateway-service`; [behavior and evidence](client/full-access-file-delivery-2026-10-16.md). `app-delivery.ts` checks delivered byte versions before suppressing legacy directives; per-user-turn publication receipts/cache span engine errors and repair attempts. Upload-before-publish errors are definite failures; publish ambiguity remains uncertain.
- `src/gateway/app-batch.ts`, `GatewayChannel.sendArtifactBatch`: native captioned mixed batches and one image gallery, complete preflight before uploads and one publication after all uploads. Per-member promises share receipts with single-file sends. `AppPlatformTools.forSession` selects exact known persisted tool versions; old two-tool threads retain their native contract and context. Tests: `gateway-app-tools`, `gateway-service`, `app-server-adapter`, opt-in `live-native-batch` (Chromium/WebKit). See [native batches](client/native-batch-delivery.md).
- `src/codex/app-server-adapter.ts`: App `dynamicTools` registration, scoped `item/tool/call` responses, and `additionalContext` application instructions. Older resumed sessions retain compatible delivery; no context reset to install tools.
- `src/codex/claude-app-mcp.ts`, `claude-stream-adapter.ts`: private SDK MCP over the existing Claude stdio worker; pre-prompt handshake, exact foreground native call grants, cancellation, once-only execution and bounded compatibility fallback. Upload acknowledgments refresh activity; a stalled host call still times out. Tests: `claude-app-mcp`, `claude-stream-adapter`, `gateway-service`; opt-in browser `live-claude-app-tools` verifies real batches and persistent restart on Chromium/WebKit. See [Claude native tools](client/claude-native-app-tools.md).
- `src/codex/deepseek-app-plugin.ts`, `deepseek-app-tools.ts`, `native-app-pipe.ts`: agent-scoped native tools over private inherited pipes, exact logged prompt/step/call identity, PTC ancestry and turn-bound grants. Native policy/context notices do not originate work. Private Host patch and pre-prompt fallback preserve sessions; cancellation and closed pipes revoke tools. Tests: `deepseek-app-tools`, `deepseek-harness-host`, `deepseek-harness-adapter`; opt-in `live-deepseek-app-tools` verifies single-file/restart/capability/two-file batch on Chromium/WebKit. See [DeepSeek native tools](client/deepseek-native-app-tools.md).
- `client/e2e/live-app-tools.spec.ts`: opt-in (`TAROCUB_LIVE_APP_TOOLS=1`) real Codex autonomous file/capability selection, production-worker restart with the same session, two-client exact downloads, durable native receipts and scoped session archive/read-back. No model turns in ordinary browser runs.
- `client/e2e/live-deepseek-media.spec.ts`: explicit `TAROCUB_LIVE_DEEPSEEK_MEDIA=1`
  acceptance of ten image codes and one PDF through the native DeepSeek App batch
  tool, one publication, durable receipt and exact paired-browser downloads.
  `deepseek-harness-adapter.ts` preserves all original attachment paths alongside
  inline image bytes, preventing filename guessing for edit/return workflows.
  Test: `deepseek-harness-adapter`; evidence and model-error limits:
  [DeepSeek media acceptance](client/deepseek-media-2026-10-04.md).
- `client/e2e/live-media-batch.spec.ts`: opt-in `TAROCUB_LIVE_MEDIA_BATCH=1`,
  with `TAROCUB_LIVE_MEDIA_ENGINE=claude|kimi|antigravity` (default Claude).
  Real eleven-file input hashes, image/PDF recognition, one titled gallery and
  paired-client cache/download bytes on Chromium/WebKit. Recognition failures
  remain failures while transport checks continue. Kimi uses a private home;
  Claude disables persistence; AGY history is retained. [Original Claude media
  acceptance](client/media-batch-acceptance.md) and [Kimi/AGY receipts and model
  error](client/compat-media-2026-10-04.md). This shared test does not distinguish
  Claude native from compatibility delivery; use the dedicated native test.
- `client/e2e/live-quoted-media.spec.ts`: opt-in `TAROCUB_LIVE_QUOTED_MEDIA=1`
  and optional `TAROCUB_LIVE_ENGINE`. Real five-engine reads of quoted and
  forwarded PNG/PDF copies across paired desktop/phone contexts, source
  deletion and orphan collection, target-scoped authorization, explicit Bot
  recipients and separate topic/direct sessions. `fixtures/quoted-media-observer.mjs`
  observes native input hashes without replacing protocol bytes or responses.
  Ordinary runs skip before CLI startup; scoped native fixture cleanup is required.
  Hub schema 11 retires recalled attachment IDs in `store.ts`, with protocol-aware
  legacy event migration in `database.ts` and backup support in `state-backup.ts`.
  `attachments.ts` excludes retired IDs from downloads and upload dedup/retries;
  existing references and forwarded copies survive. Gateway's recent-message
  cache has count/encoded-size limits and skips oversized entries. Regression:
  `hub-forwarding`, `hub-state-backup`, `hub-link-preview`, `gateway-service`.
- Behavior and rollout limits: [App platform prompt](client/app-platform-prompt.md). Focused regressions: `gateway-app-tools`, `gateway-service`, `gateway-workflows`, `gateway-environment`, `app-server-adapter`, `bridge`, existing Gateway voice/recovery and shared Core delivery suites. Run the full pre-complete hook after changes.
- Remaining Kimi/Antigravity native-extension investigation and exact-call
  authorization constraints: [extension gaps](client/native-tool-extension-gaps.md).


### 2026-10-04 phone settings and startup boundary

`client/src/Bootstrap.tsx` mounts HostApp and Pairing; `Pairing.tsx` owns the
connection setup screen. The chat Workspace is dynamically loaded from App.tsx
with explicit failure/retry feedback. Vite module preloading is disabled because
its failed WebKit preload blocked retry; offline shell files remain complete.
PreferencesPanel owns phone page depth for general, notification and device settings.
`ConnectionPanel.tsx` owns the independent Connection page above My network in
MobileHome and the desktop Workspace menu, with unsaved-edit, native Back and
focus-return guards. `connectionConfiguration` edits direct/relay addresses while
retaining compatible legacy QR metadata and certificate authorities; no deployment
choice or host migration is performed. RoutesEditor publishes dirty/busy guards
during layout commit. [Change and verification](client/connection-navigation-2026-10-17.md).
For a proven local desktop host, `LocalRelaySettings.tsx` edits the host's
advertised VPS routes through the existing signed network command, while
`local-relay-routes.ts` preserves shared direct routes and detects stale drafts.
Native health probes verify the pinned target without tokens; desktop loopback
routes remain protected. CLI parity is the existing `network routes` command.
[Local VPS entry and boundaries](client/local-vps-settings-2026-10-19.md).

Settings also expose a **Network & connections** category via `PreferencesPanel.tsx` /
`network-settings.css`. `network-navigation.ts` keeps settings drafts when entering
network management and guards actions that leave the page. Saved-host route settings
open at HostApp scope without switching the current workspace.
[Navigation redesign and acceptance](client/network-settings-2026-10-19.md).
Regressions: `local-relay-routes`, browser `local-relay`, `native-transport`,
`tailscale-pairing`, plus existing Hub/CLI network and remote-route suites.
Regressions: `client-route-form`, browser `settings`, `settings-language`,
`native-back`, `deployment`, `multi-vps`, `routes`, `pairing-route-repair`.
MobileHome settings entries
allow same-workspace focus recovery after rotation. See
[settings QA](client/settings-nav-qa-2026-10-04.md).
NotificationSettings also reports quiet-hour dirty/busy guards, observes the accepted
connection store, and preserves successful write receipts across refresh failures.
UnifiedPush provider changes report their accepted preferences through the same path.
Coverage: `settings-notifications`, `settings`, `settings-language`, `unifiedpush-native`.
See [notification settings QA](client/notification-settings-2026-10-05.md).

### 2026-10-05 keyboard viewport and creation focus

`NewConversation.tsx` and the input stage of `NewBot.tsx` opt phone creation
sheets into `conversation-creation.css`:
the title/close action stays outside the scrolling form, and focus scrolling
reserves space for the name label. Browser `keyboard` reproduces focus scrolling
for direct chats and groups, then checks selection and successful creation.

The 2026-11-04 New Bot refinement adds scoped `new-bot.css` groups, a compact
runtime-host caption, responsive model/effort fields and progressive dispatcher
help. Its footer stays in normal flow inside the existing mobile form scroller;
creation APIs, permissions and retry guards are unchanged. See
[New Bot form refinement](client/new-bot-form-2026-11-04.md) for verification
and the App-only/CLI-not-applicable boundary.

Conversation creation dialogs additionally opt into desktop header dragging in
`client/src/dialog-drag.ts` (2026-10-12). Bounds, pointer capture and resize cleanup
are local to the dialog; phone sheets do not drag. `CreationDialog` requires a
backdrop press as well as release before dismissing, so dragging out cannot close
it. Regression: browser `creation`, `native-back`, and `keyboard`; see
[dragging QA](client/dialog-drag-2026-10-12.md). The quoted-attachment keyboard
regression was subsequently fixed in `mobile-shell.css`: rich drafts use a
vertical composer stack even with short text. See the
[product audit](client/product-audit-2026-10-12.md).

Phone composer spacing (2026-10-14): `mobile-shell.css` removes the extra inner
padding around the input row and paints the normal attachment circle at 36px
inside its unchanged 44px touch target; `App.tsx` uses a smaller 20px plus glyph.
`expressive-themes.css` retains the CLI treatment with tighter phone
padding. Draft-driven expansion, voice and Send/Stop slots remain unchanged.
Verified in Chromium/WebKit: `composer-busy` (320/390/1360px), the phone attachment
picker journey in `attachment-composer`, and the small-mic shortcut in `hold-to-talk`.

The theme picker uses the supported `colorPalettes` catalog from `palettes.ts`.
White Teal, Sand, Plum, Pixel, TTY, Paper and Agent themes were removed on
2026-10-28, including their styles, previews, chart tokens and hidden-theme
fixture path. Both global and legacy preference readers, plus the synchronous
startup mirror, fall back to Monochrome without resetting other choices.
The remaining CLI theme stays dark-only. See [theme retirement and verification](client/theme-retirement-2026-10-28.md).
Regressions: `retired-palettes`, `palettes`, `cli-typography`, `theme-font-size`.
App presentation only; no headless CLI command, Host API or protocol change.

Monochrome's optional accent also colours otherwise-black solid controls in
light mode, using local primary-control tokens rather than changing the global
accent or chat surfaces. Dark-mode pale controls and disabled/off states retain
their original colours. Existing `porcelain-details` journeys cover appearance
persistence, scope, contrast and system mode. See [accent controls](client/mono-accent-controls-2026-10-26.md).
Warm Gray is the default accent from 2026-11-04; valid saved choices, including
an explicit opt-out, remain authoritative in startup and hydrated settings.
See [default accent verification](client/default-warm-accent-2026-11-04.md).
The online chat-header Wi-Fi icon also follows the chosen Monochrome accent in
light/dark modes; offline/reconnecting indicators retain their state colours.

`client/src/MobileViewport.tsx` installs `viewport.ts` outside pairing and the
mobile lock. The controller coalesces window/visual-viewport/native keyboard
events, preserves pinch zoom, and cleans up late native listener registrations.
`viewport.css` bounds the phone shell, composer, pairing and dialogs to the
visible area. `safe-area-tokens.css` retains browser/iOS inset fallback values;
`safe-area.css` reserves them for chat headers, rotated layouts and overlays.
iOS `contentInset: "never"` leaves safe-area ownership with these CSS surfaces;
UIKit must not add another automatic WKWebView scroll inset. See the
[iOS inset follow-up](client/mobile-safe-area-2026-10-12.md#ios-container-inset-follow-up-2026-10-23).
Android `MainActivity` installs `NativeInsets.java`: native window padding owns
system bars and cutouts. It reports IME overlap to `viewport.ts` instead of
resizing the WebView ahead of the keyboard. SystemBars inset handling is disabled,
and Android selects zero CSS safe tokens before React renders.
The opt-in `PairingJourneyTest` nativeLayout journey compares packaged controls
with OS screen insets and exercises reload, rotation and keyboard transitions.
The overlay controller also reveals the focused form field after a window
resize with unchanged IME height; unchanged signals and already visible fields
do not write scroll positions. Browser `keyboard` covers the real New Bot form.
Both native apps use the overlay controller; iOS retains `KeyboardResize.None`,
and Android declares `adjustResize` for insets delivery. Keyboard changes animate
the shell and input sheets through the shared motion setting; browser-only
viewport changes keep their own path. See [keyboard motion and acceptance
limits](client/keyboard-motion-2026-10-23.md) and [fast mobile navigation](client/mobile-motion-2026-10-23.md).
Plugin registration is not physical-device acceptance.
The [iOS chat timing adjustment](client/ios-chat-keyboard-speed-2026-11-12.md)
uses a separate capped page transition only for a focused phone composer opening
the keyboard and inbox height restoration after a native hide report. General
foreground form/sheet motion, Android and old iOS shells retain their timing. Tests:
`client-viewport`, browser `ios-keyboard-motion`, `keyboard` and
`ios-keyboard-dismiss`; native component evidence is distinct from full-App
physical acceptance.
New iOS binaries advertise `tarobotKeyboardInsets.supported()` from
`client/ios/App/App/KeyboardInsets.swift`. `UIKeyboardLayoutGuide` is converted
into the current WebView's coordinates and reports overlap through the existing
`tarobot-keyboard` channel; old binaries retain the Capacitor event fallback.
Only expanded iPhone windows enable the undocked-guide workaround; the overlap
predicate still rejects floating or partial-width keyboards. In those windows,
`ios-keyboard-dismiss.ts` adds a short touch tap in chat history to dismiss text
input. Ordinary/folded iPhones and iPads retain their previous keyboard behavior;
scrolling, selection, long presses and interactive controls remain unchanged.
`ios-keyboard-accessory.ts` restores the native Done bar only in expanded iPhone
windows and restores the default on folding/teardown. Its serialized lifecycle
also reconciles retained native state on every iPhone document load. A plain
method adapter loads the Capacitor proxy without Promise assimilation. After a
successful current policy call, the optional main-frame native
`tarobotKeyboardInsets.refreshAccessory()` refreshes the existing input view
without a blur/refocus cycle; older shells skip this bridge. Coverage is in
`ios-keyboard-accessory.test.ts`; native component probes cover live policy
changes and document reloads, separately from physical folding or installed-App
acceptance.
Regression: browser `ios-keyboard-dismiss`; pure Swift geometry is not an
installed-device keyboard receipt. These are App presentation changes; the
headless CLI has no keyboard or viewport.
`ios-adaptive.css` handles iOS-only asymmetric sheets, touch controls above the
phone breakpoint and keyboard avoidance with a fine pointer. `AttachmentPicker`
retains camera/photo/file choices on expanded iOS windows. Browser `iphone-duo`,
`client-viewport` unit tests and `client/scripts/ios-keyboard-insets-test.mjs`
cover the contracts. [Duo verification and limits](client/iphone-duo-2026-10-25.md).
See [safe-area coverage](client/mobile-safe-area-2026-10-12.md); browser
`safe-area`, `keyboard`, `creation`, `document-preview`, `mobile-im`.

`ComposerSuggestions.tsx` bounds slash-command and group Bot completions to the
space above the composer and below the header/topic/notices. Its absolute menu
scrolls internally, recomputes before resize frames paint, and preserves input
focus when selected. Slash suggestions render the full engine-filtered Gateway
catalog; limit menu height, never truncate the matching command rows. Browser
coverage includes scrolling to the last command with the keyboard closed and a
trusted Chromium touch swipe that must not scroll the conversation. This includes
visual-viewport panning, native resize and
IME candidate-bar changes; an area too small for one touch row hides the menu
until space returns. Regression: browser `composer-suggestions`, `composer-ime`,
`keyboard`, `safe-area`, `command-parity` (Chromium and WebKit). See
[suggestion-menu QA](client/composer-suggestions-2026-10-12.md).

CreationDialog opens/closes in the layout commit; App retains explicit desktop
composer focus requests until the selected conversation is rendered. Phone
creation still avoids automatically opening the keyboard. NewConversation's
Bot label layout must not flex-grow the Avatar span. Regression: `client-viewport`,
browser `keyboard`, `creation`, `mobile-im`, `native-back`, `settings-language`,
`attachment-composer`, `questions`, `startup`, `link-preview`, `voice`.
See [keyboard and short-viewport QA](client/keyboard-qa-2026-10-05.md).

### 2026-10-14 device identity and management presentation

`client/src/PreferencesPanel.tsx` orders access records by the authenticated current
identity, other active devices, then collapsed revoked records. Names never identify
the current device. Each record opens a dedicated detail page; phones use the full
safe viewport. Rename drafts, uncertain write receipts and keyboard focus remain
guarded. `device-presentation.ts` owns neutral pairing defaults, dismissible legacy
name hints and network-aware revocation scope; `SettingsParts.tsx` avoids claiming
online state or native-client roles from an untrusted display name/platform.
Legacy relative names now render as neutral platform labels in the device list,
details, rename control and revoke confirmation, without rewriting paired records
or guessing another computer's host name. Duplicate displayed labels retain ID
disambiguation. See [legacy device labels](client/legacy-device-labels-2026-10-19.md).

Device rename remains scoped to the selected host's existing device row. Host
names and network membership use their separate shared APIs. CLI parity:
`tarobot devices rename ID --name NAME` reuses `/api/devices/rename`; no new
identity, authorization or membership mechanism is introduced. See
[device management changes and verification](client/device-management-2026-10-14.md).
Regressions: client `device-presentation`, `settings-devices`, `device-settings-ux`,
`settings`, `settings-language`, `remote-pairing`, `novice-onboarding`,
`network-manager`; host `host-cli-management`, `host-cli-network-command`,
`hub-device-actions`, `hub-request-revocation`, `hub-private-network`.

### 2026-10-06 device settings reliability

Device trust mutations also use `src/client-protocol/device-actions.ts`,
`src/hub/auth.ts`, `client/src/connection.ts`, `client/src/identity.ts`,
`client/src/native.ts` and `client/src-tauri/src/device_actions.rs`. Fresh
one-use proofs bind each approval/revocation to its actor, session, Hub and
target record. See [device action proofs](client/device-action-proofs.md).
Regressions: `hub-device-actions`, `hub-request-revocation`, `hub-foundation`,
`device-action-protocol`, `client/tests/device-action-{signing,connection}`;
Rust `device_actions` tests verify the shared signing vector.

`PreferencesPanel.tsx` separates device-list reads from acknowledged mutations,
rejects stale reads, reconciles uncertain write receipts without resubmitting,
and keeps rename drafts/busy state in the settings exit guards. `DeviceName` in
`RoutesEditor.tsx` owns inline rename errors and keyboard focus recovery;
`device-errors.ts` translates device operation failures at render time.
Device HTTP calls are bounded to 20 seconds. The authorized-device list precedes
pairing instructions and offers a keyboard-safe refresh action. Tests:
`client/e2e/settings-devices.spec.ts`, `settings`, `settings-language`,
`settings-notifications`, `pairing`. See
[device settings review](client/device-settings-2026-10-06.md).

### 2026-10-06 review fixes, complete conversation drafts and pairing flow

`conversation-drafts.ts` owns per-conversation attachments, completed recordings,
quotes, previews and reply recipients. ClientCache schema 7 persists their bytes
in a dedicated `conversationDrafts` store, isolated by pairing identity and cache
generation. Revision compare-and-swap rejects stale-window writes; empty revision
tombstones prevent an old draft from being recreated after sending. Limits affect
offline draft storage only, never the attachment send limit. Failed saves preserve
the visible draft and expose retry; restored drafts never auto-send. An explicit
phone hold-to-talk release sends only that new recording. Text remains in ClientCache;
`clearDraftIfMatches` atomically protects newer saved drafts from late sends.
Composer autosave feedback is quiet during routine writes, retaining its flex
spacer and showing failures. [Quiet draft feedback](client/quiet-drafts-2026-10-13.md).
App blocks archived conversation/topic retry both at entry and execution.
`ConversationPanel` uses bounded receipt reconciliation, synchronous mutation
admission, idempotent command retries, App confirmations and stable return focus.
`connection.acceptConversationMute` invalidates older notification reads.

`PreferencesPanel` and `device-settings.css` own a three-step nested pairing
flow, explicit operation progress, device identity/time details and approved
row positioning. Unknown write outcomes only trigger reads. Flow Back stays
inside the wizard; codes/rename drafts remain intact. HostApp remounts its
closable registry/pool owner only when its development module version changes;
production renders and normal host switching retain stable instances.

Regressions: browser `persistent-drafts`, `chat-drafts`, `conversation-settings`, `device-settings-ux`,
`host-hmr`, `message-actions`, `message-hold`, `attachment-composer`, `voice`,
`topics`, `host-workspace`, `settings-devices`, `settings`, `settings-language`,
`settings-notifications`, `pairing`, `native-back`. See
[review fixes and acceptance boundaries](client/review-fixes-2026-10-06.md).

### 2026-10-11 system push token maintenance

`client/src/system-push.ts` installs per-host maintenance from HostApp;
`push-maintenance.ts` uses token-free Hub binding metadata and conditional PATCH,
without creating subscriptions or changing notification preferences.
`native-push-token.ts` shares an in-flight device read, checks existing OS permission,
and separates APNs registration from snapshot-only hints. `native.ts` emits an
explicit foreground signal even when a healthy connection only pings.
`share-inbox-bridge.ts` registers the iOS snapshot/file plugin once; AppDelegate
records the current APNs result in memory before its Capacitor notification.
Local reset cancels old reads and explicit enable intents before native cleanup.
Hub schema 12 retains push consent independently of provider-invalidated tokens;
manual writes/preferences change revisions, DELETE/revocation remove consent,
and provider `gone` responses cannot invalidate a later explicit re-registration.
Tests: `hub-push-rotation`, `client-push-maintenance`, `hub-state-backup`, browser
`system-push-native`, `unifiedpush-native`, `native-events`, `settings-notifications`,
`host-hmr`. See [implementation and acceptance limits](client/system-push-rotation-2026-10-11.md).

### 2026-10-11 notification receiving diagnostics

`client/src/NotificationReadiness.tsx` separates reminder intent from receiving
conditions. `notification-readiness.ts` performs read-only checks using fresh host
configuration, token-free binding metadata and the appropriate platform status.
Android `UnifiedPushPlugin.notificationStatus` checks the app switch and existing
channel without creating it. `MessageNotificationChannel` supplies new-channel
sound/vibration defaults, preserves existing channel settings, reports alert
flags, and builds the explicit system-settings route. Browser `notification-readiness`
and native `NotificationAlertsTest` cover these changes; [Android alert defaults
and upgrade limits](client/android-notification-alerts-2026-10-17.md).
Explicit APNs/FCM recovery retains provider and
consent revision; UnifiedPush recovery remains in its distributor controls.
Setting reads must not trigger registration through the maintenance observer.
Tests: `hub-push-rotation`, `client-push-maintenance`; browser
`notification-readiness`, `settings-notifications`, `device-settings-ux`,
`system-push-native`, `unifiedpush-native`, `host-push`.
See [implementation, review and native limits](client/notification-readiness-2026-10-11.md).

### 2026-10-11 desktop first installation

`DesktopWelcome.tsx` explains that running Bots requires a separately installed
AI CLI and provider sign-in/API configuration on that host. Phones and computers
used only as controllers do not need CLIs. `NewBot.tsx` repeats this at engine
selection and distinguishes executable detection from authentication readiness;
both READMEs put the prerequisite before product screenshots and in setup steps.

`client/src/DesktopWelcome.tsx` → native `desktop_host.rs` →
`src/hub/desktop.ts` starts the bundled standalone Hub and enrolls the local
owner. `desktop-tls.ts` and `DesktopHostInvite.tsx` generate LAN pairing without
system CA changes; `route-trust.ts`, `transport.ts` and all three native network
bridges carry the QR-scoped CA for HTTP and WebSocket. Compatibility IDs stay
unchanged. `scripts/prepare-desktop-host.mjs` packages an upstream Node runtime
and standalone production dependencies; only Apple Silicon is currently bundled.
Tests: `desktop-host`, `hub-tls-identity`, `hub-foundation`, Rust
`pinned_transport`; browser `native-transport`, `mobile-network`,
`android-transport`, `pairing`, `device-settings-ux`; JVM/Foundation audits.
See [first-install evidence and limits](client/desktop-host-onboarding-2026-10-11.md).

### 2026-10-11 LAN pairing recovery

`client/src/identity.ts` uses base64url nonces compatible with both mobile native
signers. `Pairing.tsx`, `HostApp.tsx`, `storage.ts` and `connection.ts` retain
pending enrollment and finish only after authentication. `RepairHostRoute.tsx`
updates a same-Hub direct route without replacing device identity or relays.
`connection-routes.ts` holds route construction; advanced pairing controls load
on demand. `src/hub/desktop.ts` retains the desktop LAN port across offline starts.
Android `HubTransport.close` performs pooled TLS cleanup off the UI thread.
Tests: `challenge-nonce`, `repair-host-route`, `desktop-host`; browser
`pairing-recovery`, `pairing-route-repair`, `pairing`, `host-workspace`,
`attachment-composer`, `native-transport`, `deployment`, `startup`; the mobile
identity audit consumes production nonces. `PairingJourneyTest` and its disposable
`android-pairing-peer.mjs` exercise native enrollment/reload/TLS/chat/reconnect.
See [evidence and limits](client/lan-pairing-2026-10-11.md).

### 2026-10-12 Tailscale pairing entry

`DesktopHostInvite.tsx` offers explicit LAN and Tailscale choices. Native
`desktop_host.rs` admits the fixed `tailscale` action; `src/hub/desktop.ts`
prepares listeners only on detected Tailscale IPs with private exposure and a
QR-scoped CA. Enabled LAN/Tailscale modes share a stable port and CA, survive
offline startup independently, and preserve unrelated listeners. Failed network
restarts restore the prior config and leaf certificate. `connection-routes.ts`
retains a scanned Tailscale name and CA for the same origin. Existing phones use
`RepairHostRoute.tsx`, keeping enrollment and relays. No Tailscale login, Serve
configuration, firewall change, or actual remote-device approval is automated.
Regressions: `desktop-tailscale`, `desktop-host`, `repair-host-route`;
browser `tailscale-pairing`, `pairing-route-repair`, `deployment`,
`device-settings-ux`, `native-transport`. Physical tailnet/mobile-data acceptance
remains separate from the fixture tests; see
[evidence and limits](client/tailscale-pairing-2026-10-12.md).

Local setup in `src/hub/desktop.ts` uses `desktop-network.ts` to allocate a new
port across every intended interface and verify the private-CA HTTPS endpoint
and Host identity before returning an invite. Existing ports remain stable;
unavailable interfaces do not block local startup. Native setup and headless
CLI pairing share this path. Regressions: `desktop-host`, `desktop-tailscale`,
`hub-host-routes`; see [1.0.117 verification](releases/1.0.117-verification.md).

`desktop-tls.ts` retains all eligible LAN IPv4 candidates rather than truncating
before a later Wi-Fi interface. Desktop selection and CLI `pair --lan --address`
share that list; the selected QR remains a single direct route. Regressions:
`desktop-lan-addresses`, `desktop-host`, `desktop-tailscale`, `hub-host-routes`,
`host-cli-management`, `tailscale-review-regressions` and Chromium
`tailscale-pairing`. See [scope and evidence](client/lan-interface-discovery-2026-11-12.md).
Candidate health failures are independent, with an optional unavailable count;
all-failed and explicitly selected CLI failures remain errors. Multiple or partially failed
LAN candidates require an explicit UI choice before QR issuance/publication.
Also cover `desktop-network-resilience`, `desktop-network-port` and the
`device-invite` browser parent flow when changing this path.

### 2026-10-21 Host route refresh and self-route sync

`src/hub/host-routes.ts` observes bound desktop-managed listeners after each
listener refresh (`src/hub/cli.ts`, outside the desktop mutex) and keeps its
debounce record in the `host-routes:v1` meta key. `src/hub/private-network.ts`
`replaceManagedRoutes` may only replace this host's own stale managed direct
route by compare-and-swap. `src/hub/server.ts` serves owner-only
`GET /api/network/host-routes` (`src/client-protocol/host-routes.ts`,
`host-routes.v1`). `POST /api/network/host-routes/select-lan`
(`host-routes.select-lan.v1`) records an owner's explicit choice among current,
listening managed LAN endpoints. URL and CA must match; authorization, the
signed-route conflict check and the local record write share the DB guard.
Selection and background observations are serialized. This endpoint never
changes signed routes, listeners or trust anchors. The CLI's explicit
`pair --lan --address IP` uses the same selection when compatible with existing
shared routes; `network select-lan --from FILE --yes` exposes the owner API.
A different signed LAN route requires the existing explicit `network routes`
command. Client `network-sync.ts` applies the read view per origin through
`host-route-sync.ts` with `host-registry.ts` `hostRoutes` provenance; signed
discovery keeps `networkRoutes` as its own base. CLI: `network local
[--tailscale]` (`src/host-cli/network-local.ts`, `tailscale-status.ts`).
Regressions: `hub-host-routes`, `hub-private-network`, `hub-network-recovery`,
`host-cli-network-command`, `host-cli-tailscale-status`, client
`host-route-sync`.
Client selection: `client/src/route-performance.ts` and `connection.ts` own
bounded health racing, EWMA, hysteresis, mutation/transfer guards and single
business-socket handoff. `storage.ts` `saveIdentityRoutes` owns transactional
identity-route CAS. `HostRoutesStatus.tsx` reports owner-only listener state and
capacity; `pairing-link.ts` `connectionPairingPayload` projects client-local
multipath lists into legacy QR v1. The local `RoutesEditor` address list treats
listener state as mode-wide: retained addresses with a selection/listener warning
say "Address needs confirmation" instead of "Ready". A pending replacement has
no mode field, so it leaves both modes unconfirmed until the notice clears;
mode-specific warnings affect only that mode. Browser `host-entries` covers these
states in both languages. This is App presentation only; Host/CLI protocols and
route selection are unchanged. Further regressions:
`tailscale-review-regressions`, `client-multipath-routes`,
`connection-route-updates`, `route-performance`, `connection-switchback`;
Chromium `multipath-routes`, `host-route-sync`, `network-manager`, `routes`,
`multi-vps`, `downloads`, `uploads`. Device/tailnet acceptance remains separate; see
[evidence and limits](client/tailscale-route-sync-2026-10-21.md).

## Local connection settings (2026-10-23)

`LocalConnectionSettings.tsx` separates host listener setup/status from new-device
QR invitation. `useDesktopHostAccess.ts` is the shared explicit native preparation
and signed route publication path used by it and `DesktopHostInvite.tsx`.
`ConnectionPanel.tsx` propagates setup busy state through both dialog levels.
The [address clarity update](client/tailscale-connection-clarity-2026-10-23.md)
keeps complete host URLs and copy controls visible, distinguishes first pairing
from route changes, and gives read-only refresh explicit completion feedback.
`host-cli/tailscale-status.ts` accepts a signed-out node's null IP list and
reports `NeedsLogin` without exposing authentication URLs or peer information.
No membership, transport, storage or adapter semantics change. Regressions:
`tailscale-pairing`, `device-invite`, `local-relay`, `multipath-routes`,
`host-route-sync`, `desktop-tailscale`, `host-cli-tailscale-status` and existing
host/CLI network suites. [Behavior and acceptance boundaries](client/local-connection-settings-2026-10-23.md).

## Device invitation and connection navigation (2026-10-23)

- `DeviceInviteCode.tsx` reads the selected host’s existing routes and shows a connection QR directly; loopback/unspecified/insecure routes are excluded, host identity must match, failed reads are retryable, and obsolete responses cannot replace another host’s QR. First-time listener setup remains explicit in `DesktopHostInvite.tsx`.
- `NetworkManager.tsx`, `HostApp.tsx`, `PreferencesPanel.tsx` open the invitation or 8-digit approval flow directly. `MobileHome.tsx` places Devices & network and Connection status & routes beneath the selected host. Independent phones and signed host membership keep their existing semantics.
- `network-manager.css` gives the invitation, management shortcuts, network overview and host group distinct palette-based surfaces without changing navigation or platform size baselines. [Visual refinement and evidence](client/network-visual-polish-2026-10-23.md).
- Address publication is labeled “同步主机地址” in host details and review. `HostAddressSyncHelp.tsx` provides a clickable question-mark explanation of the recipient network, the difference from saving routes on one device, and the later-added Tailscale/VPS case. Help is read-only and restores focus; publication still requires the existing owner confirmation. This is App presentation only; the shared Host API and headless CLI are unchanged.
- The network overview exposes that same address-sync review with an explicit host selector, bound to the opening network. Replaced addresses are visible before confirmation; offline/permission reasons and waiting-for-coordinator receipts remain distinct. Existing detail/join entries retain their routes. See [overview entry and review boundaries](client/host-address-sync-entry-2026-10-23.md); regressions: `network-address-sync-entry`, `network-manager`, `network-manager-target` in Chromium/WebKit. CLI/API behavior is unchanged.
- `PairingCode.tsx` distinguishes connection and approval scanner instructions; `Pairing.tsx` persists the HTTP Date clock offset for its pending-code countdown; `PendingPairings.tsx` uses authenticated server time and owner permission.
- Regressions: `device-invite`, `network-manager`, `network-manager-target`, `novice-onboarding`, `remote-pairing`, `device-settings-ux`, `mobile-settings`, `pairing-design`, `tailscale-pairing`, scanner/recovery/native-back/transport, and `pairing-time` unit tests. CLI capabilities and JSON are unchanged; help/docs use device-inclusive wording. [Audit, evidence and release boundary](client/device-join-2026-10-23.md).

## Pairing and scanner presentation (2026-10-11)

- Monochrome setup/settings primary buttons use a fixed light warm grey fill and dark warm text, with or without an accent, in light/dark/system modes (`porcelain-details.css`). This covers pairing, Bot setup (the `bot-setup` surface in `NewBot.tsx`), device/network setup and settings saves. Existing neutral/secondary and destructive buttons, chat sends, other palettes, focus, disabled guards and layout stay unchanged. This is App presentation only; no Host/CLI or configuration protocol change.
- `client/src/DesktopWelcome.tsx`, `Pairing.tsx`: desktop host choice and remote pairing; device/security semantics unchanged.
- Unfinished desktop enrollment can return to the start page without deleting its identity. Late approval cannot steal navigation; Windows explains its companion-only boundary. Regressions: `native-transport`, `pairing-design`, `pairing-recovery`, `host-workspace`. [Return-flow repair](client/onboarding-return-2026-10-13.md).
- `client/src/pairing.css`, `pairing-scanner.css`: consolidated first-run layout and scanner states; do not add pairing overrides back to global theme sheets.
- Native phone first-run branding uses a 128 px mascot over its named heading; desktop setup and pending confirmation retain a 64 px mark with the name bottom-aligned. Connection actions wrap at narrow widths and large text sizes. `pairing-layout` covers portrait, landscape, safe-area tokens, text scaling and preserved input across resizing on Chromium/WebKit. This is presentation only; no Host/CLI change. [Evidence and physical-device boundary](client/onboarding-brand-layout-2026-11-05.md).
- Existing users' “返回会话” action in `DesktopWelcome.tsx` and `Pairing.tsx` uses an arrow and a palette-aware filled, bordered button, with a larger touch target on touch screens. The action, busy guard and first-run visibility are unchanged; this presentation-only refinement has no headless CLI or Host impact.
- `client/src/PairingCode.tsx`: image decoder and owned camera-stream lifecycle; `pairing-link.ts` owns the validated QR protocol. Hide the video until actual playback; clean up late camera results after closing. `qr-image.ts` loads and resamples screenshot pixels with bounded work; scanner text entry and QR copy use the same strict pairing parser. [Image recognition and recovery evidence](client/qr-pairing-2026-10-13.md).
- Focused regressions: `qr-scanner`, `pairing-design`, `pairing` and `native-transport` browser journeys, then client and root builds. Native versus browser/physical-camera evidence is recorded in `docs/client/pairing-design-2026-10-11.md`.

- Remote enrollment: direct paste/image entries in `Pairing.tsx`, visible phone device settings and confirmation shortcut, and owner-only pending-device hints in `PendingPairings.tsx`. Screenshot tiles in `qr-image.ts` preserve small QR detail. No new authorization or network membership protocol. Regressions: `remote-pairing`, `qr-scanner`, pairing/recovery/settings/native-transport/private-network suites. [Remote pairing acceptance](client/remote-pairing-2026-10-14.md).

- [Route setup and dense QR recovery](client/network-join-qr-recovery-2026-10-16.md):
  the join footer opens the missing host's existing route review before consent;
  `qr-image.ts` adds bounded, source-aligned finder crops for dense phone screenshots.
  Tests: `network-manager`, `novice-onboarding`, `qr-scanner`, and client network
  protocol/storage/route suites. Sharing and membership still require confirmation.

- New-computer network onboarding: `desktop-join-intent.ts` records public navigation intent only; `HostApp.tsx` resumes pairing/admission and clears intent from actual matching membership. `NetworkManager.tsx` hosts inline LAN/Tailscale setup and route correction through `DesktopHostInvite.tsx`. `useDesktopLocalHost.ts` and `RoutesEditor.tsx` fail closed while native host identity is unresolved, preventing accidental loopback edits. No host/CLI protocol change. Regressions: `novice-onboarding` (real disposable two-Hub membership, foreground/background phone approval), `network-manager`, `native-transport`, `tailscale-pairing`, `desktop-host-name`, and `client-network-routes`. [Opus novice audit and verification boundaries](client/novice-network-audit-2026-10-14.md).

## App scheduled task management

- `client/src/ScheduledTasks.tsx`: + menu creation and per-Bot task management;
  desktop Workspace / phone Me entry, presets, timezone and context controls.
  `scheduled-tasks.css` groups task identity/status, planned run time, result
  conversation and actions into responsive cards, with sectioned creation forms.
  `schedule-cadence.ts` describes exact common cron schedules; unusual expressions
  remain custom rather than claiming a misleading fixed interval.
- `src/client-protocol/schedules.ts`, Hub `/api/bots/:id/schedules`,
  `src/gateway/schedules.ts`: owner/conversation-scoped calls into the worker's
  existing CronStore/CronScheduler. Stable receipts and atomic revision checks
  protect retry and concurrent edits; historical `lark:gw_` keys are retained.
- Regressions: `gateway-schedules`, `cron-store`, `cron-scheduler`, browser
  `schedules` and `creation`. See [behavior and native acceptance](client/schedules-2026-10-12.md).
- `ScheduledTasks.tsx` keeps Bot selection in the same dialog, with bounded
  searchable rows, draft/focus preservation and a Bot-bound save receipt.
  Browser `schedule-picker` and `schedules` cover selection, native-back routing,
  offline/deleted Bots and retry/edit restrictions. Presentation-only CLI impact:
  [selection behavior and independent review](client/schedule-bot-picker-2026-10-21.md).
- `src/core/cron.ts` applies pending App session selections inside the queued
  run and resolves conversation resume scope before deriving execution and
  delivery roots. Tests: `cron-conversation-context`, `gateway-schedules`,
  `core-cron`, `gateway-goal-session`; weekly editor transitions are covered by
  browser `schedules`.

### Private host network

The [network overview and guidance refinement](client/network-overview-2026-10-16.md)
uses compact theme-aware host rows, conditional identity suffixes, separate
availability/permission notices, expandable explanation, and a non-blocking
read-only refresh. `HostApp.tsx` calls the local connection manager “Connections
on this device” and shares its public-key suffix with the network detail.
Regressions: `network-manager`, `private-network`, `novice-onboarding`,
`host-name-sync`, and connection-manager navigation/removal journeys.

See [private network behavior and trust](client/private-network.md). Membership is
a signed single-writer directory in `src/hub/private-network.ts`, with bounded
HTTPS peer transport in `src/hub/network-peer.ts`. Protocol schemas live in
`src/client-protocol/private-network.ts`; fresh command proofs reuse the existing
`device-actions.ts` native signing boundary. `host-profile.ts` owns shared names.
Client `network-sync.ts` owns discovery independently of the selected workspace;
`NetworkManager.tsx` owns explicit admission review. `storage.ts` persists each
Hub's pinned latest directory without changing drafts or identity. Run focused
`hub-private-network`, `hub-network-http`, `hub-network-peer`, host-profile/device
action tests plus private-network/native onboarding/host workspace browser tests,
then both root and client production builds. Keep physical-device and VPS gates
separate from simulated/browser evidence.

Shared host names: `connection.ts` publishes acknowledged host-profile revisions
independently of directory refreshes; `host-registry.ts` caches them against the
current registration; `host-connections.ts` resolves one name for App views.
`HostApp.tsx` and `NetworkManager.tsx` require a host acknowledgement for renames.
The sidebar host filter displays host names without unread-count suffixes;
duplicate names retain their identity suffix. This is App presentation only;
read markers, message badges and Host/CLI behavior are unchanged.
Regressions: `host-profile-connection`, `hub-host-profile`, `host-cli-management`,
and browser `host-name-sync`, `multiple-hosts`, `host-concurrency`,
`network-manager`, `mobile-network`, `novice-onboarding`, `private-network`.
See [shared-name consistency and acceptance limits](client/host-name-consistency-2026-10-14.md).
Native desktop device names now share the host profile after proof enrollment;
`local-controller.ts` owns exact marker matching, and `host-profile.ts` synchronizes
linked rows transactionally. See [host/device naming](client/host-device-name-sync-2026-10-16.md).
Regressions: `desktop-controller-migration`, `hub-network-http`, `hub-private-network`,
`host-cli-management`; browser `host-name-sync`, `device-settings-ux`, `desktop-host-name`.

Cross-host device names use exact signed member origins in `private-network.ts`;
`network-device-name.ts` keeps automatic-name provenance separate from explicit
local aliases. `server.ts` persists an alias with the authenticated rename in one
transaction. `PreferencesPanel.tsx` refreshes after accepted directory revisions,
preserving edit drafts. See [cross-host naming](client/network-device-name-sync-2026-10-19.md).
Regressions: `hub-private-network`, `hub-network-http`, `hub-host-profile`,
`desktop-controller-migration`, `hub-network-peer`, `host-cli-management`;
browser `network-device-name`, `host-name-sync`, `device-settings-ux`.

## App native run presentation

Claude dialogue continuity: `client-protocol/background-task.ts`,
`core/background-task-notice.ts`, `core/background-task-delivery.ts` and
`client/BackgroundTaskReference.tsx` keep late reports linked to their original
request. Gateway binds persistent engine callbacks to App rendering policy.
`run-record.ts` preserves child progress separately from final output and records
background lifecycle receipts without settling a foreground turn. See
[behavior and compatibility](client/claude-card-continuity-2026-10-14.md).
Regressions: `background-task-notice`, `background-task-header`,
`claude-stream-adapter`, `run-presentation`, `gateway-workflows`; browser
`claude-card-continuity`, five-engine `run-presentation`, `run-formatting`.

Background report density: `client/RunPresentation.tsx`, `BackgroundReport.tsx`,
`RunReportPreview.tsx` and `RunReport.tsx` retain short visible reports and a
separate full-text reader for long scoped/background reports. `message-overlay.ts`
keeps the reader's message mounted during timeline virtualization; state stays
scoped to its host, device, conversation, message and run. Foreground answers and
interactive cards retain their existing presentation. See
[design and verification](client/background-report-presentation-2026-10-17.md).
Regressions: `run-presentation-ui`; browser `background-run`, `run-scopes`,
`claude-card-continuity`, `adhd-board`.

Background reader audit: `message-overlay.ts` retains image/file readers during
timeline virtualization; `use-attachment.ts` owns Blob URLs independently of
route connectivity. `run-journal.ts` applies personal deletion and avoids
inferring scoped artifact ownership from overlapping request time windows.
`background-task.ts` adds optional status/delivery metadata for accurate push
classification. Claude's `background_review_wait` records admission waiting,
while `use-turn-stop.tsx` and `turn-stop.ts` explain shared-process impact and
fence delayed UI confirmations. An explicit stop of an active Claude turn also
reads the native task snapshot with a bounded timeout. Declared foreground,
subagent and whole-session scope controls which running background tasks are
listed; failed/unsupported lookups remain explicitly unverified. No stop is sent
until required confirmation, and changing host/chat/turn or hiding the pane
invalidates late results. No wait-only cancellation protocol was added.
Regressions: `hub-push`, `gateway-workflows`, `scoped-run-presentation`,
`claude-stream-adapter`, `turn-stop-impact`, `run-presentation`; browser
`run-stop-recovery`, `background-run`, `image-gallery`, `image-recovery`,
`attachment-message-actions`, `adhd-board`. See
[verification and limits](client/background-reader-audit-2026-10-17.md).

Background subagent groups (backend): `client-protocol/background-task-group.ts`
defines optional `extra.backgroundTaskGroup` v1 (`groupId`, `scopeId`, `runId`;
readers ignore later optional fields). `core/scoped-run-presentation.ts` creates
one opaque group ID per callback controller, never from `replyTo`, and marks only
bound background subagent cards; review scopes, unattributed work, foreground
process cards and any card carrying a user-facing report remain standalone.
`gateway/channel.ts` always consumes the producer property and writes the record
only when the Hub negotiates `runs.v1`, `runs.scopes.v1` and
`runs.scope-groups.v1` (`hub/server.ts`), bound to that card's `scopedRun.id`.
Every member keeps its message, journal, status, notification and read-only
controls; no aggregate record or extra message exists. Hub interruption recovery
(`hub/store.ts`) restores a valid record for the same run; forwarding strips it.
The headless CLI host shares this path; presentation needs no CLI command.
Regressions: `background-task-group`, `scoped-run-presentation`, `run-scopes`,
`gateway-workflows`, `hub-push`, gateway recovery suites.
App projection/dock: `client/src/background-task-groups.ts` and
`BackgroundTaskGroup.tsx`; `App.tsx` maps member navigation and virtual rows,
`RunPresentation.tsx` reuses the existing scoped journal reader.
`BackgroundTaskDock` composes its existing read-only locator with a stable
`EngineTasks` management button; only the container is unified. Group counts
never join to opaque native handles. Native notices, task control and
unsupported fallbacks remain independent. See [task bar](client/task-bar-unification-2026-10-24.md). Browser coverage:
`background-task-groups`, `background-task-groups-edges`. See
[format, fallback and acceptance](client/background-task-groups-2026-10-24.md).
Running dots in grouped rows and the compact task-manager button use the same
Monochrome accent signal as the reply indicator; error and uncertain states
retain their semantic colors. This is App styling only; the headless CLI is unchanged.
Standalone scope labels can contain native completion summaries.
`ScopedTaskDescription.tsx` keeps those in regular type with bounded excerpts
and a Markdown disclosure, without changing the grouped-card path. See
[task description typography](client/background-task-typography-2026-10-24.md);
regressions: `run-presentation-ui`, browser `background-run` and the grouped suites.

Claude interrupted work: `codex/claude-turn-recovery.ts` keeps bounded per-Bot,
native-session/workspace receipts without modifying the native transcript.
Both Claude adapters reject synthetic no-response terminal replies; shared
error semantics forbid automatic replay. Regressions: `claude-turn-recovery`,
`claude-stream-adapter`, `claude-adapter`, `error-classification`,
`gateway-app-tools`. See [incident evidence and limits](client/claude-interrupted-work-2026-10-15.md).
The [CLI upgrade audit](client/cli-upgrade-audit-2026-10-15.md) covers delayed
stdin failures, bounded optional receipt storage, and actual installed-engine
handshake/resume checks. These fixes use the shared desktop/headless host core.

Context maintenance feedback: the production Codex, Claude, DeepSeek and Kimi
adapters report native compaction lifecycle events; AGY checkpoint events are
labeled as context summaries rather than proof of history pruning.
`core/run-record.ts` records non-tool maintenance through the existing v1 current
activity. App replies show “正在压缩上下文”; detail views hide the internal event
name and retain confirmed outcomes/durations. Missing completion receipts never
become invented success. Desktop/mobile and headless hosts share this path;
no new CLI command or schema is needed. Tests: all five production adapters,
`kimi-hook-relay`, `run-presentation-ui`, `run-presentation`, Gateway card/writer/
recovery and scoped-run suites; browser five-engine `run-presentation`.
[Native contracts, limits and verification](client/context-compaction-status-2026-10-17.md).
[Original preventive-compaction incident](client/context-compaction-feedback-2026-10-16.md).

Run feedback and Claude session IDs: `client/run-presentation.ts` formats
durations; `RunPresentation.tsx` separates wall time from last public progress
and preserves narration paragraphs. `connection-timing.ts` gives remote/native
links a cellular-appropriate liveness budget. `runtime/session-scanner.ts` reads
bounded transcript metadata for direct Claude UUID binding in
`core/shared/session-commands.ts`, without probing external workspace paths.
Regressions: `run-presentation`, `run-presentation-ui`, `session-scanner`,
`shared-session-commands`, `gateway-command-parity`; browser
`run-presentation`, `run-details-refresh`, `routes`, `host-concurrency`.
[Behavior and limits](client/run-feedback-and-claude-resume-2026-10-14.md).
The [2026-10-19 progress-feedback refinement](client/run-progress-feedback-2026-10-19.md)
removes reporting-gap warnings from cards and shows event freshness in process
details. Regressions: `run-presentation`, `run-presentation-ui`,
`scoped-run-presentation`, `gateway-run-writer`, `client-stream`; browser
`run-presentation`, `background-run`, `run-details-refresh` and the ADHD background
reader scenario. The Opus follow-up covers always-visible exact timestamps,
stable two-line freshness layout, local-stop/interruption display parity,
clock offsets and two-Bot ADHD reader/focus checks. Quiet intervals do not prove
idle work or a transport failure.

`core/run-record.ts` captures public engine events before card truncation for App turns. Ordinary turns, scheduled tasks and goal watchers share `createLarkRunCardController`. Gateway negotiates `runs.v1`, stores changed entries through `hub/run-journal.ts`, and publishes an additive `card.extra.nativeRun` summary. `client/RunPresentation.tsx` owns the lightweight reply and on-demand detail view. See [native run presentation](client/native-run-presentation-2026-10-13.md) for limits, compatibility, status semantics and verification. Regressions: `run-presentation`, `app-server-adapter`, `gateway-card-states`, `gateway-recovery`, `hub-server`, `hub-state-backup`, `cron-conversation-context`; browser `run-presentation`, `questions`, `stop`, `composer-busy`, `message-reading`.

The process reader toolbar uses a 32 px search field with 13 px input text;
phone actions retain their 44 px height. Browser checks: `run-details-refresh`.
[Compact search and first-run palette](client/compact-run-search-2026-10-17.md).
`porcelain-details.css` excludes this wrapped search input from generic dialog
field fills in both idle and focus states, keeping the icon and text on one
continuous surface. This is App-only styling; CLI-not-applicable.
The [process reader waiting-state refinement](client/run-details-empty-state-2026-10-28.md)
separates empty/loading/search states, folds record explanations, retains visible
freshness, and shows pagination only when needed. Regressions:
`run-details-refresh` and `run-scopes` in Chromium/WebKit. Host and CLI unchanged.

User-prompt reply markers: `client/user-reply-status.ts` indexes explicit foreground
`replyTo` evidence; `client/UserReplyStatus.tsx` renders a stable metadata annotation
and per-Bot group details. Unstarted/queued prompts remain unmarked. No CLI command
or host schema is added. Tests: `user-reply-status`, browser `user-reply-status`,
`run-presentation`, `storage-memory`. [Semantics and review](client/user-reply-status-2026-10-16.md).

Native run recovery: `runs.recovery.v1` gates a once-per-worker `run.recover` RPC after durable outbox replay and before ordinary inputs. `hub/store.ts` closes the authenticated Bot's orphan native runs; pending user deliveries retain receipt-based recovery. Socket reconnects do not rerun the sweep. Active phases remain streaming and cannot claim a completion notification. Regressions: `gateway-run-recovery`, `gateway-recovery`, `gateway-delivery-recovery`, `hub-push`. [Daily audit and release](client/release-1.0.67-2026-10-14.md).

Live response latency: `gateway/run-writer.ts` moves optional process batches
behind live publication while fencing terminal publication on its run's flush.
`client-protocol/stream.ts` and `hub/server.ts` negotiate
`streaming.card-extra.v1`; old clients retain compatible operations/snapshots.
Open `RunPresentation.tsx` details catch up with delayed evidence. The same
Gateway core serves desktop and headless CLI hosts for all five engines; no
separate CLI command is required. Tests: `gateway-run-writer`, `client-stream`,
`run-presentation`, `hub-server`, recovery suites; browser `stream`,
`run-details-refresh`, five-engine `run-presentation`, and reading/following.
See [measurements and limits](client/native-stream-latency-2026-10-15.md).

Active foreground replies also carry `nativeRunThinking`, a run/revision-bound
tail of the latest public thinking entry (at most 600 characters), outside the
strict v1 summary. `client-protocol/run-thinking.ts` excludes child scopes and
terminal runs; `RunPresentation.tsx` shows a short literal excerpt above the
reply and retains full text in the process reader. No extra journal polling or
generated summary is involved. Forwarding drops this live metadata. Older
clients ignore it; older Hosts simply omit the preview. App and headless Hosts
share the same Gateway projection, with no new CLI command or model setting.
Tests: `run-thinking-preview`, `run-presentation`, `run-presentation-ui`, Claude
partial-event adapter coverage and browser `run-presentation`.
See [preview behavior and validation limits](client/live-thinking-preview-2026-10-27.md).
The [follow-up joint review](client/followup-joint-review-2026-10-27.md) covers
long-thought tail capture, Unicode excerpt boundaries, mixed-script strong text,
compaction recovery/goal fencing, and the corrected browser clock setup.

The [five-engine streaming audit](client/streaming-latency-audit-2026-10-26.md)
adds immediate reservation of committed event projections in `hub/server.ts`
while preserving ordered publication and per-frame session validation. Open
unfiltered process readers perform one bounded trailing read for a stale public
thinking tail; slow-Host polling and journal persistence remain unchanged.
Tests: `hub-server` (ordered preparation, hidden messages, late connections,
revocation and rejection recovery), browser `run-details-refresh`; opt-in
`streaming-latency` and `scripts/benchmark-run-transport.mts` record stage timing
without machine-speed CI thresholds. Shared headless Host behavior is identical;
the reader adjustment is App presentation, with no new CLI command or protocol.

The [Codex cadence follow-up](client/codex-output-cadence-2026-10-27.md) removes
the fresh 100 ms wait on every sparse native burst: a short aggregation window
uses the actual previous patch start as the rate-limit origin. Waiting patches
recheck that limit; fractional early timers wait only the remaining deadline.
Serial coalescing, retry backoff and terminal fences remain. Shared App/headless
Host behavior changes together; no model setting, adapter or protocol change.
Tests: `run-update-cadence`, Gateway writer/recovery suites; opt-in browser
`streaming-latency` supports bounded 50/250 ms input cadences.

Broadcast failure recovery: a committed user input enters the existing durable
Bot dispatch queue independently of App projection success or latency. A failed
event projection retires only affected connections that still need that event,
including clients partway through a replacement snapshot whose old hello cursor
may exceed the current Host head. Normal authenticated reconnect replays retained
events or takes a snapshot. Workers, per-user projections and idempotency remain
unchanged. Tests: `hub-server`, `hub-socket-revocation`, `hub-prompt-queue`,
`gateway-service`; browser `stream` verifies phone/desktop draft retention and
final-state recovery. Same shared Host behavior for App and standalone CLI; no
new command, protocol capability or schema. See [independent daily audit](client/day-audit-2026-10-27.md).

Native run engine parity: `client-protocol/run-tools.ts` shares semantic labels
between the producer and UI. Claude stream-json retains explicit SDK diff/search
metadata; AGY persistent/one-shot paths reconcile output snapshots; Kimi ACP
retains plans, diffs and linked terminal receipts; DeepSeek ordinary/goal paths
share result-ID and `meta.diffs` extraction. Regressions: all five adapter suites,
`run-presentation`, `run-presentation-ui`, and the five-engine desktop/phone
browser matrix. Native metadata is optional; absent exit codes/reasoning are not
inferred from printed output.

- [macOS 1.0.68 release and pending mobile/Windows packages](client/release-1.0.68-2026-10-14.md): current host/client fixes, signed-bundle checks, source-versus-installer status and external-volume authorization blocker.

## Cross-model audit follow-up (2026-10-16)

- `runtime/secret-redaction.ts`, `runtime/redacted-log-tail.ts` and
  `runtime/service-lifecycle-log.ts` own complete-line worker log scrubbing and
  shared recursive metadata redaction. Pending stderr is per worker and flushes
  on stream closure, not process exit. Regressions: `secret-redaction`,
  `redacted-log-tail`, `service-lifecycle-log`, `hub-supervision`.
- `hub/database.ts` / `hub/store.ts` close failed startup connections without
  replacing the triggering error or corrupt database; `hub-startup-cleanup`.
- `gateway/app-tools.ts` rejects empty/changed files before publication, preserving
  receipt shape; `gateway-file-read-races`, `gateway-app-tools`. The auxiliary
  `HubAttachments.importForBot` reuses complete forwarded attachments;
  `hub-forwarding` covers destination authorization and bytes.
- CLI update preflight rejects an already selected revision before stopping.
  `host-cli/update-recovery.ts` fences runtime and offline-autostart recovery by
  the frozen pointer and digest; `host-cli-update`, `host-cli-update-recovery`,
  `host-cli-day-audit` cover these boundaries. Desktop/mobile retain the shared
  host APIs and network ownership. See [audit evidence and limits](gemini-opus-audit-2026-10-16.md).

- Personal message deletion: `client/src/MessageDeletion.tsx` adds single delete
  and phone hold/desktop context-menu multiselect, scoped to one host/chat.
  `DELETE /api/conversations/:id/messages` and `tarobot messages delete` share
  `HubStore.deleteMessages`. Schema 16 keeps per-user tombstones without recalling
  canonical messages, deliveries, Bot context or shared attachments. Live events,
  replay and snapshots project tombstones only for that user; search, files,
  stale quote/forward sources and push use the same personal scope. Capability:
  `messages.delete.v1`. `messages list` provides bounded CLI pagination.
  Tests: `hub-message-deletion`, `host-cli-messages`, `message-deletion`, existing
  message-actions/context-menu/hold, snapshot, persistent-drafts and search.

- Personal full-history clearing: `ClearHistoryControl.tsx` under conversation
  settings calls `GET/POST /api/conversations/:id/messages/clear`, also used by
  `tarobot messages clear`. `HubStore.clearMessages` resolves an opaque message
  cutoff per transaction, processes at most 100 old-to-new personal deletions,
  and rejects a whole page containing unfinished tasks or actionable question/
  approval cards. Native session bindings, canonical messages and deliveries
  are preserved. `messages.clear.v1` gates the new control; ordinary deletion
  events remain compatible with older paired clients. Retries keep `throughId`;
  the App waits for the committed `seq` in its own cache before acknowledging
  each page. `storage.ts` recomputes a deleted sidebar preview only if its
  source might have been removed, with a legacy-metadata fallback.
  Tests: `hub-message-clear`, `hub-message-deletion`, `hub-message-activity`,
  `host-cli-messages`, `clear-messages-operation`, browser `message-clear`,
  `message-clear-control`, `message-deletion` and `conversation-settings`.
  See [scope, performance evidence and limits](client/clear-chat-history-2026-10-28.md).
  The additive `messages_personal_history` partial index orders visible shared
  rows by conversation and implicit SQLite rowid, so planning/clearing does not
  sort the whole conversation by insertion order. The remaining count still
  scans the conversation; no persisted rowid cutoff or new wire field is added.

## Fable follow-up performance and retention (2026-10-19)

The [2026-10-25 efficiency and stability follow-up](client/performance-stability-audit-2026-10-25.md)
documents measured reconnect/report/stream costs and the independent Claude review.
`client/src/share-directory.ts` preserves unchanged directory metadata references;
`observe-message-deletions.ts` coalesces deletion/snapshot result pruning. Sync
progress is presentation-only and every per-conversation outbox flush remains.
Regressions: `share-directory`, `observe-message-deletions`,
`connection-revision-scope`, `connection-independent-sync`, browser
`directory-performance`, `report-performance`, `link-cover-lifecycle`,
`snapshot`, `outbox-refresh`, `message-send-continuity`, `message-deletion`,
`search`, `conversation-files`, `deletion-result-sync` and `stability-history`.

- `src/hub/push/receipts.ts` retains compact, body-free notification identities
  before seven-day transport-payload pruning. Startup backfill and an outbox
  insert guard cover compatible older writers. Receipts follow physical message
  and device deletion, not personal hides or shared tombstones; revoked devices
  are cleaned during maintenance. Tests: `hub-push`, `hub-message-deletion`,
  `hub-request-revocation`. Shared Hub behavior also applies to the headless CLI.
- Route checks pause while hidden, back off on unreachable preferred routes,
  deduplicate wake events and preserve three-success switchback. Reconnect tries
  unfailed alternatives before revisiting a failed route. Bus workspace polling
  slows only when collapsed and idle. See [adaptive reads and contracts](client/adaptive-background-reads-2026-10-19.md).
- Both pre-completion shells use `scripts/check-secrets.mjs`, build/test the
  shared host, build the client and run native Cargo integration targets.
  Script parity does not imply a physical Windows run or successful cloud CI.
  Secret scanning rejects worktree/index `.gitleaksignore` baselines before
  invoking the pinned scanner; a null ignore path alone does not prevent its
  automatic worktree baseline loading.
- `bot_message_upload_permits` indexes only new permits with known provenance,
  preserving the original authority value in `meta`. A message-reference trigger
  also marks permits used by compatible old writers. GC removes only tracked,
  unused permits whose attachment is physically absent; used/legacy permits and
  incoming/outgoing request receipts retain duplicate-send semantics.
- One-shot cron admission failures wait for explicit retry within the current
  scheduler. Manual execution, newer user revisions or a new scheduler can retry;
  stale refresh snapshots cannot release the fence. Preparation failures before
  admission are recorded and disabled atomically. Tests: `cron-run-once-claim`,
  `cron-native-crash`. Cancellation covers queue and file-lock waits.
- `client/service-worker-notifications.js` reads only existing language preferences
  for missing Web Push bodies; normal bodies do not read IndexedDB. Sidebar card
  summaries use a separate projection in `conversation-preview.ts`, preserving
  source message, search and forwarding contracts.

- Desktop navigation uses `client/src-tauri/src/navigation.rs`: external HTTP(S),
  file URLs and unrecognized schemes cannot replace the document. App origins
  and local blob/about preview documents remain allowed; only debug builds
  admit the exact configured dev origin. Outbound links still use the OS opener.
  Rust policy tests cover origins, deceptive hosts, credentials and preview paths.

### Readonly workspace diff review (2026-10-19)

`src/hub/workspace-diff.ts` owns bounded Git/workspace reads; `src/hub/server.ts`
adds owner + conversation/Bot membership guarded `/changes` and `/changes/file`
routes. `src/client-protocol/workspace-diff.ts` owns schemas/capability/limits;
`src/host-cli/changes.ts` reuses the same live-Hub routes. `DiffViewer.tsx` is now
the secondary **Current workspace (live)** view. `DiffViewerTrigger.tsx` opens
the lazy `RunDiffViewer.tsx` from ordinary run cards (see below). `diff-view-rows.ts` and
`diff-highlight.ts` own bounded presentation; `use-diff-review.ts`,
`diff-review-draft.ts`, `storage.ts` and `connection.ts` own persistent notes,
atomic outbox preparation and authenticated ACK cleanup. Never clear review
notes merely because send/enqueue resolved. See
[diff viewer](client/diff-viewer-2026-10-19.md). Focused regressions:
`hub-workspace-diff`, `host-cli-changes`, `diff-review-draft`, `diff-view-rows`;
browser `diff-viewer`, `diff-review-storage`, `diff-review-hook-races`,
`persistent-drafts`, `outbox-refresh`, `run-presentation` and `adhd-board`.

### Recorded run changes (2026-10-20)

`src/core/recorded-diff.ts` parses bounded edit receipts without filesystem or
Git access. Codex/Claude/Kimi/DeepSeek adapters preserve known coordinates and
whole-file add/delete receipts; unknown coordinates remain unknown.
`src/gateway/channel.ts` publishes count-only `extra.runChanges` after foreground
journal flush. It is outside the strict native-run v1 schema.
`src/hub/run-changes.ts` projects finished message/run evidence from the journal;
`src/client-protocol/run-changes.ts` owns `runs.changes.v1` and separate historical
schemas. Message `/changes` and `/changes/file` routes reuse owner/session and
conversation visibility checks, including a final queued authorization check.
Paths are evidence labels, never inputs to filesystem reads.
`RunDiffViewer.tsx` uses shared virtualized `DiffCode.tsx`. Persistent annotations
retain the v1 note/outbox schema; `diff-review-reference.ts` owns the parallel,
immutable run/operation anchors in the same IndexedDB transactions. Missing or
changed anchors fail closed; a corrupt optional anchor cannot roll back ACK
settlement. CLI `changes list/show --message` uses the same API, while commands
without `--message` retain live workspace semantics.
See [recorded run changes](client/run-diff-2026-10-20.md). Focused tests:
`run-changes`, `run-changes-http`, adapter suites, `host-cli-changes`,
`diff-review-draft`, and the existing workspace tests. Browser tests add
`run-diff-viewer` to the matrix above. Do not fabricate old evidence from disk,
mix separate operations' annotations, or clear drafts before authenticated ACK.


## Local Qwen3-ASR installation and supervision

`src/runtime/qwen-asr-setup.ts` owns account-level installation jobs shared by
`tarobot integrations asr` and owner-only Hub `/api/integrations/asr` routes.
`scripts/install-qwen-asr.sh` delegates to the packaged Python installer for
cross-process locking, dependency/model readiness, launchd/systemd registration,
private configuration and guarded repair. `qwen-asr-paths.ts` keeps diagnostic and
voice fallback selection consistent. `LocalAsrSetup.tsx` lives in the existing
integration recommendations, polling acknowledged host state and retaining
uncertain request IDs. Capability: `integrations.asr.v1`.
Tests: `qwen-asr`, `asr-setup`, `asr-watchdog`, `integration-assets`, `voice`,
`core-voice`, `gateway-voice`, `asr-cloud-routing`, `gateway-environment`;
browser `local-asr-setup`, `integration-recommendations`.
See [integration setup](../integrations/qwen3-asr/README.md).

## Host voice routing settings

`src/hub/voice-settings.ts` owns owner-only `/api/integrations/voice` status and
versioned updates; `src/runtime/voice-policy.ts` stores private non-secret
Host-scoped policy. `runtime/asr-cloud.ts` reads it per transcription;
`core/agent-instructions.ts` reads the same effective configuration per turn.
Gateway advertises `integrations.voice-policy.v2` so old workers are identified.
`client/src/VoiceSettings.tsx` is mounted under Settings and reuses LocalAsrSetup;
`src/host-cli/voice.ts` uses the same Hub API through the one-shot CLI.

Regressions: `voice-settings`, `gateway-voice`, `asr-cloud-routing`, `asr-setup`,
`gateway-environment`, `gateway-service`; browser `voice-settings`,
`integration-recommendations`, `local-asr-setup`, `settings-lifecycle`.
No Agent Bus, model routing, credentials migration or production service restart.
See [voice settings](client/voice-transcription-settings-2026-10-21.md).


## 2026-10-22 three-day joint audit repairs

Scope, evidence and unresolved boundaries: [joint review](audits/2026-10-22-three-day-joint-review.md).

- `client/src/group-mentions.ts` resolves current-member IDs and visible names
  for send/steer and composer model controls. Unknown or ambiguous directed
  mentions require the recipient picker before unselected group sends; code and
  email text do not select Bots. Tests: `client/tests/group-mentions.test.ts`,
  browser `group-discussion`, `composer-model-controls`.
- `runtime/media-transcript-cache.ts` reuses successful authorized recordings
  across Worker processes and discussion rounds. `core/message-handler.ts`
  supplies Gateway attachment scope; `core/voice.ts` snapshots routing before
  cache lookup. Tests: `media-transcript-cache`, `gateway-parallel-voice-reuse`,
  `gateway-discussion-voice-reuse`, existing Core/Gateway voice and cloud routing.
- `hub/prompt-queue.ts` distinguishes an already-claimed head from a stale queue
  version; `PromptQueue.tsx` retains edits without offering an impossible
  conflict-save. Tests: `hub-prompt-queue`, browser `prompt-queue`.
- `Widget.tsx` removes a repeatedly failing guest, retains its summary and permits
  explicit retry or replacement HTML. This does not preempt synchronous loops.
  `widget-document.ts` disables WebRTC constructors before authored scripts;
  CSP alone does not block STUN. Tests: browser `inline-widget`, `widget-performance`.
- `hub/desktop.ts` classifies reconcile control/mutex timeouts as waiting.
  `client/src/local-controller.ts` preserves an already authenticated, running,
  same-identity, directory-proof-capable connection on a recovery error.
  Tests: `desktop-reconcile-errors`, `local-controller-recovery`, existing
  desktop lifecycle and update suites.
- `gateway/agent-instructions.ts` omits compatibility-engine widget recipes
  for implementation-only chart requests; explicit mixed visual requests and
  on-demand native capabilities retain them. Tests: `widgets`, `widget-settings`.

## Conversation workbench (#93)

`client/src/WorkbenchLibrary.tsx` adds **Settings → Workbench files**, also
reachable from the Workbench tab list. It manages this device's whiteboards,
notes and Design content across accessible hosts/conversations, including
closed tabs. `workbench-library.ts` and `storage.ts` own scoped metadata reads,
editor-lock-aware batch deletion and cross-window invalidation. HostApp/App
navigate to the exact original scope; Bot/CLI authority does not expand.
See [library behavior and verification](client/workbench-library-2026-10-31.md).
Phone library filters retain native pickers with compact visible labels. Desktop
attachment images expose Add to whiteboard in their context menu; mobile omits
that shortcut. ADHD browser header height follows its adjacent board toolbar.
See [presentation follow-ups and regression evidence](client/browser-ui-followups-2026-11-01.md).

`client/src/AdhdBrowserDock.tsx` and `personal-browser-controller.ts` provide the
independent ADHD browser next to Agent Bus. It shares `BrowserPage`/page tools
and native surfaces with the conversation browser, but has no Hub registration
or Bot command subscriber. Its reserved personal profile is cleared on full
local reset, not individual Host removal. See
[personal browser behavior and verification](client/adhd-personal-browser-2026-10-31.md).

`client/src/Workbench.tsx`, `use-workbench.ts`, `workbench-controller.ts` own
conversation-scoped tabs, splits, chart references, local whiteboards and Markdown notes.
The right-panel choice is also scoped by Host, user and conversation in the current
window: A's open Workbench does not open B's; returning restores each conversation's
choice. `use-workbench.ts` gates the controller during render and derives expansion
from that same owner, preventing the previous conversation's surface/context from
appearing during a switch. See [conversation isolation](client/workbench-conversation-2026-11-04.md).
Right-side opening shares `useSideWindowExpansion`, `SidePanelResize` and the
`conversation-side-panel` layout/entry styles with side chat. The Workbench
name appears below the icon in its empty state. The top bar keeps tabs and
actions together in one row; roomy docked headers retain smaller tabs.
See [empty-state title placement](client/workbench-empty-title-2026-10-31.md).
Empty-state creation actions wrap inside narrow panels; product labels use
画布 / Canvas and PPT, with upstream skill routing unchanged. See
[neutral names and narrow-layout validation](client/workbench-labels-width-2026-11-04.md).
New content sits immediately after the tabs; only the tab list scrolls, while
the plus button stays visible. Its menu anchors below the tab group. See
[adjacent new-content control](client/workbench-adjacent-add-2026-10-31.md).
Tab right-click/keyboard menus reuse the shared `DesktopMenu` point portal;
toolbar disclosures stay in-panel. See [context-menu anchoring](client/workbench-tab-context-menu-2026-10-31.md).
Docked height follows the adjacent conversation header with a scoped ResizeObserver. The active tab
is revealed by scrolling only the tab strip. The bar owns expand/close; native pages are revealed after the entry animation at
settled bounds. Single-page views omit the repeated region title; split
regions retain their own controls. The desktop Split action opens a draft checkbox
chooser for exactly 2–4 open tabs, with a selected count and explicit Apply.
Merge remains one click; its adjacent chevron reopens the chooser for adjustment.
The atomic `set-visible` action uses the existing editor-flush and layout-CAS queue;
unchecked tabs stay open. Maximized panes restore via the tab bar.
See [explicit split selection](client/workbench-split-picker-2026-10-31.md).
Single-page views have no remove-from-split command. The tab list provides
per-tab management on desktop and phone, replacing the global ellipsis; phones
omit split controls. See [split controls and menu ownership](client/workbench-split-controls-2026-10-31.md).
Workbench content passes
`showHeader=false` to Report/Widget so their nested titles and expand buttons do
not repeat the workbench controls; Widget retry remains in its error area.
Notes/boards own their save status; there is no duplicate global save footer.
Expanded and phone layouts remain separate.
Phone/expanded positioning uses untransformed layout offsets so returning to a
conversation cannot retain the navigation animation's temporary horizontal
offset. See [phone return alignment](client/workbench-phone-return-2026-10-31.md).
ADHD hides the per-pane Workbench and screen shortcuts in both overview and
expanded layouts. Ordinary conversation shortcuts and the independent ADHD
browser dock remain available. This is presentation-only; Host/CLI contracts
are unchanged. `workbench-adhd` covers mode switching and retained drafts.
Existing content-link and file-library actions still use
`ConversationPane.expandForWorkbench`: opening
sets the owning card expanded, overview hides its workbench while retaining the
controller, native page and draft. A narrow expanded card uses its reading area
without changing persisted layout or resizing the native window. Instance-scoped
ARIA IDs allow repeated Bot request IDs across conversations. Browser surfaces
yield to the narrow Agent Bus overlay through its entire transition; wide Bus
columns do not hide pages. Browser `workbench-adhd` covers scope, drafts, hidden
commands, same-ID notes, narrow/overview/mode restoration and native layout calls.
See [ADHD browser acceptance](client/workbench-adhd-2026-10-31.md).
`App.tsx` keeps the original composer and freezes the target when sending;
`workbench-draft.ts` keeps full originals separate from annotation previews.
`WorkbenchCanvas.tsx` / `workbench-board.ts` share versioned saves, a single
writer lock and undo history. `WorkbenchMarkdown.tsx` adapts pinned Vditor 4.0.1
source editing; `workbench-markdown.ts` owns revisions, CAS, bounded history and
single-writer ownership. `workbench-note-recovery.ts` retains per-window failed
saves across controller teardown; explicit device reset clears recovery too.
`vditor-assets.ts` bundles local lazy scripts and licenses without relaxing CSP.
The [workbench frame correction](client/workbench-frame-2026-10-31.md) keeps
active outlines thin and mark-coloured, with Markdown focus below the editor
instead of a second vertical strip. Only simultaneous split panes have outer
frames and spacing; one visible pane joins the tab bar without an inset frame,
including phone and maximized views with other open tabs.
`storage.ts` database v11 adds `workbenchMarkdown` to the v10 workbench stores;
legacy v9/v10 imports are explicitly additive, not an unrestricted schema bypass.
`workbench.markdown.v1` Host capability / `markdown.v1` window capability gate Bot
operations; older Hosts keep notes local. Gateway tool v7 extends the operation
enum while preserving exact v6 definitions for existing sessions.

`src/client-protocol/workbench.ts` and `src/hub/workbench.ts` own authentication,
capability negotiation, exact device/window/tab targets, one-shot admission,
idempotency and cancellation. Received requests retain cancellation through
awaits, with per-user/global intake bounds (including duplicate IDs); a closed
broker cannot register or dispatch again. Pre-dispatch Host refusals are
`not_executed`; uncertain writes keep their original ID for reconciliation.
Gateway `app_workbench` and CLI
`tarobot workbench guide|context|targets|publish|run` use the same Host contract.
The CLI guide is static; context and chart publication bind the current human
source and Bot credentials, never an owner controller. Publication returns the
authoritative message/block/version for chart open/update and is idempotent. Tools capture the
current turn's source even when an engine reuses an earlier asynchronous reader.
Unavailable/unknown results must never be described as saved content.

Electron `browser*.mjs` adds scoped WebContentsView pages through the existing
DesktopServices/NativeOwner bridge. External pages have no App preload or file
capabilities; session/permissions/lifecycle are separate from the chat document.
`browser-policy.mjs` retains the session's actual Electron version only for
YouTube's HTTPS `/api/jnn/` integrity requests, preventing the observed empty
caption responses caused by stripping that engine token. Page UA, other sites
and App-token removal stay unchanged. The header listener leaves and returns
with the native request filter; extension compatibility mode keeps control of
its own network handling and is outside this caption fix. Regression coverage:
Electron `browser.test.mjs` (URL/header bounds, per-session versions and filter
restoration) and `browser-extensions.test.mjs`. Source-level Mac playback and
native browser checks do not certify Windows installed-App acceptance. This is
desktop page-session behavior; the headless Host/CLI contract is unchanged.
User takeover can only be resumed by trusted UI. `workbench-browser.ts` merges
native layout across panels and hides pages behind dialogs/menus.
`BrowserPageTools.tsx` and `workbench-browser-tools.ts` add trusted-user page
controls (find, print/PDF, zoom, device-size preview, PNG save, downloads, history,
clear-data choices and scoped settings). New commands are capability-gated,
excluded from the Bot action allowlist and refused by the Hub's user-only guard.
Electron `browser-user-tools.mjs` / `browser-user-store.mjs` handle native helpers
and conversation-scoped local metadata. Saved idle history lists are bounded at
16 loaded scopes; active operations and unsaved writes are retained, and live
tickets reload evicted data without reviving cleared history. See [page tools and acceptance](client/browser-page-tools-2026-10-31.md).

`BrowserExtensions.tsx` / `browser-extensions.ts` expose the desktop person's
extension manager from the page menu. The manager explains the URL/ID
installation flow and that the store page's Add to Chrome button is unavailable;
compatibility mode affects
installed extensions' network rules, not installation. Per-extension status also
separates current-browser access from compatibility: neither switch grants the
other. See [effective-scope diagnosis](client/browser-extension-effective-scope-2026-11-03.md).
The manager separates identity/enable, scope and maintenance controls; see
[extension layout verification](client/browser-extension-layout-2026-11-03.md).
This presentation-only guidance
has no headless CLI impact. `workbench_browser_extensions` is a trusted
native command, absent from the Bot browser action contract. Electron
`browser-extensions.mjs`, `extension-archive.mjs` and `crx3.mjs` stage bounded local
packages or verified Chrome Web Store downloads and load them only in managed
page sessions, never the App session. Default scope is the personal browser;
conversation-page access needs a separate native confirmation. Compatibility
mode is off by default and bound to the exact page scope. Its explicit opt-in
permits extension background scripts and settings pages to reach local/LAN services; switching it
off restores the native request filter before restarting extensions.
Enabling drains the exact session's existing page documents before removing
the filter, then recreates visible tabs under the extension policy. Busy pages
refuse the switch; possibly unsaved input requires a separate reload decision.
Changed pages or a concurrent reset invalidate that decision. A failed settings
write restores default protection. Policy failures do not retry on every sync;
the person can retry explicitly. Host removal unloads its extensions and removes
the session mapping. See the [post-1.0.123 audit](client/post-1.0.123-audit-2026-11-01.md)
for actual Electron checks and remaining platform limits.
`extension-bridge.mjs` supplies a limited service-worker API bridge for managed
pages of the extension's own session. This is not full Chrome API parity.
`browser-google-signin.ts` recognizes Google's explicit rejection URL and offers
a user-clicked system-browser continuation; cookies/login are not transferred.
Headless CLI is not applicable to these device-local browser preferences, and
Bot tooling cannot install extensions or switch compatibility mode. See
[extension behavior and verification](client/browser-extensions-2026-11-01.md).
Manifest-declared settings pages open through the trusted `options` command in
a separate sandboxed window using the exact extension session. Availability is
derived from the installed package; personal-only settings are explicitly labelled
when opened from a conversation manager. See [settings isolation and acceptance](client/browser-extension-options-2026-11-02.md).
Targeted coverage: Electron `extension-options.test.mjs`, `browser-extensions.test.mjs`,
`extension-bridge.test.mjs`, existing browser/native contract tests; Playwright
`browser-extensions.spec.ts` and `browser-page-tools.spec.ts`.

Focused regression paths: `tests/hub-workbench*`, `workbench-cli-tools`,
`workbench-cancel-admission-race`, `workbench-cancel-retention-review`,
`workbench-gateway-rejection`,
Gateway app-tool/source tests; client `workbench-*`, `excalidraw-assets`,
`desktop-migration`; browser `workbench`, `workbench-storage`, `workbench-send`,
shared side-conversation/Widget/Report tests; Electron `browser.test.mjs` and
`browser.smoke.mjs`; native `tauri_migration_core`.
See [implementation and acceptance boundaries](client/conversation-workbench-2026-10-30.md)
and [Vditor notes](client/workbench-markdown-2026-10-30.md).
The [iOS Workbench layout correction](client/ios-workbench-2026-11-04.md)
scopes safe-area ownership, wrapping whiteboard tools and short-editor scrolling
to iOS. Cover `client/e2e/workbench-ios-layout.spec.ts` in WebKit and Chromium;
browser native-inset inputs do not establish installed-device acceptance.
The [stability audit](client/workbench-stability-2026-10-31.md) records initialization
and hidden-editor cleanup, chart interaction continuity, native wake/capacity/cancellation
fences, layout IPC deduplication, admitted-close receipts and DeepSeek native tool registration.
Slow navigation can outlive the Host deadline: keep the uncertain action's request ID
(resending it returns the recorded outcome), and reconcile with fresh list/observe reads.
Never replay that action under a new ID.

The [usability and persistence audit](client/workbench-ux-audit-2026-10-31.md) adds
menu keyboard recovery, editor-resource retry, explicit closed-content deletion,
atomic board creation and layout-CAS recovery. Browser title/URL persistence is
coalesced while live native state continues. Trusted local Host removal/reset
clears only its attributable website partitions, retaining a durable retry on
failure; this reset IPC is not a Bot/browser action.
Note/board delete labels name the selected item; the confirmation names its
conversation/device scope. Closing a tab retains content for reopening.
See [delete wording](client/workbench-delete-labels-2026-10-31.md).
Failed whiteboard saves retain the unsaved scene and its actual stored revision
through editor remounts. Tab deletion checks the same editor leases as the library
and broadcasts committed deletion IDs to other windows. Regressions:
`client/tests/workbench-retained-content.test.ts`,
`client/e2e/workbench-audit-retention.spec.ts`, `workbench-library-storage`.

[1.0.128 preflight](client/release-1.0.128-preflight-2026-11-03.md) records the
authorized Design/PPT release scope, CLI parity and fresh upstream inventory.

[The responsiveness audit](client/workbench-efficiency-2026-11-10.md) documents
the canvas reveal handshake, bounded registration coalescing, shared whiteboard
reads and native browser overlay tracking. Cover `workbench-controller`,
`workbench-registration`, `workbench-design-frame-reveal` and
`workbench-browser-layout`; actual editor entrypoints also assert the upstream
reveal mark. These scheduling changes retain save and scope fences.

### Baoyu Design / Baoyu PPT skills (2026-11-03)

[The 2026-11-10 upstream refresh](client/workbench-upstream-2026-11-10.md) pins
both editors and adapted skills to 2.12.2, keeps offline authoring and native PPT
routing, and records editor/browser acceptance separately from installed Apps.

`skills/baoyu-design` and `skills/baoyu-ppt` are TaroBot adapters, with pinned
upstream authoring references, not upstream's local-server workflow. Use them
for explicit Baoyu requests or an unambiguous continuation of the selected Baoyu
project; ordinary PPT/design requests retain native engine skills. In particular,
“用 Design 做 PPT” uses the engine's native presentation skill, even with a Baoyu
tab selected. See [PPT selection and validation](client/baoyu-ppt-routing-2026-11-03.md).
“做 PPT 放工作台” also retains native authoring: Workbench is the destination,
not a skill choice. An explicit Workbench PPT request can open the slide editor;
the guide covers publishing native-authored content without loading a branded
skill and distinguishes that from binary PPTX import. New tool contract v13 uses
neutral labels; old schema digests remain exact and receive the corrected guide.
`install-skills.sh --skill ...` copies
references as well as SKILL.md; the Host package includes the same allowlisted
resources. Release upstream checks include both skills and editor assets.

PPT reuses `design.*` and storage but has `format:slides`, `designFormat:slides`,
`deck.json` v4 and slide HTML. Host `workbench.design.slides.v1` / App
`design.slides.v1` fence old peers; new tool schema v11 preserves v1–v10 digests.
The opener, library recovery and import preserve the requested/stored format.
ADHD auto-opening remains disabled. `client/vendor/baoyu-slides` is pinned and
patched by `design-assets.ts`; a lazy separate sandbox shares the existing opaque
loader, virtual file bridge, CAS and quit guards. Never substitute a canvas for
unsupported PPT or permit external network/Host paths to make upstream tools work.
See [integration and acceptance](client/baoyu-design-ppt-skills-2026-11-03.md).
The [canvas/PPT follow-up audit](client/baoyu-canvas-ppt-audit-2026-11-03.md)
records the 2.8.2 pin, two-editor scope, comment/history/backup ownership,
sharing boundaries and held-publication validation.

The [second Design/PPT review](client/baoyu-design-ppt-second-review-2026-11-03.md)
records shared snapshot freshness, resource loading, private-data visibility,
bounded result fragments, slow-reader handling, owner recovery and definite
refusal/old-Host outcomes.

### Workbench Design canvas (2026-10-31)

Explicit Design tasks may use `design.open` (`workbench.design.open.v1`, tool
schema v10). The lightweight `use-workbench-design-opener.ts` /
`workbench-design-opener.ts` endpoint belongs to the sending App conversation; it
loads no editor during ordinary chat. ADHD panes never register an automatic
opener; explicit content-link/file-library opening and existing content operations remain available.
Electron additionally requires native visible/not-minimized state from
`desktop_window_read` and `window-state` events: Page Visibility alone stays
visible for hidden windows with background throttling disabled. Regressions:
`design-opener-visibility`, `workbench-design-opener`, `desktop-services`.
`workbench-open-design.ts` waits for the
actual panel and returns its saved, registered Design target. Retiring the opener
on navigation/hide/close invalidates old source requests. Content controllers and
other Workbench commands remain separate. See [automatic opening and acceptance
boundaries](client/design-auto-open-2026-11-01.md).

`Workbench.tsx` / `WorkbenchDesign.tsx` add the baoyu-design canvas editor as a
`design` tab. See [scope, lifecycle and validation](client/workbench-design.md).
`client/design-assets.ts` verifies pristine vendor hashes and builds the offline
opaque-origin editor; `design-frame.ts` owns DOM lifetime/flush and `design-runtime.js`
provides a per-tab file/comment/event bridge. Never serve project code at the App origin or
relax the App script policy. The build adapter must keep upstream filename filtering
compatible with the shared Unicode Design paths; saved files alone do not prove
rendering. Cover multi-page Unicode publishes, reopen and Electron rendering; see
[the silent artboard filtering defect](client/design-unicode-artboards-2026-11-03.md).
The trusted loader contains no project data or message handler before its
data-origin navigation.
`design-wheel.ts` supplies bounded viewport wheel input to both the canvas and
PPT build adapters, including nested artboard forwarding. Native scroll, touch
and fit boundaries stay upstream-owned. Cover `workbench-wheel.spec.ts` when
upgrading either bundle; see [wheel navigation](client/baoyu-wheel-2026-11-03.md).

`workbench-design.ts`, `workbench-design-session.ts`, Cache v13 workbenchDesign
plus workbenchDesignMeta/workbenchDesignObjects,
`workbench-controller.ts` own bounded files, SHA/CAS, atomic content/layout writes,
request receipts, creation/import/deletion, and editor recovery. Full local reset and
all desktop migration allowlists include workbenchDesign. Content is device-local.

`src/client-protocol/workbench-design.ts`, Hub WorkbenchBroker, Gateway and CLI share
`workbench.design.v1` / `design.v1`; native tool schema v9 adds create/read/publish
without changing persisted v1–v8 digests. `src/gateway/design-guidance.ts` is the same
on-demand recipe in App tools and `tarobot workbench guide`; no direct Host file
paths or new authority. Run the focused tests listed in the feature guide when
changing this integration, including real editor flush/reopen and Electron CSP.
`design-frame.ts` must rebind surface sizing after a Bot reload and propagate
App/system appearance changes without replacing the live editor. The Electron
`design-quit.mjs` fixed script collects each current DesignFrame's locked flush
before quitting; the opaque iframe cannot guard the parent by itself. Only a
still-locked, saved instance can reuse its preparation. Cancel, destroy and reload
invalidate its epoch/generation; late results cannot authorize a later quit.
`DesktopUpdates` awaits the same preparation before installation, fences competing
commands and cancels before mutation when preparation fails or the document retires.
A verified bundle replacement keeps its prepared locks even on Host restart failure;
actual quit still checks current editors and browser pages, never a stale native
boolean. Bot writes during the lock return `design_closing`; no new CLI authority
or native command is exposed. Browser/reload paths retain a conservative unload
confirmation; live unresponsive-renderer preparation times out to cancellation.
The text-read bridge normalizes UTF-16 page starts before calculating their ends.
Cover this with `workbench-design-audit.spec.ts`, Design session tests, Electron
`design-quit`/`updater`/`lifecycle` tests and the actual native Design smoke; see
[post-release audit](client/post-1.0.122-audit-2026-10-31.md).

Design remote control has an additional exact-target boundary in the Host broker:
`design.read` may use a complete frozen turn context, but `design.publish` must
explicitly name its tab. Partial targets never fall back to live selection. Design
retry journals and in-flight requests compare source-message identity; create
replay retains only a bounded validated tab ID. App tools and the headless CLI
share `design-guidance.ts` and these checks. See [conversation routing audit](client/design-conversation-control-2026-10-31.md).
The Hub must advertise `workbench.design.v1` in both App-client `ready` and Bot
`instance.ready`; direct Instance API tests bypass the Gateway capability guard.
Keep real GatewayTransport → GatewayChannel → `app_workbench` socket regressions
alongside old-Host rejection tests. See [the 1.0.123 handshake defect](client/design-gateway-capability-2026-10-31.md).
Regressions: `tests/hub-workbench-design-routing.test.ts`, signed-socket Design
coverage, and `client/e2e/workbench-design-routing.spec.ts` (actual editor/storage).
Public DesignSession refreshes share its mutation queue so a delayed old read
cannot roll the live revision behind a completed save. Queue-internal operations
use a private refresh to avoid recursive waiting; a rejected refresh does not
block later saves. See [overall efficiency and stability follow-up](client/overall-efficiency-stability-2026-10-31.md)
for shared-path measurements, lifecycle checks and unresolved frame-timing limits.

## Dispatcher Bots (#110)

Shown in the App as 幕僚长 / Chancellor. A dispatcher Bot is chosen at creation (`createBotSchema.role`), keeps one
direct conversation and runs tickets directly on installed engine CLIs through
hidden per-engine worker Bots (`BotManager.dispatchWorker`, `role: "worker"`)
in hidden worker conversations. `hub/dispatch.ts` owns settings, the ticket ledger, dispatch,
the 2 s settlement sweep (ticket update and dispatcher notice in one
transaction) and `engine_health`; `hub/server.ts` exposes the owner routes and
`/api/instance/tickets` for the dispatcher's own turn. `host-cli/tickets.ts`
serves both the owner controller and a Bot-run CLI (via
`host-cli/bot-messages.ts::instanceEndpoint`). The Gateway injects
`dispatcherInstructions` for `config.role === "dispatcher"` and maps a worker
conversation's `ticket` marker to Core `engineOverride`, which Bridge passes to
each adapter for that session only. `core/errors.ts::renderedEngineFailure`
must stay in sync with `renderCoreUserFacingError`. Schema 23 adds the role,
hidden/ticket conversation columns and dispatch tables; hidden conversations
reach only `dispatch.v1` clients and never push. CLI parity: `bots create
--role dispatcher`, `tickets …`. See [dispatcher Bots](client/dispatcher-bot-2026-11-01.md).
Post-merge controls: ticket mutations and worker creation carry transaction
session/credential guards. An attempt's durable `stopRequested` targets its
exact input and fences reconnect replay in `prompt-queue`; terminal settlement
requires no live reply. `waitingFor` surfaces worker approvals/questions without
releasing their slots. Sweep batches rotate through an indexed 64-row window.
Worker ownership is committed with registration; idle permission changes create
a new worker generation rather than upgrading an active session. See
[post-merge audit](client/dispatcher-post-merge-audit-2026-11-01.md).
Efficiency follow-up: settlement checks active/pending state before materializing
reply bodies; `messages_bot_replies` indexes the exact input. Terminal replies
are paged by `(created_at,id)` with bounded excerpts instead of a 201-row cutoff.
Owner App polls may request `tickets?summary=1`; the SQL overview omits bodies
and keeps the latest attempt. Full CLI/instance reads retain their contract.
The visible ticket panel shares generation-tagged reads with the per-connection/Bot
avatar cache; reads/actions are bounded, and hidden panels pause polling.
The ticket list starts collapsed on desktop and phone, including active or
review-needed tickets. Its count/status summary stays visible; only clicking the
header expands it. Refreshes retain the user's current expanded/collapsed choice.
Review-needed counts in the summary and expanded ticket badges use a pale
selected-accent surface, including the monochrome theme's chosen accent.
This is App presentation only; Host ticket execution and CLI behavior are unchanged.
Phone ticket rows keep time/model information and actions together below the title/status row; full-width notices and cancellation confirmation retain reading order. See [phone ticket layout](client/mobile-ticket-layout-2026-11-03.md).
Owner-only `tickets remove` / ticket action `remove` hides done/cancelled entries through the additive `dispatch_ticket_removals` ledger. It retains execution data and request receipts; unfinished attempts block removal. App list reads are invalidated across actions. See [ticket removal](client/ticket-removal-2026-11-03.md); regressions: `hub-dispatch`, `host-cli-tickets`, `dispatcher-bot`, `dispatcher-polling`.
See [efficiency and stability audit](client/dispatcher-efficiency-stability-2026-11-01.md).
DeepSeek/Opus follow-up: terminal message envelopes do not prove successful work;
settlement reads foreground `nativeRun` outcomes and preserves interrupted work
for review. Scoped terminal failures do not override a completed parent, while
live scoped runs still block settlement. Success only clears health older than
the successful attempt's start, preserving later concurrent failures. See
[independent findings and adjudication](client/dispatcher-deepseek-audit-2026-11-01.md).
Ticket context recovery: the Gateway supplies a short per-turn
`AppPlatformTools.executionInstructions` contract; Codex sends it in its own
`tarobot.execution` application-context entry so long App/media prose cannot
clip the current ticket context. The shared dispatcher instructions retain the
same contract for other adapters. Bot CLI writes reject missing context before
sending and explain Host `dispatch_context_not_active` without guessing an ID,
switching identity or retrying. See [incident and real Codex transport evidence](client/dispatcher-context-recovery-2026-11-02.md).
The same short contract now retains per-task model/effort selection and keeps
simple execution in tickets, while conversation/status stays with the
coordinator. Omitted CLI model/effort still means defaults, not classification.
See [selection follow-up and bounded real-model evidence](client/dispatcher-model-selection-2026-11-02.md).
Permissive selection clarifies empty catalog model/effort defaults, the lowest
adequate effort and provider/order neutrality without a ranking or rotation
algorithm. See [final wording and separate plan/real-execution evidence](client/dispatcher-permissive-selection-2026-11-02.md).
Quality needs and owner-reported outcomes inform per-task selection; unavailable
preferences permit fallback, while owner restrictions remain binding instructions.
The Host reassign notice retains the same confirmation, cost and restriction
boundaries. See [quality selection and independent live evidence](client/dispatcher-quality-selection-2026-11-02.md).
Quality-aware selection also considers the required deliverable quality and
scoped owner-reported outcomes. Unavailable preferences may fall back under the
same ask/auto rules, while an explicit owner restriction prevents substitution,
including redispatch. These remain coordinator instructions, not a new Host
approval gate or automatic preference store. See the [1.0.126 preflight](client/release-1.0.126-preflight-2026-11-02.md).
Evidence-led selection adds read-only `tickets capabilities --engine E [--match TEXT] [--offset N]` through the shared owner/Bot Hub route. User-scope metadata is partial/unverified; no worker creation, model-discovery process, automatic ranking or outcome memory. Acceptance criteria and quality-failure reassessment stay in the bounded per-turn contract. See [selection change and paired real-ticket evidence](client/dispatcher-evidence-selection-2026-11-02.md). Additional regressions: `dispatch-capabilities`, `dispatch-engine-capabilities`, `bot-capabilities`, `dispatcher-selection-contract`.
Execution-time assistance adds `tickets assist` / `assist-status` for the authenticated current worker attempt and `tickets assists` for owner/dispatcher readback. `hub/dispatch-assistance.ts` defines bounded helper inputs/outcomes; `hub/dispatch.ts` owns parent yield, helper settlement and same-session continuation in the existing ticket slot. Schema 24 persists the separate ledger/allowance without changing strict App ticket/attempt markers. Gateway identifies worker turns from current Hub-owned `conversation.ticket`, not `config.role` (which only persists dispatcher). See [worker assistance and verification](client/dispatcher-worker-assistance-2026-11-02.md). New regressions: `hub-dispatch-assist`, `dispatch-assistance-boundaries`, `host-cli-assistance`, `gateway-worker-assistance-context`, `gateway-worker-assistance-lifecycle`.
`DispatcherSettings` keeps edits local until explicit save, displays Host read/save status, and guards close/reload against unsaved draft loss. Ask/auto labels describe the existing policy. See [settings save feedback](client/dispatcher-settings-save-feedback-2026-11-03.md); browser regression: `dispatcher-settings-allowlist`.
`DispatcherRoutingHelp` explains current model-selection tendencies beside the New Bot role checkbox and existing Chancellor settings; native hover plus touch/keyboard dialog access share localized copy. It changes no routing policy or CLI behavior. See [routing help](client/dispatcher-routing-help-2026-11-02.md).
A same-source six-task [DeepSeek Chancellor follow-up](client/dispatcher-deepseek-coordinator-comparison-2026-11-02.md) verifies autonomous Claude/GPT selection, while retaining a missed protocol-design defect; completed execution is not accepted result quality.
The [1.0.127 release audit](client/dispatcher-release-audit-2026-11-02.md) covers help/pause settlement and bounded `tickets assists` helper-result/continuation-delivery readback. Readback never resumes cancelled work; accepted delivery is not answer acceptance.
Regressions: `hub-dispatch`, `hub-dispatch-efficiency`, `hub-dispatch-health`, `hub-dispatch-auth`, `host-cli-tickets`, `gateway-dispatch`,
`gateway-dispatcher-context`, `client-dispatcher-settings`, `engine-override`,
the six adapter suites, `hub-bot-manager`, schema-version suites, and browser
`dispatcher-bot`, `dispatcher-polling`, `dispatcher-settings-allowlist`, `avatar-agent-state`, `creation`.

### Release 1.0.125 preflight

[Release checks and file-lock creation race](client/release-1.0.125-preflight-2026-11-01.md); [upstream integration inventory](client/release-1.0.125-dependency-inventory.md). `src/state/file-mutex.ts` retries only ENOENT from either container/ticket creation with deadline and abort checks; `tests/file-mutex-creation-race.test.ts` covers success, permission denial, repeated failure and cancellation. Publication and installed acceptance remain separate receipts.

### 1.0.125 publication readback

See [release verification](releases/1.0.125-verification.md) and [source-bound receipts](releases/1.0.125-verification.json) for Mac/Android/canonical CLI publication, TestFlight internal availability, CI/editor/runtime evidence and guarded artifact retention. Installed Mac 1.0.125 / Host and CLI 0.1.470 passed native CUA window/version/connection checks plus the already-passed installed runtime and real DeepSeek checks; identity and baseline history IDs were preserved. Installed GUI smoke and isolated feature tests remain distinct. Windows remains owner-deferred.

### 1.0.126 publication readback

See [release verification](releases/1.0.126-verification.md) and [source-bound receipts](releases/1.0.126-verification.json) for Mac/Android/CLI publication from `e54dcc9`, TestFlight 1.0.126 (1) internal availability, final-source CI, unchanged local failure retakes, real CLI and packaged-model checks. Installed Mac 1.0.126 / Host and CLI 0.1.471 passed runtime, real-model and CUA native window/version/Host-connection checks; baseline identity/history were preserved. The GUI device remains unauthorized for remote-screen viewing, so no capture/control acceptance is claimed. Windows remains owner-deferred. Guarded cleanup retained the sealed 1.0.126 backup, and the unfiltered Spotlight query returned only the installed App.

### 1.0.127 publication readback

See [release verification](releases/1.0.127-verification.md) and [source-bound receipts](releases/1.0.127-verification.json) for Mac/Android/canonical CLI publication from `f22db812b0f6c76074d791b78a3bf63f276e4250`, TestFlight 1.0.127 (1) internal availability, source/native/browser/real CLI/packaged-model checks, final CI and the separately committed scanner policy. Local Mac 1.0.127 / Host and CLI 0.1.472 now passed installed runtime, real model and CUA native window/version/GUI Host-connection checks; schema migrated from 23 to 24 with identity and baseline IDs preserved. Full functional acceptance remains incomplete: the first real local screen-view session stayed paused without frames; disconnect/reconnect recovered sustained viewing and closing removed the session. Its original trigger is unresolved, and no native input was posted. Newer main UI/extension fixes are not part of this frozen release. Windows runtime remains owner-deferred. Scoped cleanup retired five old release Apps; the unfiltered Spotlight query returned only the installed App. The defective DeepSeek-generated protocol answer was rejected and not imported.
