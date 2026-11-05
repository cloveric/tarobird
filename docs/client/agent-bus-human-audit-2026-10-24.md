# Agent Bus 拟人审计与修复 · 2026-10-24

本轮由 root 与真实 CC1（Claude Opus 5.5、1M context、xhigh）协作。基线为 `15ecaa53a7e2fca76fa8a7474dba1157e5ebaf33`；已安装 App 1.0.108 / Host、CLI 0.1.455。Opus 负责独立操作、提出问题和复审，root 负责独立复现、修复与回归。

## 验证边界

- 使用独立 Host、配对设备、合成工作区、`root-*` / `验收-*` Bots 和 `root-*` / `opus-*` Buses。正常、错误、停止和删除操作均在隔离数据内；没有重启生产 Host、修改真实会话、给生产 Bot 追加协作权限。
- root 的真实运行路径为 standalone CLI → Hub → Gateway → Bus → 本机真实模型 CLI → 独立阶段记录。不是仅检查模型的自然语言“成功”声明。
- 浏览器回归包含控制 API 的边界用例，以及生产 UI + 真实 Hub/Gateway/队列/Bus HTTP + 脚本模型的确定性集成用例。后者不等同于真实模型验收。
- 手机截图为 390 宽浏览器模拟，不构成 iPhone/Android 真机验收。本轮不变更平台字号、键盘、动画或后台子代理展示。
- 原生 App 仅做只读入口清点；原生复验未完成，不能把该观察算作最终原生验收。后续写入均在隔离浏览器中完成。本轮未打包或更新已安装 App。

## 已确认并修复

| 问题 | 原因及修复 | 回归依据 |
|---|---|---|
| 未保存分工也能准备权限，实际授权对象与运行页列出的已保存对象不同 | 草稿存在时禁止准备并引导返回配置；handler 同样拦截。必须先明确保存，再确认授权 | Opus O-07 实际给草稿 Kimi 授权；真实 Hub UI 红→绿 |
| 某角色 Bot A→B→A 丢掉原记录绑定，保存后多出同名记录对话 | 每个草稿角色记忆 Bot 对应记录；切回只恢复存在、未归档、属于该 Bot、未被其他角色占用的记录。显式选择默认记录仍有效；草稿记忆不进入协议或存储 | Opus O-08 实际复现；真实 Hub UI 检查原记录 ID、数量、显式默认选择 |
| 已删除发起者/成员仍提示准备权限，用户无法按提示修复 | 按角色指出 Bot 不可用，提供重新选择 Bot 并聚焦该角色；保留目标和分工，不自动替换成员或授予权限 | 真实 Hub 删除 coordinator/member 两种用例，换成员后可继续 |
| 仅不可见字符的目标会启动一次真实任务，生成空气泡 | 创建/更新/启动的共享准入规则拒绝纯空白与默认不可见字符；UI 同规则。可选分工若只含不可见字符则写为未填写；有效 emoji ZWJ、波斯语 ZWNJ 等原文保留 | Opus O-05 真实运行；共享 schema、CLI 无派发、浏览器输入回归 |
| 名称超长粘贴被静默截断；初次打开即报错；尾部空格造成空保存 | 保留全文、显示计数并禁保存；交互后提示名称错误；比较保存后的规范化名称/任务 | Opus O-02/O-04/O-06，边界与 Unicode 浏览器回归 |
| 协作摘要预览露出截断的原始 Bot ID | 对预览末尾的已知 Bot ID 前缀显示省略号；完整正文、复制、代码、路径和 URL 不改写 | Opus O-01；预览正反例单测 |
| 阶段提示截断切开 emoji 代理对 | 记录截断退让一个 UTF-16 单位；真实下发全文不变 | Gateway 定点红→绿，全文与 UTF-8 往返断言 |
| 权限弹窗关闭名称错误，结束等待/冲突说明误导 | 赋予弹窗正确可访问名称；结束等待不被允许时说明未强制停止；冲突文案同时适用于启动和保存 | Opus O-03、映射单测与交互回归 |
| Antigravity 某具体 high 模型可搭配 low，运行后才报错 | 具体 preset 只提供默认与自身强度；家族选择器仍原子切换模型+effort。`/model`、`/effort` 拦截冲突组合 | 真实 AGY 失败→配置修正后成功；catalog、设置、slash 命令及桌面/手机回归 |
| 只发送 `/ask`、`/fan`、`/chain`、`/verify` 等无任务命令，意外落入模型甚至执行工具 | 识别命令后检查实际目标，缺少内容直接返回用法提示；显式成员选择后的目标也受检查；普通相似文本不拦截 | Opus O-11 真正发起了 Gemini 工具调用；13 个缺参反例及正常文本反例红→绿；含已选成员但未写任务，不再误报权限问题 |
| 研究团队数字输入清空后变成 0，再输入变成 03；科学计数法被改写 | 保留编辑中的字符串，清空保持空，非法/越界值禁止保存，合法整数失焦后规范化 | Opus O-10；Chromium/WebKit 数字草稿回归 |
| 已有冲突模型参数的 Bot 报“重启实例”，重启也无法恢复 | 从实际 CLI 错误提取受限的模型/effort 参数，提示调整设置而非重启；不暴露其余 stderr | Opus O-09；真实错误样本及敏感字段不泄露断言 |
| 离线时正在输入的分工被禁用并丢失焦点 | 本地草稿允许继续编辑；保存、删除、重新载入、授权、启动仍须在线，断网不会派发任务 | Opus O-13 实操；Hub 真实断开/恢复、编辑焦点与无远程写入回归 |
| ADHD 每个窗格重复显示通用断线错误，Bus 又展示过期准备回执 | 只抑制与该窗格离线横幅重复的通用重连错误；认证/TLS/消息/本地错误仍保留。Bus 准备回执只在在线时展示 | Opus O-14 截图；离线多窗格和重连排队回归 |

历史兼容：可见内容校验只用于写入。历史配置与 run snapshot 继续按旧读取 schema 解析，已有不可见名称的 Bus 可以列出并改名；不让坏名称拖垮全部历史。协议字段、worker v3 能力、Hub schema、scope/origin/provenance 校验不变。

## 真实执行与非正常输入

- Ask：Codex、Claude、Kimi、DeepSeek 均真实完成；Antigravity 先复现模型/effort 冲突，再修正实际配置获得完成记录。
- Fan：3 个 Bot，分别记录；Chain：Claude→Codex→Claude，重复 Bot 的不同角色绑定独立会话并按序接收前一步输出；Verify：先回答再复核；Crew：计划、研究、分析、撰写、审阅五阶段均完成。
- 每次真实运行重复提交原 requestId，返回原 run，没有新增一次执行。
- 运行中再启动同一 Bus 被 busy 拒绝；停止指定运行、重复停止幂等；随后新任务有真实回应。
- 两组 Codex 协作真实时间重叠；只停止其中一组，另一组继续完成。
- CLI 反例覆盖空/超长名称、空角色、错误模式与人数、重复记录绑定、非法数字、损坏 JSON、非 UTF-8、符号链接输入、空/超长目标、旧 revision、相同 requestId 改内容。字面 `/stop`、换行与 emoji 作为目标正常传给模型；不被误当成单独控制指令。
- 删除隔离 Bus 配置后，原成员会话与消息保留。
- Opus 让创建/启动请求在服务端接受后丢失响应，并阻断刷新、重载页面。服务端只有一个 Bus/一次运行，重连后显示原运行；没有复现自动重复创建/执行，因此不据内存 Ref 的代码猜测重写持久化。
- CLI 22 项反例/生命周期检查通过。修订后 standalone CLI + Host 再验证 5 项：不可见名称、不可见目标、具体模型冲突强度均被拒绝，原配置和已有 Bus 保持不变。

## 保留的行为与限制

- 保存 Bus 只保存配置；授权需确认；启动是另一项操作。关闭面板不会停止协作。
- 单人委托和串联步骤的发起者只负责派发/汇报；Fan、Verify、Crew 的发起者有自己的执行角色。同一个 Bot 可以占多个角色，成员数量表示角色槽位。
- 手机没有桌面 ADHD/保存 Bus 编辑入口；手机通过“更多聊天操作 → 发起 Bot 协作”使用单次协作，或输入相应 slash 命令。不要把设计上未提供的入口写成测试通过。
- 一次 Claude Sonnet 步骤被供应商策略拒绝，Bus 正确标记失败并停止后续步骤；原始供应商英文原因仍可在记录中查看。本轮不修改供应商行为或隐藏该诊断。
- Crew 是研究报告工作流；角色结果可能比共同目标要求的极简格式更长。本轮没有改写研究流程来保证“严格三句”这类格式要求。
- 后续阶段输入还包含模型生成的输出，无法仅凭初始输入保证全流程不触及组合字节上限；既有执行时边界继续生效。
- 不把强制结束等待等同于确认后台工作已经停止；离线、旧 worker、回执不确定的安全边界保留。
- 没有完成真实手机键盘/IME 组合输入和最终原生桌面 WebView 复验。旧 Gemini 冲突配置的错误映射使用实际 CLI 失败样本测试；新设置入口、slash 拦截及纠正后真实应答已验，未人为绕过新准入再跑一次旧配置的完整 UI 失败链路。
- 预览若恰好截断在 `client` 单词内部而尚未包含 `client_` 标记，仍保留原文，避免把普通词误判为 Bot ID；这是保守的显示边界。
- 延迟目录读取与重连时，Opus 未复现错误“Bot 已不可用”；该猜测没有引出额外改动。名称与分工不自动移除有意义文本中的 Unicode 格式符，也不把所有空形 Unicode 字形一律视为空白。

## 证据与验收记录

隔离证据目录：`/Volumes/gdrive/taro-tmp/agent-bus-human-audit-20261024/`。`root-live-report.json`、`root-boundary-report-3.json`、`root-concurrent-isolation-evidence.json`、`root-input-report.json` 保存真实输入与运行 ID；`opus-coverage.md`、`opus-findings.json` 保存独立实际操作矩阵；screens 保存 UI 截图。

- 全量回归：480 文件通过，6,616 项通过、5 项条件跳过（`full-unit-frozen.log`）。随后 R1/R2 两个残余追加定点修复，6 文件 176 项通过（`residual-green-final.log`）。
- Chromium Agent Bus 工作区、真实 Hub/Gateway 集成、单次协作：77 项通过（`chromium-frozen.log`）。额外离线/重连边界 6 项通过（`final-offline.log`）；新用例先在旧构建因字段禁用失败，再在最终构建通过。
- WebKit 工作区/运行集成：75 项通过，一项多主机入口加载超时；同一失败路径与新增数字/不可见输入/单次协作共 5 项复测通过（`webkit-final.log`、`webkit-last-fixes.log`）。最终离线输入/停止/删除/重新加载再验 4 项通过（`final-offline-webkit.log`）。
- 关联旧测试中的设置入口/删除确认及 effort 断言与当前产品已不同步，按现有 UI 修正；相关设置、手机安全区 2 项通过。先前 ADHD 后台报告计数超时单独复测通过，未因此改产品逻辑。
- 最终 Host 与 client 均构建通过（`final2-host-build.log`、`final2-client-build.log`）；standalone 依赖图 442 模块，无旧传输依赖。
- 最终构建再次经 standalone CLI → Hub → 真实 Codex 执行：纯不可见可选分工被省略，共同目标正常回应 `ROOT_FINAL_BUS_OK`，同 requestId 重放只有一次运行（`root-final-live-report.json`）。
- Opus 独立操作矩阵 T01–T30、修订版 V01–V18、最终版 F01–F07 已完成。最终反例中不可见分工、真实 Chain 摘要截断、离线焦点/横幅/准备回执复验通过；没有在复验路径发现回归。最后 O16 缺任务误报权限的补丁另有 3 文件 113 项通过（`empty-selected-command-green.log`），Host 再构建通过（`final3-host-build.log`）；Opus 随后在手机宽度输入两条真实 ID 命令复验 G01/G02，通过且无模型轮次/协作派发。最终独立复审已结束。

## 改动位置与 CLI 影响

- `client/src/AgentBusPanel.tsx`、`AgentBusSlots.tsx`、`agent-bus-view.ts`：草稿、角色记录、权限准备、输入验证与错误恢复。
- `client/src/DelegationDialog.tsx`、`bot-references.ts`、`App.tsx`、`agent-bus.css`、`locales/en.json`：单次协作、摘要预览、ADHD 通用离线提示去重与提示样式/翻译。
- `src/client-protocol/agent-bus.ts`：App/CLI 共用写入准入，历史读兼容；没有新协议字段。
- `src/core/shared/delegation-commands.ts`：各现有协作命令入口的缺参拦截；`src/codex/antigravity-models.ts`、`src/core/commands.ts`、`src/runtime/error-classification.ts`：模型与 effort 配对校验和可修复错误说明。
- `src/gateway/agent-bus.ts`：只修正记录摘录的 UTF-16 截断；实际分派全文不变。
- 对应单元、CLI、Hub/Gateway 和浏览器测试，以及本文和入口地图。纯显示变化不新增 CLI 命令；准入和模型校验通过共享服务同时适用于 CLI。


## 1.0.109 发布门槛追加：展开时滚轮回跳

未发布候选 `b5470681` 的 Chromium 回归在 `agent-bus-workspace.spec.ts:1582` 失败：展开 Bus 同时滚回面板顶部后，`scrollTop` 又变为 902。原测试单独重复三次，一次失败、两次通过；WebKit 同项通过，不能因此当作测试噪声放行。

隔离浏览器探针确认滚轮落在 `.adhd-grid`，并非侧栏分隔条；捕获阶段已为 `scrollTop=0`，下一帧却又变为 1343。展开后的最终校正先发出第二个 React reveal，再由卡片的被动 effect 滚动，给用户滚动后仍执行延迟定位留下窗口。

`AdhdBoard.tsx` 将最后一次定位直接放进原来受输入取消约束的动画帧内，同步核对目标面板后滚动；完成后消费该 serial、清理监听。用户中途滚动、点击、按键、调整窗口或收起面板仍可取消，不增加另一轮 React 定位，也不让简单开关侧栏重复唤起已消费意图。保存/重开 Bus、面板容量不足、焦点与草稿、减少动态效果的原有回归保持。

原用例与相邻两项各重复三次：Chromium **9/9**、WebKit **9/9** 通过，未修改原断言。证据在 `release-1.0.109-20261024/bus-fix-{chromium,webkit}.log`；原失败 trace、独立重复和探针日志同目录保留。修复后重新冻结并重建所有发布包；包、独立复审与安装验收以该版本发布记录为准。本项只改变桌面面板的显示定位，CLI API、运行状态、消息、权限、数据和协议不变，不需要新增 CLI 命令。
