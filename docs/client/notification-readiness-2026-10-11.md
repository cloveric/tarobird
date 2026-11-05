# 通知接收状态与恢复流程

本轮完成通知设置的接收状态诊断与显式恢复。原来的“已开启”只是用户开关，不能证明系统权限、主机配置和订阅仍可用；现在开关与接收状态分开显示。延续原计划通知门槛和后续人性化手机设置要求，未调整应用层端到端加密范围。

实现与审查结论：

- Hub 的认证 `GET /api/push` 增加无令牌的 `subscribed`，在同一串行读取中核对绑定、实际订阅及开关。无订阅、损坏数据、provider 不匹配均为 false；旧 Hub 没有此字段时客户端显示未知。
- 检查本次取得的主机配置、本机权限，以及对应的浏览器或 UnifiedPush 本地状态。Android 新增只读原生方法检查 App 通知开关与已有 `tarocub` channel；channel 未创建单独解释，检查不会创建 channel。
- APNs/FCM 恢复只更新原 provider，使用 revision CAS，不无条件 PUT、不重新开启被用户关闭的通知、不改勿扰时段。UP 故障引导原分发器区域；不会静默换成 FCM。
- “检查接收状态”不请求权限、不获取 token、不注册分发器或 Service Worker；UP 读取不执行 legacy migration。后台 token 维护也不再因为同值设置读取或首次未知值加载而重复注册。
- 查询有取消、超时和主机生命周期隔离；旧分发器查询不能回滚新连接，切换主机不继承旧恢复锁。后台维护先赢 CAS 时，新的就绪检查清除过时手动恢复错误。
- 勿扰草稿、独立保存、离线说明和中英文切换保留。手机原生界面只说明系统权限，不混用浏览器设置文案。

Astra 做了两次只读审查，上述配置时效、scope 切换、CAS 反馈、旧查询覆盖等发现均已处理。实际 `claude-opus-5-5 --effort xhigh` 调用 600 秒无返回后结束，退出码 143；不能记为 Opus 通过。原始提示、运行器、输出与状态文件位于证据目录。

## 流程与视觉检查

使用 product-design:audit 工作流，在 Codex 内置浏览器打开生产组件的受控原生状态 fixture；这不是实体手机或安装包截图。

1. **权限关闭：已修复。** 修改前系统权限被拒绝，但仍出现绿色“已开启”；修改后保留提醒意愿，独立说明权限关闭及恢复路径。修改前（本地材料：`evidence/notification-readiness-20261011/before.jpg`），修改后（本地材料：`evidence/notification-readiness-20261011/after-permission.jpg`）。
2. **订阅失效：已修复。** 明确展示“重新连接推送”，不会改变勿扰草稿或推送方式。390 像素截图（本地材料：`evidence/notification-readiness-20261011/after-reconnect.jpg`）。
3. **窄屏英文与深色：通过受控布局检查。** 320 像素宽无横向溢出，新增按钮高度 44 像素，长文案正常换行。截图（本地材料：`evidence/notification-readiness-20261011/after-english-dark.jpg`）。

内置浏览器 fullPage 捕获曾出现与 DOM 布局不符的窄列图像，保留 `capture-anomaly-fullpage.jpg` 供排查；最终截图使用同一页面的 viewport 捕获，并逐张查看。DOM 主卡宽 342/手机视口宽 390，英文文档宽 305/视口宽 320。

## 验证与边界

- 最终根检查：239 个测试文件，3,832 项通过、1 项跳过；`pre-complete-hook.sh` 与根构建通过。
- 最终 Chromium、WebKit 各 76 项相关回归通过，其中本轮新增接收状态/恢复套件 18 项；覆盖权限、channel、旧 Hub、配置读取失败、草稿、UP、真实维护器与 APNs reader 的受控竞态、离线/晚到查询、卸载取消与语言布局。
- 客户端翻译检查、类型检查、生产构建通过。前端资源已复制到两个手机工程，逐文件哈希见 `verification.json`。
- 本轮未编译 Android SDK / iOS SDK，没有物理手机的权限切换、后台送达或点击通知验收。Mac 桌面仍锁定，不能补普通 App 的操作验收。
- r37 开发包不包含本轮源码；本轮未生成新桌面安装包、未安装、未重启生产舰队、未部署。主机与客户端需要匹配更新；旧 Android 壳缺少只读方法时显示“暂时无法检查”。

证据目录：notification-readiness-20261011（本地材料：`evidence/notification-readiness-20261011/`）。总计划仍未完成，真实设备推送、原生 TLS / QR、外部服务授权和发布等门槛保持开放。

后续出包补充：上述源码已进入 r38 开发包（本地材料：`evidence/macos-r38-2026-10-11.json`），
完成双架构、ad-hoc 签名、DMG／完整挂载内容与下载副本核验；此前“未进入安装包”的
描述保留为该轮结束时的状态。r38 尚未安装、公证或进行新一轮普通原生／真机验收。
