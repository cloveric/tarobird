# Opus 5.5 mobile IM review

Actual model: `claude-opus-5-5`, effort `xhigh`. Implementation completed in 6 tool turns; visual review completed separately from actual browser screenshots. Both completed calls reported no permission denials. An earlier overly broad attempt reached its turn limit before writing files and is not counted as successful implementation.

## Visual review

没有阻断问题。390 和 320 宽度下，收件箱的截断、未读角标和角标合计（6、5）都正常；Bot 页的主机身份信息也清楚。下面 3 条建议都是小调整：

1. **群聊话题栏（06）**：第三项「# ☰ 2」看起来像一个被截断的话题后面跟了个图标，意思不清楚。建议改成明确的「更多 · 2」入口；或者让话题栏可以横向滑动，并在末尾加一个渐隐提示。
2. **输入栏（06）**：一行 6 个控件有点挤。现在没有在运行的回合，但「引导」是高亮的胶囊按钮，⊙ 又没有文字标签，两个都像可以点的主操作。建议只在回合运行中显示引导和停止，空闲时收起来。
3. **底部 Tab 选中状态不一致**：04 里 Bot 是灰色块背景，03 里「消息」和其他 Tab 几乎看不出区别。建议统一用图标和文字的颜色或字重来标出当前页。如果 04 的灰块只是截图时鼠标悬停造成的，那只需要给 03 补上选中颜色。

## Integration corrections

The implementer explicitly disclosed two unverified data assumptions. The primary agent verified the real contracts and corrected unread aggregation to the number of message-ID keys and host status to `online`. The creation menu targets the named active host. Native Back now closes the creation menu before backgrounding; mobile home never marks the hidden selected chat read.

All three visual suggestions were addressed: explicit Topics label and edge fade, idle steering / stop available in More (promoted to the composer during visible activity), and consistent active bottom-navigation styling. Later visual inspection corrected Send alignment. WebKit found a focus-return problem across the More-to-settings transition; PreferencesPanel now accepts an explicit return target.
