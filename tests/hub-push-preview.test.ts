import { expect, test } from "vitest";
import { messageSchema, type Block } from "../src/client-protocol/index.js";
import { pushPayloadSchema, type PushPayload } from "../src/client-protocol/push.js";
import { notificationPreview } from "../src/hub/push/preview.js";
import { initialCoreRunState, renderCoreRunCard, renderCoreRunCardCompact } from "../src/core/card-renderer.js";
import { translateCard } from "../src/gateway/card-translator.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
import { createRunRecord } from "../src/core/run-record.js";

function preview(blocks: Block[], kind: PushPayload["kind"] = "answer", title = "发布准备", bot = "CC1", incomplete = false) {
  const message = messageSchema.parse({ id: "reply", conversationId: "chat", authorType: "bot", authorId: "bot", createdAt: 1, status: "complete", version: 1, blocks });
  const body = notificationPreview(message, title, bot, kind, incomplete);
  expect(pushPayloadSchema.safeParse({ id: "push", title: "TaroCub", body, conversationId: "chat", messageId: "reply", kind, at: 1 }).success).toBe(true);
  return body;
}
test("a real terminal run previews the answer rather than its status, reasoning or tools", () => {
  const state = initialCoreRunState("chat");
  state.status = "done"; state.resultText = "**已修复** ADHD 侧栏，保留全部草稿。\n\n[查看提交](https://example.test/private-url)";
  state.reasoning = { active: false, content: "PRIVATE_REASONING" };
  state.blocks = [{ kind: "tool", tool: { toolName: "Bash", toolInput: { command: "PRIVATE_COMMAND" }, output: "PRIVATE_LOG", status: "done" } }, { kind: "text", content: state.resultText, streaming: false }];
  const card = withChannelProfile("gateway", () => translateCard(JSON.parse(JSON.stringify(renderCoreRunCard(state)))));
  const body = preview([card]);
  expect(body).toBe("「发布准备」 · CC1\n回复完成：已修复 ADHD 侧栏，保留全部草稿。 查看提交");
  expect(body).not.toMatch(/PRIVATE|private-url|\*\*|已完成 回复/);
});
test("expanded process panels and action values never become the excerpt", () => {
  const body = preview([{ type: "card", title: "确认发布", elements: [
    { type: "collapsible", text: "过程", open: true, children: [{ type: "markdown", text: "PRIVATE_TOOL_LOG" }] },
    { type: "markdown", text: "请确认是否发布安卓版本。" },
    { type: "button", text: "同意", actionId: "approve", value: { secret: "PRIVATE_VALUE" } },
  ] }], "action");
  expect(body).toBe("「发布准备」 · CC1\n待处理：请确认是否发布安卓版本。");
});
test.each(["partial", "error"])("%s does not announce successful completion", phase => {
  expect(preview([{ type: "text", text: "网络中断，尚未上传安装包。" }], "error", "发布准备", "CC1", phase === "partial"))
    .toBe("「发布准备」 · CC1\n任务未完成：网络中断，尚未上传安装包。");
});
test("file-only, image and audio messages describe the delivered artifacts", () => {
  expect(preview([{ type: "file", attachmentId: "file", name: "版本报告.pdf", size: 10, mime: "application/pdf" }])).toContain("收到文件：版本报告.pdf");
  expect(preview([{ type: "image", attachmentId: "image" }, { type: "audio", attachmentId: "audio", name: "说明.m4a" }])).toContain("收到1 张图片、1 条音频");
});
test("long titles, controls, Markdown and emoji remain bounded and plain", () => {
  const body = preview([{ type: "text", text: "# 修复完成\n- **已完成** `代码` [附件](/private/file)\u202E\n" + "😀".repeat(300) }], "answer", "标题\n\u202E「很长」".repeat(40), "Bot\n".repeat(40));
  expect(body.length).toBeLessThanOrEqual(200); expect(body.split("\n")).toHaveLength(2);
  expect(body).not.toMatch(/\u202E|\*\*|\/private|`/);
  expect(body.isWellFormed()).toBe(true); expect(body).toContain("修复完成 已完成 代码 附件");
});
test("empty output still names its conversation and duplicate Bot/title is not repeated", () => {
  expect(preview([{ type: "card", elements: [{ type: "markdown", text: "**已完成**" }] }], "answer", "CC1", "CC1"))
    .toBe("「CC1」\n回复完成：点按查看回复。");
});
test.each([renderCoreRunCard, renderCoreRunCardCompact])("goal and background banners cannot displace the final result (%s)", render => {
  const state = initialCoreRunState("chat");
  state.status = "done"; state.goalObjective = "一个很长的目标说明".repeat(20);
  state.resultText = "侧栏现在可以调整宽度。";
  state.nativeRun = createRunRecord();
  state.nativeRun.entries.push({ seq: 1, revision: 1, kind: "tool", status: "running", at: 1, name: "background_task_started", callId: "background" });
  const card = withChannelProfile("gateway", () => translateCard(JSON.parse(JSON.stringify(render(state)))));
  expect(preview([card])).toBe("「发布准备」 · CC1\n回复完成：侧栏现在可以调整宽度。");
});
test("technical comparisons and generic types survive plain-text formatting", () => {
  expect(preview([{ type: "text", text: "把 `Map<String, String>` 换成 List<Item>，并且 a < b 时返回 b > c。<br>**完成**" }]))
    .toBe("「发布准备」 · CC1\n回复完成：把 Map<String, String> 换成 List<Item>，并且 a < b 时返回 b > c。 完成");
});
test.each(["interrupted", "idle_timeout", "delivery_error"] as const)("%s previews the result without repeated status or Markdown markers", status => {
  const state = initialCoreRunState("chat"); state.status = status;
  state.resultText = status === "idle_timeout" ? "" : "*已完成* 侧栏修改，_尚未_ 发布。";
  state.errorText = status === "delivery_error" ? "安装包上传失败。" : "";
  state.idleTimeoutMinutes = 30;
  const card = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
  const body = preview([card], "error", "发布准备", "CC1", true);
  expect(body).not.toMatch(/[_*]|任务未完成：(已中断|无响应已自动终止|交付未完成)/);
  expect(body).toContain(status === "idle_timeout" ? "30 分钟无响应" : "已完成 侧栏修改，尚未 发布。");
});
test("table structure and emphasis become a readable compact excerpt", () => {
  expect(preview([{ type: "text", text: "*注意*：_已经_ 保存；~~旧方案~~ 删除。\n\n| 项目 | 状态 |\n|---|---|\n| 侧栏 | 完成 |" }]))
    .toBe("「发布准备」 · CC1\n回复完成：注意：已经 保存；旧方案 删除。 项目 · 状态 侧栏 · 完成");
});
test.each([
  ["已更新 `*.ts` 和 `*.tsx` 的格式化规则。", "已更新 *.ts 和 *.tsx 的格式化规则。"],
  ["已更新 *.ts 和 *.tsx 文件。", "已更新 *.ts 和 *.tsx 文件。"],
  ["超时改为 `30 * 1000 * 60` 毫秒。", "超时改为 30 * 1000 * 60 毫秒。"],
  ["面积 = 2 * 3 * 4 = 24。", "面积 = 2 * 3 * 4 = 24。"],
  ["读取 `__init__.py` 和 `_private_` 变量。", "读取 __init__.py 和 _private_ 变量。"],
  ["**已修复 `*.ts`**；[`file.ts`](/private/path)；`<b>`；\uE0000\uE001", "已修复 *.ts；file.ts；<b>；\uE0000\uE001"],
  ["运行 `npm test` - 全部通过。", "运行 npm test - 全部通过。"],
  ["设置 `MAX` # 默认 10。", "设置 MAX # 默认 10。"],
  ["| 文件 | 状态 |\n|---|---|\n| `src/a.ts` | 已修改 |\n| `src/b.ts` | 已删除 |", "文件 · 状态 src/a.ts · 已修改 src/b.ts · 已删除"],
])("literal technical text survives emphasis formatting: %s", (text, expected) => {
  expect(preview([{ type: "text", text }])).toBe(`「发布准备」 · CC1\n回复完成：${expected}`);
});
