# 1.0.127 upstream integration inventory

Checked 2026-11-02T13:18:17.993368+00:00 against official GitHub and npm registry APIs.

| Integrated project | Previous | Release selection | Decision |
|---|---|---|---|
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) | v0.18.1 | v0.18.1 | Current |
| [Vanessa219/vditor](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) | v4.0.1 | v4.0.1 | Current |
| [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design/releases/tag/v2.7.1) | v2.6.1 | v2.7.1 | Upgraded; adapter and save/restore regression required |
| [be5invis/Sarasa-Gothic](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) | v1.0.43 | v1.0.43 | Current |
| [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono/commit/19371302b95d218af43299bce79ddbddd0bc364d) | 19371302b95d218af43299bce79ddbddd0bc364d | 19371302b95d218af43299bce79ddbddd0bc364d | Current |

Design is pinned to `6759e358eb88d83986c753b0fc60c84e4aabdb3a` (2.7.1). The 26 bundled files were copied from that tag, with a refreshed byte manifest. The editor JS/CSS/font and print reference changed; TaroBot’s separate one-match build adapter was updated for the new symbols. The standalone server, LAN sharing and upstream agent are still excluded. LICENSE, NOTICE and third-party notices were compared and retained; no new license grant is asserted.

68 direct manifest entries checked. SDK/framework/utility/toolchain updates below remain separately tracked under the existing release boundary, rather than being described as current.

| Manifest | Package | Locked | Registry stable |
|---|---|---|---|
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
| client/package.json | @tanstack/react-virtual | 3.14.13 | 3.14.25 |
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
| client/package.json | lucide-react | 1.49.0 | 1.66.0 |
| client/package.json | pdfjs-dist | 6.4.299 | 6.5.438 |
| client/package.json | react | 19.3.0 | 19.3.1 |
| client/package.json | react-dom | 19.3.0 | 19.3.1 |

Fresh root and client production audits report zero known vulnerabilities. Design Chromium regressions passed 12/12; WebKit edit/save/restore regressions passed 8/8. Final builds and native validation are recorded in release verification; this inventory alone is not installed-device acceptance.
