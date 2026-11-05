# 工作台个人头像焦点提示

左下角个人头像按钮使用通用 `:focus-visible` 外轮廓；关闭设置恢复焦点、
或键盘移动到头像时，黑白主题会形成与图片分离的黑圈。

仅为共享 `WorkspaceFooter` 的个人头像入口取消 outline/box-shadow。
键盘焦点保留，并用现有 hover 底色提示；指针操作仍沿用现有规则。
强制对比度模式使用系统 Highlight 底色。设置按钮、工作台按钮、其它
头像以及页面布局不变。普通聊天和 ADHD 共用此规则。

旧构建在 WebKit 重现黑圈，新的验收断言如预期失败。修复后 Chromium、
WebKit 各 2 项通过：实际打开/关闭设置、恢复焦点、Tab/Option-Tab、
Shift-Tab 和 Enter，以及侧栏边线回归；两种桌面布局和明暗模式均覆盖。
Client 和 Host 构建通过。证据：`/Volumes/gdrive/taro-tmp/footer-avatar-focus-20261026`。

纯 App 样式修改，headless CLI/Host 行为不适用。本轮未发布、安装或做真机验收。

## 列表模式的 Tab 焦点

后续截图中的「按 Bot／按对话／ADHD」也继承了同一粗外轮廓。
`sidebar-layout.css` 取消这组按钮的焦点外框，键盘导航用浅底色和文字下方
1px 标记，选中的白色分段仍只代表当前模式。Tab 本身不切换模式；
Enter 才触发切换，鼠标操作不保留下划线。普通聊天和 ADHD 共用该组件。

明暗模式下的 Tab/Option-Tab、反向切换、Enter 进入 ADHD 与返回聊天通过；
连同头像焦点、设置指针/键盘边界，Chromium/WebKit 各 3 项通过，Client/Host
构建通过。证据：`/Volumes/gdrive/taro-tmp/sidebar-mode-focus-20261026`。
此次仍为 App 展示修改，未发布或安装。
