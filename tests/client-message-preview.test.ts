import { describe, expect, it } from "vitest";
import { messagePreview } from "../client/src/message-preview.js";
import type { Message } from "../src/client-protocol/index.js";

const message = (blocks: Message["blocks"]): Message => ({ id: "message", conversationId: "chat", authorId: "bot", authorType: "bot", status: "complete", version: 1, createdAt: 0, blocks });

describe("rich reference projection", () => {
  it("keeps Markdown and nested attachments while leaving folded process details and actions inert", () => {
    const markdown = "| Day | Weather |\n| --- | --- |\n| Mon | Sunny |\n\n- Bring a coat\n\n```js\nconst day = 1;\n```";
    const source = message([
      { type: "card", title: "Report [draft]", elements: [
        { type: "columns", children: [{ type: "column", children: [{ type: "markdown", text: markdown }] }] },
        { type: "button", text: "Confirm", actionId: "approve", url: "https://example.com/approve" },
        { type: "collapsible", text: "Process", children: [{ type: "markdown", text: "Folded internal details" }, { type: "image", attachmentId: "image", text: "Chart" }] },
      ] },
      { type: "image", attachmentId: "image", title: "Chart" },
      { type: "file", attachmentId: "file", name: "report.txt", size: 39, mime: "text/plain" },
      { type: "audio", attachmentId: "voice" },
    ]);
    const before = structuredClone(source), preview = messagePreview(source);
    expect(preview.text).toContain(markdown);
    expect(preview.text).toContain("Report \\[draft\\]");
    expect(preview.text).toContain("Confirm");
    expect(preview.text).not.toContain("Folded internal details");
    expect(JSON.stringify(preview)).not.toContain("https://example.com/approve");
    expect(preview.attachments).toEqual([{ id: "image", type: "image", name: "Chart" }, { id: "file", type: "file", name: "report.txt", mime: "text/plain", size: 39 }, { id: "voice", type: "audio" }]);
    expect(preview.truncated).toBe(false);
    expect(source).toEqual(before);
  });

  it("bounds huge history previews without dropping the attachment after a long text block", () => {
    const source = message([{ type: "text", text: "正文".repeat(100_000) }, { type: "file", attachmentId: "file", name: "complete.pdf", size: 1024, mime: "application/pdf" }]);
    const preview = messagePreview(source);
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBeLessThanOrEqual(16_000);
    expect(preview.attachments[0]?.name).toBe("complete.pdf");
    expect(source.blocks[0]).toEqual({ type: "text", text: "正文".repeat(100_000) });
  });
});
