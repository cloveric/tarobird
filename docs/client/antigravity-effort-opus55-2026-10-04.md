# Opus review — Antigravity effort, 2026-10-04

Actual CLI invocation used `--model claude-opus-5-5 --effort xhigh`,
`--no-session-persistence`, no tools and an empty strict MCP configuration.
Completed successfully in one turn; no permission denials. Model usage names
`claude-opus-5-5`. The reviewer's note about effort refers to the model's inability
to inspect its own setting; the host invocation explicitly requested xhigh.
It reviewed a read-only code packet and did not itself execute tests.

## Raw completed report

# 审查结论：TaroCub 手机端 Antigravity xhigh 兼容性修复

**没有阻塞问题。** 在给出的代码里，xhigh 在以下位置都已打通：保存、校验、持久 worker、/goal 单次进程、空闲 worker 重建。下面列出几个不阻塞的具体问题和需要确认的点。

关于审查者身份：我是 Opus 5.5（`claude-opus-5-5`），但我在会话内部看不到自己当前的推理强度，**无法确认是否以 xhigh 运行**。本次按要求没有调用任何工具，也没有运行任何测试。

## 逐项核对（都通过）

| 关注点 | 依据 |
|---|---|
| 按 Bot 保存，不按会话 | `PUT /api/bots/:id/effort`（`client/src/EffortControl.tsx:45`）写入该 Bot 的 `config.json`（`src/runtime/effort-settings.ts:33-39`）。`scope: "bot"` |
| 其他 Bot 隔离 | 每个 stateDir 有独立的 config。e2e 在 gamma 保存后读取 alpha 和 beta 的配置并断言（`client/e2e/effort.spec.ts:79-81`） |
| 跨设备冲突 | revision 包含 engine、model、effort 和 `_clientEffortRevision`（`effort-settings.ts:18`）。IM 端执行 `/model` 或 `/effort` 后，旧版本的保存会被拒绝 |
| 保存不碰会话 | 保存路径只写 `config.json`，不调用 bridge，也不写消息（`effort.spec.ts:82-83, 93-94`） |
| 持久 worker 传入 xhigh | `antigravity-adapter.ts:665`。settingsKey 含 effort（`:483`） |
| /goal 单次进程传入 xhigh | 每轮都在分支前重新读取配置（`:429`），然后传参（`:524`） |
| 空闲 worker 只改 effort | settingsKey 不同时停掉旧 worker，用 `--conversation <同一 ID>` 重建（`:615-622, 666`）。单测 `tests/antigravity-adapter.test.ts:1198` 覆盖了只改 effort（high→xhigh）的情况 |
| ultra 仍拒绝 | `ANTIGRAVITY_EFFORT_LEVELS` 不含 ultra（`instance-config.ts:35`）。手机选项列表做了精确断言（`effort.spec.ts:72`） |

## 具体问题（均不阻塞）

**1. Antigravity 的 effort 校验不看模型，手机会对任何模型都提供 xhigh**
- 位置：`src/telegram/instance-config.ts:68-73`，`src/runtime/effort-settings.ts:17`
- 复现：设置 `{engine:"antigravity", model:"claude-sonnet-4-6"}` 后执行 GET effort，choices 里有 xhigh。同一个模型在 Claude 引擎下会被 `:62` 拒绝 xhigh。代码库本身就用过这个组合（`tests/antigravity-adapter.test.ts:1197`）。
- 影响：agy 遇到不支持的组合时，可能拒绝、静默降级或忽略，这一点未知。如果在 worker 启动时就报错，该 Bot 之后每一轮都会失败，直到把档位改回去。max 以前就有同样的缺口，这次的修复只是扩大了范围。`agy --help` 列出 xhigh，不代表每个模型都接受它。

**2. 部署后会生效原本被忽略的 xhigh**
- 位置：`instance-config.ts:154-176`，`antigravity-adapter.ts:391`
- 以前 antigravity 配置里的 `effort: "xhigh"` 在加载时被清掉，适配器也会过滤。现在会直接生效。手工编辑或旧版本留下的配置，重启后会悄悄变强、变慢。
- 建议重启 Lark 机群前先扫一遍：
  `for f in ~/.cctb/*/config.json; do grep -q '"engine": *"antigravity"' "$f" && grep -H '"effort"' "$f"; done`

**3. 单测参数断言不检查相邻顺序**
- 位置：`tests/antigravity-adapter.test.ts:673-676, 1227-1231`
- `arrayContaining` 只检查元素存在，不检查 `--effort` 后面紧跟的是不是对应的值。
- 对这次修复不算伪通过：旧代码下 `--effort` 根本不会出现，测试会失败。但它抓不到参数错配。建议改为断言 `args.slice(i, i + 2)` 等于 `["--effort", effort]`。

**4. e2e 的部分断言证明范围比看上去窄**
- `effort.spec.ts:82-83` 的「session.json 未变」必然成立，因为 bridge 是桩函数（`:40`），没有适配器，也没有 worker。它只能说明保存路径不写会话文件，不能说明下一轮还在同一个对话里。
- 对话延续只由假 spawn 单测证明，即参数里有 `--conversation`。
- `:87` 的 ultra→409 用的是 alpha（Codex）。Antigravity 服务端拒绝 ultra，只通过 `:72` 的选项列表间接覆盖。

**5. 弹窗打开时 botId 被冻结**（低概率）
- 位置：`client/src/EffortControl.tsx:27, 30, 40-41`
- `useState(bots[0]!.id)` 只取一次初始值。如果弹窗打开期间另一台设备把该 Bot 移出群，`<select value>` 找不到对应选项，界面会显示另一个 Bot 的名字，但 PUT 仍然发给旧 botId，`:41` 的名字也会变空。
- 是否可能发生，取决于父组件能否在模态框打开时改变 `bots`。父组件代码没有给出，我无法确认。

## 需要确认（给出的材料里没有，不下结论）

- **Telegram/Lark 文案和选项列表**：你说文案已同步，但相关文件没有给出。还需要检查 `src/lark/config-card.ts` 和 `src/telegram/simple-commands.ts` 里有没有写死的 effort 选项列表，例如 `"low", "medium", "high", "max"`。如果有，Lark 卡片就不会出现 xhigh。
- **保存时写回的是 zod 解析结果**：`effort-settings.ts:11, 37` 写回的是 `ConfigFileSchema.parse` 的输出，而 `updateInstanceConfig` 写回的是原始 JSON（`instance-config.ts:522-546`）。如果 schema 里有 `.default` 或 `.transform`，保存会把其他字段规范化后落盘。e2e 只证明了 model、workspacePath 和 locale 保留下来。
- **`withFileMutex` 是否跨进程**：如果 CLI 等其他进程同时写 `config.json`，可能丢失更新。
- **IM 端改档后手机头部摘要是否刷新**：e2e 只测了手机/桌面互相同步，没有测 Lark 或 Telegram 执行 `/effort` 后手机端是否更新。也没测 Lark 侧是否缓存配置。
- **agy 两个运行时行为**：
  - 在 `--input-format stream-json` 持久模式下，是否真的执行 `--effort`。
  - 无宽限期直接杀掉旧 worker（`antigravity-adapter.ts:1155-1165`）后，`--conversation` 恢复的上下文是否完整。

## 当前证据边界

- **已证明**：参数拼装和重建逻辑，用的是假 spawn 单测；Bot 级保存、隔离、冲突检测和离线提示，用的是 Playwright Chromium 移动视口模拟加桩 bridge。
- **未证明**：
  - 真机：iOS Safari 或 Android 的原生 select 选择器和键盘行为。
  - 真实 agy 接受 xhigh，并且推理强度确实变化。
  - 真实 Lark 消息路径。
  - `npm test` 和 `npm run build` 的结果。我没有运行，你也没有提供输出。
  - `agy 1.2.16 --help` 列出 xhigh 这个事实由你提供，我没有核实。

**最小真机验收步骤：**
1. 用实际在用的每个模型分别执行一次 `agy -p ping --output-format stream-json --model <模型> --effort xhigh`，确认返回 SUCCESS。
2. 用真手机在群里选 gamma，改为 xhigh 并保存，然后在 Lark 发一条消息。用 `ps -axo pid,args | grep '[a]gy'` 确认新进程带有 `--effort xhigh`，并且 `--conversation` 是同一个 ID。再追问上一轮的内容，验证上下文还在。
3. 对 `/goal` 重复第 2 步。
4. 在 Lark 执行 `/effort`，确认显示 xhigh，并确认手机头部摘要同步刷新。

## Primary-agent disposition

- Adopted: argument assertions now require exact adjacent `--effort`/value and
  resumed `--conversation`/ID pairs. Tests also distinguish persistent chat
  startup from single-process `/goal`. All 57 adapter tests passed afterward.
- Adopted: the browser journey sends an authenticated Antigravity ultra update,
  expects `409 effort_incompatible`, and reads back unchanged xhigh. Both
  Chromium and WebKit passed the strengthened journey.
- Provider/model support remains explicitly bounded in the feature documentation.
  Claude's provider-specific matrix must not be assumed identical to Antigravity's
  routing, so no unverified AGY model restrictions were invented.
- Existing explicit xhigh configuration will now be honored. No production
  restart or fleet configuration write was performed; this is documented for
  later rollout instead of treating an explicit saved preference as disposable.
- The proposed group-member race is not currently reproduced: App keys the
  control by current conversation ID, and the current conversation update
  protocol/store does not support editing its Bot membership. Revisit when that
  capability is introduced; no speculative UI rewrite was made.
- The config schema uses passthrough objects without defaults or transforms.
  The shared mutex uses filesystem lock directories plus in-process queues;
  it is not limited to a browser or one process. External editors that ignore
  the locking protocol are outside that guarantee.
- Lark's config card renders effort; it does not contain the hypothesized
  four-choice selector. Lark and Telegram command validation use the shared list.
  Lark's real message-handler path passed the focused config-persistence test,
  with a fake channel and no live fleet traffic.
- IM command changes are read when the picker opens; arbitrary filesystem
  changes are not watched. No automatic live IM-to-App header refresh is claimed.
- Required root gate passed 232 files / 3,656 tests / one existing skip and build.
  Afterward, the stronger adapter and browser assertions passed as stated above.
  Native model behavior, physical phone input controls and real fleet delivery
  remain separate acceptance gates.
