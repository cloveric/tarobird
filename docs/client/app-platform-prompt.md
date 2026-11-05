# App 平台提示词与结构化交付

2026-10-02：App 的常驻平台提示词已独立，不再从飞书提示词逐行删改。人设仍从实例 `agent.md` 读取，项目指令、记忆、workspace 和原生 session 绑定仍沿用原引擎。

## 常驻规则和按需说明

`src/gateway/agent-instructions.ts` 管理短版 App 合同及 files/documents/media/browser/schedules/questions 六类说明。普通聊天不注入文档命令、浏览器流程、ASR 配方或 cron 示例。相关任务才补充说明；新 Codex App 会话及 Claude 原生 App 前台回合还可调用 `app_capability` 主动查询。

普通聊天只保留短平台说明；原生批次工具版本补充一处图集入口，不展开完整使用配方。字符数不代表 token 或延迟；原生工具 schema、Bot 人设和本轮按需说明另外计入上下文。缺少原生提问工具时仍保留 `lark.choice` 兼容入口。

App 的 Codex app-server 调用通过 `turn/start.additionalContext` 的 `application` 字段提交平台、人设和本轮说明。用户输入仍是实际问题，不以 `[System Instructions]` 开头。不会改写或删除已有原生历史／旧标题。

## 原生文件工具

新建 Codex App 会话在 `thread/start.dynamicTools` 注册；Claude 前台 App 回合通过私有 stdio SDK MCP 安装以下工具（Claude 名称加 `mcp__tarocub_app__` 前缀）：

- `app_send_file({path, kind, caption?})`：当前会话内发送文件、图片、语音或视频；说明和附件放在同一条消息。视频仍使用现有文件块及视频 MIME。
- `app_send_batch({artifacts:[{path,kind,caption?}],caption?})`：图片合为带标题图集，可与 PDF 等文件、语音／视频及说明同条发布。最多 50 项、文件合计 512 MiB；每项说明最多 12,000 字符，编码后总说明不超过 200 KiB。先检查所有文件，再上传，全部完成后只发布一次；上传中断不显示半套图集。已上传但未发布的临时附件遵循 Hub 的现有保留／清理策略。
- `app_capability({topic})`：只读能力说明，不能借此执行命令或更改定时任务。

工具直接调用 Gateway 上传与 Hub 发布，不把 JSON 再转成最终回答里的 `[send-file]` 标记。只有 Hub 返回发布回执才返回 `delivered: true`、`messageId` 和文件摘要。原生工具调用和结果进入已有工具进度展示。

工具绑定到当前已授权会话，参数不能指定其他用户／群／Bot。发送前复用真实路径和凭证文件预检，以文件描述符复核类型、大小和文件身份；旧飞书的任意路径环境开关不能扩大 App 工具权限。支持 Bot workspace、当前恢复工作区、输出目录及既有生成图片目录。

请求重复与重启重放使用持久化回执。同一个调用 ID 改参数会被拒绝。发布失败／回执丢失只报告不确定，不自动重新执行发送。停止或回合结束会撤销本轮能力，上传接受取消信号；已发出的 Hub 发布可能在取消同时完成，不能声称能够撤回已经提交的消息。

确认回执覆盖整个用户回合及自动修复：引擎随后报错、恢复流式文本、补发时，已交付附件不会因旧标记再发。去重校验内容摘要；同一路径更新后的文件正常发送。同一回合内相同路径、内容、类型及说明的原生调用也复用回执，新用户回合可以重新发送。未发送的同批文件和引用示例保留。交付追问与自动修复识别真实回执，已有交付后的引擎错误仍显示为部分完成。

批次还会为每个成员保留同一个发布结果：随后以 `app_send_file` 重发相同文件版本／类型／说明时直接复用。完全相同的批次复用整批回执；与已有单文件或另一批次部分重叠的发送会明确拒绝，要求先核对已发内容、只发送剩余项，不悄悄拆分或重复发送。确定的上传失败可以修正后用新调用 ID 重试；无法确认发布结果时，成员和整批的缓存均保留不确定状态。

上传或读文件阶段的确定失败返回 `published: false` 和可处理的原因；仅发布结果无法确认时返回 `delivery_uncertain`，该回合内换调用 ID 也不重复发布。Hub 的 413 会明确显示文件超限，修正后可用新调用 ID 重试。原生附件引用来源消息，遵守 Hub 的失败输入守卫；静默定时任务不能通过原生文件工具发布。原生成功交付记入 `file.accepted` 时间线。

## 迁移边界

| 路径 | 当前行为 |
|---|---|
| 新 Codex app-server App 会话 | 原生单文件和批次工具；短常驻提示；按需能力工具 |
| 已注册工具的 Codex 会话恢复／重启 | 按注册版本选择精确工具、常驻及本轮说明和执行器；保留原线程 |
| 仅注册了早期两项原生工具的 Codex 会话 | 保留 `app_send_file` 与 `app_capability`，不宣称或调用尚未安装的批次工具；不强制清空上下文升级 |
| 迁移前的 Codex `/resume` 会话 | 保留文件标记兼容，不为安装工具重置上下文 |
| Claude 前台 App 对话／恢复／重启 | 原生 SDK MCP 单文件、批次及能力工具；保留原 session；握手失败仅在提交问题前兼容回退，见 [Claude 合同](claude-native-app-tools.md) |
| DeepSeek Harness 前台 App 对话／恢复／重启 | 原生 agent 级单文件、批次及能力工具；精确原生请求／调用归属；提交问题前安装失败才兼容回退，见 [DeepSeek 合同](deepseek-native-app-tools.md) |
| Kimi／Antigravity／Codex process | 独立短 App 提示、按任务补说明；文件仍使用现有标记投递 |
| Claude 子代理／独立后台通知 | 不授予前台 App 发送能力；子代理返回文件给父回合，后台通知沿用原处理器的兼容路由 |
| 无当前授权回合的 Codex 后台／自主 goal 回合 | 原生调用拒绝，错误明确说明未交付，要求报告文件路径并在普通聊天回合请求发送；自主 goal 的文字标记不会自动发送附件 |
| 飞书／Telegram | 原有提示词和投递协议保持原样 |

注册记录保存在 Bot 状态目录 `app-tool-threads/`；交付回执在 `gateway-receipts/`。不写入用户 `agent.md`、`MEMORY.md` 或项目 `AGENTS.md`。已知早期版本的定义摘要固定并受测试保护；未知版本、记录缺失或损坏才保守回退，不猜测旧线程能力。App 的新旧两种投递均不接受飞书的任意路径环境开关。早于 `turn/start` 回执的原生请求先缓冲，确认精确回合后才执行，过期请求拒绝。当前协议及真实模型工具选择已用本机 Codex CLI 0.160.0 / gpt-6-astra 验证；其他 CLI 版本和模型仍需对应验收。

## 验证

2026-10-03 补充：DeepSeek 前台原生工具及其真实重启、能力查询、两文件批次和
双端下载见 [DeepSeek 原生工具验收](deepseek-native-app-tools.md)。它使用原生
agent 注册表和本轮请求 ID，不读取 Codex 的 `app-tool-threads/` 注册记录。
下面较早的 DeepSeek 兼容验收保留原日期与范围。

2026-10-03 补充：Claude 使用每个 worker 的真实 SDK MCP 初始化状态，不读取
Codex 的 `app-tool-threads/` 注册记录；发送回执共用 `gateway-receipts/`。
真实 Claude 工具选择、重启／上下文和双端字节验证见
[Claude 原生工具验收](claude-native-app-tools.md)。下文 Codex 和其他引擎
较早的兼容验收保留原日期与范围，不代表新的 Claude 路径仍依赖标记。

- 协议测试：注册、原生回调、旧线程恢复、App 上下文与用户输入分离、线程／回合隔离、重复调用、取消及迟到结果。
- 真实 Hub/Gateway + 受控引擎：同消息 caption/附件、字节下载一致、重复请求和旧标记去重、交付追问不误重试、回合结束后拒绝继续发送。
- 路径／收据测试：凭证文件、越界符号链接、伪造接收者、任意路径环境开关、失败回执、跨会话隔离、重启回执、用户人设文件保持原样。
- 本机协议探测采用独立临时 Codex 状态目录和 ephemeral thread，工具 schema 被接受；未启动模型 turn，未向用户日常 session 列表写入验收对话。
- 2026-10-03 真实模型验收：用户请求未指定工具名称或文件标记，Codex 自主调用 `app_send_file` 创建并交付文件。重启临时 Bot 后保持原 session、上下文及工具注册，同路径新版文件正常交付；两版在桌面和手机浏览器各下载一次，四次字节／SHA-256 一致。两条持久化收据、原生成功结果与 `file.accepted` 时间线逐条对应，无重复附件。`app_capability(files)` 也被实际调用。见真实原生工具验收（本地材料：`evidence/native-app-tools-2026-10-03.json`）。
- 上述实测使用两个独立浏览器上下文，不是手机系统容器、所有模型／媒体类型或线上部署验收。现有真实 MCP 服务配置和长短语音路由未被替换。

新增 opt-in 用例 `client/e2e/live-app-tools.spec.ts`，从 `client/` 执行：

```sh
TAROCUB_LIVE_APP_TOOLS=1 TMPDIR=/tmp/t npx playwright test e2e/live-app-tools.spec.ts
```

仅显式启用时调用已登录的真实 CLI；普通浏览器套件跳过。透明观察器只记录相关原生 RPC，不注入工具选择或结果。测试关闭 Hub／worker 后，通过原生归档 API 清理该临时工作区的测试会话，并回读确认日常列表无残留。首轮已完成原生交付，随后因测试过早检查重启 PID 而失败；修正等待条件后完整用例通过，首轮测试会话也已归档。没有为通过此验收修改生产交付代码。

Opus 审查后的验收：完整 `scripts/pre-complete-hook.sh` 通过（221 个测试文件，3461 通过、1 跳过；构建通过）；定向测试 204 项通过。修复覆盖报错恢复、同路径更新、原生修复／重复调用、静默任务、真实 Hub 413 后修复、消息引用与失败输入守卫、回执前的迟到工具请求及取消。汇总见 验证记录（本地材料：`evidence/app-platform-prompt-validation.json`）。

后续跨引擎实测已通过 Claude、DeepSeek、Antigravity、Kimi 的真实兼容文件交付、带说明同消息、两端下载、流式输出、重启／强杀恢复及手机停止后续聊。Claude、DeepSeek、Kimi 原生问题跨端回答通过，Claude 本地 MCP 审批／拒绝重测通过。实测修复了模糊围栏示例、附件说明拆分、AGY 可执行文件检测和 Claude 停止后旧 worker 复活；最终全量为 3467 通过、1 跳过及构建通过。详情与明确未测范围见 跨引擎验收（本地材料：`evidence/cross-engine-app-acceptance.md`）。这不表示其他引擎已迁移到 Codex 的原生动态工具。
