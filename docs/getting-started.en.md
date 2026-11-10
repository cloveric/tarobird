# Run TaroBird locally

[Home](../README.md) · [Product guide](product-guide.md) · [中文](getting-started.md)

This is a source-build guide. Desktop and mobile are the product interfaces;
the loopback browser below is a convenient way to check a development Hub before
opening the native App. For ready-to-install packages, use [Releases](https://github.com/cloveric/tarobird/releases). See [migration and upgrade boundaries](repository-migration.md). To run without a desktop window, see the [host CLI guide](host-cli.md).
For a phone outside your LAN, use [Agent-assisted or manual remote setup](client/remote-access.en.md).

## 1. Prepare the host

- **Node.js 24 and npm**, matching the repository's `.nvmrc`.
- Access to this private GitHub repository.
- At least one supported AI CLI installed and authenticated on the computer
  that will run your Bot: Codex, Claude Code, Kimi Code, DeepSeek Harness or
  Antigravity. TaroBot does not supply a model subscription or provider credentials.

Desktop development additionally needs Rust and your platform's Tauri build
prerequisites. macOS needs Xcode Command Line Tools; Android needs the Android
SDK and JDK; iOS needs macOS and full Xcode.

## 2. Build the Hub and client

```sh
git clone https://github.com/cloveric/tarobird.git
cd tarobot
npm ci
npm ci --prefix client
npm run build
npm run build --prefix client
```

The root install and App builds contain no Feishu/Lark SDK or Telegram Bot
transport. See [adapter retirement](adapter-retirement-2026-10-21.md) for retained
historical-data compatibility.
Dependencies and build outputs are not committed.

## 3. Start a separate development Hub

```sh
node dist/src/index.js init --name "Development host" --state-dir "$HOME/.tarobot-dev/hub"
node dist/src/index.js hub run --state-dir "$HOME/.tarobot-dev/hub"
```

Leave this terminal running. The listener is loopback-only, on the port chosen by init; use the address printed at startup. The Hub
serves the client you just built. This explicit state directory keeps development
data separate from existing Bot services. It contains this Hub's persistent
history, attachments and trusted-device records.

Open **the HTTP address printed at startup on the same computer**. Enter a host name and its
Hub address, then select **Pair this device**. In a second terminal, approve the
new code shown by the client:

```sh
node dist/src/index.js hub devices approve '<pairing-code-from-the-client>' --state-dir "$HOME/.tarobot-dev/hub"
```

Return to the client and finish connecting. If the initial interface is Chinese,
open **设置 → 通用 → 语言** and select **English**. The language setting belongs
to this device.

## 4. Create your first Bot

1. Select **New Bot**, choose an available engine and model, and give it a name.
2. Choose a workspace, or leave it blank to create a separate one.
3. Set the model's supported effort level if you need an override.
4. Open a conversation and send a short task.

The Bot's model, effort and workspace persist. A new conversation starts fresh
session context; you do not need to configure a new Bot for every task. See the
[product guide](product-guide.md) for groups, topics, memory, approvals and files.

## 5. Open the desktop App

With the Hub still running, start the native development shell in another
terminal:

```sh
npm run desktop:dev --prefix client
```

Pair the App through the same approval flow. For a local desktop build:

```sh
npm run desktop:build --prefix client
```

The product is named **TaroBot**. Existing application IDs, URL schemes and
state paths retain `tarocub` compatibility identifiers; those are not a separate product.
A development build is not a signed, notarized release.

## 6. Prepare a phone build

```sh
npm run build --prefix client
npm run mobile:sync --prefix client
npm run android:open --prefix client
# On macOS, for iOS:
npm run ios:open --prefix client
```

These commands synchronize resources and open the native projects. SDK builds,
signing, device permissions, background behavior and push delivery still require
platform setup and real-device validation. They do not install a finished phone
App by themselves.

## Connect another device

`127.0.0.1` always means the device you are using. A phone cannot reach your
computer through its own loopback address.

| Where you use it | Connection to configure |
| --- | --- |
| On the same network | A reachable LAN address, TLS and trusted Hub identity |
| Across networks with Tailscale | A reachable Tailscale route, TLS and trusted Hub identity |
| Across networks through a relay | A configured VPS relay route; the phone App connects without a separate VPN |
| With the Hub on a VPS | A secured public Hub endpoint, or a separate relay in front of it |

Remote access requires **HTTPS and the trusted Hub identity**, followed by device
pairing. A native client verifies the Hub identity against the TLS peer. Do not
publish the loopback HTTP development listener as a remote endpoint. A relay
forwards traffic; the Hub is the component that stores messages and files.

Follow [host deployment](client/host-deployment.md),
[relay deployment](client/relay-deployment.md) and the
[security model](client/security.md) before configuring remote access. Full
native remote-connection acceptance remains open; see the
[current development status](details.md#project-status).

## Verify a source change

```sh
npm run build
npm test
npm run build --prefix client
```

For browser integration tests, install their browsers first:

```sh
npx --prefix client playwright install chromium
npm run test:e2e --prefix client
```

Use Chromium on a personal Mac and disposable macOS CI for WebKit to avoid
login-keychain prompts. On Linux, install WebKit separately and run
`npm run test:webkit --prefix client`. See [browser test isolation](client/playwright-keychain-isolation.md).

The browser suites use disposable test data. Tests prefixed `live-` are opt-in
engine acceptance checks; do not enable them just to view the interface.

To stop the development Hub, press **Ctrl+C** in its terminal. Keep its state
directory if you want to resume the same workspace later.
