# 1.0.124 upstream integration inventory

Checked 2026-11-01 against official GitHub release/commit and npm registry APIs.

| Integrated project | Included version | Current stable / pin | Decision |
| --- | --- | --- | --- |
| [Excalidraw](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) | 0.18.1 | 0.18.1 | Current stable; development HEAD is not a release |
| [Vditor](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) | 4.0.1 | 4.0.1 | Current stable |
| [baoyu-design](https://github.com/JimLiu/baoyu-design/releases/tag/v2.5.0) | 2.5.0 | 2.5.0 | Upgraded from 2.4.1; exact commit 8398e52f3c58ab12e080e8579de66dcb02ea384a |
| [Sarasa Term SC](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) | 1.0.43 | 1.0.43 | Current stable; font files unchanged |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono/tree/19371302b95d218af43299bce79ddbddd0bc364d) | 19371302b95d218af43299bce79ddbddd0bc364d | Same upstream HEAD | Existing font pin is newer than latest stable v2.304; no downgrade |

Design's 26 vendored hashes bind the exact upstream commit. LICENSE/NOTICE are unchanged from 2.4.1; their mixed-license exclusions remain disclosed in LICENSING.md and the shipped notices. The prior owner decision to retain Design does not establish additional distribution rights. The unused upstream share-ui.js is excluded. Standalone LAN sharing/server integration is not enabled; the existing opaque sandbox and Host authorization remain in force. Adapter symbol changes retain one-match guards and the save/flush bridge.

## Direct package inventory

68 direct manifest entries checked; 0 lookup errors. The 29 differences below are retained SDK/framework/utility/toolchain updates, separate from the integrated user-facing project gate. No blanket npm-latest upgrade or automatic audit downgrade was applied.

| Manifest | Package | Locked | npm latest |
| --- | --- | --- | --- |
| package.json | @agentclientprotocol/sdk | 1.4.0 | 2.2.0 |
| package.json | @peculiar/x509 | 2.1.0 | 3.1.0 |
| package.json | @types/adm-zip | 0.5.8 | 0.6.0 |
| package.json | croner | 10.0.1 | 11.0.0 |
| package.json | https-proxy-agent | 9.0.0 | 9.1.0 |
| package.json | smol-toml | 1.9.0 | 1.9.1 |
| package.json | ws | 8.21.3 | 8.22.1 |
| client/package.json | @capacitor/android | 8.5.2 | 8.6.0 |
| client/package.json | @capacitor/app | 8.1.1 | 8.1.2 |
| client/package.json | @capacitor/core | 8.5.2 | 8.6.0 |
| client/package.json | @capacitor/filesystem | 8.1.3 | 8.1.5 |
| client/package.json | @capacitor/ios | 8.5.2 | 8.6.0 |
| client/package.json | @capacitor/push-notifications | 8.1.2 | 8.1.3 |
| client/package.json | @capacitor/share | 8.0.2 | 8.0.3 |
| client/package.json | @tanstack/react-virtual | 3.14.13 | 3.14.24 |
| client/package.json | @tauri-apps/api | 2.12.1 | 2.12.4 |
| client/package.json | @tauri-apps/plugin-deep-link | 2.6.1 | 2.6.3 |
| client/package.json | @tauri-apps/plugin-dialog | 2.8.1 | 2.8.4 |
| client/package.json | @tauri-apps/plugin-fs | 2.6.0 | 2.7.1 |
| client/package.json | @tauri-apps/plugin-global-shortcut | 2.4.0 | 2.4.1 |
| client/package.json | @tauri-apps/plugin-notification | 2.5.1 | 2.8.0 |
| client/package.json | @tauri-apps/plugin-opener | 2.7.0 | 2.7.2 |
| client/package.json | @tauri-apps/plugin-updater | 2.13.1 | 2.14.1 |
| client/package.json | hast-util-to-jsx-runtime | 2.3.6 | 2.3.7 |
| client/package.json | idb | 8.0.3 | 8.0.4 |
| client/package.json | katex | 0.18.10 | 0.19.1 |
| client/package.json | lucide-react | 1.49.0 | 1.66.0 |
| client/package.json | react | 19.3.0 | 19.3.1 |
| client/package.json | react-dom | 19.3.0 | 19.3.1 |

## Dependency audit boundary

Fresh root installation reports zero vulnerabilities. Client production-only audit reports zero. The client development dependency graph reports seven moderate entries: two underlying glob/minimatch advisories and their build-tool dependents (@capacitor/cli, @electron/asar, @electron/packager, @electron/universal, rimraf). Registry-proposed automatic fixes include incompatible toolchain downgrades. Build inputs here are the frozen trusted repository; no user-supplied glob expressions are accepted by this release pipeline. These build-only findings remain tracked, not claimed fixed or absent.

Validation and final artifact binding are recorded in the release preflight and publication report. Browser/native-isolated checks are not physical-phone or installed-App acceptance.
