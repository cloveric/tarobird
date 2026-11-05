# 折叠标题重复箭头修复

## 原因与范围

用户截图中，运行过程的每个步骤同时显示组件自带的 SVG 箭头，以及
Porcelain 通用弹窗样式添加的 `summary::before` 箭头。
`06ad5fee1` 增加的规则以 `details` 没有 class 判断它需要通用样式；
运行步骤正好满足这个条件，但已经有自己的标题布局和箭头。
更早的设置页通用规则也覆盖了语音设置的「查看接入配置」和云端授权详情。

静态清点 35 个组件的 59 个 `summary`，其中 7 个组件有 8 处自带箭头：
运行过程、语音设置（两处）、富卡片、网络说明、定时任务、能力说明、Agent Bus
最近运行。后五类此次没有确认截图中的同一回归，但也明确标注箭头归属，
避免原生 marker 或今后的通用主题规则叠加。

## 修复

- 自带箭头的标题使用 `data-disclosure-icon`，通用弹窗和设置页 fallback
  样式跳过这些标题；组件继续负责自己的间距、箭头及展开状态。
- 标记的标题隐藏浏览器原生 marker。无标记的纯文字标题保留原有的
  CSS 或浏览器箭头，不全局取消折叠指示。
- 装饰 SVG 从无障碍名称中排除。没有更改点击、Enter/Space 展开、
  运行状态、消息归属或任务操作。

纯 App 展示修复；Host、协议、存储和 headless CLI 不适用，无版本号改动。

## 验证

原过程读者 fixture 没有导入实际发布的 `porcelain-details.css`，因此漏掉了
样式叠加。现在导入该文件，并按实际渲染计算 SVG、伪元素和原生 marker，
要求同一标题恰有一个折叠指示。基线 WebKit 复现计数为 2，修复后为 1。
卡片、网络 fixture 也加入同一发布样式。

覆盖过程读者的 390/1360 宽度、8 个有效主题 ID 的明暗模式、开关折叠及键盘，
并在完整 App/隔离 Hub 流程验证 Claude 手机和桌面运行记录。
其它六类组件复用各自的真实浏览器流程检查；模型和外部云端服务使用受控数据，
不是收费模型或云端转写验收。

Agent Bus 原有深色断言还假定首次启动跟随系统，与已改为显式浅色的产品默认
不符。测试改为先选择 `system` 再模拟 OS 明暗切换，保留原来的颜色变化断言。

去重后的相关浏览器结果：Chromium 12 项通过、1 项既有失败；WebKit 19 项通过。
Client TypeScript/Vite 构建与 Host standalone 构建通过。没有运行全仓库全量测试。

- `baseline.log`：旧箭头样式的预期失败（2 个指示），证明新断言能捕获截图问题。
- `chromium-related.log`、`webkit-related.log`：七类组件流程；其中 Agent Bus
  旧主题前提失败，修正后分别在 `chromium-final.log`、`webkit-final.log` 通过。
- `webkit-process.log`：8 项过程读者回归，含搜索、刷新、滚动位置和终态更新。
- `chromium-process-final.log`、`webkit-process-final.log`：有效主题 ID 的
  过程/语音矩阵以及完整 App 的 Claude 手机、桌面流程。
- Chromium 完整手机流程在新箭头断言之前的「压缩上下文完成 → 正在思考」
  等待失败，单独重跑也失败。原封不动的 `6839c8b` 基线在同一步同样失败
  （`chromium-status-baseline.log`）；两份代码的该测试和相关运行记录逻辑无差异。
  该流程会人为前拨并回拨浏览器时钟，尚未确认超时是否只由模拟时钟触发。
  未削弱或跳过状态断言，也未把它宣称为通过；本轮不改运行状态处理逻辑。

截图在 `webkit-process-final/run-presentation-*` 以及主题矩阵测试的输出目录。
完整 App 图来自受控测试，包括刻意模拟的失败工具步骤；不代表生产 Bot 的失败。

证据目录：`/Volumes/gdrive/taro-tmp/disclosure-icons-20261026`。
本轮没有真机验收、发布、安装或重启；不会据此宣称所有 UI 已无缺陷。
