# 2026-10-21 PR integration and release verification

Released: App **1.0.97**, Host/standalone CLI **0.1.445**. The ten PRs were
integrated in dependency order: #45, #46, #47, #49, #51, #54, #55, #56, #58, #57.
Each merge retains the original PR head. Unrelated dirty checkout changes were
preserved; publication and installation are separate gates below.

## Changes and compatibility

- Codex 6.1/6 presets and their actual effort ranges, including rejecting Luna
  ultra; shared App/CLI catalog.
- Queue editing accepts Option/Alt+Enter; diff detail returns to the file list;
  expired card actions no longer indefinitely block the outbox.
- DMG replacement reconciles an old App-managed Host only after draining;
  runtime incompatibility, startup failure and credential errors remain distinct.
- Normal groups reply only to explicitly selected/@-mentioned Bots (including
  single-Bot groups/topics). Without a recipient the message is recorded only.
  The existing mode hint and recipient selector show this; this implements the
  owner's requested group rule. Sequential and independent discussions have
  durable ordering, bounded rounds, explicit controls and preserved dissent.
- Trusted Host route synchronization and conservative multi-route selection;
  self-Bot message grants; configurable short/long voice routing and threshold.
- Retired Lark/Telegram entrypoints and SDK removed while shared Core regression
  coverage and old persisted identifier readers remain. Current instructions
  and architecture no longer direct agents to removed adapters.
- Previously interrupted stability work is included: bounded passive attachment
  readers, cache-close fencing, streaming Markdown paint progress and slow image
  swipes. Mobile schedule selection retains drafts and returns one level.
- Integration testing additionally found WebKit merging undo transactions across
  textarea boundaries. Modal history edits are now fenced from background/parent
  drafts, retaining native undo inside the active dialog. A nested-dialog browser
  regression covers undo, redo, cleanup and subsequent ordinary input.
- Mobile keyboard layouts hide the idle group-mode row to preserve room for
  messages, quoted replies and attachments; active discussion controls remain.
- Vite patched to host 7.3.7/client 8.3.5 following dependency audit.
- Immediate question/approval submissions wait for the original card's send
  receipt before choosing an in-place update. This prevents duplicate submitted
  cards when the Hub publishes a card before its Gateway acknowledgement returns.

Protocol remains **1**, private-network protocol **2**. The Host accepts existing
schema 1–20 and migrates to schema **20**. Do not run an older Host on the migrated
database. Installation takes an offline database/identity/config snapshot before
starting the new Host. Rollback after migration requires a matching backed-up
state; replacing only the App with an old binary is not a data rollback.

CLI: groups and voice management use the same authenticated Hub APIs as App;
route inspection and Bot grants retain shared identity and authorization. Queue
keyboard, modal undo and mobile spacing changes are presentation-only.

## Codex verification

- Earlier complete pre-complete gate: **415 files, 5,786 passed, five skipped**; standalone
  Host build, client TypeScript/translations/production build and **76 native Rust
  tests** pass. Standalone dependency graph contains 402 modules and no retired
  transport/Feishu SDK.
- A final gate after the modal changes exposed one intermittent duplicate
  question receipt (5,785 passed, one failed, five skipped). A twenty-run probe
  reproduced it once; holding the original send acknowledgement reproduced the
  duplicate deterministically on the unchanged integration baseline. Waiting for
  presentation and rechecking cancellation fixes both question and command
  approval paths. The related 438 checks passed; three delayed/ordinary receipt
  cases also passed. The next full gate caught a missing inactive-choice notice
  when cancellation occurred during access checking. The notice is restored;
  all 34 card-security and Gateway workflow checks pass.
- The final source is `3df0becccfd5eb39228f2dda7a35cef0e00400a2`.
  A run concurrent with desktop compilation finished with 5,783 passed, five
  failed and five skipped: one archive-fixture cleanup race, one five-second
  archive timeout and three runtime-probe failures. The standalone package
  upgrade probe also failed during that build. After compilation ended, both
  affected files passed all 403 checks without source changes, and the package
  upgrade passed. These failures remain recorded. The final full gate without
  concurrent platform builds passes: **415 files, 5,788 tests passed, five
  skipped**, standalone build, client translations/TypeScript/production build,
  and **76 Rust tests**. Rebuilt frontend bytes match all 445 packaged files.
- Chromium integration initially exposed five assertions invalidated by explicit
  group recipients, new status badges, the 120-second healthy-route probe interval
  and offline-list filtering. Corrected fixtures preserve the original invariants;
  all five passed on recheck (16 checks). No product failure was hidden by retries.
- WebKit integration: 130 passed, four explicit skips, four queue undo failures;
  all four failures reproduced and passed after the modal repair. The separate
  nested-dialog regression passes. The broader keyboard/composer/history/memory run passed 30 checks and exposed
  the mobile idle-row space regression; its corrected Chromium check and nine
  WebKit keyboard checks passed. Final global guard coverage: 18 WebKit and five
  Chromium checks, including draft persistence after reload.
- A concurrent Diff timeout test had subscribed to its second rejection too late.
  Both rejection assertions now attach immediately; real-Git focused tests and
  the clean complete gate passed without unhandled errors.
- Real Codex plus Claude: the production UI starts sequential and independent
  discussions; both participants complete, order/blindness match the mode, and
  reload retains results. Synthetic inputs and disposable Bot state only.
- Packaged CLI clean install, extracted-archive install and 0.1.444→0.1.445 upgrade
  passed, preserving Host/controller/network/workspace identity. Actual Codex
  through paired App protocol passed text sync, immutable recorded diff, exact
  attachment round-trip, local ASR, question-card submit/resume, stream stop and
  context-preserving continuation.
- Real isolated macOS process handoff: old Host remains running while its runtime
  path is replaced, then resumes through the new reconciler; old PID exits, one
  new Host authenticates, identities/conversation survive, and cold start after
  stop works. Production data was not used.
- Actual macOS Tauri/WKWebView audit: pinned TLS, authorization, proxy/redirect
  rejection, 8 MiB upload, peer-close handling and streamed 512 MiB download.
  The final native run also passed modal newline, undo/redo, repeated undo and
  post-modal editing probes. These programmatic system-WebView checks are
  distinct from physical-device gestures or the installed App menu.
- Final run-card WebKit checks: 13 passed; two clipboard cases could not start
  because this Playwright WebKit backend rejects `clipboard-write` permission.
  Those two checks are not counted as passes. The installed-App footer and ADHD
  interaction matrix in #50 remains separate from browser and package checks.

## Opus review findings and disposition

Claude Opus 5.5, effort xhigh, independently reviewed the merge plan and integrated
source. Its private review records are retained outside the repository. It did
not claim to have rerun Codex's suites.

- Verified all ten merge parents, capability unions, App branches, voice worker
  flags, connection cleanup and retired-path import boundaries.
- Restored exact ordered-model/unsupported-effort regressions during adapter-test
  migration; added route-failure assertions for local preparation failures.
- Added omitted WebKit history/Markdown/schedule suites. Heap inspector checks
  explicitly remain Chromium-only.
- F1 raised the single-Bot group default as a product decision. Kept explicit
  recipients because the owner had already required normal groups to answer only
  when mentioned; documented the change rather than introducing implicit replies.
- F2 found contradictory agent instructions and historical docs. Corrected current
  instructions/architecture, labeled historical audit material and appended
  current integration receipts to draft-era reports. The full legacy reference
  was already explicitly labeled historical, not executable setup guidance.
- Follow-up: Opus independently reproduced modal history crossing inert fields
  in pure WebKit probes, verified the proposed guard and identified settings/route
  dialogs outside CreationDialog. Adopted one global guard with HMR cleanup and
  a composer persistence fallback; real native WebView undo/redo/repeated-undo
  tests pass. Final release review is recorded separately.
- Final helper review identified inherited test environment paths, live-Host
  replacement, stale staging directories, changed GUI processes and missing GUI
  recovery after failure. The private activation scripts now use system temp
  paths, verify the stopped Host, preflight old staging, recheck GUI identity and
  recover the GUI on failure. Follow-up review also retained the installation
  root cause if Host restart fails, and prevented an interrupt during replacement
  from restarting the Host before the swap or rollback finishes. Eight
  actual-helper control-flow cases pass with
  mocked OS/filesystem/lifecycle adapters; these are separate from the real
  isolated Host handoff and eventual production installation receipts.

## Limits and remaining validation

- WebKit may consume the blocked background undo entry; saved draft text is
  preserved and newly typed text remains undoable. Existing platform cross-field
  undo outside modal dialogs is unchanged.
- Real Tailscale tailnet/cellular/lock-screen matrix remains open (#53 and the
  dedicated follow-up #59). On 2026-10-22 the owner explicitly deferred this
  matrix while authorizing the remaining integration and release work. This Mac
  requires Tailscale login and no physical Android device is connected. Route
  simulation and native Mac transport checks do not establish that matrix.
- Windows native MSIX recovery and Android physical notification/update behavior
  are not validated by cross-compilation, browser tests or package inspection.
- Real Tongyi cloud transcription/billing and iOS TestFlight/APNs are not claimed.
- Dependency audit: Host zero advisories; client retains one moderate underlying
  sprintf-js advisory reported through three package nodes (mammoth→argparse).
  App calls mammoth conversion in a worker, not its CLI argument parser; no unsafe
  forced downgrade was applied. Keep tracking the upstream dependency fix.
- Private macOS packages use ad-hoc sealing plus the existing signed updater key,
  not Apple Developer ID notarization. Stable Apple signing remains separate work.
- GitHub Actions jobs on the released source commit did not start: GitHub reports failed payments or a spending limit, and every inspected job executed zero steps. Local Gitleaks 8.30.1 history/staged scans pass; cloud CI is not reported as passing.

## Publication and local installation

The source-frozen Mac and Windows packages each match 850 files in the published
CLI archive. The Mac DMG and updater archive contain the same 5,016 file/link
entries, including bytes, modes and symlink targets; strict sealing passes.
Both desktop updater signatures and embedded updater settings pass. The Android
package retains the previous signing certificate, passes 39 unit tests and lint
(zero errors, 19 warnings), and matches all 445 final frontend files. Windows
icons and packaged runtime imports pass inspection; native Windows execution is
not claimed.

The final CLI archive passes clean/extracted installation and an actual
0.1.444-to-0.1.445 upgrade preserving Host/controller/network/workspace identity.
Real Codex App-protocol acceptance passes all six checks on this exact archive.

GitHub confirms all ten PRs merged. The [Mac](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.97),
[Windows](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.97) and
[Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.97)
releases are published, and all three tags resolve to the frozen source commit.
Every published asset was downloaded and matched against its local bytes,
GitHub digest and attached SHA256SUMS. Both desktop manifests, pinned updater
signatures and signed versions pass. Mac and Windows both include the identical
standalone CLI archive. Five cloud jobs executed zero steps due to the verified
GitHub billing block.

The old installed Mac App (1.0.96 / Host 0.1.444) has a verified sealed backup.
The 1.0.97 bundle is staged and matches all 5,016 entries; staging is not installation.
At this documentation checkpoint, production activation is still pending.
The update helper waits for active work, takes an offline state snapshot, then
replaces the App and verifies the new Host, schema and authenticated reconnect.
The current conversation itself is active Host work; its end may be required
before the helper can switch. The eventual installation receipt and installed-App
UI check must be reported separately, never inferred from staging or publication.

## Verified artifact checksums

All artifacts use source `3df0becccfd5eb39228f2dda7a35cef0e00400a2`.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| TaroBot-1.0.97-macos-arm64.dmg | 131267077 | `57103e20c20d24291aed27a3a36b13dcd32be43e09f471f49081d3c3d58f3a2a` |
| TaroBot.app.tar.gz | 132019505 | `bad219b1e06b2f561bb25ce70911c6e194c84acd674493b6bb722060cdead806` |
| TaroBot-1.0.97-windows-x64-setup.exe | 97934203 | `381203c41f3088b7d326c68b3e7726d3553d9a710b9dfb030d007cfa3b8eda24` |
| TaroBot-1.0.97-android.apk | 36569423 | `274340d79c1845d8a28fb5f2f6dde910e09f00ae6780be8bfe0706ae4768f515` |
| tarobot-0.1.445.tgz | 26106355 | `c8f9023589a0d63409bde5aca2df89e5fcd59984c6bbec37ffffb960b206f4fe` |
