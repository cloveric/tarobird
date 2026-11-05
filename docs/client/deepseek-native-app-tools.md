# DeepSeek 原生 App 工具

2026-10-03。App 前台用户回合通过 DeepSeek Harness 的 agent 级工具注册表
安装 `app_send_file`、`app_send_batch` 和 `app_capability`。沿用原生 CLI、
权限、流式输出和持久会话；工具执行直接使用已有 Gateway 上传与 Hub 发布回执。
不要求模型在最终回答中生成文件标记，不修改用户的全局 DSH/MCP 配置。

## 调用归属

主进程为本轮生成请求 ID，并作为 `session.prompt.requestId` 提交。插件从
原生日志读取对应的 `user/message.source.rpcId`，检查原生 session、当前打开
的 turn/step、未结束的根工具调用、名称和精确参数。PTC 子调用还要匹配已记录
的父子调用链；子 agent 不能借用父 agent 的发送权限。

`configureSession` 可能在用户问题前插入 `user-approval` 审批策略通知。
它与 `runtime-context`、`agent-instructions`、`skill-catalog` 一样只提供上下文，
不被当成任务来源。未知来源和自主 goal 仍拒绝。单独协议探测未发现此顺序差异，
真实 Hub 流程发现误拒绝后已补回归；不能只用一次能力查询代表整个交付链路。

父进程再次核对原生 session、请求 ID、工具名和仍有效的回合授权。同一原生
调用复用执行 promise；同 ID 改参拒绝。跨调用、文件版本、批次成员和不确定发布
仍使用共享交付层的缓存与持久化回执。参数不能指定其他接收者。

## 进程与失败处理

- 工具插件仅写入 Bot 私有 DSH home 的 patch，按 agent 注册，正常结束、
  停止或进程重启撤销本轮授权。原会话不为安装工具而重置。
- fd3/fd4 是专用继承管道，不解析模型 stdout 或日志；Node Socket 持有并关闭
  句柄，不使用常驻阻塞的 `fs` read stream。初始化后清除环境开关。
- 管道关闭会撤销在途请求、注销原生工具。单个超大出站请求／响应以及并发上限
  不使其他对话的管道失效。非法入站帧仍关闭不可信流。
- 安装仅发生于提交用户问题前；不支持、拒绝或超时可在本轮保留兼容交付。
  用户已经停止则不显示兼容提示。提交问题后的错误不会自动重放模型请求。
- 管道错误／取消可能与已提交发布交错，提示核对回执，不承诺撤回或自动重发。
  真实上传响应可刷新活动时间，停止信号传到共享交付器。
- 不授予独立后台／子 agent 原生 App 发送权限。原有兼容后台路径仍由原处理器
  根据来源和频道负责；不能借当前前台回合决定接收者。

这是会话路由与生命周期边界，不是对同用户任意本机代码的操作系统沙箱。
Linux 子进程句柄继承、Windows 管道及其他 DSH 版本尚未实测；不支持的句柄初始化
会关闭管道并使用兼容路径。公开网络访问仍由 Hub 配对与授权处理。

## 验证及范围

- `tests/deepseek-app-tools.test.ts`：私有协议、取消、损坏／超大数据、精确归属、
  子代理／goal／旧 step／已结束工具、PTC、策略通知、卸载和安装回滚。
- `tests/deepseek-harness-adapter.test.ts`：请求 ID 与本轮绑定、原生／兼容提示、
  停止时不提交模型问题、提交后不重放、原生配置／会话回归。
- `tests/deepseek-harness-host.test.ts`：私有 patch、不写共享配置、生命周期回归。
- `client/e2e/live-deepseek-app-tools.spec.ts`：显式 opt-in 的真实 CLI；从 UI 新建
  Bot，模型自己选择工具，两版单文件和说明、真实 worker 重启与上下文延续、
  按需能力查询、两文件原子批次、独立桌面／手机浏览器实际下载与字节／回执核对。
  透明观察器仅记录原生 RPC，不注入结果。关闭后检查所创建的观察器和 CLI PID
  均已退出，并删除此次临时 Hub 及其私有原生历史。普通套件不调用付费模型。

在 `client/` 执行：

```sh
TAROCUB_LIVE_DEEPSEEK_APP_TOOLS=1 TMPDIR=/tmp/t npx playwright test e2e/live-deepseek-app-tools.spec.ts
TAROCUB_LIVE_DEEPSEEK_APP_TOOLS=1 TMPDIR=/tmp/t npx playwright test --config playwright.webkit.config.ts e2e/live-deepseek-app-tools.spec.ts
```

当前验证为本机 DSH 0.2.0-rc.2、引擎默认模型、low effort。该轮不是所有模型／媒体、
十图 PDF 编号读取、实体手机容器、Windows、Linux 或公网中转验收。Kimi、
Antigravity 和 Codex process 仍保留兼容文件交付，不能宣称已全部原生化。

实际 Opus 5.5 xhigh 已审查。已修正关闭句柄、请求大小隔离、安装回滚、生命周期
清理和停止竞态；其 Linux fd 继承等推测单独保留为未验证范围，不当成已证实漏洞。
最终测试及截图回执见 验证记录（本地材料：`evidence/deepseek-native-app-tools-2026-10-03.json`）。


## 2026-10-04 媒体批次补充

十图与 PDF 的原生流程已在 Chromium／WebKit 完成：随机编号读取、单次图集发布、
双端真实下载和摘要校验均通过。适配器现在把原始图片路径与内联像素一同传给引擎，
供编辑／原样回传使用。脚本修正和一轮原生模型非法 JSON 失败保留在
[媒体验收记录](deepseek-media-2026-10-04.md)，不把复测成功描述为所有模型无失败。
