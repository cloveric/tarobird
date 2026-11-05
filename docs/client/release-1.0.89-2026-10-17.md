# TaroBot 1.0.89 / host CLI 0.1.437

This release adds Android in-app updates, packages the DeepSeek Harness
0.2.1-rc.2 compatibility fixes, and includes the desktop ADHD product showcase.
The earlier background-report, attachment-reader and ADHD fixes remain included.

## Changes and use

- Android: open **Settings → Appearance → App updates**, connect an authorized
  GitHub account, check, download, then confirm installation in Android's system
  installer. Install this version once with the original-signer APK to bootstrap
  older clients. The existing App must not be uninstalled to upgrade.
- Downloads verify SHA-256, size, package ID, signer and increasing version.
  Authorization stays in Android native code and encrypted storage. A dedicated
  read-only provider grants access only to the verified APK. Canceling installation
  returns to a retryable state with the cached download; Android may evict cache.
- DeepSeek Harness 0.2.1-rc.2: resume existing sessions using list/follow instead of
  create; do not silently create a fresh context when resume fails. Working-directory
  notices no longer masquerade as active model work. See the
  [compatibility record](deepseek-0.2.1-rc.2-2026-10-17.md).
- The GitHub homepage presents desktop ADHD beside the desktop/mobile screenshots,
  with actual shared-client capture and explicit screenshot provenance.

Android update management is a native phone distribution feature and needs no new
CLI command. The DSH host changes ship identically in desktop-bundled host and
standalone CLI. See [Android design, limits and tests](android-github-updates.md).
Agent Bus, cross-host commands, queue policy and permissions are unchanged.

## Versions and compatibility

App **1.0.89**, host/CLI **0.1.437**, bundled Node **24.14.0**, protocol **1**,
network membership **2**, Hub schema **17**, accepted input schemas **1–17**.
Android versionCode **2026101707** retains package ID and original signer.
Source: [0fc91ba](https://github.com/cloveric/tarobot/commit/0fc91bacd5d31b97466f8be165e46aa21c839534).
Later documentation-only commits are separate from these executable bytes.

## Verification

| Surface | Result | Boundary |
| --- | --- | --- |
| Full source gate | 325 files, 4,310 passed, 1 existing Windows-only skip; standalone build passed | Local macOS run, no optional SDK dependency |
| Client | Clean dependency install, translations, TypeScript and Vite passed | Shared client build |
| Update browser tests | Chromium 22, WebKit 22; another 3 WebKit mobile-settings cases passed | Native bridge fixtures, not physical devices |
| Android production APK | 38 JVM tests; lint 0 errors / 19 warnings; original certificate retained; all 410 web files match | Public OAuth configuration, updater plugin and dedicated provider checked in packaged APK |
| Android API 36 emulator | Real system installer cancel/retry; cache persistence; tamper rejection; 1.0.88 → 1.0.89 upgrade and retained data read-back | Isolated `.updatetest` package; mocked network, real package manager; self-update terminates the old instrumentation process |
| Mac native tests | 64 passed | Real macOS native policy/lifecycle tests |
| Final Mac DMG | Read-only mount, strict deep seal, icons/version, embedded renderer and 772 matching CLI/host files | Apple Silicon, ad-hoc sealed, not Apple-notarized |
| Final Windows installer | Extracted NSIS, embedded renderer, native dependency and 772 matching CLI/host file checks | Cross-built x64; no native Windows execution or Authenticode signing |
| Desktop update signatures | Existing pinned key and signed version verified for both platforms | Separate from production OAuth UI acceptance |
| Native Mac updater | Tampered archive rejected; signed archive installed; host resumed with identity/pairing/history/file retained | Disposable external-disk App and synthetic state |
| Standalone CLI | Clean production install, pack/extract, second clean install and startup | Production dependencies inspected; no registry publication |
| CLI upgrade | 0.1.436 → 0.1.437; identity, controller, network and workspace retained | Disposable host, no OS service installation |
| Real Codex | Two-client text sync, original-file return, local ASR, native question submission and streamed stop/resume | Client protocol → compiled Hub → supervised Gateway → real engine |

The GitHub device-code endpoint accepted the configured public client ID. No
OAuth grant or token was created by that probe. Physical Android installation
and the full production GitHub authorization-to-install flow remain unverified.
The emulator upgrade is evidenced by package/version and retained-private-data
read-back, not an instrumentation pass after the process was replaced.
DSH live compatibility was checked during its feature work; this packaging pass
did not repeat other providers or physical two-host collaboration. Tests were
not weakened for packaging.

[Source checks 39038124613](https://github.com/cloveric/tarobot/actions/runs/39038124613)
executed zero steps: GitHub blocked both jobs due to account payments/spending
limit. Local checks are recorded separately and are not cloud CI success.

## Distribution and local Mac

- [Mac Apple Silicon and CLI](https://github.com/cloveric/tarobot/releases/tag/macos-v1.0.89)
- [Windows x64 and CLI](https://github.com/cloveric/tarobot/releases/tag/windows-v1.0.89)
- [Android](https://github.com/cloveric/tarobot/releases/tag/android-v1.0.89)
- [Machine-readable verification and hashes](evidence/release-1.0.89-2026-10-17.json)

All three release asset sets are downloaded again and compared against GitHub's
SHA-256 digest and verified local bytes. Desktop manifests and signed versions
are checked independently. The Mac channel includes its DMG, updater archive,
signature, manifest and matching CLI. No npm publication or optional adapter
fleet restart belongs to this release.

Publishing and installation are separate. The old local App is backed up to the
external disk; the verified new App is staged for atomic replacement. The detached
activation helper waits for this Bot turn and other active work, snapshots host
state, replaces the App, resumes the same host, verifies version/identity/history
and authenticated local connection, then opens and checks the new GUI process
and window. At publication the local activation state is **staged/waiting**, not
already installed. Its private external-disk `activation.json` records the later
result. Production GUI interaction and OAuth remain separate acceptance surfaces.
