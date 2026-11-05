# TaroBot 官方通义听悟适配器

这是 TaroBot 长音频云端转写的官方参考适配器。**不要给每个 Bot 分别开发适配器。** 一台机器只维护一个共享目录，各 Bot 实例通过 `TINGWU_ASR_DIR` 指向它。

## 职责边界

- TaroBot 负责下载媒体、探测时长、选择云端或本地路线、取消任务、失败回退，以及在进入 Codex、Claude、Kimi、DeepSeek 或 Antigravity 前注入转写文本。
- App「设置 → 语音转写」可选全部本地、全部云端、按时长自动选择。
- 全部云端对所有录音执行本目录适配器；自动模式达到阈值（默认 900 秒）后使用云端。
- 仅自动模式在云端失败后回退本地；全部云端失败直接报告，不悄悄切换。
- 适配器负责 OSS 临时上传、签名 URL、听悟离线任务创建与轮询、结果下载及临时对象清理。
- `transcription.txt` 会从听悟的结构化段落和词元重建：保留重复词、恢复英文空格，并且只在多人录音中添加发言人标签。
- TaroBot 只向子进程传递最小化的系统、证书和代理环境，不透传 Bot、引擎或云端凭据；适配器只从自己的 `.env.local` 加载阿里云凭据。
- 收到 `SIGTERM`/`SIGINT` 取消信号时，适配器会先清理临时 OSS 对象再退出；若清理卡住，TaroBot 仍会在有界宽限期后升级为 `SIGKILL`。
- 通义听悟没有本地常驻端口。`8412` 是本地 Qwen ASR 的端口，只用于短音频和云端失败回退。
- 阿里云凭据只保存在本目录的 `.env.local`；TaroBot 不读取、不复制、不记录它。

## 安装

在 TaroBot 仓库运行：

```bash
bash scripts/install-tingwu-asr.sh
```

默认安装到 `~/.tarocub-secrets/tingwu_asr`。安装器会复制官方适配器、创建虚拟环境并安装锁定版本的依赖，但会刻意留到下一步才创建 `.env.local`；绝不会覆盖已有凭据。

填写配置：

```bash
bash ~/.tarocub-secrets/tingwu_asr/configure_env.sh
```

需要：最小权限 RAM 用户的 AccessKey、听悟项目 AppKey、专用 OSS Bucket/Endpoint/Prefix。不要使用主账号 AccessKey，也不要通过聊天发送 `.env.local`。
配置向导默认拒绝覆盖已有的非空文件；只有确实要整体轮换或替换凭据时才使用 `--force`。

先独立验证：

```bash
cd ~/.tarocub-secrets/tingwu_asr
out_dir="$(mktemp -d /tmp/tingwu-smoke.XXXXXX)"
.venv/bin/python tingwu_transcribe.py \
  --file "/绝对路径/测试音频.m4a" \
  --source-language auto \
  --wait \
  --out-dir "$out_dir"
test -s "$out_dir/transcription.txt" && echo "Tingwu OK: $out_dir"
```

必须验证 `transcription.txt` 非空，不能只看退出码。配置检查不读取凭据值，不能代替这一步真实认证烟测。

## 接入 TaroBot

推荐在 App 的「设置 → 语音转写」检测已有安装、选择目录、设置切换时长并明确同意启用云端。
CLI 同步提供 `tarobot integrations voice status/set`，复用同一主机 API。
设置页不读取凭据；“配置就绪”不等于上面的真实云端测试成功。首次保存后该 Host 的新版
Bot 从下一条语音读取统一策略，不需要为开关重启；旧 Worker 需要更新后再使用。
详见 [语音设置行为与边界](../../docs/client/voice-transcription-settings-2026-10-21.md)。

以下环境变量方式保留为尚未采用主机托管策略时的兼容入口：

将以下非秘密配置加入 `~/.tarobot/integrations.env`（所有 Bot）或 `<Hub-state>/bots/<bot-id>/bot.env`（单个 Bot）。私有适配器目录保留历史名称以兼容已保存路径，不代表依赖飞书：

```bash
TINGWU_ASR_DIR="/absolute/path/to/.tarocub-secrets/tingwu_asr"
ASR_CLOUD_THRESHOLD_SECONDS="900"
ASR_CLOUD_JOB_RETENTION_DAYS="7"
```

路径必须是该机器的真实绝对路径。多个 Bot 只重复这几行，不复制适配器和凭据目录。

从 App 重启受影响的空闲 Bot，再发送测试媒体。`tarobot doctor` 用于主机环境检查，不代表听悟云端认证已成功。

自动模式端到端测试时，发送达到所设阈值的音频；也可把“强制云端转写”和音频放在同一条消息或同一批发送。事后单独发送关键词不能改变已经启动的转写路线；全部本地/全部云端模式不受该关键词覆盖。
