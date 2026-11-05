# 本地 Qwen3-ASR

TaroBot 短语音的本机服务，以及 HTTP 不可用时的 CLI 回退。HTTP 与 CLI 复用逐段识别、推理串行和缓存回收；模型不打包进 App。手机通过所连接的主机转写，不在手机安装模型。

## 安装、启用和状态

需要 **Python 3.12、ffmpeg 和 ffprobe**。macOS 可用 `brew install python@3.12 ffmpeg`；Linux 使用发行版包管理器。PyTorch GPU 版本需匹配主机环境，CPU 也可运行。尚不提供原生 Windows 后台服务一键安装；Windows 内存监测代码已覆盖，但不代表完成 Windows GPU 实机验收。

App：**Skills 与 MCP → 语音与搜索建议（可选）→ 本地语音转写**。首次创建本机 Bot 的建议页也有入口。仅已认证主机所有者可以确认安装，操作作用于当前连接主机的操作系统用户。显示模型、服务、当前内存、看门狗和安装进度；失败不会显示已启用。旧主机显示更新提示。

无界面用户可以运行同一个安装器，不启动第二个 Hub：

```sh
tarobot integrations asr status --json
tarobot integrations asr install --yes --json
```

源码和独立包也支持：

```sh
# 原有默认行为：只安装代码和 Python 依赖，不下载模型、不注册或重启服务
PYTHON_BIN=python3.12 bash scripts/install-qwen-asr.sh
# 下载模型并注册当前用户后台服务
bash scripts/install-qwen-asr.sh --with-model --as-service
# 只查看将生成的服务配置，不写文件、不下载
bash scripts/install-qwen-asr.sh --with-model --as-service --dry-run
bash scripts/install-qwen-asr.sh --status
```

默认安装 `~/.tarobot/integrations/qwen3-asr`；`--dir /规范绝对路径` 可更改；安装目录及祖先路径不得为符号链接（包括 `/tmp`、`/var` 等别名），可先取 `realpath`。符号链接 HOME 暂不自动处理。目录需位于支持 `flock` 的本地文件系统；网络盘不在支持范围，exFAT 等其他文件系统尚未实测。`--no-deps` 仅复制代码，不验证 Python 依赖安装成功，不适合作为完整安装验收。所有路径由参数、用户目录和环境推导。模型来源及许可见 [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)。

已有完整模型可复用：

```sh
ASR_MODEL_PATH=/绝对路径/已有模型 bash scripts/install-qwen-asr.sh --with-model --as-service
```

检查模型配置、分词器、权重头和长度；配置的模型不完整时拒绝安装，不覆盖它。没有显式路径和安装记录时，先校验并复用旧默认目录 `~/projects/qwen3-asr/models/Qwen3-ASR-0.6B`。仍未找到模型时 `hf download` 使用 Hugging Face 缓存和断点续传。下载前检查至少 4 GiB 模型空间；首次依赖安装检查至少 8 GiB，实际依赖大小因平台而异，不能保证其他进程不会在安装途中占满磁盘。缓存可用 `PIP_CACHE_DIR` 等放置到其他磁盘。

安装采用跨进程锁；重复请求编号返回原回执，网络断线不自动重复安装。依赖哈希一致时复用虚拟环境；正在运行的标准服务不允许原地更新依赖。检测到端口占用或已注册服务时明确拒绝，不擅自停止其他服务。

## 后台服务和恢复

- macOS：`com.tarobot.qwen3-asr`，用户 LaunchAgent，`KeepAlive=true`。
- Linux：`tarobot-qwen3-asr.service`，`systemd --user`，`Restart=always`。默认登录后启动；不自动开启 linger，退出登录后持续运行需管理员另行配置。
- 服务配置显式写入 `ASR_RECYCLE_IDLE=1`、模型路径和安装身份。启动后核对同一身份的 `/status`，才保存启用配置。
- `~/.tarobot/integrations.env` 权限 600，保留其他键，写入 HTTP、CLI、模型路径和 `ASR_SERVICE_COMMAND`。已有显式进程环境/每 Bot 配置优先，不覆盖它们。已运行 Bot 在空闲后重启才能读取新的公共配置；新服务的默认 HTTP 地址可以直接使用。
- 连续 HTTP 故障看门狗和空闲内存看门狗互补：前者执行固定本机修复命令；400/422/429 等输入错误及 503 忙碌不触发重启。后者在服务空闲且内存超限时退出，由监督器拉起。
- 修复命令与转写共享进程间锁，模型冷启动、已接受和排队的请求持锁；修复拿不到独占锁时拒绝，修复过程中新的请求返回忙碌。不同 Bot 的修复还共享至少 60 秒冷却。不强杀卡住且仍持有锁的推理或模型加载，需要人工判断后处理。`activeRequests` 长期不变、转写无完成记录或加载一直未出现 listening 时，应先确认任务状况，再按下方人工停止/恢复步骤处理。

安装失败保留依赖/下载缓存用于重试；服务启动失败尝试撤销注册。撤销失败保留服务配置，明确报告失败，需先核对服务状态；不会把未验证的启用当作成功。安装日志位于 `~/.tarobot/asr-install.log`，App/CLI 管理入口限制 16 MiB，不向手机返回日志内容。

## 空闲内存看门狗

| 设置 | 行为 |
| --- | --- |
| `ASR_RECYCLE_IDLE=1` / `0` | 强制开启 / 关闭，最高优先级 |
| 未设置，launchd 或 systemd 直接管理 | 默认开启 |
| 手动启动或只继承监督器环境变量 | 默认关闭 |
| `ASR_WATCHDOG_INTERVAL` | 定时检查秒数，默认 300 |
| `ASR_WATCHDOG_GB` | 空闲回收阈值，默认 5.5 GiB |

自动判断检查 `XPC_SERVICE_NAME` / `INVOCATION_ID`，并核对父进程、监督器登记的实际 PID 和成功退出后的重启策略（launchd KeepAlive / systemd always 或 on-success），防止从 GUI 或受监督程序启动的普通子进程误退出。包装脚本无法确认时保守关闭；服务配置应显式开启。启动日志说明状态、原因、间隔和阈值。每次请求结束以及定时检查均受同一队列状态锁约束，有处理中或排队请求时不退出。

macOS 使用 `proc_pid_rusage` 的物理 footprint（包含 MPS）；其他平台使用 psutil RSS，加当前 PyTorch 进程 CUDA reserved 显存池，避免 allocated/reserved 重复相加。它们不是完全相同的系统指标，GPU 占用也不含驱动所有开销，阈值需按硬件评估。读取失败明确记录 `Watchdog unavailable`，状态返回 `available:false`，不会把 0 当作成功。

示例日志：`Watchdog: footprint 5.8GB > 5.5GB while idle (after request); exiting for supervisor restart`。只记录资源数字和触发原因，不记录音频路径或转写内容。

## 接口与安全边界

- `GET http://127.0.0.1:8412/health`：就绪返回 `ok`。
- `GET /status`：安装身份、请求数、模型存在性、内存和看门狗状态；不返回本机路径或转写内容。
- `POST /transcribe`，JSON `{"path":"/绝对路径/音频.ogg"}`，返回纯文本；音频经过 ffprobe 校验。
- 只监听 `127.0.0.1`，最多 8 个处理/等待请求，拒绝浏览器 Origin 请求，无 `/shutdown`。错误不回显文件路径、内容或底层异常。相同操作系统账户的本地进程属于信任边界。
- 默认单请求最多 300 秒，内部最多 45 秒一段；TaroBot 对长录音先切段，配置听悟后可路由更长音频。默认 MPS float16，可用 `ASR_DTYPE=float32` 调整。
- HTTP 与 CLI 共用 FFmpeg 解码，支持其能够读取的音频容器，包括手机的 Opus/M4A、AAC/M4A、OGG、WebM、MP3 和 WAV；不依赖 librosa 的可选格式回退。通过标准输出读取单声道 16 kHz PCM，转换为 float32，解码本身不写临时音频文件。FFmpeg 有 120 秒超时及解码输出上限；实际解码超过单请求时长上限会拒绝整个输入，不返回截断转写。无音轨、无效编码和解码超时返回通用 400，不回显路径或底层 stderr。
- Hub 安装 API 复用当前主机 owner 会话检查，严格参数仅允许模型/服务选项及请求编号，不能传任意脚本、路径或 shell 命令；执行前再次校验。Bot 实例令牌不能调用 owner API。相同 OS 用户的高权限 Bot 可访问本机所有者 CLI，这是已有本机信任边界，并非本功能能隔离的沙箱。

旧服务迁移应先验证新环境和模型，确认旧服务空闲，禁用并停止旧监督器，再注册新服务。验收须包含实际转写，不仅健康检查。保留旧目录、服务配置和原公共环境副本；回滚先禁用/停止新服务，再恢复配置、启用旧服务，避免双实例抢端口。与其他 Agent 共用的脚本及数据不自动迁移或删除。


## 已注册服务的人工升级 / 回滚入口

本次不自动覆盖运行中的 ASR。先确认 `/status` 的 `activeRequests` 为 0，保留标准目录和私有配置副本，再由主机操作者停止并移走原注册文件，运行新版安装器。macOS 使用 `launchctl disable gui/$(id -u)/com.tarobot.qwen3-asr`、`launchctl bootout gui/$(id -u)/com.tarobot.qwen3-asr`，保留 `~/Library/LaunchAgents/com.tarobot.qwen3-asr.plist` 备份后移走原件。Linux 使用 `systemctl --user disable --now tarobot-qwen3-asr.service`，保留并移走 `~/.config/systemd/user/tarobot-qwen3-asr.service` 后执行 `systemctl --user daemon-reload`。随后用新版 `--with-model --as-service` 注册，校验健康、状态及实际音频；失败时先停止新版，再恢复目录、配置和旧注册文件。不要同时启动两份服务。

App 安装失败只提供已确认的错误和重新核对状态，不提供自动删除旧服务或覆盖升级的按钮。CLI 遇到另一个进程正在安装时返回真实的 `job.status=running`，不重复执行；使用 status 命令继续查看。

故障恢复命令 `--restart` 只检查并重启现有标准服务，不复制内置脚本；重新安装才会使用安装器所携带的版本。修复需要同时进入仓库源文件和标准服务，后续 App / CLI 构建再从仓库打包。不要手工修改已签名 App 的资源或把旧安装包当作新版服务的修复来源。

解码回归可在已安装 ASR 的 Python 环境执行 `TAROBOT_REQUIRE_ASR_CODECS=1 python -B tests/python/qwen_decode_test.py`（在仓库根目录运行）。测试实时生成手机常见容器，不下载模型；此模式要求 numpy、ffmpeg 和 ffprobe 都可用，缺失时失败而非跳过。仅 Node 开发环境仍运行错误处理测试，并明确跳过需要这些依赖的部分。上线验收还应使用真实手机录音通过运行中的 `/transcribe`，不能以 `/health` 或纯 WAV 测试代替。

旧 Host 仍将无效输入计为失败时，修复 helper 会先检查新版服务的推理失败计数；推理健康时不重启。模型返回乱码或持续空文本属于质量问题，不自动重启；极少数可通过时长校验但在解码阶段失败的文件仍可能触发一次空闲修复，受请求锁和共享冷却限制。
