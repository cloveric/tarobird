# 引用与转发附件：真实引擎验收 · 2026-10-05

这轮补的是原来缺少的真实 CLI 证据。已有 Hub、Gateway 和 UI 测试不能单独证明
模型能读取被引用的附件。本轮新增显式启用的验收脚本，并修复 Opus 复核发现的两项问题。
整体产品计划和真机验收仍未完成。

## 实际流程

1. 在独立临时 Hub 中建立资料 Bot、真实审阅 Bot、旁听 Bot、工作群和群内话题。
   审阅 Bot 不属于原始资料对话。
2. 原始消息包含一张 PNG 和一个 PDF。随机编号只写在图片像素、PDF 正文里，
   不写在文件名、任务提示词或测试代理提供给模型的文本里。
3. 桌面通过转发窗口发到群内话题，保持“让 Bot 回复”关闭：零原生输入、零待处理任务。
4. 检查审阅 Bot 不能下载原对话附件，目标附件有独立 ID；删除原消息后，原附件立即拒绝
   新下载请求，再调用孤立附件回收并确认回收两个原附件。目标副本仍可下载且 SHA-256
   与原始文件一致。
5. 手机引用副本发送新问题，新消息自身没有附件。真实 CLI 收到两个文件，哈希正确，
   读出图片与 PDF 编号，桌面和手机都渲染了回复。
6. 手机再次转发到工作群的默认讨论，启用“让 Bot 回复”，只选审阅 Bot。
   第二个独立原生 session 再次读对两个编号；旁听 Bot 无待处理任务。
7. 关闭隔离 Hub 与其原生子进程；归档本测试拥有的 Codex 线程、删除专属 Claude
   项目记录和 Kimi 私有临时目录。没有清理用户的其他会话。

## 范围

- 使用真实 Codex、Claude Code、Kimi Code、DeepSeek Harness、Antigravity。
  Codex 模型为 gpt-6-astra，Claude 为 sonnet，其余使用已配置 CLI 默认模型；effort 为 low。
  Opus 5.5 xhigh 单独负责静态复核，不冒充这些业务模型。
- 两个独立配对的浏览器上下文，桌面 1360px、手机 390px；不是实体手机或原生容器验收。
- 随机图片/PDF 的单次成功不代表所有文档格式、OCR 准确率或全部模型版本。
- 默认运行五项均跳过，只有显式设置环境变量才会启动真实模型。
- 第一轮 Codex 测试在模型启动前因 `online` 返回数字 1 而非布尔 true 的断言错误失败；
  测试改成布尔归一化后重新通过。这是验收脚本错误，没有作为产品缺陷修复。

## 最终结果与证据

| 引擎 | Chromium 桌面 + 手机 | WebKit 桌面 + 手机 |
|---|---|---|
| Codex | 通过 | 通过 |
| Claude Code | 通过 | 本轮未跑 |
| Kimi Code | 通过 | 本轮未跑 |
| DeepSeek Harness | 通过 | 本轮未跑 |
| Antigravity | 通过 | 本轮未跑 |

以上每个通过项均包括两次真实模型读取、两个独立原生 session、两端渲染和停机清理，
不是单纯上传回执。逐引擎机器收据（本地材料：`evidence/quoted-media-2026-10-05/quoted-media-codex.json`）
位于同目录，文件名分别为 `quoted-media-{engine}.json`；WebKit 有独立收据。
本轮未把其他引擎的 Chromium 结果计为 WebKit 通过。

最终全量门槛：235 个测试文件，3,787 项通过、1 项跳过，构建通过。
汇总收据及最终源文件哈希（本地材料：`evidence/quoted-media-2026-10-05/summary.json`）。

Chromium 桌面（本地材料：`screenshots/quoted-media-20261005/quoted-media-codex-desktop.png`）
WebKit 手机（本地材料：`screenshots/quoted-media-20261005/webkit-quoted-media-codex-phone.png`）

Opus 初审发现（本地材料：`evidence/quoted-media-2026-10-05/opus-focused.json`）和
修复复核（本地材料：`evidence/quoted-media-2026-10-05/opus-fix.json`）保留实际模型名、xhigh 请求档位、
轮次数、耗时和报告；达到上限的首次尝试也单独保留。修复前失败日志、迁移和备份回归
日志、最终全量门槛日志保存在同一目录。

运行入口：

```sh
cd client
env -u CCTB_LARK_ALLOW_ANY_FILE_PATH TMPDIR=/tmp/t \
  TAROCUB_LIVE_QUOTED_MEDIA=1 npx playwright test e2e/live-quoted-media.spec.ts
```

## Opus 发现与修复

实际 Opus 5.5 xhigh 的第一轮阅读达到回合上限，没有完整报告；缩小范围后成功给出
两项静态发现。父代理写回归测试后均复现了预期失败，再完成修复。

- **撤回附件旧 ID。** schema 11 保存附件停用标记。最后一个已发布引用撤回后，新下载、
  复用旧 ID 发送、上传续传均拒绝；其他仍有效的引用和独立转发副本继续可用。
  重新上传相同文件得到新 ID。GC 保持既有保留周期，删除附件时一并移除停用标记。
  v10 及更早版本从保留的历史消息事件恢复已撤回附件 ID，备份支持 schema 11；
  历史事件已被外部删除时无法反推附件归属。
- **长期缓存增长。** Gateway 改为最近使用缓存，最多 128 条、序列化内容合计 8 MiB；
  大于 1 MiB 的单条消息不保留在缓存，仍可从 Hub 读取。断开后清空缓存。
  这是缓存内容预算，不是对整个进程实际内存的上限承诺。

Opus 完成第二次只读复核，未发现阻断问题。随后父代理另外发现并复现迁移误识别按钮
数据中同名 `attachmentId` 字段的问题，改成协议结构遍历和小批量迁移；新增回归验证
真实嵌套图片被停用、普通按钮数据引用的未发送文件保持可用。此最后调整由父代理
测试验证，未声称经过第三次 Opus 修复复核。

撤回不会抹除已经下载、缓存、转发的副本，也不取消已获准的下载；主机和备份中的原始
字节仍按回收规则保存。这不是安全擦除或“文件从所有设备消失”的承诺。

结果、Opus 复核状态和渲染截图随本次验收收据保存。修复属于 Hub / Gateway；
前端未变，开发包仍为 r15，需配套使用本轮 Hub 代码。未重启生产服务或安装新包。
