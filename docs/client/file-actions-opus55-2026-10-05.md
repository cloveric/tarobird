# 附件“打开 / 另存为”操作链路 · 2026-10-05（Opus 5.5）

交接状态：**源码已修改。我没有构建、类型检查、运行测试，也没有在浏览器里渲染。**
本文结论只来自三张“修改前”截图（已用 Read 实际打开
`docs/client/screenshots/file-actions-20261005/01-card-before.png`、`02-save-before.png`、
`03-preview-before.png`）、源码阅读，以及已安装 `@capacitor/share` 8.0.2 的 iOS/Android 源码。
截图 02 是浏览器内窄 IPC 替身，不是原生窗口。构建、渲染 QA、回归和修错由父代理负责；
本文任何地方都不代表验收通过，也不代表原生保存对话框或真机验收。

改动文件：`client/src/Content.tsx`（`AttachmentFile`、新增 `FileStatus` / `fileStatusText`、imports）、
`client/src/attachment-export.ts`、`client/src/locales/en.json`、`client/src/brand-theme.css`。

## 一、截图观察

- 01：229 字节的文件显示 “0.00 MB”。大小按 MB 固定两位小数，小文件全部是 0。
- 02：文件其实已下载完，界面还停在“下载中 100%”，旁边是“取消下载”，另存为按钮在转圈。
  原因：`busy` 覆盖“下载 + 导出”整个过程，但取消按钮只能中止下载；进入保存对话框/写入后，
  `AbortController` 已经不起作用，所以点取消无效，而且看不出现在在等什么。
- 03：预览层（390px）顶部是“另存为 / 关闭”。原代码里，预览中另存为的进度和错误只显示在
  被遮住的底层卡片上；`busy` 时原生返回被吞掉、按钮仍可关，Escape 和背景点击却照常关闭，三条规则不一致。
- 原代码把主动取消当错误：`downloads.ts` 抛出“下载已取消。”，卡片用红色 `role="alert"` 显示。
- 手机分享面板被关闭时，`@capacitor/share` 会 reject `"Share canceled"`，原代码也当成红色错误。

## 二、状态与文案

一次只显示一个步骤，位置固定在卡片文件名下方的一行（预览打开时改在预览标题下方）。

| 步骤 | 中文 | English | 指示 | 可操作 |
|---|---|---|---|---|
| 下载 | 下载中 {0}% | Downloading {0}% | 确定进度条（accent） | 取消下载 |
| 下载·等待恢复 | 连接中断，等待恢复… | Connection lost. Waiting to resume… | 进度条变灰、保留已下进度 | 取消下载 |
| 下载·收尾 | 正在完成下载… | Finishing download… | 进度条满 | 取消下载（仍有效，见下） |
| 准备预览 | 正在准备预览… | Preparing preview… | 小转圈 | — |
| 桌面·选位置 | 请选择保存位置… | Choose where to save… | 无（等待用户） | — |
| 桌面·写入 | 正在保存… | Saving… | 小转圈 | — |
| 手机·准备 | 正在准备分享… | Preparing to share… | 小转圈 | — |
| 手机·分享中 | 请在系统分享中选择去处 | Choose a destination in the share sheet | 无（等待用户） | — |
| 完成·桌面 | 已保存 | Saved | 绿色对勾 | — |
| 完成·手机 | 已交给系统分享 | Handed to the share sheet | 中性灰 | — |
| 完成·浏览器 | 已交给浏览器下载 | Handed to the browser to download | 中性灰 | — |
| 取消·下载 | 下载已取消 | Download cancelled | 中性灰 | — |
| 取消·桌面 | 已取消保存 | Save cancelled | 中性灰 | — |
| 取消·手机 | 已关闭系统分享 | Share sheet closed | 中性灰 | — |
| 失败 | 原错误文案 | 原错误文案 | 红色，`role="alert"` | 重试（重做失败的那个动作） |

设计取舍：

- **绿色只给“已保存”**。只有桌面原生写入完整、文件句柄关闭后才会出现。浏览器和系统分享
  是“交出去”，用中性色，不说已保存。颜色本身就区分了“已落盘”和“已交出”。
- **主动取消是中性结果**，用灰色和 `role="status"`，不用红色和 alert。
- **“下载·收尾”仍可取消**：进度到 100% 后，`connection.blob` 还在做整文件校验和写本地缓存，
  文件还没有交给平台；这时取消会丢弃结果，所以取消按钮是真的有效。
- **手机取消文案写“已关闭系统分享”，不写“未发送”**：Android 插件按“本 Activity 是否被 stop”
  判断取消（`RESULT_CANCELED && !stopped`），不盖住本应用就打开的目标也可能被报成取消。
  “已关闭”只描述看到的事实。
- 写入失败发生在“桌面·写入”步骤时，错误后补一句“所选位置可能留下不完整的文件。”
  （英文 “An incomplete file may remain at the chosen location.”）。只说“可能”，不承诺原子保存，
  也不做删除。
- 大小改用 `files.ts` 的 `formatFileLimit`：229 字节显示 “229 B”，和上传上限的写法一致（KiB/MiB）。
- 结果提示不自动消失，没有计时器，留到下一次操作；卡片重新挂载后清空（状态在组件内部）。

## 三、`exportAttachment` API 约定

```ts
export type ExportStage = "choosing" | "saving" | "preparing" | "sharing";
export type ExportDelivery = "saved" | "shared" | "browser";
export type ExportReport = { stage?: (stage: ExportStage) => void; delivered?: (delivery: ExportDelivery) => void };
export async function exportAttachment(blob: Blob, rawName: string, report?: ExportReport): Promise<boolean>;
```

- 返回值不变：`true` = 平台已接受，`false` = 用户关闭了保存对话框或分享面板。两个参数的调用照旧可用。
- `delivered` 在 `return true` 之前调用，且只调用一次：
  - Tauri：写完所有字节并 `close()` 成功后才报 `"saved"`。写入或关闭失败都会 reject，不会报 delivered。
  - Capacitor：`Share.share` resolve 后报 `"shared"`。
  - 浏览器：`anchor.click()` 之后报 `"browser"`。
- `stage` 的第一次调用是**同步的**，发生在任何 `await` 之前：Tauri 先报 `"choosing"`，Capacitor 先报 `"preparing"`。
  这样下载结束到进入导出之间没有渲染间隙，“取消下载”不会在下载结束后还留在屏幕上。
  Tauri 选好路径后报 `"saving"`；Capacitor 写完缓存副本、打开分享面板前报 `"sharing"`。浏览器路径不报 stage。
- Capacitor 取消识别：`error instanceof Error && error.message === "Share canceled"` 时返回 `false`。
  依据是已安装插件源码：iOS `SharePlugin.swift` 在 `completed == false` 时 `call.reject("Share canceled")`；
  Android `SharePlugin.java` 在 `RESULT_CANCELED && !stopped` 时 `call.reject("Share canceled")`；
  原生桥把错误放进 `CapacitorException`（`extends Error`），并拷贝 `message` 字段。
  取消时缓存副本**不删除**。现有清理是在下次导出时移除创建已超过 24 小时的目录，并非计时器，也不保证 24 小时内删除（父代理核对源码后的补充；原因见上面 Android 那条）；其他错误照旧删除。
- UI 约定：`true` 本身不代表已保存。卡片只按 `delivered` 选文案；如果将来某条路径返回 `true`
  却没报 delivered，UI 回到空闲，不显示任何完成文案。
- 本轮保留不变：短写循环（只按原生确认的字节数前进）、`finally` 中关闭句柄、
  原生字符串错误转成可操作的保存错误、`attachmentFilename` 文件名安全策略。

## 四、交互规则

- **不并发**：`running` 引用覆盖整个动作（下载 + 预览/导出），不只是下载。忙碌时两个主按钮用
  `aria-disabled` 变淡、点击不起作用（`run` 直接返回）。不用原生 `disabled`，这样键盘焦点
  不会掉到 `body`。
- **卸载**：`alive` 引用在卸载时置为 false，并中止进行中的下载；之后所有状态更新（包括进度回调）
  都不再执行。下载期间卸载不会弹出保存对话框（`run` 在导出前检查 `alive`）。
- **预览中另存为**：直接导出预览时持有的 Blob（`source`），不再下载一遍，所以预览里不会出现下载进度。
  步骤、结果、错误和重试都显示在预览标题下方。
- **预览关闭规则统一**：关闭按钮、Escape、点背景、原生返回都调用同一个 `close()`，**保存中也能关**。
  关闭后保存继续，状态回到卡片上显示（预览关闭时卡片渲染状态行）。以前保存中原生返回被吞掉、
  其他方式却能关闭；现在不会再关不掉。
- **重试**：错误状态带“重试”按钮，重做失败的动作（打开或另存为）。在预览中保存失败后重试，
  继续用持有的 Blob；关闭预览后再重试会重新获取（通常命中本地缓存）。
- `useBackAction` 优先级仍是 200；预览没打开时 `panel` 为空，这个返回动作不会参与分发。

## 五、视觉与布局（brand-theme.css）

- `.file-card` 加 `flex-wrap:wrap; row-gap:8px`。状态行 `.file-status` 占满一行，
  `margin-inline-start:48px`（36px 图标 + 12px 间距），和文件名左对齐。
- 字号 12px，默认 `--grey`；完成 `--green`；错误 `--red`；状态行里的按钮文字固定 `--text`，
  不跟着变红。只用已有 token，深浅色都使用同一组语义色。
- 进度条：3px、`--surface-alt` 底、`--accent` 填充；等待恢复时填充改 `--muted`。用 `transform: scaleX()`，
  过渡 `--t-med --ease`，不动画 width。`prefers-reduced-motion` 由已有全局规则关掉过渡和转圈动画，
  文字照样表达状态。
- 不新增装饰、入场动画或循环动画；转圈只用于确实在进行的本地工作（准备预览、写入、准备分享）。
  等用户在系统界面里做选择时不转圈。
- 触控：手机（≤760px）和宽屏粗指针（≥761px + coarse）下，卡片内全部按钮和预览标题按钮至少 44×44px。
  原来手机共用的 40px 规则中去掉了 `.file-card button`。
- 预览中的状态行：`.file-preview>.file-status{flex:none;margin:-4px 0 12px}`。必须写 `flex:none`，
  因为预览是纵向 flex，否则 `flex-basis:100%` 会变成占满高度。
- 注意 `styles.css` 里有 `.file-card span{flex:1;flex-direction:column…}`，所以状态行里刻意不用 `span`
  （文字用 `small`，容器用 `div`）。

## 六、对现有测试的影响（我没有改测试）

- `client/e2e/downloads.spec.ts:108` 断言 `phone.getByRole("alert")` 包含“下载已取消”。
  现在主动取消是中性状态：文字在 `.file-card` 内的 `role="status"`，内容正好是“下载已取消”。
  这条断言需要改成按 status 查找，例如 `phone.locator(".file-card").getByRole("status")` toHaveText “下载已取消”。
- `downloads.spec.ts:98/104` 的 “连接中断，等待恢复…” / “下载中 6%” 仍在 `.file-card` 内唯一的
  `role="status"` 上，文字不变。“取消下载”按钮名不变，位置从主按钮行移到了状态行。
- 卡片按钮名（“打开”“另存为 {name}”）、对话框名（“文件预览”）、预览中的“另存为”“关闭”都不变。
- 忙碌时主按钮从 `disabled` 改成 `aria-disabled="true"`。如果有测试用 `toBeDisabled()` 检查这两个按钮，
  请父代理确认 Playwright 对 `aria-disabled` 的判断；我没有查到这类断言，也没有验证。
- `desktop-export.spec.ts` 只调用两个参数，预期行为不变（取消仍只有一次 `plugin:dialog|save` 调用）。
  建议补测：传入 `report`，断言 stage 顺序 `choosing → saving`、成功时 delivered 为 `"saved"`，
  失败或取消时没有 delivered；Capacitor 路径用 `"Share canceled"` 替身断言返回 `false`。
- `check-translations.mjs` 只扫描 `t("…")` 字面量，新增文案都以字面量调用，`en.json` 已补齐 12 条，
  占位符 `{0}` 两边一致。

## 七、剩余边界

- 没有原生验收：没有打开过 Tauri 原生保存对话框，也没有在 iOS/Android 真机上走分享面板；Mac 锁屏。
  只核对了插件源码。
- Tauri 写入不是原子的：失败可能在所选位置留下不完整文件。本轮没有扩大权限去删除或原子替换，
  只在错误里写明“可能留下”。
- 浏览器路径看不到用户在浏览器自己的保存框里是否取消，所以只说“已交给浏览器下载”。
- Android 的“取消”可能是误报（见上）；文案和缓存保留策略已按这个情况处理。
- 原生保存对话框打开时卡片被卸载（例如离开对话）：用户选好位置后写入会继续完成，但不会有界面提示。
- 手机上按钮仍叫“另存为”，实际打开系统分享面板。改名会影响现有测试的按钮名，本轮没有动。
- `docs/entrypoint-map.md` 436–443 行描述了 `attachment-export.ts`，不在我的修改范围内；
  如需提到 stage/delivery 报告和取消识别，请父代理补充。
- 320px 时状态行可用宽度大约 200px，英文长句会换成 2–3 行。如果实测太挤，可以在 ≤360px 时去掉
  48px 缩进；这一点需要实际渲染后决定。

## 八、建议父代理验收

1. 桌面 / 390px / 320px，中英文，浅色 / 深色：截取下载中、等待恢复、选位置（IPC 替身暂停）、
   写入中、已保存、已取消保存、写入失败 + 重试的卡片状态，以及在预览中另存为的同一组状态。
2. 截图 02 的场景：替身暂停写入时应显示“正在保存…”，不应出现“取消下载”。
3. 下载中点“取消下载”：灰色“下载已取消”，没有 alert；再点另存为可以重新开始。
4. 预览中保存进行时，分别按 Escape、点关闭、点背景、触发原生返回：都能关闭预览，状态回到卡片。
5. 连续快速点另存为两次：只出现一次保存对话框。
6. 229 字节文件显示 “229 B”。

## 九、父代理渲染验收后的修订

实际浏览器检查发现并修复了三项候选问题：
- 文件预览改成原生 HTML `dialog.showModal()`，覆盖聊天不可交互。关闭前先 dismiss dialog 并显式聚焦原打开按钮，防止 React 卸载后焦点留在 body；三个关闭路径均已做双浏览器焦点断言。
- 状态行的 `margin-inline-start:48px` 改成内边距，避免宽度加上边距后超出卡片。
- 44px 触控规则包含预览中的重试按钮；≤480px 文件名和操作分行，防止 320px 英文界面将短文件名挤成竖排。

这些是父代理对当前实现的后续修订，不计作 Opus 自己运行过的验证。
最终图像、双浏览器测试与原生边界见 [交互验收](file-actions-qa-2026-10-05.md)。
