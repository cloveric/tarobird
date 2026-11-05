import { it, expect } from "vitest";
import { backgroundTaskBody, backgroundTaskContext, backgroundTaskReplyTo } from "../src/core/background-task-notice.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { backgroundTaskNotice } from "../src/client-protocol/background-task.js";
import { renderBackgroundTaskHeader } from "../src/runtime/background-task-header.js";
import { engineEventTimelineMetadata } from "../src/runtime/timeline-events.js";
import { renderCoreNotificationCard } from "../src/core/card-renderer.js";

it("removes a false App reply while retaining Feishu topic routing", () => {
  const event = { type: "task_notification", text: "old report", origin: "unattributed" } as const;
  expect(withChannelProfile("gateway", () => backgroundTaskReplyTo(event, "new-prompt"))).toBeUndefined();
  expect(withChannelProfile("feishu", () => backgroundTaskReplyTo(event, "thread-anchor"))).toBe("thread-anchor");
  expect(withChannelProfile("feishu", () => backgroundTaskReplyTo(event, "new-prompt", "gateway"))).toBeUndefined();
  const card = withChannelProfile("feishu", () => renderCoreNotificationCard("Update", "## Heading", "en", { origin: "unattributed", context: "Independent report" }, "gateway"));
  expect(card).toMatchObject({ appBackgroundTask: { version: 1, origin: "unattributed" } });
  expect(JSON.stringify(card)).toContain("## Heading");
  expect(backgroundTaskContext(event, "zh")).toContain("不是当前提问的回答");
});
it("localizes host fallbacks without translating or replacing authored results", () => {
  const event = { type: "task_notification", text: "Authored English result" } as const;
  expect(backgroundTaskBody(event, "zh")).toBe(event.text);
  expect(backgroundTaskBody({ ...event, reason: "no_result" }, "zh")).toBe("引擎没有提供更多结果。");
  expect(backgroundTaskBody({ ...event, reason: "engine_exit" }, "zh")).toContain("Claude 进程已退出");
  expect(backgroundTaskBody({ ...event, summary: "核对报告", reason: "engine_exit" }, "zh")).toContain("核对报告");
  expect(engineEventTimelineMetadata({ ...event, origin: "unattributed", reason: "engine_exit" })).toMatchObject({ taskOrigin: "unattributed", notificationReason: "engine_exit" });
  expect(renderBackgroundTaskHeader("zh", "interrupted")).toBe("后台任务已中断");
});
it("accepts additive background metadata without accepting an unknown version or origin", () => {
  expect(backgroundTaskNotice({ extra: { backgroundTask: { version: 1, origin: "bound", futureField: true } } })).toEqual({ version: 1, origin: "bound" });
  expect(backgroundTaskNotice({ extra: { backgroundTask: { version: 2, origin: "bound" } } })).toBeUndefined();
});
