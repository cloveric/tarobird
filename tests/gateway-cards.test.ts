import { recordCardVisual } from "./helpers/card-visual.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderCoreConfigCard } from "../src/core/config-card.js";
import { renderCoreBoardTaskCard } from "../src/core/board-card.js";
import { renderCoreStatusCard, renderCoreResumeScanCard } from "../src/core/command-cards.js";
import { renderCoreArchiveSummaryCard } from "../src/core/files.js";
import { requestCoreApproval } from "../src/core/card-actions.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreChannelLike } from "../src/core/types.js";
import { describe, expect, it, vi } from "vitest";
import { blocksText, type CardElement } from "../src/client-protocol/index.js";
import { translateCard, type TranslationWarning } from "../src/gateway/card-translator.js";
import { initialCoreRunState, renderCoreRunCard, renderCoreRunCardCompact, renderCoreRunCardMinimal, renderCoreReminderCard, renderCoreApprovalCard, renderCoreQueueWaitCard, renderCoreQueueCancelledCard, renderCoreNotificationCard, renderCoreContinuationCard } from "../src/core/card-renderer.js";
import { channelProfile, withChannelProfile } from "../src/gateway/platform-profile.js";
import { applyCoreEngineEvent, cleanCardText } from "../src/core/card-renderer.js";
import { deliverCoreResponse } from "../src/core/delivery.js";
import { renderLarkAccountCard } from "../src/core/account-card.js";

describe("Gateway card translation", () => {
  it("keeps CommonMark quote emphasis repairs in the App without changing inline or fenced code", () => {
    const text = '卖方主张**“先支付”**，再办理。\n\n`**“原样”**`\n\n~~~text\n**“原样”**\n~~~';
    expect(withChannelProfile("gateway", () => cleanCardText(text))).toBe(text.replace('**“先支付”**', '“**先支付**”'));
  });
  it("preserves App headings, single-line math and code through streaming and final cards", () => {
    const text = String.raw`## 交付检查

### 计算依据

$$\frac{a}{b}$$

变化为 $\Delta x \approx 2$。

~~~ts
const title = "# Keep code literal";
~~~`;
    let state = applyCoreEngineEvent(initialCoreRunState("app:formatting"), { type: "assistant_text", text });
    const live = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
    const streamed = live.elements.find(element => element.text === text);
    expect(streamed?.id).toBeTruthy();
    state = applyCoreEngineEvent(state, { type: "result", text });
    const final = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
    expect(final.elements.find(element => element.text === text)?.id).toBe(streamed!.id);
    const feishu = withChannelProfile("feishu", () => translateCard(renderCoreRunCard(state)));
    const legacy = feishu.elements.map(element => element.text ?? "").join("\n");
    expect(legacy).toContain("**交付检查**");
    expect(legacy).not.toContain("$$\\frac");
    expect(legacy).toContain('const title = "# Keep code literal";');
  });
  it("keeps the matching streamed answer identity when Gateway folds the process", () => {
    let state = initialCoreRunState("lark:test");
    state = { ...state, goalObjective: "Keep the answer readable" };
    state = applyCoreEngineEvent(state, { type: "thinking", text: "Check the source first." });
    state = applyCoreEngineEvent(state, { type: "assistant_text", text: "I will check the source." });
    state = applyCoreEngineEvent(state, { type: "tool_use", toolName: "Read", toolUseId: "read_1", toolInput: {} });
    state = applyCoreEngineEvent(state, { type: "tool_result", toolUseId: "read_1", output: "Source checked." });
    const prefix = "The answer remains in the same rendered paragraph.";
    state = applyCoreEngineEvent(state, { type: "assistant_text", text: prefix });
    const live = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
    const streamed = live.elements.find(element => element.text === prefix)!;
    expect(streamed.id).toBeTruthy();
    const result = `${prefix}\n\nThe final suffix is also complete.`;
    state = applyCoreEngineEvent(state, { type: "result", text: result });
    const final = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
    expect(final.elements.find(element => element.text === result)?.id).toBe(streamed.id);
    expect(final.elements.filter(element => element.id === streamed.id)).toHaveLength(1);
    // The Gateway optimization must not change CardKit's terminal identity.
    const feishu = withChannelProfile("feishu", () => translateCard(renderCoreRunCard(state)));
    expect(feishu.elements.find(element => element.text === result)?.id).toBeUndefined();
  });
  it("does not reuse unrelated narration as the final Gateway answer", () => {
    let state = initialCoreRunState("lark:test");
    state = applyCoreEngineEvent(state, { type: "assistant_text", text: "I am still checking the source." });
    state = applyCoreEngineEvent(state, { type: "result", text: "A different final answer." });
    const final = withChannelProfile("gateway", () => translateCard(renderCoreRunCard(state)));
    expect(final.elements.find(element => element.text === "A different final answer.")?.id).toBeUndefined();
  });
  it("preserves actual card constructors as golden protocol fixtures", () => {
    const state = initialCoreRunState("lark:test");
    const examples = {
      running: renderCoreRunCard(state),
      goal_running: renderCoreRunCard({ ...state, goalObjective: "完成示例任务" }),
      goal_completed: renderCoreRunCard({ ...state, goalObjective: "完成示例任务", status: "done", resultText: "目标完成" }),
      completed: renderCoreRunCard({ ...state, status: "done", resultText: "Complete" }),
      error: renderCoreRunCard({ ...state, status: "error", errorText: "Example error" }),
      interrupted: renderCoreRunCard({ ...state, status: "interrupted" }),
      compact: renderCoreRunCardCompact(state), minimal: renderCoreRunCardMinimal(state),
      reminder: renderCoreReminderCard("Example reminder"),
      approval: renderCoreApprovalCard({ requestId: "example_request", toolName: "ExampleTool", toolInput: { command: "echo example" } }),
      queue: renderCoreQueueWaitCard({ conversationKey: "lark:test", waitedMs: 1000 }),
      cancelled: renderCoreQueueCancelledCard(),
      notification: renderCoreNotificationCard("Notification", "Example notification"),
      continuation: renderCoreContinuationCard("More text", 1, 2),
      account: renderLarkAccountCard({ appId: "cli_example_fixture", stateDir: "/workspace/instance", instanceName: "Fixture", locale: "zh" }),
    };
    for (const [name, card] of Object.entries(examples)) { const translated = translateCard(card); expect(translated).toMatchSnapshot(name); recordCardVisual(name, translated); }
  });
  it("translates open_url, url and multi_url buttons into App link targets", () => {
    const card = { schema: "2.0", body: { elements: [
      { tag: "button", type: "primary", text: { tag: "plain_text", content: "Open console" }, behaviors: [{ type: "open_url", default_url: "https://example.test/console" }] },
      { tag: "button", text: { tag: "plain_text", content: "Docs" }, url: "https://example.test/docs" },
      { tag: "button", text: { tag: "plain_text", content: "Report" }, multi_url: { url: "https://example.test/report" } },
    ] } };
    expect(translateCard(card).elements).toMatchObject([
      { type: "button", text: "Open console", style: "primary", url: "https://example.test/console", extra: { behaviors: [{ type: "open_url", default_url: "https://example.test/console" }] } },
      { type: "button", text: "Docs", style: "default", url: "https://example.test/docs" },
      { type: "button", text: "Report", style: "default", url: "https://example.test/report" },
    ]);
  });
  it("captures choice and authored-card constructors through actual tool delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "card-delivery-golden-"));
    try {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "zh" }));
      const examples = {
        choice: { name: "lark.choice", payload: { title: "选择执行方向", prompt: "下一步怎么做？", options: [{ label: "继续", value: "continue", description: "继续验证当前结果" }, { label: "改写", value: "rewrite" }] } },
        authored_card: { name: "lark.card", payload: { title: "示例卡片", body: "**检查结果**\n已经保存", actions: [{ label: "继续", value: "continue" }] } },
      };
      for (const [name, tool] of Object.entries(examples)) {
        const cards: unknown[] = [];
        const channel: CoreChannelLike = { send: async (_to, input) => { if (typeof input === "object" && input && "card" in input) cards.push(input.card); return { messageId: "card_fixture" }; }, stream: async () => ({ messageId: "unused" }), updateCard: async (_id, card) => { cards.push(card); }, downloadResource: async () => Buffer.alloc(0) };
        await withChannelProfile("gateway", () => deliverCoreResponse({ channel, runtime: createCoreServiceRuntime(), stateDir: root, chatId: "fixture", conversationKey: "lark:fixture", bridgeChatType: "private", bridgeChatId: 42, text: `[tool:${JSON.stringify(tool)}]` }));
        expect(cards.length).toBeGreaterThan(0); const translated = cards.map((card) => translateCard(card)); expect(JSON.stringify(translated)).toContain('"type":"button"'); expect(translated).toMatchSnapshot(name); recordCardVisual(name, translated);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("captures the actual image-batch constructor with titles and opaque image keys", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "image-card-golden-")); const cards: unknown[] = []; let image = 0;
    const channel: CoreChannelLike = { profile: "gateway", send: async (_to, input) => { if (typeof input === "object" && input && "card" in input) cards.push(input.card); return { messageId: "card_fixture" }; }, stream: async () => ({ messageId: "unused" }), downloadResource: async () => Buffer.alloc(0), uploadImage: async () => `attachment_image_${++image}` };
    try {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", locale: "zh", workspacePath: root }));
      const images = [1, 2].map((index) => ({ path: path.join(root, `${index}.png`), caption: `图 ${index} · 示例` }));
      for (const img of images) await writeFile(img.path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=", "base64"));
      await withChannelProfile("gateway", () => deliverCoreResponse({ channel, runtime: createCoreServiceRuntime(), stateDir: root, workspaceOverride: root, chatId: "fixture", text: `[tool:${JSON.stringify({ name: "send.batch", payload: { images } })}]` }));
      expect(image).toBe(2); expect(cards).toHaveLength(1); expect(translateCard(cards[0])).toMatchSnapshot("image_batch"); recordCardVisual("image_batch", translateCard(cards[0]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("translates actual config, board, status, resume and archive callbacks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "card-goldens-"));
    const context = { stateDir: root, conversationKey: "lark:fixture", bridgeChatType: "private" as const, larkChatId: "fixture", bridgeChatId: 42, locale: "zh" as const };
    const walk = (elements: CardElement[]): CardElement[] => elements.flatMap((e) => [e, ...walk(e.children ?? [])]);
    try {
      await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "claude", locale: "zh", workspacePath: "/workspace/example" }));
      const cards: Record<string, unknown> = {
        config: await renderCoreConfigCard(context), status: renderCoreStatusCard({ ...context, markdown: "**状态**：就绪" }),
        resume: renderCoreResumeScanCard({ ...context, kind: "claude", sessions: [{ sessionId: "session_fixture", displayName: "示例会话", dirName: "example", workspacePath: "/workspace/example", modifiedAt: new Date(Date.now() - 300_000) }] }),
        archive: renderCoreArchiveSummaryCard({ ...context, uploadId: "upload_fixture", data: { archiveName: "example.zip", fileCount: 2, keyFiles: ["README.md"], topExtensions: [[".md", 2]], treeLines: ["README.md", "notes.md"] } }),
      };
      for (const status of ["todo", "ready", "running", "review", "blocked", "done"] as const) cards[`board_${status}`] = renderCoreBoardTaskCard({ ...context, markdown: "**任务**\n验证结果", task: { id: "task_fixture", title: "示例任务", boardSlug: "default", acceptanceCriteria: [], priority: "normal", labels: [], checklist: [], artifacts: [], review: { required: false }, dependencies: [], runs: [], execution: {}, revision: 1, retryCount: 0, status, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", createdBy: { chatId: 42, userId: 7, conversationKey: context.conversationKey } } });
      for (const [name, raw] of Object.entries(cards)) {
        const normalized = JSON.parse(JSON.stringify(raw, (key, value) => key === "revision" && typeof value === "string" ? "render_revision_fixture" : value));
        const card = translateCard(normalized); expect(card).toMatchSnapshot(name); recordCardVisual(name, card);
        for (const button of walk(card.elements).filter((e) => e.type === "button")) expect(button.value).toMatchObject({ cctb_lark: expect.any(String) });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it.each(["claude", "kimi", "deepseek"] as const)("captures the actual %s question form with its submit callback", async (engine) => {
    const runtime = createCoreServiceRuntime(); const abort = new AbortController(); let source: unknown;
    const channel: CoreChannelLike = { send: async (_to, input) => { source = (input as { card: unknown }).card; return { messageId: "card_fixture" }; }, stream: async () => ({ messageId: "unused" }), downloadResource: async () => Buffer.alloc(0), updateCard: async () => undefined };
    const pending = withChannelProfile("gateway", () => requestCoreApproval({ channel, runtime, chatId: "fixture", abortSignal: abort.signal, request: { engine, toolName: "AskUserQuestion", toolInput: { questions: [{ header: "选择", question: "选择功能", multiSelect: true, minSelections: 1, maxSelections: 2, options: [{ label: "搜索" }, { label: "导出" }] }] } } }));
    try { await vi.waitFor(() => expect(source).toBeDefined());
      const id = [...runtime.pendingApprovals.keys()][0]!; const normalized = JSON.parse(JSON.stringify(source).replaceAll(id, "request_fixture"));
      const card = translateCard(normalized); expect(card).toMatchSnapshot(`ask_${engine}`); recordCardVisual(`ask_${engine}`, card);
      expect(card.elements[0]?.children?.find((e) => e.name === "askq_submit")?.value).toMatchObject({ cctb_lark: "ask_user_question", action: "form_submit", requestId: "request_fixture" });
      expect(card.elements[0]?.extra?.tarocub_questions).toMatchObject({ version: 1, requestId: "request_fixture", questions: [{ question: "选择功能", multiSelect: true, minSelections: 1, maxSelections: 2, allowFreeText: engine !== "kimi" }] });
    } finally { abort.abort(); await pending; }
  });
  it("carries layout, callbacks, form limits, unknown properties and elements without silent loss", () => {
    const warnings: TranslationWarning[] = [];
    const result = translateCard({ header: { title: { content: "Approval" }, template: "orange" }, body: { padding: "12px", elements: [
      { tag: "column_set", flex_mode: "none", column_spacing: "8px", columns: [{ tag: "column", weight: 2, vertical_align: "center", elements: [{ tag: "markdown", content: "Note", text_size: "notation", text_color: "grey" }] }] },
      { tag: "collapsible_panel", expanded: true, header: { title: { content: "Tools" }, icon: { token: "down" } }, border: { color: "grey" }, elements: [] },
      { tag: "form", name: "form", elements: [{ tag: "multi_select_static", name: "choices", min_selected_count: 1, max_selected_count: 2, options: [{ text: { content: "One" }, value: "1" }], initial_options: ["1"] }, { tag: "button", type: "danger", text: { content: "Run" }, value: { action: "approve", id: "example" }, confirm: { title: { content: "Confirm" }, text: { content: "Continue?" } } }] },
      { tag: "future", content: "Fallback", custom: { keep: true } },
    ] } }, (w) => warnings.push(w));
    expect(result.template).toBe("orange"); expect(result.layout?.padding).toBe("12px");
    expect(result.elements[0]?.layout).toEqual({ flexMode: "none", columnSpacing: "8px" });
    const select = result.elements[2]?.children?.[0] as CardElement;
    expect(select).toMatchObject({ type: "select", min: 1, max: 2, multiple: true, extra: { initial_options: ["1"] } });
    expect(result.elements[2]?.children?.[1]).toMatchObject({ type: "button", style: "danger", value: { action: "approve", id: "example" }, confirm: { title: "Confirm", text: "Continue?" } });
    expect(warnings.some((w) => w.name === "future" && w.kind === "unknown_element")).toBe(true);
    expect(blocksText([result])).toContain("Fallback");
  });
  it("keeps concurrent profile contexts independent", async () => {
    await Promise.all([withChannelProfile("gateway", async () => { await new Promise((resolve) => setTimeout(resolve, 10)); expect(channelProfile()).toBe("gateway"); }), withChannelProfile("feishu", async () => { await Promise.resolve(); expect(channelProfile()).toBe("feishu"); })]);
    expect(channelProfile()).toBe("feishu");
  });
});

it("retains root card layout and gives explicit body layout precedence", () => {
  const card = translateCard({ padding: "8px", direction: "horizontal", body: { direction: "vertical", elements: [{ tag: "markdown", content: "**Answer**\n\n```ts\nconst n = 1;\n```" }] } });
  expect(card.layout).toMatchObject({ padding: "8px", direction: "vertical" });
  expect(card.elements[0]?.text).toContain("```ts");
});
