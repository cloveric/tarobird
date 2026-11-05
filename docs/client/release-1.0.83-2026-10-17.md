# TaroBot 1.0.83 / host CLI 0.1.431

This development preview packages cross-host Bot tasks and the changes made after the 1.0.80 desktop / 1.0.82 Android releases. It includes the Windows native-entrypoint repair, idle return to a healthy direct route, phone image-viewer improvements, network-management refinements and the homepage/help audit.

## Versions and compatibility

- App: **1.0.83** on macOS arm64, Windows x64 and Android.
- Android version code: **2026101701**, original `com.tarocub.client` identity and signing certificate retained.
- Bundled host and standalone CLI: **0.1.431**, executable source **70a9cca77159b33e5d271c880919662790a014a2**.
- Client protocol: **v1**; private-network membership: **v2**; Hub schema: **17**; accepted upgrade input schemas: **1–17**. This range does not authorize opening a newer database with an older runtime.
- Mac and Windows packages include Node **24.14.0**. The standalone archive requires Node 20.17+; official Node 24 is recommended.
- CLI is affected: `conversations list`, `messages send`, `messages wait`, recipient grants and revocation use the shared host APIs. Agent Bus commands remain local to one host.

[Download all four artifacts and checksums](https://github.com/cloveric/tarobot/releases/tag/v0.1.431-test.1). The release provides `SHA256SUMS` and a sanitized [verification receipt](evidence/release-1.0.83-2026-10-17.json); archived installer hashes are checked again after downloading from GitHub.

## Checks on this release

| Surface | Result | Boundary |
| --- | --- | --- |
| Source gate | Standalone build: 355 modules, no Feishu SDK; 313 files, **4,134 passed / 1 skipped** | Windows-only installed-Codex shim test skipped on Mac; not a Windows full-suite run |
| Client | Clean locked dependency install; translation, TypeScript and Vite build passed | Does not prove native provider permissions |
| Browser UI | **Chromium 38 / WebKit 38 passed**: source badges, network management, direct-route recovery, image export, model settings | WebKit source-badge case ran separately because the existing preset does not select that file |
| CLI package | Clean production install, dependency-tree audit, packed-archive extraction and installed-package startup passed | No external registry publish; no OS service installation in this run |
| CLI upgrade | **0.1.430 → 0.1.431**: identity, local controller and workspace preserved; personal deletion in the new runtime survives restart while the canonical message remains | Disposable external-disk state; production host unchanged |
| Real engine | Packaged CLI → Hub → supervised Gateway → real Codex: text/two-client sync, original file bytes, local ASR, question submission/resume, stop/context recovery passed | Protocol clients, not physical phone UI; other engines not rerun live |
| Final Mac DMG | Read-only mount, deep/strict signature, icon/version, embedded HTML/JS/CSS, **748 matching CLI/host files**, packaged-Node host smoke passed | Ad-hoc signature, no Apple Developer ID/notarization; no full final-App GUI journey |
| Mac state recovery | **6 cases passed** using old/new packaged runtimes: empty profile, local enrollment, retained identity/history/files, stale lock, corrupt config/database isolation | Synthetic data; isolating damaged state is a laboratory simulation, not a claim of a Mac fresh-reset UI |
| Final Android APK | Original signer, version/code, non-debuggable flag, zip alignment, icon variants and **390 matching frontend files**; **30 JVM tests**, lint **0 errors / 22 existing warnings** | No physical-phone or background push acceptance |
| Android upgrade | Emulator **1.0.82 → 1.0.83**, first-install timestamp retained, cold launch passed, crash buffer empty | Emulator only |
| Windows installer | Final embedded renderer and PE import checks; packaged host parity; physical-Windows result recorded below | Unsigned cross-compiled x64 preview; ARM64 not tested |

The previously completed physical **Mac mini ↔ Windows** text/file/reply exchange and same-host two-Bot exchange are recorded in [the MVP evidence](cross-host-bot-messages-2026-10-17.md#验证记录). They used isolated Hubs and real Codex Bots, before installer packaging. They are not relabeled as a fresh installer or all-engine acceptance run.

## Windows final-package result

On a physical x64 Windows computer (build **26200.9457**), the final GitHub installer was downloaded and its **95,511,004-byte size and SHA-256** independently matched the release artifact. The NSIS contents were extracted without executing the installer. The bundled Node **24.14.0**, host **0.1.431** and schema **17** were verified.

Using the packaged Node with `--preserve-symlinks-main`, both ordinary and verbatim (`\\?\`) paths passed empty-state `status`/`resume` without creating a host directory, followed by `start` → `status` → `stop`. Every command exited 0 with empty stderr, and both isolated Hub processes exited. The exact source revision's **2 Rust native command-construction tests** compiled and passed against the final package's Node. The extracted final EXE's read-only `--confirm-host-stopped` probe returned its expected exit **22**, with empty stdout/stderr, before WebView initialization.

The production desktop and Hub processes remained running, and user data/cache were not deleted. This verifies the packaged runtime and native executable loading; it does **not** verify installer execution, ordinary GUI launch or WebView. The original Windows account remains in use by a production Hub; testing the final GUI with a clean Known Folder would require a separate Windows user or VM. Redirecting `APPDATA` alone does not isolate the native App, so that is not used as a substitute.

## Initial failures and corrections during packaging

The first source-gate run used an external temporary path containing `1.0.83`. Five legacy workspace-path-decoder fixtures failed because the helper cannot reconstruct embedded dots from the lossy directory encoding. No application code or assertion was changed to hide the failures. Restoring the established external temporary root made all 17 scanner checks pass; the complete gate then passed in **252.55 seconds**. The initial log is retained privately. Actual Claude session lookup reads the recorded workspace rather than relying on that decoder.

The isolated Windows build initially produced different relay bundle module labels because `node_modules` was symlinked to the main checkout. Normalizing only that exact prefix made the files identical. Packaging now uses the canonical relay bytes shared by Mac and CLI; the final installer is re-extracted and verified. This was a build-path difference, not a changed relay implementation.

Windows verification initially hit reserved PowerShell variable names in its recorder, and a proposed temporary-file cleanup was rejected by local policy. The recorder was corrected and the final read-only checks use process pipes without file cleanup; these harness failures are not counted as product-test passes. Failed fixture directories remain intact.

Cloud [Source checks run 38976390429](https://github.com/cloveric/tarobot/actions/runs/38976390429) did **not start**: GitHub reports failed account payments or a spending limit. Both jobs have no executed steps; local success is not cloud CI success.

## Update notes and remaining scope

Update both hosts and the calling CLI for Bot-to-Bot tasks; upgrading Android alone does not upgrade a remote Hub. Preserve existing identities, pairings and data. Desktop-managed hosts should finish active work before restarting into the new App. CLI-managed hosts must stage the fully installed archive and apply it through [the update workflow](../host-cli-update.md); replacing the CLI command does not switch an already frozen service. Schema 17 must not be opened by the old schema-16 archive.

Mac and Windows signing/notarization limits, full native GUI/fresh-install journeys, physical Android interactions and lock-screen push, iOS packages, a full Windows test-suite run and live checks of every AI provider remain outside this release's evidence. Production Apps/hosts and optional Telegram/Lark fleets are not restarted by publication.
