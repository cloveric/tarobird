import { addPassiveAttachments } from "./passive-attachments.js";
import { createRoot } from "react-dom/client";
import { MessageContent } from "../../src/Content.js";
import type { HubConnection } from "../../src/connection.js";
import { ClientCache } from "../../src/storage.js";
import type { Block, Message } from "../../../src/client-protocol/index.js";
import fixtures from "./generated-cards/index.json";
import "../../src/styles.css";
import "katex/dist/katex.min.css";

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get("theme") === "dark" ? "dark" : "light";
const layout: Block = { type: "card", title: "布局检查", template: "blue", layout: { padding: "16px", verticalSpacing: "18px" }, elements: [
  { type: "columns", layout: { flexMode: "none", columnSpacing: "12px", verticalAlign: "center" }, children: [
    { type: "column", layout: { weight: 2, height: "120px", verticalAlign: "center", horizontalAlign: "center", background: "grey" }, children: [{ type: "markdown", text: "宽栏" }] },
    { type: "column", layout: { weight: 1 }, children: [{ type: "markdown", text: "注释小字", layout: { textSize: "notation", textColor: "grey" } }] },
  ] },
  { type: "collapsible", text: "展开内容", open: true, layout: { border: { color: "grey", corner_radius: "8px" }, verticalSpacing: "14px" }, children: [{ type: "markdown", text: "第一项" }, { type: "markdown", text: "第二项" }] },
] };
const table = "| 项目 | 结果 |\n|---|---|\n| 数据 | 完成 |\n\n";
const cases = [...fixtures, { name: "layout", blocks: [layout] }, { name: "long_answer", blocks: [{ type: "text", text: Array.from({ length: 150 }, (_, i) => `段落 ${i + 1}：这是用于检查长回答排版的本地样本。\n\n`).join("") }] }, { name: "multi_table", blocks: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `### 表格 ${i + 1}\n\n${table}`).join("") }] }];
const selected = cases.find((entry) => entry.name === query.get("case")) ?? cases[0];
const connection = {
  cache: new ClientCache("tarocub-visual-fixture"),
  identity: { deviceId: "visual-preview", hubPublicKey: "visual-preview" },
  state: { status: "online" },
  subscribe: () => () => undefined,
  send: async () => undefined,
  blob: async (id: string) => {
    const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d")!; ctx.fillStyle = id.endsWith("1") ? "#dbe7ff" : "#e1f3df"; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#3370ff"; ctx.fillRect(40, 40, 80, 100); ctx.fillStyle = "#34a853"; ctx.beginPath(); ctx.arc(230, 90, 40, 0, Math.PI * 2); ctx.fill();
    return await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/png"));
  },
} as unknown as HubConnection;
addPassiveAttachments(connection);
const message: Message = { id: "message_visual", conversationId: "conversation_visual", authorType: "bot", authorId: "fixture", blocks: selected.blocks as Block[], status: "complete", version: 1, createdAt: 0 };
createRoot(document.getElementById("root")!).render(<main style={{ padding: 16, maxWidth: 752, margin: "auto" }}><p style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>客户端本地样本 · {selected.name} · 非飞书截图</p><MessageContent message={message} connection={connection}/></main>);
