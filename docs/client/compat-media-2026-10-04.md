# Kimi / Antigravity 十图与 PDF 兼容交付验收

2026-10-04。覆盖原计划第 12.5 项的真实引擎与浏览器流程，沿用 Opus 主导的
新版桌面和手机 UI。测试不改生产 worker、全局 MCP、模型配置或已安装客户端。

## 验证方式

`client/e2e/live-media-batch.spec.ts` 现在可通过 `TAROCUB_LIVE_MEDIA_ENGINE`
选择 `claude`（默认）、`kimi`、`antigravity`。仍需显式设置
`TAROCUB_LIVE_MEDIA_BATCH=1` 才会启动 Hub、CLI 或生成媒体样本。

- 手机布局在同一条消息发送文字、十张 PNG 和一个 PDF。
- 只在图片像素／PDF 内容中放随机编号，提示和文件名不包含答案。
- 透明观察器记录真实 CLI 收到的十一条附件路径，逐一检查原文件 SHA-256。
  Kimi 使用 ACP `session/prompt`；AGY 使用 `event:user`。不伪造回答或工具结果。
- 解析实际交付的报告文件，不假设模型把它写在工作区根目录。
- 检查唯一十图图集、各图标题、原图字节、PDF 和报告说明。
- 桌面和手机各自解码十张图并检查本地附件缓存摘要，实际点击下载 PDF／报告，
  核对文件字节，检查横向溢出，并保存普通视口截图。
- 识别准确率和传输完整性分别断言；软断言仍会使测试失败，只是不提前中断后续
  传输检查。回执中的识别结果来自实际比较，不能硬写为成功。

## 结果与保留的失败

| 引擎 | Chromium | WebKit |
|---|---|---|
| Kimi 2.1.1，默认模型、low | 通过 | 通过 |
| Antigravity 1.2.16，默认模型、low | 最后一次完整流程通过；另一次识别失败保留 | 通过 |
| Claude Code 2.1.287，sonnet、low | 同脚本回归通过 | 本轮未重跑，原有独立原生证据保留 |

共 7 次真实流程：5 次通过，2 次失败；不把后续成功改写成所有尝试都成功。
最终成功流程均校验十一份输入、十个图片编号、一个 PDF 编号、十图标题，以及
两端原图缓存和 PDF／报告实际下载。查看 Kimi 手机图集（本地材料：`screenshots/compat-media-20261004/kimi-webkit/media-grid-phone-01.png`）、
AGY 桌面图集（本地材料：`screenshots/compat-media-20261004/agy-chromium-delivery-check/media-grid-desktop-10.png`）。

AGY 初轮观察器误按 Claude 的 `type:user` 识别输入，未记录实际 `event:user`
帧；模型已回传图集，但校验中断，该轮保留为失败。修正仅涉及测试观察器。

AGY Chromium 另一轮在原始输入字节一致的前提下读错两张图：第 6 图将 `5` 看成
`S`，第 9 图多读一个 `S`。该轮保持失败，不替换答案、放宽编号精度或把它归为
浏览器传输故障。之后将识别断言改为不提前中断的软断言，用一次独立流程补查
全部传输步骤；这不是自动重试机制或模型稳定性保证。

Claude 同脚本回归通过。该通用脚本不观察 Claude 的原生 MCP 调用，因此这里只
证明实际媒体输入／交付；不能凭回执里的旧固定字段判定使用了原生还是兼容通道。
后续脚本已把这一字段改为“未区分原生／兼容”。Claude 原生工具仍以
[独立原生验收](claude-native-app-tools.md)为准。

## 清理、运行与边界

在 `client/` 中执行，例如：

```sh
TAROCUB_LIVE_MEDIA_BATCH=1 TAROCUB_LIVE_MEDIA_ENGINE=kimi TMPDIR=/tmp/t npx playwright test e2e/live-media-batch.spec.ts
TAROCUB_LIVE_MEDIA_BATCH=1 TAROCUB_LIVE_MEDIA_ENGINE=antigravity TMPDIR=/tmp/t npx playwright test --config playwright.webkit.config.ts e2e/live-media-batch.spec.ts
```

Kimi 使用私有会话目录，Claude 禁止保存测试会话。两者只复用现有认证，不记录
密钥。AGY 尚未配置独立历史目录，其原生测试历史保留；本测试不擅自删全局历史。
所有测试均关闭自有 Hub，并验证观察器和原生子进程已经退出后清理自有临时目录。

三个引擎选择 × 两种浏览器，六项最终默认关闭检查均跳过，未启动真实模型。
必需仓库检查：233 个文件、3676 项通过、1 项既有跳过，构建通过；此次未改生产
源码，后续测试软断言和回执字段调整由最后一次 AGY Chromium 流程验证。
七轮清理回执均确认自有进程退出、临时目录移除；最终没有遗留的批次验收目录。

Kimi `2.1.1`、AGY `1.2.16` 均选择已配置默认模型，未把默认值推断成具体模型名。
这是有限真实模型样本，非所有模型、实体手机原生容器、Windows/Linux 或公网
中转验收。Kimi／AGY 通过现有兼容通道；原生 App 工具接入的
[授权和协议限制](native-tool-extension-gaps.md)仍保留。前端与 r10 包未改动。

完整回执、失败摘要、日志及截图摘要（本地材料：`evidence/compat-media-2026-10-04.json`）。
