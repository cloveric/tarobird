# 1.0.126 upstream integration inventory

Checked 2026-11-02T04:11:31.993356+00:00 against official GitHub release/commit and npm registry APIs.

| Integrated project | Included | Current stable / pin | Decision |
| --- | --- | --- | --- |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) | v0.18.1 | v0.18.1 | Current; no update |
| [Vanessa219/vditor](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) | v4.0.1 | v4.0.1 | Current; no update |
| [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design/releases/tag/v2.6.1) | v2.6.1 | v2.6.1 | Current; no update |
| [be5invis/Sarasa-Gothic](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) | v1.0.43 | v1.0.43 | Current; no update |
| [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono/commit/19371302b95d218af43299bce79ddbddd0bc364d) | 19371302b95d218af43299bce79ddbddd0bc364d | 19371302b95d218af43299bce79ddbddd0bc364d | Current; no update |

All five maintained editor/font integrations remain at the verified selections from 1.0.125. Design remains 2.6.1; its upstream LICENSE/NOTICE exclusions and source hashes are unchanged. No new distribution-rights conclusion is made. Existing static artwork/branding notices remain intact.

## Direct package inventory

68 direct manifest entries checked; zero lookup errors. The differences below are separately tracked SDK/framework/utility/toolchain updates under the existing release integration boundary. They are not silently upgraded or claimed current; a blanket toolchain upgrade is outside this dispatcher release.

| Manifest | Package | Locked | Registry latest |
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

Fresh-install audits, validation results and exact release source binding will be recorded in the release verification document. Source comparisons alone do not prove installed or physical-device behavior.
