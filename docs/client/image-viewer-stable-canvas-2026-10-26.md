# 图片查看器：切换工具栏时保持画面稳定

用户确认希望保留手机点击图片外空白区域隐藏／显示名称和工具栏，只消除
切换时的闪动，不改成点击空白退出。

## 复现与原因

浏览器逐帧采样显示：普通网页只让工具栏淡出，图片坐标和尺寸保持不变。
原生路径却把 `acquireImageViewerImmersive()` 的生命周期绑定到 `controls`。
每次隐藏／显示工具栏都会隐藏／显示系统栏；Android 的 `NativeInsets`
随之增减整个 WebView 的 padding，再触发图片重新定位。

在 API 36 Android 模拟器、隔离 `.appearancetest` APK 中使用正式共享
`LocalImagePreview`/`ImageViewer` 复现。旧控件生命周期下，点击空白隐藏
工具栏后 viewport 高度从 839 变为 915 CSS px，图片 top 从 303.625 变为
341.625；图片尺寸不变，却跳了 38 CSS px。回归断言因此失败。这份对照
使用旧版 ImageViewer 和同一份原生构建，隔离的是工具栏／全屏生命周期。

## 修改

- 打开查看器即获取原生全屏租约，直到关闭查看器才释放。图片名称、工具栏
  只在同一张画布上淡入淡出，不再带着系统栏反复变化。
- Android 仍然让图片占满画布；单独把忽略可见性的系统栏／刘海安全边距传给
  工具栏 CSS。不会把 padding 重新加到整张图片上。横屏侧边、底部操作区
  同样读取对应边距；iOS／浏览器继续回落到现有 safe-area 值。
- 重载时重新报告边距，关闭后恢复原系统栏和聊天区域，安全边距仅用于查看器。
- 触摸聚焦查看区域不显示原生全屏焦点框，键盘操作保留细焦点边线。
- 当时未修改单击图片关闭（现已由下方追加修订取消）、双击缩放、拖动、惯性、长按菜单、切图、图片字节或
  桌面鼠标规则。无需 Host/CLI/协议/存储变化，属于 App 展示调整。

## 可复验入口

`image-viewer.spec.ts` 的 Android/iOS 桥接场景使用真实触摸和正式 App
组件，验证一次打开只获取一次租约、空白点击只切换工具栏、图片几何不变、
安全边距和关闭释放。桥接替身不代表物理设备验收。

`client/scripts/image-viewer-phone-build.mjs <外部输出目录>` 构建独立原生
查看器 fixture，不安装或访问生产 Host。把输出复制到独立 Android 包的
`assets/public`，使用 `-PtarobotApplicationId=com.tarocub.client.appearancetest`
构建 `:app:assembleDebug :app:assembleDebugAndroidTest` 后执行
`AppearanceTest#imageToolbarDoesNotResizeNativeCanvas`。该用例注入真实 Android
触摸、检查每帧图片坐标、重复显隐、控件安全区和关闭后的 native padding。
测试包必须使用该 fixture，其他 AppearanceTest 用正式 App 资源单独执行。

证据目录：`/Volumes/gdrive/taro-tmp/image-backdrop-touch-20261026`。

本轮只修改源码，没有发版、更新生产 App 或重启生产主机。物理 Android /
iPhone 验收未完成，模拟器也不能覆盖 ColorOS 等厂商的系统动画差异。

## 验证结果

- 客户端翻译、类型检查、构建及 Host 构建通过。
- 相关单元测试 17 项通过。完整图片查看器／图库／原审计回归／菜单浏览器
  套件：Chromium 40 项通过、1 项条件跳过；WebKit 33 项通过、8 项条件
  跳过。跳过项为浏览器能力／CDP 条件，不计入通过。
- 最终焦点边框补充后，Chromium／WebKit 各 4 项针对性回归通过，包括
  开关工具栏、键盘 Close 可达性和原生桥接租约。
- Android 隔离 APK 构建、lintDebug 和最终原生仪器用例通过。连续两次
  隐藏／显示工具栏时，逐帧采样的 viewport、图片位置和尺寸始终只有一个
  值；关闭后上下 native padding 正常恢复，触摸后焦点框为 none。
- 首次命令误调用了所有 Gradle 子项目的 AndroidTest 构建，触发 Cordova
  子项目既有 Kotlin 测试依赖冲突；改用本 App 的精确构建目标后通过。
  两次早期原生复测被 Android 首次全屏说明遮挡，截图确认并完成该系统
  提示后，实际触摸、坐标及焦点边框断言全部通过。没有为通过测试取消原生
  触摸路径或放宽几何断言。


## 后续修订：手机单击图片恢复工具栏显隐

按用户的新要求，触摸图片时，无论是否放大，单击都只隐藏／显示名称和工具栏，
不再关闭查看器。点击图片外空白处同样切换工具栏。关闭按钮和系统返回仍可
退出；桌面鼠标点击图片外空白处退出的规则不变。

复用原有单击／双击判定和全屏租约，不重新请求全屏或改变图片尺寸。双击缩放、
拖动、惯性、长按菜单和切图的处理不变。同步更新辅助说明与中英文翻译。
此变更只涉及 App 手势展示，Host、CLI、协议和存储不受影响。

回归覆盖手机／扩展触摸窗口、桌面窄／宽窗口，单击显隐、双击缩放、关闭返回
焦点、键盘或工具栏操作取消待定单击，以及 Android／iOS 桥接下图片几何和
全屏租约稳定。浏览器和桥接替身不代表真机验收；本次没有发版或安装。

本次追加修订验证：`image-viewer`、`image-viewer-opus-regressions-20261023`、
`image-gallery`、`image-context-menu` 的 Chromium 40 项通过、1 项条件跳过；
WebKit 33 项通过、8 项条件跳过（CDP、剪贴板和浏览器全屏能力限制）。
增强后的长按／停止惯性不切换工具栏断言单独复测 1 项通过。客户端翻译、
类型检查和生产构建通过。手机宽度与扩展触摸窗口均验证过，仍未做真机验收。
