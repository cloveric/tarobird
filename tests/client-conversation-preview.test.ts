import { describe, expect, it } from "vitest";
import { conversationBlocksPreview, conversationPreview } from "../client/src/conversation-preview.js";
import { blocksText, type Block } from "../src/client-protocol/index.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";

describe("conversation navigation excerpts", () => {
  it("uses card summaries only for navigation and keeps search/copy content unchanged", () => {
    const blocks: Block[] = [{ type: "card", title: "后台任务", summary: "正在核对两份报告", elements: [{ type: "markdown", text: "完整运行记录" }] }];
    expect(conversationBlocksPreview(blocks)).toBe("正在核对两份报告");
    expect(blocksText(blocks)).toBe("后台任务\n完整运行记录");
    expect(blocks[0]).toMatchObject({ summary: "正在核对两份报告" });
  });
  it.each([
    [false, "正在压缩上下文"],
    [true, "正在整理上下文摘要"],
  ] as const)("preserves active context maintenance in navigation (checkpoint=%s)", (checkpoint, title) => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "context_compaction", id: "maintenance", status: "started", checkpoint });
    const card: Extract<Block, { type: "card" }> = {
      type: "card", title: "任务", summary: "任务处理中", elements: [{ type: "markdown", text: "完整正文" }],
      extra: { nativeRun: summarizeRun(record, "running") },
    };
    const original = structuredClone(card);
    expect(conversationBlocksPreview([card])).toBe(title);
    expect(blocksText([card])).toBe("任务\n完整正文");
    expect(card).toEqual(original);

    recordRunEvent(record, { type: "context_compaction", id: "maintenance", status: "completed", checkpoint });
    card.extra = { nativeRun: summarizeRun(record, "running") };
    expect(conversationBlocksPreview([card])).toBe("任务处理中");
    recordRunEvent(record, { type: "assistant_text", text: "报告已完成。" });
    card.summary = "报告已完成。";
    card.extra = { nativeRun: summarizeRun(record, "done") };
    expect(conversationBlocksPreview([card])).toBe("报告已完成。");
  });
  it("does not revive stale, scoped or malformed maintenance metadata", () => {
    const record = createRunRecord();
    recordRunEvent(record, { type: "context_compaction", id: "maintenance", status: "started" });
    const run = summarizeRun(record, "running");
    for (const extra of [
      { nativeRun: { ...run, phase: "done" } },
      { nativeRun: { ...run, phase: "stopping" } },
      { nativeRun: { ...run, current: { ...run.current, status: "done" } } },
      { nativeRun: { ...run, current: { ...run.current, kind: "tool" } } },
      { nativeRun: { current: run.current } },
      { scopedRun: run },
    ]) {
      expect(conversationBlocksPreview([{ type: "card", summary: "保留卡片摘要", elements: [], extra }])).toBe("保留卡片摘要");
    }
    recordRunEvent(record, { type: "assistant_text", text: "继续处理。" });
    expect(conversationBlocksPreview([{ type: "card", summary: "继续处理。", elements: [], extra: { nativeRun: summarizeRun(record, "running") } }])).toBe("继续处理。");
  });
  it("falls back for blank summaries, hides queue status and bounds a mixed preview", () => {
    const blocks: Block[] = [
      { type: "text", text: "已完成" },
      { type: "card", title: "详情", summary: "  ", elements: [{ type: "markdown", text: "两项检查" }] },
      { type: "card", summary: "不属于用户正文", elements: [], extra: { promptQueue: true } },
      { type: "card", summary: "结果".repeat(100), elements: [] },
    ];
    expect(conversationBlocksPreview(blocks)).toBe(("已完成\n详情\n两项检查\n" + "结果".repeat(100)).slice(0, 120));
  });
  it("counts untitled images once instead of repeating raw markers", () => {
    const image = (attachmentId: string, title?: string): Block => ({ type: "image", attachmentId, ...(title ? { title } : {}) });
    expect(conversationBlocksPreview([{ type: "text", text: "三张参考图" }, image("a"), image("b"), image("c")])).toBe("三张参考图\n[3 张图片]");
    expect(conversationBlocksPreview([image("a")])).toBe("[图片]");
    expect(conversationBlocksPreview([image("a", "封面"), image("b")])).toBe("封面\n[图片]");
    // Search, copy and Bot-facing text keep the protocol marker.
    expect(blocksText([image("a")])).toBe("[image]");
  });
  it("keeps image-first previews before long prose and does not mutate original blocks", () => {
    const blocks: Block[] = [
      { type: "image", attachmentId: "a", title: "  " },
      { type: "text", text: "详细说明".repeat(80) },
      { type: "image", attachmentId: "b" },
    ];
    const original = structuredClone(blocks);
    expect(conversationBlocksPreview(blocks)).toBe(("[2 张图片]\n" + "详细说明".repeat(80)).slice(0, 120));
    expect(blocks).toEqual(original);
    expect(conversationBlocksPreview([
      { type: "image", attachmentId: "a" },
      { type: "image", attachmentId: "b", title: "封面" },
    ])).toBe("[图片]\n封面");
  });
  it("shows completion and reply prose without paired bold markers", () => {
    expect(conversationPreview("**已完成** 已收到。**下一步**：查看文件。")).toBe("已完成 已收到。下一步：查看文件。");
  });
  it("uses link labels and image descriptions without leaking Markdown syntax", () => {
    expect(conversationPreview('See [report](https://example.test/a) and ![chart](https://example.test/b "Chart") with *notes*.'))
      .toBe("See report and chart with notes.");
    expect(conversationPreview('`[label](url)` **unfinished')).toBe('[label](url) **unfinished');
  });
  it("preserves URLs, code, unfinished delimiters and literal identifiers", () => {
    const url = "https://example.org/**asset**?name=a_b";
    expect(conversationPreview(`**参考** ${url}`)).toBe(`参考 ${url}`);
    for (const text of ["**尚未闭合", "a_b * 2", "client_aaaaaaaaaaaaaaaaaaaaaaaa"]) {
      expect(conversationPreview(text)).toBe(text);
    }
    expect(conversationPreview("`**literal**`")).toBe("**literal**");
    expect(conversationPreview("```js\na ** b\n```")).toBe("a ** b");
  });
  it("turns tables and block framing into readable excerpts without losing the matched text", () => {
    expect(conversationPreview("## 计划\n\n| 事项 | 状态 |\n| --- | :---: |\n| 项目研究 | 已完成 |\n\n> 请检查\n- [x] 中文\n```ts\nconst ready = true;\n```"))
      .toBe("计划 事项 · 状态 项目研究 · 已完成 请检查 中文 const ready = true;");
    expect(conversationPreview("**结论** `a_b ** c` https://example.org/**asset**")).toBe("结论 a_b ** c https://example.org/**asset**");
  });
  it.each([
    ["run `npm test` - then commit", "run npm test - then commit"],
    ["先执行 `make` - 再部署", "先执行 make - 再部署"],
    ["endpoints: `/a` - `/b`", "endpoints: /a - /b"],
    ["value `5` + 3", "value 5 + 3"],
    ["`cmd` > out", "cmd > out"],
    ["[report](https://example.test) # 2", "report # 2"],
    ["![图](https://example.test) + 说明", "图 + 说明"],
    ["`cmd` | output |", "cmd | output |"],
    ["`cmd`\n- next\n> result", "cmd next result"],
    ["```text\n# literal\n- literal\n```\n## 标题\n- 内容", "# literal - literal 标题 内容"],
  ])("keeps original line boundaries around protected fragments: %s", (source, expected) => {
    expect(conversationPreview(source)).toBe(expected);
  });
});
