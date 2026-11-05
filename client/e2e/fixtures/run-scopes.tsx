import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { HubConnection } from "../../src/connection.js";
import { anyRun, type RunEntry, type RunSummary } from "../../../src/client-protocol/run.js";
import type { Block, Message } from "../../../src/client-protocol/index.js";
import { MessageContent } from "../../src/Content.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";

const entries: RunEntry[] = Array.from({ length: 42 }, (_, index) => ({
  seq: index + 1, revision: 1, at: Date.now(), kind: index % 3 === 0 ? "thinking" : index % 3 === 1 ? "tool" : "text", status: index === 1 ? "error" : "done",
  name: index % 3 === 1 ? "Read" : undefined, text: `公开步骤 ${index + 1}`, output: index % 3 === 1 ? `工具回执 ${index + 1}` : undefined,
  scope: index % 2 === 0 ? { kind: "subagent", id: "child-1", label: "核对报告", parentId: "background-1", parentCallId: "agent-call-1" } : { kind: "background", id: "background-1", label: "资料检索", parentCallId: "background-call-1" },
}));
const params = new URLSearchParams(location.search);
const history = params.has("history"), historicalEnd = Date.now() - 86_400_000;
const urls: string[] = [], sent: unknown[] = [];
let withheld = false;
const connection = {
  identity: { hubPublicKey: "fixture", deviceId: "scopes" },
  state: { status: "online", runScopesAvailable: !params.has("rollback"), bots: [{ id: "alpha", online: true }] },
  subscribe: () => () => undefined,
  stopReceipt: () => ({}),
  send: async (message: unknown) => { sent.push(message); },
  http: async (url: string) => {
    urls.push(url); const query = new URL(url, "https://fixture.test").searchParams;
    if (query.get("scopes") !== "1") throw new Error("scope negotiation missing");
    const after = Number(query.get("after") || 0), search = query.get("q") || "";
    const selected = withheld ? [] : entries.filter(e => e.seq > after && JSON.stringify(e).includes(search));
    return { entries: selected.slice(0, 40), next: selected.length > 40 ? selected[39].seq : null, expired: false, files: [] };
  },
} as unknown as HubConnection;
const initial: RunSummary = { version: 1, id: "background-run", revision: 1, phase: "working", count: 14, completed: 13, failed: 1, startedAt: Date.now(), updatedAt: Date.now(), truncated: false };
const block = (scoped: boolean): Extract<Block, { type: "card" }> => ({ type: "card", elements: [{ type: "markdown", text: "Status" }, ...(scoped && !params.has("child") ? [{ type: "markdown" as const, id: "background_context", text: "后台任务回报 · 这是关联请求的后续通知。" }] : []), { type: "markdown", text: scoped ? "后台公开正文" : "前台正在处理" }], extra: { ...(scoped && !params.has("child") ? { backgroundTask: { version: 1, origin: "bound" } } : {}), [scoped ? "scopedRun" : "nativeRun"]: JSON.parse(JSON.stringify({ ...initial, id: scoped ? "background-run" : "foreground-run" })) } });
function Fixture() {
  const [finishedAt, finish] = useState<number | undefined>(history ? historicalEnd : undefined);
  const [pending, setPending] = useState<boolean | undefined>(undefined);
  const [unavailable, setUnavailable] = useState(false);
  Object.assign(window, { runScopesFixture: { urls, sent, finish: () => { withheld = true; finish(Date.now()); setPending(true); }, deliver: () => { withheld = false; }, confirm: () => { withheld = false; setPending(false); }, fail: () => { withheld = true; finish(Date.now()); setPending(false); setUnavailable(true); } } });
  return <>{[true, false].map(scoped => {
  const current = block(scoped), message = { id: scoped ? "background-message" : "foreground-message", conversationId: "chat", authorId: "alpha", authorType: "bot", status: scoped ? "complete" : "streaming" } as Message;
  const run = anyRun(current)!;
  if (finishedAt !== undefined && scoped) { run.phase = "done"; run.endedAt = finishedAt; message.status = "complete"; }
  if (scoped && pending !== undefined) current.extra!.scopedJournal = { runId: run.id, revision: run.revision, pending };
  if (unavailable && scoped) run.detailsUnavailable = true;
  current.extra![scoped ? "scopedRun" : "nativeRun"] = JSON.parse(JSON.stringify(run));
  return <MessageContent key={message.id} message={{ ...message, createdAt: Date.now(), blocks: [current] }} connection={connection}/>;
})}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
