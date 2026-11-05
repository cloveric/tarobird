import { createRoot } from "react-dom/client";
import { MessageContent } from "../../src/Content.js";
import { setLocale } from "../../src/i18n.js";
import type { HubConnection } from "../../src/connection.js";
import type { Message, Json } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
const query = new URLSearchParams(location.search), listeners = new Set<() => void>(), actions: unknown[] = [];
setLocale(query.get("locale") === "en" ? "en" : "zh");
const terminalPalette = ["cli"].includes(query.get("theme") ?? "");
document.documentElement.dataset.theme = terminalPalette ? "light" : query.get("theme") ?? "light";
document.documentElement.dataset.palette = terminalPalette ? query.get("theme")! : "white-violet";
let state = { status: "online", bots: [{ id: "bot", online: 1 }] };
const connection = { get state() { return state; }, subscribe(fn: () => void) { listeners.add(fn); return () => listeners.delete(fn); }, async send(action: unknown) { actions.push(action); } } as unknown as HubConnection;
const root = createRoot(document.getElementById("root")!);
function publish(phase = "queued", status: Message["status"] = "complete") {
  const message: Message = { id: "notice", replyTo: "task", conversationId: "chat", authorType: "bot", authorId: "bot", status, version: 1, createdAt: 1,
    blocks: [{ type: "card", layout: { padding: "8px 12px 8px 12px" }, extra: { schema: "2.0", config: { update_multi: true }, ...(query.has("legacy") ? {} : { appQueue: { version: 1, taskId: "task", conversationKey: "lark:chat", state: phase, at: 1 } as Json }) },
      elements: [{ type: "markdown", text: "Preparation detail" }, ...(phase === "queued" ? [{ type: "button" as const, id: "queued_turn_cancel", actionId: "cancel", text: "Cancel", value: { cctb_lark: "stop", conversationKey: "lark:chat", taskId: "task" } }] : [])] }] };
  root.render(<main style={{ padding: 12, width: Math.min(Number(query.get("width")) || 240, innerWidth) }}><MessageContent message={message} connection={connection}/></main>);
}
Object.assign(window, { queueFixture: { actions, publish, offline(value: boolean) { state = { ...state, status: value ? "offline" : "online" }; listeners.forEach(fn => fn()); } } });
publish(query.get("phase") ?? "queued");
