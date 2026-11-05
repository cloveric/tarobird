# Opus 5.5 mobile regression review — 2026-10-04

Actual CLI model: `claude-opus-5-5`; effort: `xhigh`; no session persistence.

Scope: four UI regression journeys (avatars, capabilities, collaboration, dashboard). No production code, deployment or live Bot calls delegated. Completed successfully; permission denials: 0. The report below precedes root integration and test execution; its note that helpers were absent reflects its earlier read.

## Reviewer report

我改好了指定的 4 个 e2e 文件，但一个都还没跑过，也没做 tsc 检查：它们 import 的 `waitForClientOnline`、`openMobileHome`、`selectConversation`、`openWorkspacePage` 在 `fixtures/mobile.ts` 里还不存在，所以加 helper 之前这几个文件编译不过。按约定没碰 fixtures、生产代码和其他测试，没有 commit 或 push。

## 改动的文件
- `client/e2e/avatars.spec.ts`
- `client/e2e/capabilities.spec.ts`
- `client/e2e/collaboration.spec.ts`
- `client/e2e/dashboard.spec.ts`

## 改了什么
- **等待在线**：四个文件的 `pair()` 原来查的 `.connection-pill.online` 和 sidebar 里的“已连接”，在手机上都是隐藏的，统一换成 `waitForClientOnline`。
- **进入页面**：“运行状态”和“Skills 与 MCP”都改用 `openWorkspacePage`。会话行的点击改用 `selectConversation`。手机上的“对话设置”改用 `mobileChatAction`。删掉了 avatars 里原来那个本地 `select` helper。
- **avatars 断言加严**：`rendered()` 现在要求至少有一个**可见**的头像，同时仍要求所有副本（包括隐藏的）都是 256px。头像删除后的 `count 0` 检查不变，仍然统计全部 DOM。手机上各头像的可见检查点：
  - 个人头像：自己发的消息不显示头像，所以去“我的”页的个人卡片上看。
  - Bot 头像：群聊里 Bot 消息的头像。
  - 群头像：手机聊天页顶部的头像本来就是隐藏的，所以先回收件箱，看群那一行。
  - 话题沿用群头像：进入话题后打开 More → 对话设置，检查“对话管理”弹窗里有可见的 `group:<id>` 头像，并且出现“话题沿用所属群的头像。”。
- **dashboard 规模测试**：手机先从聊天页返回首页，再从“我的”打开运行状态；关闭后点“消息”标签，回到“性能验收对话”，再测停止。
- **桌面部分**：所有业务断言、截图名称和桌面步骤顺序都没动。avatars 第二个测试只有桌面，里面的 `.connection-pill.online` 原样保留。

## 我对 helper 行为的假设（请对照你的实现）
1. `openWorkspacePage` 在手机上只会从首页调用（“消息”或“我的”标签）。从聊天页出发时，我会先显式调一次 `openMobileHome`。
2. `openMobileHome` 只在手机、并且在聊天页里调用，不在桌面调用。
3. 手机上 `selectConversation` 只会在“消息”标签下调用。从“我的”返回时，我在 spec 里先点底部导航“主导航”里名字以“消息”开头的按钮；用正则匹配，是因为有未读时按钮名称会带“N 条未读”。
4. `waitForClientOnline` 在手机上不能依赖已隐藏的 connection pill。
5. 在“我的”标签里，`openWorkspacePage(page, "运行状态")` 只能命中可见的那一项。隐藏的 sidebar 里还有一个同名按钮。

## 产品问题
- **话题目录里没有群头像**：`GroupTopics.tsx` 的目录只用了 `Users` 图标，没有渲染群头像，所以“话题沿用群头像”只能在对话管理弹窗里验证。如果想在目录里也能看到，需要改产品。
- **手机上个人头像只在“我的”页能看到**：自己的消息隐藏头像，聊天页顶部也不显示，这符合现在的设计，只是很不显眼。
- **手机的停止按钮要看状态**：composer 里的停止按钮只在 Bot 正在回复时出现，其余时候只在 More 菜单里。dashboard 测试依赖这时消息还处在 streaming 状态，如果 streaming 状态判断变了，这一步会失败。
- **返回按钮的名字不准确**：手机聊天页的返回按钮和历史搜索的返回按钮，aria-label 都是“打开会话列表”，但实际作用是回到收件箱，读屏用户会被误导。

## Follow-up: mobile preview fix

Actual Opus 5.5 xhigh read-only packet review completed successfully. The preceding bounded attempt exhausted its turn allowance without a final report and is not counted as a completed review.

**结论：没有阻塞问题。** 按包里的内容看，这个修复本身是对的：每行会话都用它自己主机的 `host.bots` 包一层 `BotReferences`，所以一个主机的 ID 不会被另一个主机的 Bot 名替换。预览以 React 文本节点渲染，名字会被转义，不存在 XSS 风险。下面几条都不阻塞。

## 确定的问题（非阻塞）

1. **只要预览里有 `~` 或反引号，整条预览都不替换**（`BotReferences.tsx:1`，`ReferencePreview` 里的 `/[`~]/.test(text)`）。
   - 中文对话和 Bot 输出里 `~` 很常见，比如"约 3~5 分钟"、"好的~"。这类预览里的 `client_…` 会原样显示，正是这次要修的 bug。
   - `referenceParts` 已经会跳过紧挨 `/`、`:`、`@` 等字符的 ID，所以 `~/client_…` 这种路径本来就安全。`~` 的检查大概率只是在误伤。
   - 如果桌面端也用同一个组件，两端表现一致，但两端都有这个缺口。

2. **`App.tsx:15` 读取缓存时没有 `.catch`。**
   - 第 16 行的 `saveBotNames` 和 `HostApp.tsx:50` 的 `Promise.all` 都写了 `.catch(() => undefined)`，唯独 `cache.botNames()` 没有。
   - IndexedDB 读取失败（数据库正被删除、隐私模式等）时，会产生未处理的 rejection。e2e 里的 `errors` 断言可能因此偶发失败。

## 需要确认（取决于包里没有的代码，我没法验证）

3. **`status === "online"` 被当成名单已经到齐**（`App.tsx:16`）。如果连接可能先变成 online、`state.bots` 稍后才到：
   - 缓存会先被 `saveBotNames([])` 覆盖成空；
   - `receivedDirectory` 会锁成 true。

   `HostApp` 里的 `state.bots.length || status === "online"` 也基于同一个假设。需要确认 online 状态和 Bot 名单是不是同时到达的。

4. **同一会话内从在线变离线时，用的是 `state.bots` 而不是缓存。** `receivedDirectory` 置为 true 后不会再回到 `cachedBotNames`。如果连接断开时会清空 `state.bots`，手机预览会退回显示原始 ID，直到重新加载。非活跃主机走 `HostApp` 时，名单为空会回退到 `saved`，两条路径的行为不一致。现有 e2e 只覆盖了离线重新加载，没有覆盖会话中途断线。

5. **缓存里存的字段需要确认**（顺带一个小问题）。
   - `saveBotNames(state.bots, …)` 传入的是完整的 Bot 对象，测试只检查了 `length === 3`。需要确认实际只存了 `{id, name}`，没有把 engine/model 等字段写进 IndexedDB。
   - 两处展开顺序相反：`App` 是 `{...bot, engine: ""}`，`HostApp` 是 `{engine: "", ...bot}`。如果缓存里有多余字段，活跃主机和非活跃主机显示的内容会不一致。

6. **性能小问题。** 离线时 `mobileBots` 每次渲染都会生成新数组，每一行的 `BotReferences` 都会重新跑一遍 `botLabels`（行数 × Bot 数）。可以给 `mobileBots` 加 memo，或者改成每个主机一个 provider，而不是每行一个。

## 测试缺口

- **多主机隔离**：当前 e2e 只有单主机（`singleHostCacheName`）。需要补两个场景：
  - 非活跃主机的行能用自己的名单显示名字，包括离线时走 `saved` 回退的情况；
  - 别的主机的 `client_…` ID 保持原样，不被替换。
- **直接锁住这次的回归**：在线和离线两种情况下，都对 `.mh-row` 加一条 `not.toContainText(/client_[a-f0-9]{24}/)`。
- **会话中途断线**：不重新加载，只停掉 Hub，检查预览是否仍显示名字（对应第 4 条）。
- **在线状态下移除主机**：如果移除时还有 `saveBotNames` 没写完，确认不会把数据库重新建出来。现有测试只在 Hub 停掉后做移除。
- **`ReferencePreview` 单元测试**：覆盖含 `~` 或反引号的预览（对应第 1 条）。
- 缓存存储格式只断言了长度，建议断言为严格的 `{id, name}`。
- `mh-row-title` 和 tag 没有经过替换。如果会话标题可能包含托管 ID，也需要覆盖；从这份材料里我判断不了标题会不会包含 ID。

## Root dispositions

- Tilde prose: fixed with `readablePreviewBotReferences`; complete URLs including query strings remain literal, while code-bearing/truncated excerpts remain conservatively untouched. Focused tests pass.
- Cache rejection concern: `ClientCache.botNames()` already catches storage and parse failures internally and returns an empty array.
- Online readiness: `connection.ts` sets status online and ready.bots in the same update after the signed handshake.
- Disconnect retention: `HubConnection.update` merges state; disconnect paths do not clear the Bot directory.
- Cache fields: both read and write normalize to `{id, name}`. Existing reset fencing rejects stale writes.
- Cached mobile Bot array is now memoized; row lookup uses a host-ID map.
- Added cross-host preview assertions with the same managed Bot ID mapped to different names. Existing delegation journey covers cached names after offline reload and removal, plus exact copy/code/URL source preservation.
- Phone question drafts, palettes after reload and session recovery tests now explicitly enter a conversation from the inbox.

## Executed acceptance

The four Opus-edited journeys passed on Chromium and WebKit. The primary agent
also fixed a startup script-budget regression through lazy loading and a WebKit
ResizeObserver warning through animation-frame measurement. A full-run Vite
cache conflict was reproduced from HTTP 504 trace evidence; test caches and
gallery publication are now isolated, with 63 affected cases passing in parallel
on each browser. Root required checks passed 3,648 tests and the build.
Full counts, the original failed invocation, native resource hashes and remaining
physical-device limits are in [the acceptance record](mobile-full-regression-2026-10-04.md).

The avatar-directory suggestion is a visual refinement, not a failed inheritance
contract: settings and messages render the inherited avatar. Existing phone Back
labels still describe the destination conversation list; the changed IM layout
does not invalidate that destination. Active-stream and idle Stop controls were
both exercised through their visible phone entry points.
