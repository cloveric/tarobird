# 设备列表的旧默认名称

Windows 截图中，当前 ASUS 的主机绑定名称已经正确；其他访问设备仍显示
旧配对时保存的“这台电脑”“这台手机”。之前的主机名称同步只处理经过
本机证明绑定的桌面设备。新配对默认名已中性化，但历史设备行仍原样渲染，
所以当前源码和 1.0.94 也存在这个显示遗漏，不能只归因于 Windows 版本旧。

`deviceDisplayName` 为这些历史相对名称提供显示兼容：根据记录的平台显示
“Mac 电脑”“Windows 电脑”“Android 手机”“iPhone / iPad”或浏览器设备。
未知平台显示“其他设备”；覆盖中英文旧名及“这台主机”，不猜测设备型号，
也不把任意 Mac 设备认成 macmini。自定义名称和明确绑定的主机名称保留。

列表、详情、重命名入口和撤销确认使用相同显示规则。同名判断按显示后的
名称计算，确认框仍通过 ID 区分同类设备。当前设备始终按认证设备 ID 判定。
读取页面不写回设备记录、不改授权；用户主动改名时才调用原重命名接口。
没有新增主机能力或协议，CLI 继续返回实际保存的名称并使用已有改名命令。

## 验证范围

先在生产客户端加隔离 Hub 的浏览器用例复现：预期“Mac 电脑”，实际收到
“这台电脑”。新增检查覆盖桌面和手机宽度、两台旧名不同但显示同名的 Mac、
Android 旧名、详情及撤销确认、未发生自动写回，以及主动自定义改名。
现有当前设备排序、撤销记录折叠和主机名称同步回归继续保留。

最终结果：10 项单元测试、23 项 Chromium 交互回归通过，客户端翻译检查、
TypeScript 检查及生产构建通过。截图已检查。WebKit 首次未找到默认缓存，
改用既有外置盘浏览器后仍在创建页面前退出；启动日志显示 WebKit Network/
WebProcess 沙箱配置文件缺失，未绕过沙箱，也不计为通过。

结果与界面截图保存在外置盘 `taro-tmp/tarobot-legacy-device-names-20261019`。
未修改生产主机中的设备记录，未安装或发布 App。浏览器验收不等同于
Windows WebView2 或手机真机验收。
Git 读取权限现已恢复；续办验证和源码交付见下方记录。

后续修复：[跨主机设备名称同步](network-device-name-sync-2026-10-19.md)补齐了可信成员来源名称的同步。本文原有记录仅描述中性兜底标签，不代表名称同步已完成。新修复的验证与发布边界见后续文档。

## 2026-10-19 follow-up delivery

The earlier permission/runtime blocker statements are historical. See the
[pending-delivery closeout](pending-closeout-2026-10-19.md) for final verification,
independent review dispositions, source delivery and remaining native/release gates.
