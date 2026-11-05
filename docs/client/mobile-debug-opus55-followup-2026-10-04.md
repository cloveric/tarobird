# Opus 5.5 mobile fixes — follow-up report

Executed with `claude --model claude-opus-5-5 --effort xhigh --no-session-persistence`. Canonical model receipt: claude-opus-5-5; success, no denied tools. The questions below were resolved in the final audit report; this preserves the original review verbatim.

**结论：三项修复主路径逻辑没问题，有条件通过。**

**普通对话落底**
- `App.tsx:181` 只有 shell 的 select 命令会把 `followLatest` 设回 true。332、341、334 这三处直接 `setSelected`，没有重置。之前在别的会话里往上翻过的话，切话题后可能不落到底。需确认有没有按 `selected` 变化来重置的 effect，没有就在这三处补上同样两行。
- 344 点搜索结果时没有像引用跳转那样设 `followLatest=false`。如果新消息到达时的跟随逻辑不检查 `focusTarget`，会把页面拉回底部。需确认。

**跨主机收件箱搜索/筛选**：状态放到 HostApp，所有主机副本共用，逻辑正确，spec 113-114 有覆盖。代价是每输入一个字都会重渲染全部 Workspace，属于低端机性能观察项，不是逻辑错误。

**历史搜索关闭与上下文隔离**：手机上 X、返回按钮、系统 Back 都回首页；聊天顶栏和话题条已隐藏，截图 07 页面干净；spec 179 验证了不会误标已读。需确认 `historySearch.start` 是否同步把 `searchResults` 设成非 undefined。否则在结果返回前会先露出缓存的聊天，网慢时可能被标成已读。另外，搜索结果不在当前对话里时的跳转没有测试覆盖。

**截图 06**：320 宽时，右侧悬浮头像盖住了输入框右边缘和滚动条。需确认它是不是 App 自己的元素。

**各主机副本滚动位置**：最小方案是在 HostApp 用 ref（不用 state，避免重渲染）按 tab 记下收件箱的 `scrollTop`，副本变为可见时在 MobileHome 的 `useLayoutEffect` 里恢复，不做实时同步。

**真机验收限制（不算缺陷）**：软键盘/输入法、图片等后加载内容造成的高度变化、原生包。

**审批**：可以合入。建议合入前先确认上面三个待确认点，并补一条跳到其他对话的搜索测试。