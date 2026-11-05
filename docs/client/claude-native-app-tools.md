# Claude 原生 App 文件工具

2026-10-03。Claude Code 的前台 App 对话现在通过原生 SDK MCP 控制通道使用
`app_send_file`、`app_send_batch` 和 `app_capability`。实际名称带
`mcp__tarocub_app__` 前缀。仍由原来的 Claude CLI 执行模型、工具、权限与
session；没有独立模型 API，也不启动可从网络访问的 MCP 监听器。

## 接入与作用范围

每个 worker 使用私有、权限为 0600 的临时 MCP 配置文件安装 SDK server。
不设置 `--strict-mcp-config`，不修改用户全局 MCP、Bot 人设、工作区或记忆。
worker 退出时清理自己的临时文件。新对话和已有会话均可安装工具，恢复使用
原 session ID；已有后台任务可以按原适配器规则推迟非安全配置变更。

在写入用户问题前，等待 CLI 的初始化确认及真实 `tools/list`。常驻 App 说明
与本轮原生说明使用专用合同；本轮引用／回复等私有上下文由 Gateway 原样
传入原生说明，只有兼容交付配方替换为原生工具入口。恢复时补充当前短合同，
避免旧 system-prompt snapshot 留下过期平台说明。

初始化明确拒绝或 60 秒超时，且尚未提交模型问题时，才允许一次兼容回退。
提示通过独立引擎事件发送，不加到最终正文前，避免破坏整条 inline file
回复。明确拒绝仅禁用该兼容 worker 的原生工具；短暂超时下一轮可重试；
其他健康会话不降级。普通模型／工具错误和用户停止不会自动重放模型请求。

## 交付权限与取消

- 执行必须匹配当前已写入问题的前台回合、原生 session、完整 assistant
  `tool_use` 的 ID／工具名／参数以及 CLI `_meta.claudecode/toolUseId`。
  部分流式参数不会生成授权。无法确认顺序或参数一致时拒绝发送。
- 已安装工具在 CLI 权限阶段不额外弹无法授予接收者权限的卡片；真正的
  交付权限在 host dispatch 和 Gateway 中校验。其他 MCP 工具审批照常。
- 子代理、无前台回合、已结束回合、提前到达的调用、跨频道复用和独立后台
  通知都不能借用当前 App 接收者。子代理需将文件交给父回合；后台通知的
  既有兼容交付仍由原通知处理器负责，不宣称后台原生文件工具已支持。
- 同一原生调用只执行一次；会话内和跨重启的交付仍复用 Gateway 持久化
  回执。真实路径、凭证文件、上传限制、静默任务和不确定发布规则与
  [原生批次](native-batch-delivery.md) 相同。
- 支持控制通道取消和 MCP `notifications/cancelled`，用户停止／回合结束
  撤销能力。已经提交的消息不能因此撤回。
- 只有实际上传创建、状态、分块及完成响应才刷新引擎活动时间；挂起的
  host 调用不会无限豁免空闲超时。观察回调失败不会破坏已完成的上传步骤。

## 验证范围

`tests/claude-app-mcp.test.ts` 检查协议协商、握手、授权、重复调用、取消、
初始化回退、不重放、上传进度／停滞、后台通知及跨频道隔离。
`gateway-service` 通过真实 Hub 验证上传活动、混合批次、原生附件与兼容去重。

`client/e2e/live-claude-app-tools.spec.ts` 为显式启用的真实 CLI 验收：

```sh
TAROCUB_LIVE_CLAUDE_APP_TOOLS=1 TMPDIR=/tmp/t npx playwright test e2e/live-claude-app-tools.spec.ts
```

从 `client/` 运行；WebKit 增加 `--config playwright.webkit.config.ts`。
普通套件跳过，不调用模型。透明观察器记录原生帧，不代替模型选择工具。

两个用例分别检查十图＋PDF 的读取和原生原子批次，以及单文件两版交付、
真正重启 worker 后的同 session／上下文、按需能力查询。每个用例都有独立
桌面和手机浏览器上下文、实际下载及字节校验。批次关闭原生 session 持久化；
重启用例仅清理启动前确认不存在、且归属临时工作区的 transcript，退出和
删除均读回验证。不会按时间或模型批量清理日常会话。

最终运行、截图、源码摘要与 Opus 审查处置见
验收回执（本地材料：`evidence/claude-native-app-tools-2026-10-03.json`） 和
审查记录（本地材料：`evidence/claude-native-opus55-review-2026-10-03.md`）。

这些证据针对本机 Claude Code 2.1.287 / sonnet / low、真实 Hub 和浏览器。
不是实体手机、其他 CLI 版本／模型、全部媒体类型或公开中转路线验收。
Windows 私有配置路径的设计尚未做真实 Windows 构建与运行验证。自定义
hook 改写参数时仍保守拒绝不匹配调用；不声称所有用户 MCP 组合的延迟相同。
Kimi、DeepSeek、Antigravity 与 Codex process 保留兼容交付。

协议依据：[Claude 自定义工具](https://code.claude.com/docs/en/agent-sdk/custom-tools)、
[SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp) 和安装 CLI 的实际帧探测。
