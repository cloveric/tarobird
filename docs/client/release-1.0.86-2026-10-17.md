# TaroBot 1.0.86 / host CLI 0.1.434

This release brings the desktop ADHD board, phone image gestures, saved-file
recovery, reply-source and context-maintenance indicators, reconnect fixes and
the independently reviewed host fixes into installable packages. Brief host
outages now retain previously visible conversations for five minutes; expired
grace periods respect the Show disconnected Bots preference. Offline status
remains truthful and revocation is immediate.

## Packages and compatibility

- [Mac Apple Silicon and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.86).
- [Windows x64 and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.86).
- [Android APK](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.86).
- Executable source: [87f9cd7](https://github.com/cloveric/tarobot/commit/87f9cd7705471e8044b709ce618da8a13368e445).
- App **1.0.86**, bundled host / standalone CLI **0.1.434**, bundled Node **24.14.0**.
- Protocol **1**, network membership **2**, Hub schema **17**, accepted input schemas **1–17**.
- Android version code **2026101704**, original signing certificate and Firebase
  application configuration retained. Each host still needs its own sender setup.
- Mac is ad-hoc sealed, without Apple notarization. Windows has a pinned-key
  updater signature, without Authenticode signing. Those are different checks.

Both desktop updater channels include a signed artifact, signature, manifest,
checksums and matching CLI. Mac also includes the bootstrap DMG. Existing Mac
1.0.85 users can use Settings → Application updates after GitHub sign-in; older
DMG-only installations need a bootstrap upgrade. Publication alone does not
upgrade an installed App or remote host.

## Included changes and CLI parity

The desktop-only ADHD board supports multiple conversations with independent
composers, scrolling, selection and message operations. Phone image viewing
adds swiping within the same bubble, double-tap and pinch zoom. Android restores
verified download receipts so reopening a saved attachment does not download it
again. Reply-source links and adapter-specific context-maintenance states make
queued replies and ongoing work clearer. These presentation features do not
introduce separate headless commands.

The matching CLI contains the shared cross-Bot fixes: bounded transfer pacing,
appropriate transfer/request time budgets, early owner-session refresh, strict
reply target/file validation, safe file names, turn-scoped provenance and bounded
audit retention. Ordinary App retry cannot silently turn a Bot task into a user
message. Agent Bus routing remains local. Mac update preparation now cleans only
verified abandoned preparation copies and retains ambiguous/recovery backups.

See the [day audit](day-commit-audit-2026-10-17.md),
[ADHD design and verification](adhd-board-2026-10-17.md), and
[disconnect visibility rules](disconnected-bot-visibility-2026-10-17.md).

## Verification

Artifact hashes and final publication read-back are recorded in the
[sanitized receipt](evidence/release-1.0.86-2026-10-17.json).

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | 322 files; **4,229 passed**, 1 Windows-only skipped; standalone build passed | Four workers; no relaxed assertions or timeouts |
| Client build | Clean dependency install, translations, TypeScript and Vite passed | Shared renderer build |
| Mac native tests | **64 passed** | Native policy, lifecycle and recovery tests |
| Android | **30 unit tests passed**, lint 0 errors / 24 warnings; release APK built | No physical-phone result inferred |
| Final Mac DMG | Read-only mount; deep/strict seal, version, icon and embedded renderer checks passed; **756 host/CLI files matched** | Apple Silicon; ad-hoc seal |
| Final Windows installer | Extracted NSIS; exact embedded renderer and **756 host/CLI files matched**; native dependency gate passed | Cross-built x64; no native Windows run |
| Native Mac updater | Tampered archive rejected; signed archive installed; Hub restarted; identity, pairing, chat and file retained | External App copy and synthetic state; no production OAuth/UI claim |
| CLI clean install | Production install, dependency tree, local pack, extraction, second clean install and startup passed | No Feishu SDK, OS service install or registry publication |
| CLI upgrade | **0.1.433 → 0.1.434**; identity, controller, network and workspace retained | Disposable host on external disk |
| Real Codex chain | Text/two-client sync, original-file round trip, local ASR, question submission and stop/resume passed | Authenticated client protocol → Hub → supervised Gateway → real engine; no physical-phone UI |

The behavioral commits immediately before the version bump also passed the
documented Chromium/WebKit audit and targeted reconnect regressions, including
26 five-minute-grace scenarios. Those earlier results are not counted as new
installer/device acceptance. The audit document retains the initial failures
and unreproduced browser anomaly rather than claiming a completely green browser
suite. Codex is the real provider exercised in this release; Claude, Kimi,
DeepSeek and Antigravity adapter regressions are covered by source tests, with
their live-device/provider acceptance not repeated here.
The earlier two-physical-host collaboration acceptance is not rerun or claimed
as fresh evidence for this release.

Windows is built on the Mac with the Windows toolchain, then extracted for exact
embedded-renderer, host/CLI and native dependency checks. This does not establish
native Windows startup or update acceptance. An initial isolated Windows build
copy missed a generated file while another build regenerated it; regenerating
the standalone graph inside the Windows copy corrected this build preparation
failure without changing product code or weakening checks.
The exact-byte gate then caught different generated module labels in
`relay-runtime.mjs` because the isolated copy resolves dependencies through a
symlink. The Windows host now uses the already-verified canonical CLI bundle,
and its installer is repackaged and re-signed before repeating the gate. The
comparison is not relaxed to accept different bytes.

[GitHub Source checks 39010280934](https://github.com/cloveric/tarobot/actions/runs/39010280934)
did not start any steps: GitHub reported failed account payments or a spending
limit requiring adjustment. Local passing results are not GitHub CI success.

## Local Mac activation

The user's installed App is upgraded separately from publication. An external
helper waits for this active Bot turn and other local work to finish, takes an
offline state snapshot, replaces the sealed App, and checks the resumed host's
version, identity and history. The previous App and private snapshot stay on the
external disk; private credentials and production data are not release assets.
The helper's activation receipt is separate from the isolated installer evidence.
Do not report production activation as complete before that receipt succeeds.
