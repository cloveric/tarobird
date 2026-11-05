# 1.0.129 upstream integration inventory

Rechecked 2026-11-03 at 14:47 UTC against official GitHub APIs and the npm registry.

| Integrated project | Bundled | Latest stable / pinned upstream | Source |
| --- | --- | --- | --- |
| Excalidraw | v0.18.1 | v0.18.1 | [Official source](https://github.com/excalidraw/excalidraw/releases/tag/v0.18.1) |
| Vditor | v4.0.1 | v4.0.1 | [Official source](https://github.com/Vanessa219/vditor/releases/tag/v4.0.1) |
| Baoyu canvas and PPT editors, adapted skills and authoring references | v2.8.2 / a87e91f | v2.8.2 / a87e91f | [Official source](https://github.com/JimLiu/baoyu-design/releases/tag/v2.8.2) |
| Sarasa Term SC | v1.0.43 | v1.0.43 | [Official source](https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43) |
| JetBrains Mono | 19371302b95d218af43299bce79ddbddd0bc364d | 19371302b95d218af43299bce79ddbddd0bc364d | [Official source](https://github.com/JetBrains/JetBrainsMono/commit/19371302b95d218af43299bce79ddbddd0bc364d) |

The installed 1.0.128 and this release both bundle Baoyu 2.8.2. The two editor and two adapted-skill manifests pin
a87e91ffdf77362e0061feeeeecf7f6e588cfda4; editor files, authoring references,
SKILL.md and helper provenance are included in this check. Motion is excluded.

Upstream main is four commits ahead at
609638de1594fe264f6e89b28cae986086093210. The SKILL.md and helper change adds
NETWORK_BLOCKED diagnosis for standalone localhost servers; TaroBot uses its App
bridge and does not bundle or run those standalone servers. The remaining changes
add a ChatGPT plugin marketplace and README links. These are unreleased and do
not require changing the stable editor/reference pin or copying standalone
network instructions into the App adapter. The official API reports v2.8.2;
a cached latest-release web redirect still showed v2.8.0 and was not used as the
version authority.

The licensing inventory also covers static model-brand artwork and product-only
font/image assets, with their existing notices retained. They introduce no new
runtime editor or server integration in this release.

As in the previous release inventory, direct SDK/framework/utility packages are
tracked separately from embedded editor upgrades. All 68 direct production
manifest entries were checked with no lookup errors. The following known version
differences remain recorded; they are not represented as current or silently
changed during the reviewed Design/PPT release. Their broader API/native
migrations are outside this release's editor integration scope.

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
| client/package.json | lucide-react | 1.49.0 | 1.67.0 |
| client/package.json | pdfjs-dist | 6.4.299 | 6.5.438 |
| client/package.json | react | 19.3.0 | 19.3.1 |
| client/package.json | react-dom | 19.3.0 | 19.3.1 |

The final release verification records fresh production dependency audits,
same-source builds, editor/native validation, packaged skill resources and global
skill resource readback separately. This inventory alone does not establish
publication, installed-App behavior or actual skill invocation.
