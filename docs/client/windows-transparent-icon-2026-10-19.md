# Windows 桌面图标透明背景

Windows 原先与手机、网页共用带浅紫色底的原图。它的 ICO 六档尺寸全部不透明，
桌面快捷方式因此显示方形紫底；不是客户端主题设置造成的。

图标生成器现在用已有的彩色透明源 `assets/brand/tarobot-tray-master.png`
覆盖 Windows 的 `client/src-tauri/icons/icon.ico`。保留紫色吉祥物，不新增背景。
文件名来自早期 macOS 菜单栏设计；macOS 菜单栏仍用独立的黑白矢量模板。
仅替换 ICO，其他平台、应用内图标和用户头像不变。

Tauri 的 Windows 构建从 `bundle.icon` 读取 ICO，嵌入主 EXE 的 32512 资源组。
桌面快捷方式、默认窗口图标和 Windows 托盘使用该图标。此变更只有视觉资源，
不改变主机能力、状态或协议，CLI 无新增命令。

## 验证

- 原 ICO 的 16、24、32、48、64、256px 全为不透明；新版每一档均有完整 alpha，
  四角透明，超过 30% 的像素完全透明，吉祥物内部仍有完全不透明像素。
- 使用固定版本 Tauri CLI 连续生成两次，ICO 字节一致。对所有平台图标做哈希
  对照，只有 Windows ICO 改变；macOS、Android、iOS、网页资源字节不变。
- 在外置盘的隔离源码副本完成 Windows x64 release 模式交叉编译。直接读取
  新 EXE 的 RT_GROUP_ICON / RT_ICON，确认实际选用的 32512 资源组中六档图像
  均与源 ICO 字节一致。资源编译器将未指定的平面数 0 规范化为 1；校验只允许
  这一差异，其他字段及图像数据仍严格匹配。
- `scripts/verify-release-icons.py --windows-exe` 增加上述发布校验，Windows
  检查额外依赖 pefile。新版 EXE 校验通过；旧不透明源、仍嵌有旧图标的发布版
  EXE 都被正确拒绝。发布检查表要求对最终安装包解出的主 EXE 再运行该检查。
- 目视检查透明图标和常用尺寸。没有 Windows 真机桌面验收，未验证系统图标
  缓存更新，也未发布或安装此验证构建。

证据在外置盘 `taro-tmp/tarobot-windows-transparent-icon-20261019`，包括逐尺寸
alpha 统计、再生成对照、编译日志和 EXE 图标校验记录。Git 外置盘权限现已恢复，续办交付及验证见下方记录；安装中的版本尚未包含此改动。

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.
