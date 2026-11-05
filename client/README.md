# TaroCub 客户端（开发中）

React 客户端共用于浏览器、Tauri 桌面壳和 Capacitor 手机壳。开发工作独立于当前运行的机器人；本目录目前不是已发布的 v1.0 安装包。

- [使用说明](../docs/client/user-guide.md)
- [实现与验收记录](../docs/client/implementation-status.md)
- [本机开发和运维](../docs/client/operations.md)
- [Android 开发构建与验收边界](../docs/client/android-build.md)
- [Windows 客户端安装包与构建](../docs/client/windows-desktop-2026-10-13.md)
- [架构及状态归属](../docs/client/architecture.md)
- [卡片视觉验收说明](visual-baseline/README.md)
- [Relay 部署程序说明](../docs/client/relay-deployment.md)

从仓库根目录运行 `npm ci`、`npm ci --prefix client`、`npm run build` 和 `npm run build --prefix client`，再按照运维说明启动独立开发 Hub。浏览器测试使用临时 Hub、假引擎和临时密钥，不应接入现有生产实例。

二维码由 `qrcode` 生成，`@zxing/browser` 提供摄像头和图片读取；直接声明的 `@zxing/library` 提供解码提示，使平面二维码图片在透视检测失败时仍可通过模块采样识别。解码依赖按需加载，识别结果仍须经过配对载荷校验和已信任设备确认。

验证命令：

```sh
npm run build --prefix client
TMPDIR=/tmp/t npm run test:e2e --prefix client
TMPDIR=/tmp/t npm run test:webkit --prefix client
npm run mobile:sync --prefix client
```

系统分享入口的原生文件位于 `android/app/src/main/java/com/tarobot/client/ShareInboxPlugin.java` 和 `ios/App/ShareExtension/`。iOS 主程序与扩展须配置同一个 App Group：`group.com.tarobot.client`。新标识需要在开发者后台注册并关联 App Group、生成签名描述文件；模拟器编译不等于共享容器或真机验收，详见 [迁移与发布门槛](../docs/client/native-app-identity-2026-10-28.md)。
