# Claude Bot 的 Chrome 浏览器联动

## 问题与行为

此前 `claudeChrome` 已能让新启动的 Claude 进程带上 `--chrome`，但 App
没有设置入口，持久进程也不会读取后续修改。扩展已安装时，Bot 仍可能没有
浏览器工具；只改配置又无法让已有进程生效。

桌面和手机现在在「Bot 设置 → Chrome 浏览器联动」提供同一个 Bot 级开关，
默认关闭，只对 Claude Bot 显示。说明明确区分“允许联动”和“扩展已连通”。
此 Bot 的对话、群聊和话题共用配置；不更改 Claude 的全局默认值，不重置会话。

保存仅改变后续启动策略。当前任务继续执行；下一次安全边界重新创建 Claude
进程，用原生 session ID 续接。后台任务仍在运行时，新的前台请求会明确报错，
待后台任务结束再发送；不会终止后台工作，也不会把新请求交给旧权限的进程。
关闭时显式传入 `--no-chrome`，避免用户的 Claude 全局开关覆盖 Bot 的选择。

## 接口与安全边界

- `GET /api/bots/:id/chrome` 返回 `scope`, `engine`, `enabled`, `revision`,
  `activeTurns`；`PUT` 只接受 `{ revision, enabled }`。
- Hub 检查拥有者和 Bot 可见性；与权限修改共用操作队列，排队后重新检查
  身份有效性和拥有者角色。Gateway 校验运行中的引擎与磁盘配置一致。
- `runtime/chrome-settings.ts` 在配置文件锁内读取、校验和原子写入，文件
  权限保持 `0600`。只更新布尔值 `claudeChrome` 和 UUID
  `_clientChromeRevision`；会话、凭据、工作区和其他字段保持原样。
- 版本不一致返回 `chrome_conflict`，配置损坏时拒绝保存，避免覆盖旧状态。
  开关经过开/关循环后仍会拒绝旧版本。App 不会自动重试保存。
- 每次 API 保存写入 `bot.chrome_updated` 审计，只记录 Bot ID 和开关值。
  开关不会放宽网站权限、普通工具审批或其他引擎的权限。
- 旧主机没有此接口时，App 明确提示更新；Bot 离线时不宣称保存成功。

CLI 连接已运行的本机 Hub，与 App 共用接口，不启动第二个 Hub：

```sh
tarobot bots list --json
tarobot bots chrome BOT_ID --json
tarobot bots chrome BOT_ID --enabled on --revision REV --json
# 关闭前再次读取，使用最新 revision
tarobot bots chrome BOT_ID --enabled off --revision NEW_REV --json
```

## 扩展与登录

主机必须安装 Claude in Chrome，Claude Code 与扩展须登录同一账号和组织。
根据 [Claude 官方文档](https://code.claude.com/docs/en/chrome)，API Key
和 `claude setup-token` 的长期令牌登录不支持此扩展，即便传入 `--chrome`。
此开关不安装扩展、不代替登录，也不表示每个网站已授权。
不复制浏览器配置，不读取 Cookie，不启用调试端口。

## 2026-10-17 验证

- 主机完整回归：318 个文件通过，4192 项通过、1 项跳过。
- Claude 流式适配器覆盖：显式关闭覆盖构造时旧值、任务进行中不重建、
  后续开启/关闭保留 native session ID、后台任务存在时拒绝以旧权限发送。
- 旧进程适配器单独回归：33 项通过，包括逐次开启/关闭和会话保留。
- 配置与 CLI 集成覆盖：默认值、原子持久化、错误配置、引擎变化、版本冲突、
  无认证/非拥有者拒绝、离线、审计、不发送聊天消息。
- 浏览器回归：4 个场景通过。390px 手机与 1360px 桌面检查同一开关，
  保存后重新打开、跨设备冲突、旧主机与离线提示；模型和设置生命周期回归通过。
  两个视口截图已人工检查。此项为浏览器验收，未冒充 Android 真机测试。
- 主机及客户端构建通过。客户端保留既有 `native.ts` 动态导入提示。
- macOS 上使用实际 Claude Code 2.1.301 和本次构建的 `ClaudeStreamAdapter`
  做独立只读验证：原生 `claude-in-chrome` MCP 注册连接成功，随后实际调用
  `mcp__claude-in-chrome__tabs_context_mcp(createIfEmpty: false)` 成功，返回
  `CHROME_CONNECTED`。仅做工具发现和标签页上下文检查，未打开、导航或改动
  网页，验证日志不记录标签页标题和网址。

本次未发布 App 安装包，设置 UI 仍需客户端与主机版本更新。当前已安装主机
原有的启动参数能力可通过单 Bot 配置与“空闲后重启”启用；重启安排回执和
进程实际更替必须分别核实，不能把“已安排”当成已生效。未声称验证 Windows
或 Android 上的真实扩展连接。
