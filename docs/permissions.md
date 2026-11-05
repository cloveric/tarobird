# Bot 权限与批准

TaroBot 沿用已有的高自主性默认配置，并在创建界面明确标注默认项。
已经保存的 Bot 配置不会因为升级而改写。权限属于 Bot，同一个 Bot 的独立对话、
群聊、话题和后续定时任务使用同一配置；各 CLI 自身的显式规则仍然适用。

## 可选模式与真实含义

| 引擎 | 默认 | 其他选择与原生映射 |
| --- | --- | --- |
| Codex | 完全访问 Bypass：`danger-full-access` + `never` | 普通审批：`workspace-write` + `on-request`；工作区自动执行：`workspace-write` + `never`。后者不是 Codex 新版 `--approve-for-me` 自动审查。 |
| Claude | 完全访问 Bypass：`--dangerously-skip-permissions` | Manual、Auto、Accept edits 分别明确传 `--permission-mode manual/auto/acceptEdits`；剩余权限请求送到 App 批准卡。审批模式不等于系统沙箱。 |
| Kimi | YOLO：ACP `yolo`，普通工具自动批准，敏感操作仍可询问 | Default：ACP `default`；Auto：ACP `auto` / Never Ask，即高危或无法分析的命令也自动执行。选择并保存 Auto 是显式选择此行为，同时记录 `kimiAutoNeverAskAcknowledged`。三个模式均无系统沙箱。 |
| DeepSeek Harness | `danger-full-access` | 普通审批：`workspace-write` + ask；工作区自动执行：TaroBot 的 `full-auto` preset，工作区沙箱 + never。 |
| Antigravity | `--dangerously-skip-permissions` | 沙箱自动执行：同时传 `--sandbox`；普通审批：在 App 先批准整轮任务，批准后按前述沙箱自动执行。不是逐条命令审批。 |

Codex 默认使用 app-server。旧版 `codexRuntime: process` 只能在启动前批准整轮，
界面会显示“每轮批准”，批准后以工作区沙箱、never 执行；不会误报逐工具审批。

Claude 旧配置的 `approvalMode: full-auto` 实际一直是 `bypassPermissions`，
现在在界面显示“完全访问”，不会冒充较严格的 Auto。
Claude Auto / Accept edits 用 `approvalMode: normal` 加 `claudePermissionMode`
保存，确保桥接层不会把 CLI 剩余的权限请求自动放行。
CLI 不支持所选原生模式时会报告启动错误，不静默降级为完全访问。
配置文件缺失、损坏、读不到或权限字段无效时，本轮执行会停止并提示修复，
不会回退到 Bypass。合法配置未填写权限字段时仍沿用上表默认值。
通过其他配置命令修复损坏文件时，保留原文件备份并恢复为普通审批；
重新选择引擎也不会把无效权限字段变成完全访问。需要更宽权限时须明确选择。
切换或重复选择 Antigravity 不会把显式的“每轮批准”改成自动执行。
2026-10-12 在本机核对了 Codex 0.162.1、Claude Code 2.1.296、Kimi 2.1.1
的帮助和 Antigravity `agy --help`；更老的 CLI 可能需升级。

## App 中使用

- 新建 Bot：选择引擎后，“权限与批准”显示该引擎专属选项、默认值和实际限制。
- 已有 Bot：右键 Bot → Bot 设置，或对话详情 → 权限与批准。
  群内可以选择具体 Bot，不会修改其他成员 Bot。
- 手机与电脑使用同一 Hub 配置。仅主机拥有者可修改；其他设备或本机修改后，
  旧界面保存会提示重新读取，不会覆盖较新的设置。
- 有任务在执行或等待批准时，先完成或停止，再重新读取并保存。
  其他 Bot 委派来的任务也计入忙碌状态；保存等待文件锁和写盘后会再次核对。
  不会为了切换权限而清空会话或强制杀掉正在运行的任务。
  长期后台任务也可能阻止原生进程切换；后续任务不会借用过时的更宽权限继续运行。
- 需要批准时，对话中的权限卡提供允许、拒绝，以及引擎确实支持的作用范围。
  例如“允许一次”“本会话允许”“本轮允许”不是可以随意互换的选项。

配置更新只写入对应权限字段及并发修订标记，使用既有文件锁、私有权限临时文件
和原子替换；不返回 API Key、环境变量或其他配置内容。此功能不修改本机全局 CLI 配置。

## 文件发送路径

桌面、手机和无窗口主机共用同一发送规则。“完全访问”默认允许从任何主机可读的
绝对路径发送普通文件，等效于 `TAROBOT_ALLOW_ANY_FILE_PATH=1`，无需先复制到工作区。
其他权限模式仍限制在工作区和本轮输出目录；环境变量 `1` 不会把普通权限升级为完全访问。
Claude 历史 `full-auto` 按其实际 Bypass 处理；Kimi 只有明确确认的 Auto 才算完全访问。

可以在对应 Bot 的 `bot.env` 中显式设置 `TAROBOT_ALLOW_ANY_FILE_PATH=0`，保留路径限制。
旧 `lark.env` / `CCTB_LARK_ALLOW_ANY_FILE_PATH` 仅作兼容读取；显式进程设置优先，
其次 `bot.env`、旧文件。同一来源中新名称优先，空值也视为关闭。
权限在每次发送前读取；env 已由 worker 启动加载时，修改 env 后需在空闲时重启该 Bot。
配置不可读或权限损坏不会默认放开。`.env`、`bot.env`、`*.env` 和私钥仍不可作为附件发送。
原生单文件、批量工具及兼容发送指令使用同一规则；CLI 主机不需要额外命令。

## 验证边界

适配器测试验证原生参数、审批回调与拒绝结果；独立 Hub/Gateway 的桌面及手机尺寸
浏览器测试验证创建、保存、跨设备冲突、权限隔离和批准卡回执。
这些测试不等于全部云端模型的真实调用验收，也不代表已发布或安装新版原生 App。
