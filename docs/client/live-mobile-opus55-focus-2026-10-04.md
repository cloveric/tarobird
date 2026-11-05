# Opus 5.5 多题表单焦点复核

2026-10-04，实际模型 `claude-opus-5-5`、`--effort xhigh`，只读代码审查，无工具，无持久化会话。返回 success；下文保留模型原文，主代理需独立复现及验证。

**结论：** 原来 RAF 抢焦点的问题已经修好，但 `focusAfterMove` 还有一个残留路径可以复现，测试也有两处没覆盖到。

**1. ref 残留导致延迟抢焦点（中）**

触发条件：`move()` 的目标是当前题，且其他 state 都没变。两种常见操作：
- 错误提示还在时，再点一次「提交」；
- 点当前题的步骤按钮。

这时 `setStep` 和 `setError` 都会被 React bail-out，不产生 commit，layout effect 不执行，`focusAfterMove` 一直停在 true。之后任意一次 commit 都会把焦点拉回标题，比如用户在 textarea 输入第一个字、勾选选项，或某个异步回调。手机上键盘会收起，后续输入丢失，等于原 bug 换了个入口。只有当别的异步更新碰巧先触发 commit 时才不会出现。

复现：最后一题设为必填纯文本，空着连点两次「提交」，然后点 textarea 打字。

建议修法：用 `const [focusSeq, setFocusSeq] = useState(0)` 替代 ref。`move` 里调用 `setFocusSeq(n => n + 1)`，effect 依赖 `[focusSeq]`，值为 0 时跳过。这样每次 move 都保证有一次 commit。

**2. 测试缺口**
- 所示测试里没有正向断言：「下一题」「上一题」或提交校验跳题之后，标题应获得焦点。即使把 focus 整个删掉，测试也照样通过。
- 新实现已经不走 RAF，劫持 RAF 那段只能证明"不再依赖 RAF"，覆盖不到同题残留路径。建议补一个用例：错误提示下再点「提交」→ textarea.focus → 输入 → `toBeFocused`。

**3. 需确认**

`preventScroll: true`：在长题底部点「下一题」时，新标题可能在视口外，视觉用户看不到题首。如果旧代码没有这个参数，这就是行为回归。

其余几项没发现问题：跨题校验、输入状态（`draft.current` 同步）、初次加载和草稿恢复都不会抢焦点。

## 主代理处理与最终复核

首轮真实 Hub 同题回归通过，尚未暴露状态静默时的路径。随后使用真实 QuestionForm、静默连接和延迟草稿存储的隔离 fixture，稳定复现同题点击后的焦点未完成；在修复前保留失败回执。采用 focusRevision state 后，两浏览器各 14 项回归及真实 Codex 原生表单重新通过。正向验证切题、重复当前题、重复校验后的标题焦点，并验证连续输入不丢焦点。初始 RAF 延迟测试保留。`preventScroll: true` 是旧版本已有行为，没有声称修复了长题滚动体验。fixture 独立 TypeScript 检查也通过。

再次实际调用 Opus 5.5 xhigh，仅审查最终修复：

**结论：没有发现阻断问题。** 以下基于你贴出的代码阅读，我没有运行。

**修复本身**
- `move` 每次都会让 `focusRevision` 加一。所以同题时 `setStep`、`setError` 即使值不变被跳过渲染，也一定会提交一次，`useLayoutEffect` 会在 DOM 更新后同步聚焦。
- 输入、读取草稿、`restoreOutbox` 都不改 revision，因此不会抢焦点。初始值为 0 时直接跳过，StrictMode 重复挂载也安全。
- `finish` 里先 `move(i)` 再 `setError`，最终显示的错误正确。

**回归用例**
- 连点两次同题导航，是唯一会触发更新的路径，正好命中原缺陷。
- 第二次点「提交」时错误文字不变，覆盖了状态被跳过的情况。
- 随后的「第一字/第二字」会验证延迟抢焦点的问题。

**非阻断**
- `toBeFocused` 会自动重试，无法区分同步聚焦和下一帧才聚焦，只能靠输入步骤间接兜住。
- fixture 中 `CardElement`、`QuestionData` 的结构能否通过类型检查，以 tsc 结果为准。
