# 真实短／长语音链路验收

2026-10-04。补齐原计划 6.3 的真实转写链路及用户要求的长短语音适配。
使用临时 Hub、正式 Gateway worker、Kimi 2.1.1 已配置默认模型（low），以及
独立的桌面和手机浏览器上下文。没有接触用户麦克风或私人录音。

## 通过范围

| 流程 | 实际输入与服务 | 浏览器 | 结果 |
|---|---|---|---|
| 手机录制、试听草稿、带文字发送、转写、Bot 回答 | macOS 合成约 5.87 秒中文语音；真实 MediaRecorder 编码；真实 Qwen HTTP 服务 | Chromium | 通过 |
| 同上 | 浏览器录音和实际 Qwen 请求独立执行 | WebKit | 通过 |
| 手机上传长录音、带文字发送、自动云端转写、Bot 回答 | 真实 905 秒 M4A；已配置的听悟与 OSS；没有改阈值或伪造时长 | WebKit | 通过 |

短录音的城市、星期和时间只存在于音频里；长录音的开场主题、地点和结束安排
分别位于音频开头、约 892 秒处。用户文字只要求整理这些信息，不提供答案。
三个流程中，真实 ASR 转写和 Bot 正文都包含全部预期信息。折叠过程文字不计作
Bot 的回答。

短录音分别产生约 6.20／6.34 秒的 MP4；透明观察器确认每轮一次本地 ASR 请求、
HTTP 200、没有云任务。长音频保持 905 秒；观察器确认一次听悟进程、零本地
ASR 请求，未发生失败后的本地降级。观察器只记录输入字节摘要和进程事件，
不改变参数、回答或转写结果，不读取密钥，不记录签名 URL。

每轮输入在 Hub 中只有一条「文字＋音频」消息；真实转写状态卡和回答同步到两端。
桌面和手机的播放器都成功解码、播放时间推进、无音频错误；两端附件缓存的
SHA-256 都与进入 ASR 的原始附件一致。检查了手机与桌面截图，没有横向溢出。

查看 短录音手机结果（本地材料：`screenshots/live-voice-20261004/short-webkit/voice-result-phone.png`）、
长录音桌面结果（本地材料：`screenshots/live-voice-20261004/long-webkit/voice-result-desktop.png`）。
原始回执、日志及截图摘要（本地材料：`evidence/live-voice-2026-10-04.json`）。

## 云端与本地清理

听悟适配器记录本次 OSS 临时音频对象已删除；随后针对该精确对象执行一次新的
SDK 存在性查询，结果为不存在。该验证仅证明这次临时原始媒体对象的删除，
不代表听悟云任务／转写结果的留存策略已经审计。

所有自有 Gateway、Kimi、转码和听悟子进程都确认退出，随后移除临时 Hub、
录音和 Kimi 私有会话目录。Kimi 只引用现有配置和认证；没有修改全局模型／MCP
配置、重启生产 Bot 或替换客户端。

## 测试修正与复现

初次短录音测试在点击「完成录音」后立即检查麦克风轨道，碰上 MediaRecorder
异步 stop 事件尚未完成，流程在上传／ASR／模型请求前失败。改为等待实际轨道
结束后，两种浏览器均通过；没有改变录音器实现或删掉释放麦克风的断言。

普通测试默认跳过，真实云端任务还需要第二个独立开关。在 `client/` 中运行：

```sh
TAROCUB_LIVE_VOICE=1 TMPDIR=/tmp/t npx playwright test e2e/live-voice.spec.ts --grep 'recorded short'
TAROCUB_LIVE_VOICE=1 TMPDIR=/tmp/t npx playwright test --config playwright.webkit.config.ts e2e/live-voice.spec.ts --grep 'recorded short'
TAROCUB_LIVE_VOICE=1 TAROCUB_LIVE_VOICE_CLOUD=1 TMPDIR=/tmp/t npx playwright test --config playwright.webkit.config.ts e2e/live-voice.spec.ts --grep 'long Tingwu'
```

该 macOS opt-in 用例要求 `say` 的 Tingting 声音、ffmpeg/ffprobe、已认证 Kimi、
Qwen 服务，以及显式选择云端时可用的听悟适配器。默认关闭时不启动这些服务。
两种浏览器各两项默认跳过，单独启用语音但不启用云端时，长音频仍跳过。

必需仓库检查通过：233 个测试文件、3676 项通过、1 项既有跳过，构建通过。
本轮只增加真实语音验收用例、透明观察器和证据，没有修改生产代码或前端资源，
r10 开发包仍对应当前前端。

这不是实体手机麦克风、系统权限／中断、锁屏或原生容器验收；Kimi 默认模型也
没有被扩写成全部引擎、全部模型证明。905 秒样本的大部分是静音，用于验证真实
时长分流和尾段信息保留，不是 15 分钟连续会议的识别率或吞吐基准。短录音测试
使用合成麦克风，但浏览器录音、编码、上传、ASR 和 CLI 都是真实实现。
