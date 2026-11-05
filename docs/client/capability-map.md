# TaroCub 功能适配核对表

核对日期：2026-10-01—02。依据本工作树的 README Feature Map、`docs/slash-commands.md`、命令注册表、原生引擎适配器和各处理入口。这里区分“已接通代码并用本地测试验证”与“真实账号／手机系统验收”，不能把前者当成后者。

进一步的逐命令／非命令功能审查见[全功能对齐审查](functional-parity-audit.md)：覆盖 42 项正式命令、隐藏别名、引擎差异、各状态的归属，以及新发现并修复的频道隔离和重启补发差异。

客户端消息经过 Hub → Gateway → 现有 `handleLarkMessage` → Bridge → 原生引擎；媒体预处理、会话锁、队列、计费和工具审批继续使用 TaroCub 的实现。新客户端 Bot 由独立 worker 承载；既有飞书实例可挂接 Gateway，共享原 Bridge 和 runtime。

| 功能 | 客户端入口和处理逻辑 | 验证与边界 |
|---|---|---|
| 新建 Bot／模型／effort／工作区 | 创建一次实例；`/config`、`/engine`、`/model`、`/effort`、`/yolo`、`/fast` 等仍由共享处理器执行 | `hub-bot-manager`、`gateway-operations`、`gateway-card-states`，浏览器 `creation`；真实引擎须在电脑安装、登录 |
| 新对话、群组、群内话题 | 沿用 Bot 配置，以 conversation ID 划分原生 session；话题继承群的 Bot | `gateway-service`，浏览器 `creation`、`topics` |
| 原生 session 恢复／解绑／重置／工作区 | `/resume`、`/detach`、`/reset`、`/ws` 及会话管理；显式绑定后才共享 session | `gateway-service`、`gateway-operations`；引擎原生会话格式由既有适配器负责 |
| Codex／Claude／Kimi／DeepSeek／Antigravity | 继续启动各自本机 CLI/协议；保留项目指令、认证、MCP 和插件 | 五引擎均有双端真实轮次、重启记忆和强杀恢复证据。最新精简提示词后的 Claude／Kimi／DeepSeek／Antigravity 还通过带说明文件交付、两端下载及手机停止续聊；修正了 AGY 命令检测和 Claude 停止时序。见当前跨引擎验收（本地材料：`evidence/cross-engine-app-acceptance.md`）；原生 App 文件工具已接入 Codex、[Claude](claude-native-app-tools.md) 和 [DeepSeek](deepseek-native-app-tools.md)，对应文件／批次和重启证据见各自记录；Kimi／Antigravity 的[原生接入缺口](native-tool-extension-gaps.md)及各引擎完整功能矩阵继续验收 |
| MCP、插件、技能 | 引擎读取原生全局配置和受信任的当前工作区配置；worker 载入 instance `lark.env` 与共享 `~/.cctb/shared.env` | `gateway-environment` 验证覆盖顺序和受限键过滤；`gateway-voice` 验证 MCP 工具事件、结果和审批。真实 Claude／Kimi＋本机 MCP 已验证正常审批、手机拒绝阻止写入、回传文件和两端下载字节；Codex 0.159.3 已验证正常模式的 MCP 单次确认、原生表单、两端下载与手机停止无追加写入；Kimi 2.1.1 的项目 MCP 需要预先原生工作区信任；远端 MCP 可用性仍取决于其服务和凭证 |
| 流式文字／思考／工具／计划 | 共用运行卡片和事件翻译；运行中工具详情可见，完成后按 TaroCub 原逻辑折叠摘要 | `gateway-cards`、`gateway-card-states`；浏览器 `stream`、`card-layout` |
| 停止、排队、中途引导、后台进程 | 停止按钮与 `/stop`；`/q`、`/steer`、`/bg` 复用原处理器及引擎能力 | `gateway-recovery`、`gateway-workflows`、`gateway-voice`；引导仍受引擎和窗口限制 |
| 选择、AskUserQuestion、工具审批 | 卡片控件原样传回共享处理器，提交／取消后关闭；可跨设备操作 | `gateway-workflows`、`gateway-card-states`，浏览器 `cross-device`；`live-tools` 已通过真实 Claude／Kimi 原生表单与双端审批；`live-codex-input` 通过真实 Codex 原生提问、标准 MCP 表单和两端取消 |
| `/goal`、`/board`、定时任务 | 共用目标、看板状态和 CronScheduler；Gateway 在原会话回传 | `gateway-workflows`、`gateway-operations`；独立 worker 启动时接入调度器 |
| Agent Bus：`/ask`、`/fan`、`/chain`、`/verify`、crew | 按实例 bus 配置连接本地 peer；worker 启动接收服务、注册，退出清理；停止传递给接收方引擎 | `gateway-bus` 验证真实 HTTP、用量／审计／权限／退出及取消隔离；`live-bus` 通过三个真实 Codex worker 的双端 ask/fan/chain/verify、流式后手机停止和新委托。crew 全流程仍待真实验收。默认未启用；App 协作设置编辑托管 Bot 的成员、并行／串联／复核、Crew 角色并提供空闲重启；双端冲突及真实进程启动通过 `collaboration` 浏览器验收。App 协作表单按名称发起四种流程，同名对象以 ID 区分，消息保留原文并展示已知名称；外接实例配置仍待补齐；Hub 注册域是 `<hub>/bots`，不自动并入现有 fleet |
| Mini Bus | `/mini` 把会话注册为轻量 peer，沿用群和话题边界 | `gateway-workflows` 与既有 mini-bus 测试；客户端建群／建话题使用专门 UI |
| 图文／文件／语音合并发送 | 一个消息包含正文和所有附件；上传完成才发布 | `gateway-service`，浏览器 `attachment-composer`、`voice`、`uploads` |
| 麦克风录音 | 计时、取消、结束、试听、附文字发送；切换对话／归档时取消，后台可收到可见性事件时结束为本机草稿 | 浏览器 `voice` 覆盖 Chromium/WebKit、桌面/手机尺寸、真实编码和解码；实体麦克风、来电和操作系统挂起仍待真机验收 |
| 短语音／长录音 | 共用 `createDefaultTranscribeVoice`；本地 Qwen HTTP/CLI、分块、听悟长音频、失败回退、强制路由、取消、缺段保留 | `gateway-voice`、`asr-cloud-routing`、`telegram-message-input`；见下文 |
| 语音回传和播放 | `send.audio` 等交给现有投递层，Gateway 保留文件与实际格式对应的 MIME | `gateway-voice` 验证 MP3/M4A/WAV；浏览器验证录音接收播放 |
| 视频 | 沿用视觉优先：≤10 秒抽帧并尽力转写；更长或时长未知交原文件给引擎 | `message-handler` 及既有视频测试；不能把“长视频交原文件”说成自动完整转写 |
| 图片／文件／批次／压缩包结果 | 现有 `send.file`、`send.image`、`send.batch`、audio/video 标签；继续经过路径和凭证投递预检 | `gateway-cards`、`gateway-workflows`、`gateway-service`，浏览器 `cards`／`uploads`；下载目前为整文件 |
| 引用／转发／链接预览 | 原附件进入引用上下文；转发保存独立副本，操作卡片只读；预览可选标题／卡片，显示方式和内容同步两端，阅读时可临时展开 | `hub-forwarding`、`hub-link-preview`，浏览器 `message-actions`、`link-preview` |
| 跨设备历史／任务／已读 | 同一 Hub 事件日志和快照；离线恢复、流式更新、跨端审批 | 浏览器 `cross-device`、`snapshot`、`stream`。未发草稿、录音草稿、当前页面仍在本机 |
| 运维／状态／用量／审计 | 客户端运行状态、实例服务详情、空闲后重启；Bot 时间线／审计及 Hub 审计支持筛选、分页、脱敏详情和事件统计 | 另有 Bot 详细概览：在线活动、cron 设置／历史、最近 crew 阶段和 UTC 日／月用量；`gateway-operations`、`diagnostics`、`bot-dashboard`，浏览器 `operations`、`diagnostics`、`dashboard`；原生容器与大规模状态性能仍待验收 |
| 文件中心 | 复用原盘点／分类规则；仅已登记 Bot，共享工作区去重，搜索／筛选／占用与来源详情；重要标记、分类、备注由 Hub 共享并检测编辑冲突 | `hub-file-center`、原 Console 回归、`hub-state-backup`，浏览器 `file-center`；原 Console 标注首次导入后由 App 独立管理；实际 Finder、原生容器和大型目录性能待验收 |
| 文档导出 | 客户端明确导出到 Google Docs，保留写入校验收据 | `gdocs` 本地协议验证；真实 Google 授权及外部写入验收待部署阶段 |
| 飞书专属能力 | Docs 评论事件、飞书群授权、飞书 VC 入会属于飞书入口；客户端群／话题／设备授权用原生功能替代 | 客户端不模拟飞书事件；需要飞书账号的业务工具仍可由具备相应配置的本机引擎调用。VC 和外部平台实测未完成 |
| 系统分享／推送／应用锁 | Capacitor iOS/Android 集成与现有客户端设置 | 控制器和浏览器测试已覆盖；系统分享回调、真实推送、签名安装、后台保活待真机及部署验收 |

## 长短语音处理规则

- 麦克风录制优先使用浏览器支持的 M4A/MP4，其次 Opus WebM/OGG。已有音频也可作为附件发送，并附说明文字。
- Gateway 下载原文件后进入共享 ASR。短语音使用本地 Qwen；默认超过 120 秒分块，常规块长 60 秒，CLI 回退块长 45 秒，受本地单次容量上限保护。WebM 这类容器可先由 ffmpeg 提取音轨。
- 自动 ASR 的媒体时长达到 900 秒（15 分钟）且配置 `TINGWU_ASR_DIR` 时，调用既有听悟脚本；它负责 OSS 上传、云端任务及结果获取。客户端本身不新增另一套云转写接口。
- 文字说明包含“强制云端转写”或“强制本地转写”时，沿用现有覆盖规则。云端路径必须已有配置。云端一般失败会尝试本地；主动取消不会触发回退重跑。
- `/stop`／停止按钮取消探测、提取和转写并释放会话队列。本地服务已经进入模型内核的计算可能稍后才终止。
- 成功转写附完成标记传给引擎；部分失败保留现有片段及缺失块编号，不能伪装为完整转写。真正语音消息的空转写会提示失败；以文件形式发送的音频仍保留原文件供引擎处理。
- 对话显示正在转写／完成／部分完成／停止状态。完成卡显示前 2000 字预览，完整文本交给 Bot；原录音仍可播放、引用和转发。成功进度卡不是 Bot 最终答案。
- 云端会接收录音；“文件客户端连到 Mac”不表示配置听悟后所有语音处理都留在本机。

## MCP 和运行环境

独立 worker 使用同一原生引擎和 HOME。用户明确设置的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 等仍有效，不复制或重写其配置。

进程显式环境优先，其次当前 Bot 的 `<hub>/bots/<bot-id>/lark.env`，然后共享 `~/.cctb/shared.env` 补充允许传给引擎的键。ASR 设置使用专门允许列表，不能通过 shared.env 中的任意 extras 注入 `ASR_`／`TINGWU_` 参数。worker 明确固定自己的 state directory，不能误读另一 fleet 实例。

2026-10-01 只读取 MCP 名称的本机核对显示，Codex 配置含 computer-use、四个 hexin-ifind 数据服务、node_repl、openaiDeveloperDocs 和 web-search；Claude 配置含四个 hexin-ifind 数据服务及 web-search。未读取、复制或输出这些服务的密钥；配置存在不等于已逐一验证远端服务在线。

Codex 0.159.3 的原生 `request_user_input` 在 Default 模式下需启用其试验功能 `default_mode_request_user_input`。验收只给临时 CLI 进程启用该标志；App 没有修改全局配置。原生提问本身不因 bypass 而被自动作答。标准 MCP 表单支持有限选项、自由文字、数字、布尔和枚举多选；按服务端字段约束校验，空字段确认必须用户明确允许。手机停止后旧表单关闭，迟到点击无效。

真实 MCP 表单验收使用 `/yolo off` 普通模式；当前 native CLI 在 bypass 下可能直接拒绝服务端表单，不能把协议接通解释为所有审批策略都弹出同样的界面。URL/OAuth、秘密字段、OpenAI 扩展表单以及 Goal 并发中的无归属请求不在本次已验收范围。标准表单不代表任意 MCP JSON Schema 都已支持。版本依据为本机生成 schema 与 [Codex 0.159.3 elicitation 实现](https://github.com/openai/codex/blob/rust-v0.159.3/codex-rs/codex-mcp/src/elicitation.rs)。

原生额外文件／网络权限通过独立审批处理，明确区分“本轮允许”和“本会话允许”，不会被普通问答或自动模式隐式批准。未知权限约束、无归属请求及超出完整展示预算的请求都返回空授权；详情按字面 JSON 展示，批准只回传展示过的原始权限。实际验收及版本限制见[验收记录](implementation-status.md)。

完整剩余工作以 [implementation-status.md](implementation-status.md) 为准。VPS、正式签名、推送和外部账号验收按用户要求后置。
