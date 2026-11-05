# 1.0.130 upstream integration inventory

Checked 2026-11-04 against official GitHub APIs and the npm registry.

| Integrated project | Bundled | Latest stable / pinned upstream | Source |
| --- | --- | --- | --- |
| Excalidraw | 0.18.1 | 0.18.1 | [Official release](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) |
| Vditor | 4.0.1 | 4.0.1 | [Official release](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) |
| Canvas/PPT editors, adapted skills and references | 2.9.0 / 8ec4b3d | 2.9.0 / 8ec4b3d | [Official release](https://github.com/JimLiu/baoyu-design/releases/tag/v2.9.0) |
| Electron | 45.2.2 | 45.2.2 | [Official release](https://github.com/electron/electron/releases/tag/v45.2.2) |
| Sarasa Term SC | 1.0.43 | 1.0.43 | [Official release](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) |
| JetBrains Mono | 19371302b95d218af43299bce79ddbddd0bc364d | same | [Official source](https://github.com/JetBrains/JetBrainsMono/commit/19371302b95d218af43299bce79ddbddd0bc364d) |

Canvas/PPT upgraded together from 2.8.2 to the newly published 2.9.0. All four
editor/skill manifests now pin 8ec4b3d2c0d661cd8ba9bf5ec4758efaa97ea61f. The
annotated tag object dfa4ef4b1c8e90f534bde9154f7c70b3a3c52142 peels to that commit.
Every vendored editor and authoring-reference file was compared with the release
archive and remains byte-identical. NOTICE adds upstream ChatGPT plugin paths;
the mixed-license carve-outs are retained. Local vendor READMEs now name the
current pin. Original SKILL.md and standalone artifact/server helper hashes were
refreshed after review. Their new NETWORK_BLOCKED guidance concerns standalone
localhost servers, which TaroBot does not bundle or run. The upstream DSH artifact
launcher and ChatGPT plugin additions do not change this embedded integration.
Motion is excluded. App-specific routing and sandbox protocols stay intact:
ordinary PPT, including a Workbench destination, uses the engine-native skill;
only explicit Baoyu choice selects the optional skill. UI labels stay neutral.

Electron upgraded from 45.1.0 to 45.2.2 with the exact dependency lock. Native
fullscreen, browser/extension and packaged checks must use the new runtime.
Static model-brand artwork and product font/image assets retain their notices.

All 68 direct production manifest entries were checked with no lookup errors.
As in the preceding release, SDK/framework/utility packages are tracked separately
from embedded editor/runtime upgrades. The known differences below require broader
API/native migrations outside this release scope; they are not claimed current.

| Manifest | Package | Locked | Registry stable |
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
| client/package.json | lucide-react | 1.49.0 | 1.67.0 |
| client/package.json | pdfjs-dist | 6.4.299 | 6.5.438 |
| client/package.json | react | 19.3.0 | 19.3.1 |
| client/package.json | react-dom | 19.3.0 | 19.3.1 |


Fresh source/native/browser/package results and production dependency audit results
are recorded in the release evidence. This inventory alone establishes neither
publication nor installed-App or physical Windows acceptance.
