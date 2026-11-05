# TaroBird 1.1.0 dependency upgrade and preflight

Checked 2026-11-04 against official project APIs and the npm registry. The owner explicitly chose to upgrade all 31 previously deferred foundation dependencies before this release. The matching Capacitor CLI also moves to 8.6.0.

| Manifest | Package | Previous | Upgraded |
| --- | --- | --- | --- |
| package.json | @agentclientprotocol/sdk | 1.4.0 | 2.4.0 |
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
| client/package.json | @tanstack/react-virtual | 3.14.13 | 3.14.26 |
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
| client/package.json | linkedom | 0.18.14 | 0.18.15 |
| client/package.json | lucide-react | 1.49.0 | 1.68.0 |
| client/package.json | pdfjs-dist | 6.4.299 | 6.5.438 |
| client/package.json | react | 19.3.0 | 19.3.1 |
| client/package.json | react-dom | 19.3.0 | 19.3.1 |

The release retains Electron 45.2.2, Excalidraw 0.18.1, Vditor 4.0.1, canvas/PPT 2.9.0 at `8ec4b3d2c0d661cd8ba9bf5ec4758efaa97ea61f`, Sarasa 1.0.43 and the existing JetBrains Mono commit. Fresh official release/head checks found no newer stable integration version. Fifty-six vendored editor/reference/notice files match the official Git tree; the six original skill/helper blobs also match their pinned manifests. Ordinary PPT routing and explicit optional-skill selection remain separate.

## Compatibility work

- [ACP SDK migration](https://github.com/agentclientprotocol/typescript-sdk/blob/v2.4.0/MIGRATION_STABLE_UNSTABLE.md): replace removed legacy connections with typed client apps, handlers and peer request/notification calls. The existing full ACP v1 feature set explicitly uses `/unstable`; this does not switch the wire protocol to ACP v2. Model selection, permissions, terminal operations, fork cleanup, session resume and cancellation retain their contracts.
- Notification action callbacks now read the nested notification envelope while retaining the old flat format for legacy shells. A missing notification cannot be replaced by a stray top-level payload. A focused browser regression failed before the fix and passed afterwards.
- [X.509 3](https://github.com/PeculiarVentures/x509/releases/tag/v3.0.0) retains the certificate-generation API, tightens DER parsing and requires Node `^20.19.0 || >=22.12.0`. The standalone package requires Node >=22.12.0; official Node 24 remains recommended and bundled. This minimum form remains readable by the previous CLI updater, which rejects compound ranges even on a compatible Node. A regression using the actual release manifest reproduced that rejection before the metadata correction. Node 20 standalone operators must upgrade Node before staging this release. The unified CLI moves from the released 0.1.475 line to 1.1.0; old releases are untouched.
- [Croner 11](https://github.com/Hexagon/croner/releases/tag/11.0.0) changes DST edge cases: fixed times in a spring gap run at the first valid time; interval jobs continue through repeated fall-back times; fixed times still run once. Dashboard regressions cover these cases. No persisted schedules are rewritten.
- Capacitor npm/native pins are aligned at 8.6.0. Xcode resolved the updated filesystem plugin to IONFilesystemLib 2.0.1. Native IDs and App Groups are unchanged.

## Evidence boundary

The complete Vitest retake passed 639 files and 8,243 tests, with six existing skips; all 18 Node artifact/privacy/version checks passed. Focused adapter/cron/TLS checks passed 197 tests, native-event browser checks passed 42, and the CLI updater passed 47 tests using the actual release engine requirement. Android compilation and 45 JVM tests passed. Chromium passed 75 product journeys, WebKit eight, and the dependency-focused PDF, formulas, Markdown, whiteboard and iPhone checks passed 44. Host/client builds and fresh lockfile installations passed; both production dependency audits report zero vulnerabilities. Native packaging, signing and downloaded artifact verification will be recorded separately. These checks are not publication or physical-device acceptance.

The initial Electron contract run had one history test that assumed asynchronous disk work completed in ten milliseconds. The test now waits for the existing store flush contract; its assertions are unchanged. All 369 Electron contracts passed on retake. No browser-history production behavior was changed for that test.

The first full suite retained nine assertions for the old product name or CLI bin map, plus two Node test files incorrectly collected by Vitest. The assertions now reflect the current public names and both CLI aliases; Node tests run explicitly with `node --test`. No test is waived. The complete suite retake passed. A synthetic screen-capture runner initially lacked its optional local Electron install after `npm ci` intentionally skipped the binary download; the runner was bound to the verified cached runtime and passed without a product change.

Final artifact review also rejected Mac tar headers carrying the build user and optional iOS symbols carrying archive paths. Mac archives now normalize owner/group metadata without changing modes, payload bytes or symlinks; iOS export plans keep diagnostic symbols local. Real archive-header and export-plan regressions failed before these corrections and passed afterwards. No rejected candidate was published.

A subsequent unpacked macOS check also caught the native addon’s Mach-O install name retaining its build location. Packaging now assigns the copied addon a neutral `@rpath` identity before signing. A compiled-library regression checks that the original path is removed and the resulting library can be signed and verified.
