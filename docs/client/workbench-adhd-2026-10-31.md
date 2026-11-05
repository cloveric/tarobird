# ADHD 浏览器工作台（2026-10-31）

## 行为

- ADHD 对话标题栏提供与单对话相同的「工作台」入口。点击入口，或从消息打开网页、图表、图片，会先放大所属卡片，再打开右侧工作台。
- 工作台与该对话共享原有 controller / Host 注册规则。返回总览或放大其他卡片时收起网页；标签、网页实例和草稿保留。再次打开同一卡片可以继续。
- 工作台可展开到当前对话的阅读区，也可返回右侧。卡片可用宽度不足 760 CSS px 时临时使用阅读区，原输入框仍可用；此适配不写入用户保存的展开选择。
- 退出 ADHD 回到单对话后，重新打开工作台会恢复该对话的标签与原生网页。不创建第二条 Host 连接，不拉宽 ADHD 所在的原生窗口。
- 总览/隐藏卡片不附带可操作的工作台上下文；已收起目标上的 Bot 操作返回 `workbench_hidden`。Bot、CLI 沿用 `app_workbench` / `tarobot workbench` 的同一授权、目标和回执，不增加独立命令或放宽权限。
- 工作台标题继续与相邻对话标题等高。各实例的 aside、标签面板与 `aria-controls` 使用独立 ID，即使两个对话用同一请求编号创建笔记，也不会互相指向。

## 一起修正的边界

Opus 5.5 复核指出，窄窗 Agent Bus 浮层会被原生网页盖住。浮层打开时现在立即隐藏原生网页，关闭过渡结束后恢复；宽屏 Bus 作为并列列时保留网页。对应监听随最后一个 browser surface 卸载移除。

浏览器回归还发现，点击地址栏的打开按钮时，输入框失焦可能在提交之前还原旧网址。现在保留指针/键盘 Go 操作的输入；切到导航按钮或离开表单仍结束编辑，让实际网址继续同步。

## 验证边界

浏览器测试使用真实 App、隔离 Hub、IndexedDB 和工作台命令，模拟 Electron 桥；原生验证另用独立 Electron 窗口、真实 preload / Rust helper / WebContentsView 和本机测试网站。没有操作生产主机、安装版、用户网页或真实模型。

本轮不发版、不更新安装版。Windows 原生运行和手机真机未验收；ADHD 网页功能仍仅由 Electron 桌面提供。

## 结果

| 检查 | 结果 |
| --- | --- |
| 新增 ADHD 流程 | Chromium 2 项、WebKit 2 项通过 |
| 普通工作台 / 手机布局 / 原生页面入场回归 | 两引擎各 3 项通过 |
| 编译 | 翻译检查、TypeScript、Vite 通过 |
| 真实 macOS Electron | 网页加载、放大/收起、同一 WebContents 保留、网页表单与草稿保留通过 |
| 原生几何与遮挡 | 不改变窗口外框、矮窗不盖住输入框、Bus 浮层期间隐藏并恢复网页通过；页面错误 0 |
| Opus 5.5 | 独立设计与 diff 复核；遮挡、重复 ID、幂等展开及地址栏建议已落实 |

浏览器回归在迭代中修正了测试自身的回执等待、Markdown `content` 参数和 Bus 收起按钮选择；WebKit 键盘用例显式聚焦 Go，避免依赖 macOS 按钮 Tab 策略。地址栏的鼠标提交和聚焦后 Enter 提交均核对实际 navigate 网址，不只检查显示值。

证据：[摘要与源码哈希](workbench-93/adhd-acceptance.json)、原生窗口截图 (historical image omitted from this clean snapshot)。完整本机过程保留于 `/Volumes/gdrive/taro-tmp.noindex/workbench-adhd-20261030`；最终新增测试见 `chromium-v4.log`、`webkit-v4.log` 的窄窗项与 `webkit-keyboard.log` 的主流程项，原生回执见 `native-v4/report.json`。

原有白板锁争用后的主动重试、后台网页休眠策略仍是独立改进项；Opus 没有复现其阻断本轮浏览器操作的路径。本轮没有改写编辑器锁或网页回收策略。
