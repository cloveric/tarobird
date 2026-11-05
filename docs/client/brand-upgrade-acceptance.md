# TaroCub 品牌界面验收

日期：2026-10-02。范围：本轮 Web 客户端品牌界面、暖色配色和轻量动效。整体客户端产品计划仍在推进，不以本报告代表原生安装包或全部功能验收完成。

## 设计与实现来源

用户指定 Claude Opus 5.5、xhigh 主导设计并直接实现。实际返回模型均为 `claude-opus-5-5`，三轮使用 `--effort xhigh --no-session-persistence`。第二轮在代码写入后，为传递用户新配色意见而中断；第三轮完成最终暖色方案。集成代理负责素材接入、构建、截图、交互和回归检查。

- [设计决定](brand-upgrade-opus55.md)
- [官方参考与改版前基线](brand-upgrade-references.md)
- 首轮回执（本地材料：`evidence/brand-opus55-round1.json`）、第二轮回执（本地材料：`evidence/brand-opus55-round2.json`）、暖色轮回执（本地材料：`evidence/brand-opus55-warm-palette.json`）

最终配色遵从用户最新意见：奶油背景、陶土橙操作色、浅杏桃用户气泡；深色采用浅陶橙按钮和深墨文字。Bot 普通回复保留阅读区底色，仍能通过气泡形状区分双方。绿色、警告色、危险色保留语义；群组紫色和 Bot 信息卡的低饱和蓝色不作为全局操作色。

## 实际浏览器验收

使用 Codex in-app browser 和本地隔离 Hub。普通回复与提问经过真实 Hub/Gateway，但引擎为明确标注的模拟引擎，没有为验收创建真实 Codex/Claude 对话。新 Bot 流程使用仓库已有 transport-only worker 夹具。

| 检查 | 实际结果 |
| --- | --- |
| 配对首页 | 奶油双栏、小狮子、扫码与配对按钮正常；实际主按钮背景 `rgb(185,83,44)`、白字。 |
| 桌面聊天 | 用户气泡实际为 `rgb(251,233,223)`；Bot 回复和卡片保持清晰层级。 |
| 创建 Bot | 填写名称、引擎、模型、effort 后出现“Bot 已上线”，开始对话后进入该 Bot 的独立对话。此项在首轮构建操作，后续改色未修改创建逻辑。 |
| 群中话题 | 实际创建“移动端体验打磨”，侧栏及群内导航均出现；最终主题下选中项、回复 Bot、创建入口显示正确。 |
| 自定义头像 | 上传现有演示素材并保存，出现“头像已更新”；侧栏、header 和消息头像均加载 256×256 图片。最终构建刷新后依然优先显示自定义头像。 |
| 草稿保护 | 空会话填入“尚未发送的灵感”后命令快捷入口消失，草稿原样保留；清空后入口恢复，点击写入 `/`。transport-only 夹具未声明命令列表，不以此项宣称命令菜单全量验收。 |
| 手机提问 | 390px 下单选、多步骤切换、多选、补充自定义答案及提交均实际操作；Gateway 收到“手机操作, 暖色保持清晰层次”，界面显示已提交回执。 |
| 手机 header | 390px 下标题区域实测 140px，“品牌与产品灵感”完整显示；菜单、新对话、连接、对话设置目标均 44×44px。头像按钮保留原紧凑尺寸。 |
| 深色与英文 | 英文深色手机界面无水平溢出（clientWidth 与 scrollWidth 均 390），控件和空会话文案可读；完成后恢复演示设备的中文和跟随系统设置。 |
| 流式与动效 | Gateway 模拟回复过程中 header 具有 `is-working`，光环 `tc-spin` 为 running；消息行自身 animation 为 none，inline `translateY(...)` 仍在。完成后光环暂停。没有据此声称真实模型吞吐或公网延迟提升。 |
| 减少动态效果 | 模拟 `prefers-reduced-motion: reduce` 后光环 animation 为 none、按钮 transition 为 0s；检查后恢复。 |
| 离线资源 | 重新打开页面使新 service worker 激活，再断网刷新：品牌狮子及默认伙伴头像仍可见，离线提示正确；恢复网络后重新连接成功。 |
| 连接/文件中心 | 线路保存按钮实测使用陶土色；文件中心与现有演示工作区可正常加载。没有保存或更改真实连接配置。 |

## 构建与颜色证据

- `npm run build --prefix client`：翻译校验、TypeScript 和 Vite 构建通过。
- 九张品牌 PNG 通过静态 import 进入构建和 service worker 的 FILES，共 1,928,214 bytes；重复的 public 副本已移出构建，favicon 复用同一带 hash 的狮子资源。
- 颜色对比度计算（本地材料：`evidence/brand-palette-contrast.json`）：从最终主题文件读取颜色，按 WCAG sRGB 相对亮度公式计算 12 个文字/背景组合，均 ≥4.5:1。浅色主按钮 4.843:1，深色 7.072:1；用户气泡上的灰色文字是最低组合 4.529:1。这是指定组合检查，不是全应用可访问性认证。
- 全量回归结果在本报告末尾记录。未修改测试断言或后端代码来获得通过。

## 最终截图

- 首页（本地材料：`screenshots/brand-upgrade/final-pairing.jpg`）
- 桌面聊天（本地材料：`screenshots/brand-upgrade/final-chat-desktop.jpg`）
- 手机聊天（本地材料：`screenshots/brand-upgrade/final-chat-phone.png`）
- 手机提问卡（本地材料：`screenshots/brand-upgrade/final-question-phone.png`）
- 群中话题（本地材料：`screenshots/brand-upgrade/final-group-topic.jpg`）
- 深色设置（本地材料：`screenshots/brand-upgrade/final-settings-dark.jpg`）
- 英文深色手机（本地材料：`screenshots/brand-upgrade/final-dark-english-phone.png`）
- 连接设置（本地材料：`screenshots/brand-upgrade/final-routes.jpg`）
- 文件中心（本地材料：`screenshots/brand-upgrade/final-files.jpg`）
- 离线页面（本地材料：`screenshots/brand-upgrade/final-offline.jpg`）

`round1-*` 为历史冷蓝按钮方案，保留用于对照，不代表最终外观。

## 验收边界

本轮没有重新运行 iOS、Android、Tauri 安装包或 WebKit 真机验收，也没有运行整套 Playwright 浏览器脚本；上表为实际浏览器操作范围。主题色 meta 仍按系统明暗变化，未新增跟随 App 显式主题的同步逻辑。所有临时网络、动效和视口模拟在验收后恢复。

本机重负载期间预览曾短暂离线，恢复后头像和消息操作成功；本轮未修改连接超时策略，不据本地浏览器结果推断公网质量。原生兼容性、后台恢复和公网性能继续在总体计划中跟踪。

## 最终回归结果

- 根项目完整回归：220 个文件通过，3,427 项通过、1 项跳过；退出码 0。命令为 `TMPDIR=/tmp/t VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 npm test -- --testTimeout=20000 --hookTimeout=20000`，耗时 165.49 秒。
- 根项目 `npm run build`：通过，退出码 0。
- 前端 `npm run build --prefix client`：通过，退出码 0。
- `git diff --check`：通过。新增文件另行检查空白错误。
- 按仓库要求先运行过两次 `scripts/pre-complete-hook.sh`：默认 5 秒上限下分别有 2 项等待超时；失败项在两次运行间不同。单独复查时原先的 Hub 与停止转写场景恢复通过。最终保留全部断言，只在本次测试进程增加等待上限，完整套件全部通过。默认上限的 hook 本身未获得一次通过回执，不应将最终结果写成“默认 hook 通过”。

未修改任何测试、连接逻辑或后端业务代码。本轮浏览器操作仍按上表的隔离夹具范围解释。
