# TaroBot licensing

Copyright (c) 2026 Cloveric.

Except for components carrying their own license or attribution, TaroBot is
licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`). The complete, unmodified license text is in [LICENSE](LICENSE).
This applies to the shared host, CLI, desktop/mobile client, optional adapter
code and other project-owned material in this repository.

TaroBot is distributed without any warranty; see sections 15 and 16 of LICENSE.
The SPDX identifier explicitly selects version 3, rather than granting an
automatic option to use a later version.

## Separately licensed components

Their existing copyright, license and attribution notices remain in force.
The project license does not replace those component notices.

The table below and the in-App **Settings → About → Acknowledgements** screen are
generated from [`third-party/acknowledgements.json`](third-party/acknowledgements.json)
plus bundled npm runtime dependencies via `npm run acknowledgements:generate`.

<!-- acknowledgements:table:start -->
| Component | Version / commit | License | Location & usage |
| --- | --- | --- | --- |
| [Infinite Canvas (basketikun)](https://github.com/basketikun/infinite-canvas) | `4c67f1ece4f4edaef81e58e964eb78abb1e9809d` | MIT | `integrations/infinite-canvas/` — Optional Workbench editor built from pinned upstream source |
| [Dependencies bundled in Infinite Canvas](https://github.com/basketikun/infinite-canvas) | `4c67f1ece4f4edaef81e58e964eb78abb1e9809d` | Various (see complete notices) | `integrations/infinite-canvas/notices/` — Dependency notices generated from the inputs to the optional editor bundle |
| [quickjs-emscripten-core](https://github.com/justjake/quickjs-emscripten) | `0.32.0` | MIT | `client/package-lock.json` — Host-side adapter for the isolated third-party canvas node interpreter |
| [@jitl/quickjs-ffi-types](https://github.com/justjake/quickjs-emscripten) | `0.32.0` | MIT | `client/package-lock.json` — Foreign-function interface types for the QuickJS interpreter |
| [@jitl/quickjs-singlefile-browser-release-sync](https://github.com/justjake/quickjs-emscripten) | `0.32.0` | MIT | `client/package-lock.json` — QuickJS WASM interpreter compiled into the dedicated canvas node worker |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | `2.x` | OFL-1.1 | `client/src/assets/fonts/jetbrains-mono/` — Monospace code and terminal font bundled in the App |
| [Sarasa Term SC](https://github.com/be5invis/Sarasa-Gothic) | `1.x` | OFL-1.1 | `client/src/assets/fonts/sarasa-term-sc/` — CJK monospace font used for code blocks and terminal views |
| [Assistant (Excalidraw bundled font)](https://github.com/hafontia/Assistant) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Assistant/` — Sans-serif typeface bundled locally with the Excalidraw whiteboard |
| [Cascadia Code (Excalidraw bundled font)](https://github.com/microsoft/cascadia-code) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Cascadia/` — Monospace typeface bundled locally with the Excalidraw whiteboard |
| [Comic Shanns (Excalidraw bundled font)](https://github.com/shannpersand/comic-shanns) | `Excalidraw 0.18.1` | MIT | `client/dist/excalidraw/0.18.1/fonts/ComicShanns/` — Handwritten typeface bundled locally with the Excalidraw whiteboard |
| [Excalifont (Excalidraw bundled font)](https://github.com/excalidraw/excalidraw) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Excalifont/` — Hand-drawn typeface bundled locally with the Excalidraw whiteboard |
| [Lilita One (Excalidraw bundled font)](https://github.com/google/fonts) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Lilita/` — Display typeface bundled locally with the Excalidraw whiteboard |
| [Nunito (Excalidraw bundled font)](https://github.com/googlefonts/nunito) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Nunito/` — Rounded sans-serif typeface bundled locally with the Excalidraw whiteboard |
| [Virgil (Excalidraw bundled font)](https://github.com/excalidraw/excalidraw) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Virgil/` — Classic hand-drawn typeface bundled locally with the Excalidraw whiteboard |
| [Xiaolai (Excalidraw bundled font)](https://github.com/lxgw/kose-font) | `Excalidraw 0.18.1` | OFL-1.1 | `client/dist/excalidraw/0.18.1/fonts/Xiaolai/` — CJK hand-drawn typeface bundled locally with the Excalidraw whiteboard |
| [LobeHub Model Brand Icons](https://github.com/lobehub/lobe-icons) | `bcdb7c82792a854c2967f7328e11a30205ea584d` | MIT | `client/src/assets/model-brands/` — Model provider brand icons (OpenAI, Claude, Gemini, DeepSeek, Kimi); trademarks belong to their respective owners |
| [Pi Project Mark](https://pi.dev) | `monochrome mark` | Trademark notice | `assets/product/engines.png` — Monochrome mark identifying the supported Pi engine in product documentation artwork |
| [Bricolage Grotesque](https://github.com/ateliertriay/bricolage) | `1.x` | OFL-1.1 | `assets/product/fonts/BricolageGrotesque-Bold.ttf` — Display typeface used in product artwork |
| [Instrument Sans](https://github.com/Instrument/instrument-sans) | `1.x` | OFL-1.1 | `assets/product/fonts/InstrumentSans-Regular.ttf` — Sans-serif typeface used in product artwork |
| [IBM Plex Mono](https://github.com/IBM/plex) | `1.x` | OFL-1.1 | `assets/product/fonts/IBMPlexMono-Regular.ttf` — Monospace typeface used in product artwork |
| [Lute (bundled in Vditor)](https://github.com/88250/lute) | `vditor@4.0.1` | MulanPSL-2.0 | `client/licenses/vditor/, vditor/dist/js/lute/lute.min.js` — Markdown parsing and rendering engine bundled locally with Vditor |
| [Open Artifact slides editor](https://github.com/JimLiu/open-artifact) | `0.14.6 (132c038529e4527d1bc30561a855ffd958aa7302)` | Apache-2.0 | `client/vendor/workbench-slides/` — Workbench presentation editor core (@open-artifact/slides-editor), vendored as a built bundle with the modifications recorded in UPSTREAM.json |
| [Components bundled in the Open Artifact slides editor](https://github.com/JimLiu/open-artifact) | `0.14.6 (132c038529e4527d1bc30561a855ffd958aa7302)` | Various (MIT, ISC, OFL-1.1, MIT OR Apache-2.0; notices incomplete) | `client/vendor/workbench-slides/editor/` — Third-party code and fonts compiled into the editor bundle: React, Floating UI, zustand, clsx, Lucide, PostCSS, Nano ID, picocolors, Inter, miniz_oxide, crc32fast, smallvec; the file also lists the components whose notices are still to be added |
| [deepseek-harness-plugin](https://github.com/cloveric/tarobird) | `workspace` | MIT | `deepseek-harness-plugin/` — Independently published DeepSeek search MCP plugin |
| [@anthropic-ai/claude-agent-sdk](https://code.claude.com/docs/en/legal-and-compliance) | `0.3.329` | Anthropic Terms | `dist/licenses/claude-agent-sdk/` — Bundled Claude Code history helper (not covered by AGPL-3.0-only) |
| [xlsx (SheetJS Community Edition)](https://cdn.sheetjs.com) | `0.20.3` | Apache-2.0 | `client/package.json` — Spreadsheet parsing and preview in the App |
| [Scrapling (skill reference)](https://github.com/D4Vinci/Scrapling) | `0.5 reference` | Upstream notice | `skills/scrapling/SKILL.md` — Upstream fetching reference attributed in the Scrapling skill guide |
| [Electron (and bundled Chromium / Node.js)](https://github.com/electron/electron) | `45.3.0` | MIT (Chromium BSD-3-Clause / Node.js MIT) | `client/electron/, client/package.json` — Desktop application runtime shell for macOS and Windows |
| [Tauri & Tauri Plugins (Rust)](https://github.com/tauri-apps/tauri) | `2.12.5` | MIT OR Apache-2.0 | `client/src-tauri/Cargo.toml` — Desktop Rust migration exporter and native shell crates |
| [Tokio & Async Runtime Crates (tokio, tokio-tungstenite, futures-util, bytes)](https://github.com/tokio-rs/tokio) | `1.54.1` | MIT / Apache-2.0 | `client/src-desktop-core/, client/src-desktop-native/, client/src-desktop-updater/, client/src-tauri/` — Async runtime and WebSocket transport in desktop native Rust binaries |
| [Rustls & Reqwest TLS Stack (rustls, rustls-platform-verifier, reqwest)](https://github.com/rustls/rustls) | `0.23.46 / 0.13.5` | Apache-2.0 OR ISC OR MIT | `client/src-desktop-core/, client/src-desktop-updater/, client/src-tauri/` — Pinned TLS transport and HTTPS client in desktop native Rust binaries |
| [ring (Rust cryptography)](https://github.com/briansmith/ring) | `0.17.14` | ISC / Apache-2.0 (BoringSSL) | `client/src-desktop-core/Cargo.toml, client/src-tauri/Cargo.toml` — Cryptographic primitives and AES-GCM installation binding in desktop native Rust binaries |
| [ed25519-dalek](https://github.com/dalek-cryptography/curve25519-dalek) | `3.0.0` | BSD-3-Clause | `client/src-desktop-core/Cargo.toml, client/src-tauri/Cargo.toml` — Ed25519 device identity signing in desktop native Rust binaries |
| [minisign-verify](https://github.com/jedisct1/rust-minisign-verify) | `0.3.0` | MIT | `client/src-desktop-updater/Cargo.toml` — Signed desktop update verification in tarobot-desktop-updater |
| [Serde & Desktop Utility Crates (serde, serde_json, keyring, flate2, tar, uuid, base64, sha2, zeroize, etc.)](https://github.com/serde-rs/serde) | `1.0.229 (Cargo.lock)` | MIT OR Apache-2.0 | `client/src-desktop-core/, client/src-desktop-native/, client/src-desktop-updater/, client/src-tauri/` — Serialization, OS credential keyring, archive extraction and utility crates in desktop Rust binaries |
| [NAPI-RS (napi, napi-derive, napi-build)](https://github.com/napi-rs/napi-rs) | `3.16.1` | MIT | `client/src-desktop-native/Cargo.toml` — Node-API native addon bridge for Electron desktop shell |
| [macOS Rust Bindings (objc2, block2, security-framework, core-foundation)](https://github.com/madsmtm/objc2) | `0.6.5 / 3.7.0` | MIT / Apache-2.0 | `client/src-desktop-core/, client/src-desktop-native/, client/src-desktop-updater/, client/src-tauri/` — macOS notification, keychain and launch-guard bindings in desktop Rust binaries |
| [Windows for Rust (windows, windows-sys)](https://github.com/microsoft/windows-rs) | `0.62.2 / 0.61.2` | MIT OR Apache-2.0 | `client/src-desktop-core/, client/src-desktop-native/, client/src-desktop-updater/, client/src-tauri/` — Windows WinRT/Win32 bindings for notifications, process jobs and installer helpers |
| [OkHttp](https://github.com/square/okhttp) | `5.5.1` | Apache-2.0 | `client/android/app/build.gradle` — Android native HTTPS transport with pinned certificate verification |
| [Java-WebSocket](https://github.com/TooTallNate/Java-WebSocket) | `1.6.0` | MIT | `client/android/app/build.gradle` — Android native WebSocket transport to self-hosted Hubs |
| [SLF4J (slf4j-api)](https://github.com/qos-ch/slf4j) | `2.0.20` | MIT | `client/android/app/build.gradle` — Android logging facade for native networking dependencies |
| [SLF4J NOP (slf4j-nop)](https://github.com/qos-ch/slf4j) | `2.0.16` | MIT | `client/android/app/build.gradle` — Android no-op SLF4J runtime logging binding |
| [Bouncy Castle (bcprov-jdk15to18)](https://github.com/bcgit/bc-java) | `1.86` | MIT | `client/android/app/build.gradle` — Android Ed25519 cryptography and certificate handling |
| [UnifiedPush Android Connector](https://codeberg.org/UnifiedPush/android-connector) | `3.3.5` | Apache-2.0 | `client/android/app/build.gradle` — Optional self-hosted push notifications on Android |
| [Firebase Cloud Messaging (Android)](https://github.com/firebase/firebase-android-sdk) | `26.0.1` | Apache-2.0 | `client/android/app/build.gradle` — Optional FCM push notification delivery on Android |
| [AndroidX Libraries (Activity, AppCompat, CoordinatorLayout, Core, Fragment, SplashScreen, WebKit)](https://github.com/androidx/androidx) | `AndroidX` | Apache-2.0 | `client/android/app/build.gradle, client/android/variables.gradle` — Android platform UI shell, insets, WebView and splash screen support |
| [Apache Cordova Android (cordova-android)](https://github.com/apache/cordova-android) | `15.1.0` | Apache-2.0 | `client/android/variables.gradle, client/android/app/build.gradle` — Android Capacitor/Cordova WebView framework runtime |
| [Capacitor Swift Package (capacitor-swift-pm)](https://github.com/ionic-team/capacitor-swift-pm) | `8.6.0` | MIT | `client/ios/App/CapApp-SPM/Package.swift` — iOS Capacitor and Cordova native runtime bridge |
| Bundled npm runtime dependencies | Pinned in `package-lock.json` & `client/package-lock.json` | Various (MIT, Apache-2.0, ISC, BSD, etc.) | Generated into `client/src/generated/acknowledgements.json` and viewable in Settings → About → Acknowledgements |
<!-- acknowledgements:table:end -->

### Reusing third-party code

- Place copied third-party code in its own folder with its unmodified upstream
  `LICENSE` file beside it and add one entry to `third-party/acknowledgements.json`
  (re-running `npm run acknowledgements:generate`). Per-file source headers are
  not required.
- For Apache-2.0 code, also keep its `NOTICE` file and record modifications
  (either a short line at the top of each modified file or a `CHANGES` note in
  that folder).
- Listing a component does not make an incompatible license usable.

The standalone CLI package includes this notice, the project LICENSE and the
independent DeepSeek plugin's MIT license. Its bundled web client retains the
runtime notices under `client/dist/licenses/`.

## Transition

The project license changes on 2026-10-18, after release 1.0.91 / CLI 0.1.439.
The change applies to this revision and subsequent project revisions unless
expressly stated otherwise. Earlier releases and source snapshots keep the
licenses supplied with them; their artifacts and Git tags are not rewritten.

The repository's privacy setting is separate from its license and is unchanged.

## 中文说明

TaroBot 主项目从本次修订起采用 **AGPL-3.0-only**（仅第 3 版）。完整条款以
[LICENSE](LICENSE) 为准。独立 DeepSeek 插件、第三方库、字体和图标保留各自的
许可与版权声明。本次变更不追溯修改此前已发布的安装包、源码快照及标签，
也不改变 GitHub 仓库的可见性。

References: [GNU license text](https://www.gnu.org/licenses/agpl-3.0.html) ·
[SPDX identifier](https://spdx.org/licenses/AGPL-3.0-only.html).
