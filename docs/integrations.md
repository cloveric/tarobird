# TaroBot 搜索与语音能力

独立 Node 包和桌面内置 Host 均携带搜索 MCP、Qwen 本地 ASR 适配器、通义听悟适配器、安装脚本及无密钥模板。运行代码可分发；真实密钥、账户配置、模型、用户录音和转写结果不分发。手机通过 Hub 使用同一套能力，无需安装 Python 或模型。

## 首次本机 Bot 的可选建议

桌面版创建本机第一位 Bot 后，显示「语音与搜索建议」：

- **Qwen3-ASR 0.6B**：本地语音转写，安装前检查依赖、已有模型和可用空间，默认优先使用内置硬盘；空间不足或用户指定外置存储时，再使用已挂载的外置磁盘。[官方模型说明](https://huggingface.co/Qwen/Qwen3-ASR-0.6B)。
- **通义听悟**：长录音云端转写，默认不勾选；需主机私有凭据、OSS 配置和明确的上传/费用同意。
- **Tavily + Brave**：配置联网搜索；使用用户自己的密钥。[Tavily 控制台](https://app.tavily.com)、[Brave 控制台](https://api-dashboard.search.brave.com)。

可分别选择，也可直接「跳过，开始对话」。只在原生桌面确认的本机主机、尚无现存或已删除 Bot 的情况下首次展示；手机、网页和远程主机的新建流程不插入此步骤。已有 Bot 可在「Skills 与 MCP → 语音与搜索建议（可选）」再次进入，始终针对当前选中的主机和 Bot。

「让 Bot 协助配置」生成可编辑的配置消息，确认后放入独立对话的草稿，仍需用户发送。它不会自动安装、下载模型或提交密钥；也不代表能力已经可用。Bot 应先核对已有配置，按随包说明配置和验证，密钥只在主机私有配置中填写。当前 Qwen 安装脚本为 Bash 脚本，不宣称原生 Windows 一键安装；Windows 应先检查兼容环境和依赖，不支持时明确说明。

本地语音另有直接安装入口：在同一建议页的「本地语音转写」中，由主机所有者确认下载依赖和模型并注册服务；展示进度、服务状态、模型、内存和看门狗。远程手机操作作用于当前连接的主机。需要 Python 3.12 与 ffmpeg/ffprobe；原生 Windows 暂不支持一键注册服务，旧主机提示更新。原「让 Bot 协助配置」仍只生成草稿。

CLI：`tarobot integrations asr status --json`、`tarobot integrations asr install --yes --json`。CLI 和 Hub 使用同一安装器，不启动第二个 Hub。新增 owner API `/api/integrations/asr` 与 `/api/integrations/asr/install`；同一请求编号不重复安装，进度持久保存。完整参数、失败恢复和平台限制见 [Qwen 安装说明](../integrations/qwen3-asr/README.md)。

## 一处私有配置

从仓库或独立包根目录执行：

```sh
mkdir -p "$HOME/.tarobot"
chmod 700 "$HOME/.tarobot"
# 仅首次创建；已有文件请直接编辑，不覆盖。
(umask 077; set -C; cat integrations/.env.example > "$HOME/.tarobot/integrations.env")
```

编辑 `~/.tarobot/integrations.env`，仅在本机填写搜索 API 密钥及 ASR 路径，权限设为 `600`。值是字面量，不展开 `$HOME`、`~` 或 shell 命令，路径填绝对路径。

优先级：显式进程环境 → 每 Bot 的 `bot.env` → 旧 `lark.env` → TaroBot 私有公共配置 → 旧 `~/.cctb/shared.env`。空值会阻止低优先级环境文件补值；搜索 MCP 另有读取既有 Codex 搜索密钥的兼容回退。旧文件不会被复制或改写。改动后仅重启受影响的空闲 Bot。此文件不能更改 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`NODE_OPTIONS` 等进程边界。

ASR 参数在创建转写器时读取，避免 Worker 加载配置晚于模块导入而失效；长语音路由参数仍按每次请求读取。

## 网页搜索和正文提取

私有配置填写 `BRAVE_API_KEY` 和/或 `TAVILY_API_KEY`。支持快速搜索、深度搜索、双源验证、失败回退、正文提取、来源记录和脱敏状态检查。Claude、Codex、Kimi、DeepSeek 的 TaroBot 适配器在配置了搜索 API 时自动接入；未配置时保持引擎原生搜索。Claude/Codex 已有可用或明确禁用的同类 MCP 时，保留用户设置。

独立运行 Claude/Codex CLI（不经过 TaroBot），或使用 Antigravity 时，可注册随包附带的入口（替换为固定位置的源码或独立包绝对路径）：

```sh
codex mcp add web-search -- node /绝对路径/TaroBot/scripts/search-mcp.mjs
claude mcp add -s user web-search -- node /绝对路径/TaroBot/scripts/search-mcp.mjs
agy mcp add cctb_search node /绝对路径/TaroBot/scripts/search-mcp.mjs
```

启动器读取本机私有配置，注册命令不包含密钥。已注册搜索服务时先检查原配置，避免重复注册。桌面内置 Host 的路径随安装位置变化；手动注册建议使用固定位置的独立包。更多协议见 [搜索 MCP](search-mcp.md)。明确留空的 API 会阻止旧 Codex 配置回退；未设置才读取启用的旧注册项。有 API 时优先使用已接入的 Search MCP，失败时保留原生搜索作为回退并说明失败。直接调用未配置的 MCP 仍会返回未配置提示。

## Scrapling 网页抓取 Skill（可选）

仓库与独立 CLI 包提供 `skills/scrapling/SKILL.md` 和
`scripts/install-scrapling.sh`。它独立于 Brave/Tavily Search MCP；不配置搜索
API 也可以使用原生搜索，公开网页抓取则可按需使用 Scrapling。

macOS/Linux 在包根目录执行 `bash scripts/install-scrapling.sh`，安装或升级到
与 Skill 配套验证的 **Scrapling 0.5**，并安装浏览器依赖。已有 venv 会复用；
`SCRAPLING_VENV`、`SCRAPLING_BIN_DIR` 可覆盖安装位置，`CODEX_HOME` 和
`CLAUDE_CONFIG_DIR` 可指定 Skill 目录。Scrapling 0.5 需要 Python 3.10+：脚本在改动
任何内容前检查解释器（部分 macOS 环境中的 `python3` 版本较旧），可用 `SCRAPLING_PYTHON`
指定新版解释器；已有旧版本 venv 需要重建。运行时升级后，本脚本不会自动回滚，因此
脚本先安装配套的 CLI 链接和 0.5 Skill，再安装浏览器依赖；浏览器依赖失败时返回
失败并说明 HTTP 抓取不依赖浏览器、浏览器抓取需重跑脚本，不会宣称完整安装，也不会留下
描述旧命令的 Skill。Windows 暂无此脚本的原生安装支持。

下载 App/CLI 包本身不等于已经安装 Python、Scrapling 或 Chromium；Skill
与安装器随包分发，运行环境仍是可选安装。版本固定为已验证版本，不随每次
安装自动追踪可能改变 API 的未来大版本。0.5 用 `fetch` 和 `StealthyFetcher`，
详见 [官方迁移说明](https://scrapling.readthedocs.io/en/latest/migrating-to-v0.5.html)。

## 短语音 / 视频音轨

见 [Qwen 安装说明](../integrations/qwen3-asr/README.md)。需要 Python、ffmpeg/ffprobe、Python 依赖和模型。默认新目录 `~/.tarobot/integrations/qwen3-asr`；尚未安装时仍兼容已有 `~/projects/qwen3-asr`。

本地 HTTP 服务与 CLI 回退共用 FFmpeg 解码，再输入 Qwen 模型。手机的 Opus/M4A、AAC/M4A 不再依赖 Python 音频库的格式回退；无音轨、解码失败或超时返回通用输入错误。保持原有时长校验、分片和并发限制，另限制解码输出大小，避免错误的容器时长造成无界内存分配。服务升级必须包含真实手机录音验收，详见 [M4A 修复与验证](https://github.com/cloveric/tarobird/blob/main/docs/client/qwen-asr-m4a-2026-10-20.md)。

安装器 `--with-model --as-service` 复用已有模型，注册 launchd / systemd 用户服务并保存公共配置；无参数行为保持只安装依赖和代码。依赖准备未完成时不会抢占旧 CLI 回退路径。已运行 Bot 需空闲后重启读取新公共配置。

HTTP 快路径 → 有界重试 → CLI 回退；长本地音频逐段处理。丢失片段会标注部分结果，取消不会重新开始转写。模型不打包进 App，不会在打开 App 时自动下载。

## App 中管理语音转写

「设置 → 语音转写」汇总本地 Qwen 状态与安装、转写方式、时长阈值及已有配置检测。
支持全部本地、全部云端、按时长自动选择；仅自动模式显示长语音起点（1–120 分钟）。
保存前明确确认云端上传与费用；保存后回读核实，新版 Bot 从下一条语音读取新策略。
云端凭据仍只在主机私有目录中配置，检测到文件不会标成云 API 验证成功。
旧后台需更新时会列出对应 Bot。首次保存后采用当前 Host 的统一云端策略，覆盖旧的
每 Bot 云端目录与阈值；保存前保留原有配置，查看页面不修改它们。

CLI：`tarobot integrations voice status --json` 和 `tarobot integrations voice set` 复用同一 Hub 接口，
不启动第二个 Hub。参数、权限、失败恢复与验证边界见 [语音设置说明](client/voice-transcription-settings-2026-10-21.md)。

## 通义听悟与转写方式

```sh
bash scripts/install-tingwu-asr.sh
bash "$HOME/.tarocub-secrets/tingwu_asr/configure_env.sh"
```

配置器在私有目录生成 `.env.local`；阿里云 AccessKey、听悟 AppKey、OSS 凭据仅在该文件填写，不进入公共配置、Bot 工作区或客户端。随后在「设置 → 语音转写」选择已检测到的目录，使用“全部云端”或“按时长自动选择”；自动模式默认阈值 15 分钟。尚未采用 App 托管策略的主机仍可在 `~/.tarobot/integrations.env` 设置实际绝对路径 `TINGWU_ASR_DIR`、`ASR_CLOUD_MODE=auto|local|cloud` 与 `ASR_CLOUD_THRESHOLD_SECONDS=900`。安装脚本不会覆盖已有 `.env.local`。

适配器包含 OSS 临时上传、听悟任务、轮询、转写文本整理和远端临时对象清理；自动模式的云端失败回退本地；全部云端模式直接报告失败；取消不回退。云 API 可用性取决于账户、权限、区域和余额，见 [听悟说明](../integrations/tingwu-asr/README.zh-CN.md)。检查命令不会读取密钥文件内容或启动付费任务。

## 其他配套能力

| 能力 | 已随项目维护 | 外部前提 / 迁移边界 |
| --- | --- | --- |
| 搜索 + 正文提取 | 双提供商 MCP、回退、来源记录 | 私有 API 配置；原生引擎 MCP 注册 |
| 语音 / 视频音轨 | Qwen 服务、CLI、切段、取消、部分结果 | ffmpeg/ffprobe、Python、模型 |
| 长录音 / 会议 | 听悟适配器、OSS 生命周期、回退 | 阿里云账户及私有凭据 |
| 多引擎 Bot | 五种引擎适配器 | 对应 CLI、用户登录/订阅；不复制登录态 |
| 文件 / 文档 | 附件存储、转发副本、预览、导出、权限 | 特殊格式外部打开依赖系统应用 |
| 定时任务 | 调度、存储、执行历史 | 主机在线、时区、引擎可用 |
| Google 文档 | gdocs 命令与导出 | OAuth 授权；不分发 token |
| 浏览器、行情、办公 MCP / Skills | 通过各引擎既有集成接入 | 按需独立安装；不整目录复制个人配置或插件缓存 |
| 手机外网 / 推送 | Hub、可选 relay、设备授权 | HTTPS/网络、relay 或推送配置；不打包身份密钥 |

## 检查与打包

```sh
npm run build                    # 仅源码目录，独立包已有编译结果
node scripts/check-integrations.mjs
node scripts/check-integrations.mjs --probe
# 检查某 Bot 的有效配置：
node scripts/check-integrations.mjs --state-dir /绝对路径/Hub/bots/bot-id --probe
```

报告只含配置存在性和健康状态，不显示环境值、请求头、凭据内容或签名 URL。`--probe` 仅增加 ASR 健康检查，不调用搜索/通义 API。文件存在不代表 Python 依赖、模型推理或云鉴权已实测成功。

独立包和桌面 Host 共用 `scripts/integration-assets.mjs` 中逐个文件的白名单；集成目录中即使出现 `.env.local`、模型、输出或缓存，也不会被复制。模板只列键名和非敏感默认值。提交前同时检查暂存文件和实际打包清单。
