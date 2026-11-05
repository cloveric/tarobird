import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ClientCache } from "../../src/storage.js";
import type { HubConnection } from "../../src/connection.js";
import type { Message } from "../../../src/client-protocol/index.js";
import type { RunSummary } from "../../../src/client-protocol/run.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/expressive-themes.css";
import "../../src/cli-typography.css";
import "../../src/layout-density.css";
import "../../src/adhd-board.css";

// Production loads App (and its run/table styles) after the shell stylesheet.
const { MessageContent } = await import("../../src/Content.js");

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") ?? "light";
document.documentElement.dataset.palette = query.get("palette") ?? "white-violet";
document.body.style.overflow = "auto";
export const sample = `## 交付与检查

正文保留 **重点**、*强调* 和 \`report.ts\`。

### 代码示例

~~~ts
const title = "完整保留代码的格式、缩进与这一行很长的内容";
function greet(name: string) {
  return title + name;
}
~~~

> 保留原文的引用层次。

1. 检查段落与标题。
2. 检查列表：
   - 保留子项。
   - 不挤在一起。

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| report.ts | 已完成 | 已核对格式、缩进与长文本显示，手机可以独立横向查看表格。 |
| notes.md | 已完成 | 保留原来的内容。 |

公式：$E=mc^2$。

- [x] 已核对格式
- [ ] 等待发布

---

[查看来源](https://example.com/reference)`;
const connection = {
  cache: new ClientCache("tarobot-run-formatting-fixture"),
  identity: { deviceId: "fixture", hubPublicKey: "fixture" },
  state: { status: "online", bots: [{ id: "fixture", online: true }] },
  subscribe: () => () => undefined, send: async () => undefined,
  stopReceipt: () => ({ socket: 0, failures: 0 }),
  http: async () => ({ entries: [
    { seq: 1, revision: 1, kind: "thinking", status: "done", at: 1, text: sample },
    { seq: 2, revision: 1, kind: "tool", name: "Bash", status: "done", at: 2, input: JSON.stringify({ command: "printf 'line 1\\nline 2'" }, null, 2), output: '<script>notExecutable()</script>\n  keep indentation\n<img src="never-fetch">\n' + Array.from({ length: 80 }, (_, index) => `line ${index}`).join("\n") },
  ], next: null, expired: false, files: [] }),
} as unknown as HubConnection;
function Fixture() {
  const [done, setDone] = useState(true);
  const [reply, setReply] = useState(sample);
  Object.assign(window, { setFormattingReply: setReply });
  const native = query.get("mode") !== "legacy";
  const run: RunSummary = { version: 1, id: "formatting", revision: done ? 2 : 1, phase: done ? "done" : "answering", count: 2, completed: 2, failed: 0, startedAt: 1, updatedAt: 64001, ...(done ? { endedAt: 64001 } : {}), truncated: false };
  const message: Message = { id: "formatting", conversationId: "fixture", authorType: query.get("mode") === "user" ? "user" : "bot", authorId: "fixture", status: done ? "complete" : "streaming", version: 1, createdAt: 0, blocks: ["plain", "user"].includes(query.get("mode") ?? "") ? [{ type: "text", text: reply }] : [{ type: "card", extra: { config: { streaming_mode: true }, ...(native ? { nativeRun: run } : {}) }, elements: [
    { type: "markdown", text: done ? "**已完成**" : "**任务处理中…**" },
    { type: "markdown", id: "answer", text: reply },
    { type: "collapsible", text: "过程 · 1 步", children: [{ type: "markdown", text: sample }] },
  ] }] };
  return <main style={{ maxWidth: 760, margin: "20px auto", padding: "0 12px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}><strong>{native ? "新版运行回复" : "旧卡片"}</strong><button onClick={() => setDone(value => !value)}>{done ? "切换为运行中" : "切换为已完成"}</button></div>
    <article className={`message ${message.authorType}`} style={{ position: "relative" }}><div className="message-body"><MessageContent message={message} connection={connection}/></div></article>
  </main>;
}
createRoot(document.getElementById("root")!).render(query.has("compare") ? <main style={{ display: "flex", gap: 24, justifyContent: "center", padding: 20 }}>
  {["legacy", "native"].map(mode => <iframe key={mode} title={mode} src={`?mode=${mode}`} style={{ width: 390, height: 1100, border: "1px solid #e5e5e5", borderRadius: 12 }}/>) }
</main> : <Fixture/>);
