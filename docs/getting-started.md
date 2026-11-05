# 本地开发与首次配对

[English](getting-started.en.md) · [项目首页](../README.zh-CN.md)

本指南面向开发者。新仓库暂未发布 Release；现有安装包保留在[私有历史档案](https://github.com/cloveric/tarobot/releases)，后续版本发布到[新仓库](https://github.com/cloveric/tarobird/releases)。迁移与升级边界见[迁库说明](repository-migration.md)，真机验收见[开发状态](details.zh-CN.md#开发状态)。
无界面运行请看[主机 CLI 指南](host-cli.md)；手机外出连接
已有主机请看[Agent 配置与手动部署](client/remote-access.md)。

## 1. 准备环境

- Node.js 24（根目录 `.nvmrc`）与 npm；GitHub 私有仓库访问权限。
- 主机已安装并登录需要使用的 Codex、Claude Code、Kimi、DeepSeek Harness 或 Antigravity CLI。
- 桌面构建另外需要 Rust 与系统开发工具；macOS 需要 Xcode Command Line Tools。
- Android 需要 Android SDK 和 JDK；iOS 需要 macOS 与完整 Xcode。

仓库不包含模型服务凭据，也不会替你完成第三方账号登录。

## 2. 安装与构建

```sh
git clone https://github.com/cloveric/tarobird.git
cd tarobot
npm ci
npm ci --prefix client
npm run build
npm run build --prefix client
```

根目录安装与 App 构建不包含旧飞书 SDK；旧通道需显式安装独立适配器。
构建产物和依赖均在 Git 忽略列表内。

## 3. 启动独立开发主机

```sh
node dist/src/index.js init --name "Development host" --state-dir "$HOME/.tarobot-dev/hub"
node dist/src/index.js hub run --state-dir "$HOME/.tarobot-dev/hub"
```

保持这个终端运行。仅监听本机，端口由初始化选择，以启动日志中的地址为准，并使用上一步生成的客户端资源。开发状态目录与现有 Bot 服务分开。

在同一台电脑打开启动日志显示的本机 HTTP 地址。填写本机 Hub 地址，点击配对此设备。界面生成新的配对码后，在另一个终端执行以下命令，把 `<界面显示的配对码>` 替换为当前值：

```sh
node dist/src/index.js hub devices approve '<界面显示的配对码>' --state-dir "$HOME/.tarobot-dev/hub"
```

批准后回到客户端。点击“新建 Bot”，选择主机上可用的引擎和模型。工作区留空时创建独立目录；已有 Bot 可以直接开新对话，无需再次配置模型。

HTTP 仅用于本机回环开发。其他设备不能使用你电脑的 `127.0.0.1` 地址；远程连接需要真实可达地址、TLS 及可信主机身份配置，见[网络和安全](client/security.md)。不要仅把监听地址改成公网地址就作为部署方案。

## 4. 打开原生 App

桌面开发模式在另一个终端运行：

```sh
npm run desktop:dev --prefix client
```

保持 Hub 运行，在桌面 App 中完成同样的配对流程。该命令同时启动界面开发服务和 Tauri 原生壳。

桌面开发构建：

```sh
npm run desktop:build --prefix client
```

手机工程同步：

```sh
npm run build --prefix client
npm run mobile:sync --prefix client
npm run android:open --prefix client
# 或 npm run ios:open --prefix client
```

同步资源不代表 SDK 编译或真机验收已通过。平台配置分别见 [macOS](client/macos-build.md)、[Android](client/android-build.md)及[原生发布设置](client/operations.md)。

## 5. 验证与后续配置

```sh
npm run build
npm test
npm run build --prefix client
npx --prefix client playwright install chromium webkit
npm run test:e2e --prefix client
npm run test:webkit --prefix client
```

- [日常使用](client/user-guide.md)：群组、话题、引用、附件、语音与设置。
- [主机运维](client/operations.md)：服务管理、备份、恢复与文件限制。
- [VPS 中转](client/relay-deployment.md)：专用中转服务器、证书与主备线路。
- [验收门槛](client/acceptance-gates.md)：区分浏览器、原生容器和真实设备的证据。

停止此开发 Hub 可在启动它的终端按 Ctrl+C。保留状态目录以便下次继续使用。
