# 手机附件菜单：Grok Bot 布局对齐

2026-10-05。用户明确要求手机聊天左下角的“＋”打开拍照、上传附件和附加图片。

## 实现

- 独立圆形“＋”位于输入框左下侧；手机三个入口是“拍照 / 附加图片 / 上传附件”。
- 拍照使用 `accept="image/*" capture="environment"`，一次一张；附加图片使用 `image/*` 多选；普通文件不限制类型，可多选。
- 图片、文件、录音都复用现有附件草稿和上传流程，文字与附件合为一条消息。选择后不会自动发送。
- 取消系统选择、关闭菜单或系统返回不清空草稿。返回焦点到“＋”，避免自动弹出键盘。重新选择同一文件仍会触发更新。
- 持久的单个 file input 不随菜单卸载；在同一个点击事件中设置模式、同步关闭原生 dialog，再打开系统选择器，保留用户激活并解除背景 inert。
- 每台主机的 Workspace 独立保存输入。选择期间切换对话/主机、离开聊天或归档后，过期结果被丢弃，不附加到新的目标。离开再回到原对话也不会接纳旧结果。
- 桌面保留直接选文件的入口；手机继续添加和空会话里的附件入口也统一打开新菜单。
- 延续四套配色及浅/深模式的 token；沿用已有底部面板动效和减少动态效果规则。基础点击区44–48px，菜单行56px。
- 输入区采用两行以保留文字空间和语音/协作/发送/停止/引导功能；忙碌时工具栏可换行。窄屏英文菜单已验证。

## Opus 5.5 参与

实际调用 `claude-opus-5-5 --effort xhigh`，输入用户 Grok 参考图和当前手机截图，完成了布局、菜单、交互风险和 CSS 建议。设计结果保存在 opus-design.json（本地材料：`evidence/attachment-menu-2026-10-05/opus-design.json`）。

实现沿用整个 App 的760px手机断点，采用一个按点击同步切换模式的持久 input；没有增加相机或文件选择器插件。保留两行输入布局，避免320px下文本与所有控件拥挤。

实际 Opus 代码/截图复核为“有条件通过”，指出旋转跨断点可能作废合法照片。现已拆分目标失效与菜单关闭：只在会话或主机激活状态变化时作废选择，旋转不再作废。不能仅监听会话ID，因为两台主机可能保活并使用同一ID，仍须防止主机A→B→A。新增相机/相册横屏回归，且继续验证跨主机隔离。也去掉了并不支持拖拽的面板把手，空选择不再调用添加回调。复核报告及逐项处理在 opus-review.json（本地材料：`evidence/attachment-menu-2026-10-05/opus-review.json`）。Opus未对最后修订再次出具无条件批准。

一次前置无工具复核遇到工具解析错误；后续明确使用纯文本审阅方式，完成了上述实际复核。

## 实际验证

生产前端构建通过。第一轮 Chromium 22项、WebKit 22项相关浏览器检查通过；加入旋转与消息视口修正后，再验证相关用例（与第一轮重叠）。检查包括：

- 实际 filechooser 事件及三种模式的 accept/capture/multiple 属性；图片和文件连同说明发送一条消息。
- 系统取消事件模拟、重复选同一图片、Escape/原生返回、焦点恢复、320px英文菜单和桌面直接选择。
- 选择器结果晚于对话切换、A→B→A，以及同名同ID的两台主机切换；旋转跨手机断点后，相机和相册选择仍进入原聊天。
- 文字/图片/文件跨客户端同步、上传失败保留草稿、513MiB文件上传、120MiB续传与备用线路、取消后重试。
- 引用附件时键盘展开、短视口、横竖屏、录音/语音发送与引导/排队。

验证过程中修正了新 composer 行未命中旧键盘 CSS 子选择器的回归；修正菜单打开后焦点停在关闭按钮的行为。测试中的英文导航和 Add files 标签也已按真实界面修正，未降低断言。

最终WebKit复核曾出现一次键盘展开后距末尾344px的失败；单例连续3次复查通过，说明依赖布局/消息时序。源码原先仅在消息内容/高度变化时跟随末尾。现新增消息视口 ResizeObserver，键盘或输入区高度变化时也在下一帧跟随；用户主动阅读历史仍通过原 followLatest 标记保留位置。最终复核包含原断言、历史位置与流式长消息，未将偶发失败直接算作通过。

Chrome现有隔离预览还通过真实界面分别打开图片/文件选择器，添加合成文件和说明文字。截图留存后已清理本轮测试草稿。

- 手机输入栏（本地材料：`screenshots/attachments-menu-20261005/02-phone-composer.png`）
- 三个附件入口（本地材料：`screenshots/attachments-menu-20261005/06-phone-menu-accepted.png`）
- 图片、文件和说明草稿（本地材料：`screenshots/attachments-menu-20261005/05-phone-mixed-draft.png`）
- Chromium日志（本地材料：`evidence/attachment-menu-2026-10-05/chromium-accepted.log`）
- WebKit日志（本地材料：`evidence/attachment-menu-2026-10-05/webkit-accepted.log`）

## 验收边界

浏览器 filechooser 验证不等于手机实拍。Capacitor 8.5.2 Android核心已有相机 capture 和 CAMERA运行时权限处理；项目既有 Android CAMERA声明，以及iOS相机、相册说明。

`capture`是移动端选择器提示，具体系统行为依赖 WebView/操作系统；桌面浏览器可能使用普通文件选择器。参考 [MDN capture](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/capture)。

iOS/Android真机的权限允许/拒绝、拍照返回、相册来源、旋转和低内存进程重建仍待验收。没有把浏览器模拟取消、WebKit测试或资源复制计作真机验收，也没有安装手机新包或变更在线服务。

## 最终收尾

最终相关复核 Chromium15 / WebKit15 全通过（与前述22 /22有重叠），含新增旋转和消息视口修正；全量门禁236文件 /3796通过 /1跳过，构建通过。iOS和Android各303个已验收前端资源哈希一致，资源复制不等于手机编译或安装。

本次没有生成新的安装包；此前r24为历史开发包，不包含本次手机菜单。r25候选构建在交付前停止以修正复核发现的旋转问题，未作为产物交付。当前成果为源代码、实际浏览器预览、手机工程资源与验证记录。

最终证据（本地材料：`evidence/attachment-menu-2026-10-05.json`） · 最终Chromium（本地材料：`evidence/attachment-menu-2026-10-05/chromium-final-fixed.log`） · 最终WebKit（本地材料：`evidence/attachment-menu-2026-10-05/webkit-final-fixed.log`） · 全量门禁（本地材料：`evidence/attachment-menu-2026-10-05/root-gate-final.log`）
