import React, { useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { HubConnection } from "../../src/connection.js";
import { useConversationHistory } from "../../src/use-conversation-history.js";
import { ConversationHistoryDialog, ConversationHistoryOrigin, ConversationHistoryStatus, HistoryExclusion } from "../../src/ConversationHistoryDialog.js";
import { HistoryForkMenu } from "../../src/ConversationHistoryActions.js";
import { MessageContextMenu } from "../../src/MessageContextMenu.js";
import { MessageActionSheet } from "../../src/MessageActions.js";
import { setLocale } from "../../src/i18n.js";
import { MessageContent } from "../../src/Content.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-im.css";
import "../../src/mobile-shell.css";

const query = new URLSearchParams(location.search), listeners = new Set<() => void>();
if (query.get("en")) setLocale("en");
const source = { id: "source", type: "direct", title: "研究计划", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
const c = Object.create(HubConnection.prototype);
c.identity = { hubPublicKey: "synthetic_host", publicKey: "synthetic_user", deviceId: "device" };
c.state = { cacheRevision: 0, status: "online", user: { id: "owner", role: "owner" }, bots: [{ id: "bot", name: "测试助手", engine: "fixture", online: 1 }], historyAvailable: !query.has("old"), avatars: [], outbox: 0 };
c.subscribe = notify => { listeners.add(notify); return () => listeners.delete(notify); };
c.update = () => { c.state = { ...c.state, cacheRevision: c.state.cacheRevision + 1 }; listeners.forEach(fn => fn()); };
c.refreshCache = c.update; c.refreshConversation = c.update; c.conversationRevision = () => c.state.cacheRevision;
const saved = JSON.parse(localStorage.getItem("fixture-history-server") ?? "{}");
const f = window.historyFixture = {
  connection: c, selected: "source", active: true, pendingMessages: false, localBusy: false, activity: "", mode: "normal", calls: [], posts: saved.posts ?? [], operations: saved.operations ?? {},
  snapshot: { supported: !query.has("unsupported"), revision: saved.revision ?? "revision_a", capabilities: { rewind: !query.has("whole"), fork: true, anchoredFork: !query.has("whole") } },
  conversations: saved.conversations ?? [source],
  messages: saved.messages ?? [
    { id: "user_a", conversationId: "source", authorId: "owner", authorType: "user", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "text", text: "第一条消息" }] },
    { id: "user_b", conversationId: "source", authorId: "owner", authorType: "user", status: "complete", version: 1, createdAt: 2, blocks: [{ type: "text", text: "从这一步开始重新考虑" }] },
    { id: "bot_b", conversationId: "source", authorId: "bot", authorType: "bot", status: "complete", version: 1, createdAt: 3, blocks: [{ type: "text", text: "这段回复保留可见" }, { type: "card", elements: [{ type: "button", text: "继续原任务", actionId: "resume_original" }] }] },
    { id: "unmapped", conversationId: "source", authorId: "owner", authorType: "user", status: "complete", version: 1, createdAt: 4, blocks: [{ type: "text", text: "没有原生锚点" }] },
  ],
  anchors: [{ id: "anchor_b", messageId: "user_b", rewind: true, fork: true, forkBoundary: "before-input" }],
  update: () => c.update(), setLocale,
};
function persist() { localStorage.setItem("fixture-history-server", JSON.stringify({ posts: f.posts, operations: f.operations, revision: f.snapshot.revision, messages: f.messages, conversations: f.conversations })); }
c.cache = {
  cursor: async () => f.projectedSeq ?? 10,
  operationRecord: async key => localStorage.getItem(`record:${key}`) ?? "",
  updateOperationIfMatches: async (key, old, next) => { if ((localStorage.getItem(`record:${key}`) ?? "") !== old) return false; localStorage.setItem(`record:${key}`, next); if (f.holdPersistence) await new Promise(resolve => { f.releasePersistence = resolve; }); return true; },
  clearOperationIfMatches: async (key, old) => { if (localStorage.getItem(`record:${key}`) === old) localStorage.removeItem(`record:${key}`); },
  seedConversation: async value => f.conversations.find(item => item.id === value.id) ?? value,
};
c.http = async (route, init) => {
  f.calls.push({ route, method: init?.method ?? "GET" });
  const [pathname, search = ""] = route.split("?");
  if (pathname === "/api/conversations") { if (f.directoryFailure) throw Error("directory_unavailable"); return f.conversations; }
  if (pathname.endsWith("/history/anchors")) return { anchors: f.anchors.filter(anchor => anchor.messageId === new URLSearchParams(search).get("messageId")) };
  if (pathname.endsWith("/history")) { if (f.snapshotFailure) throw Error("snapshot_unavailable"); return structuredClone(f.snapshot); }
  if (pathname.endsWith("/reconcile") && init?.method === "POST") {
    if (f.checkFailure) throw Error("receipt_unavailable");
    const body = JSON.parse(init.body);
    const result = f.operations[body.requestId] ?? { requestId: body.requestId, operationId: "cancelled_before_admission", state: "rejected", reason: "cancelled", sourceRevision: body.expectedRevision };
    f.operations[body.requestId] = result; persist(); return result;
  }
  if (pathname.includes("/history/operations/") && !init?.method) {
    const requestId = pathname.split("/operations/")[1];
    if (f.checkFailure) throw Error("receipt_unavailable");
    return f.operations[requestId];
  }
  if (pathname.endsWith("/history/operations") && init?.method === "POST") {
    const body = JSON.parse(init.body);
    if (f.operations[body.requestId]) return f.operations[body.requestId];
    f.posts.push(body);
    const result = { requestId: body.requestId, operationId: `operation_${f.posts.length}`, state: f.mode === "reject" ? "rejected" : "applied", sourceRevision: body.expectedRevision, resultingRevision: "revision_b" };
    if (f.mode === "reject") result.reason = "source_changed";
    else if (body.action.kind === "fork") {
      result.destinationConversationId = `fork_${f.posts.length}`;
      f.conversations.push({ ...source, id: result.destinationConversationId, title: body.action.title, historyOrigin: { operationId: result.operationId, sourceConversationId: "source", sourceRevision: body.expectedRevision, boundary: body.action.scope === "whole" ? "whole" : "before-input", ...(body.action.scope === "anchor" ? { sourceMessageId: "user_b" } : {}) } });
    } else {
      result.sourceEventSeq = 10;
      f.messages = f.messages.map(message => ["user_b", "bot_b"].includes(message.id) ? { ...message, historyContext: { excludedBy: result.operationId } } : message);
      f.snapshot.revision = "revision_b"; f.anchors = [];
    }
    f.operations[result.requestId] = result; persist();
    if (f.mode === "hold") await new Promise(resolve => { f.release = resolve; });
    if (f.mode === "unknown") throw Error("response_lost");
    return result;
  }
  throw Error("unexpected_fixture_route");
};
function App() {
  useSyncExternalStore(c.subscribe, () => c.state);
  const root = useRef<HTMLDivElement>(null), origin = useRef<HTMLElement | null>(null);
  const [sheet, setSheet] = useState<string>(), [draft, setDraft] = useState("保留的草稿");
  const conversation = f.conversations.find(value => value.id === f.selected) ?? source;
  const history = useConversationHistory({ connection: c, conversation, enabled: f.active, activity: f.activity, pendingMessages: f.pendingMessages, localBusy: f.localBusy, fallback: root, opened: value => { f.selected = value.id; c.update(); } });
  f.history = history;
  const phone = matchMedia("(max-width:760px)").matches;
  const message = f.messages.find(value => value.id === sheet);
  const actions = message ? history.messageActions(message) : undefined;
  return <div style={{ maxWidth: 700, margin: "auto", padding: 12 }}>
    <h1>{conversation.title}</h1><button id="refresh" onClick={history.refresh}>刷新状态</button><button id="back" onClick={() => { f.selected = "source"; c.update(); }}>返回原对话</button>
    <div className={phone ? "mobile-chat-action-list" : "desktop-menu"} style={{ position: "static" }}><HistoryForkMenu phone={phone} action={history.fork}/></div>
    <ConversationHistoryOrigin conversation={conversation} source={source} open={id => { f.selected = id; c.update(); }}/>
    <div ref={root} tabIndex={-1}>{f.selected === "source" && f.messages.map(message => <article key={message.id} data-message-id={message.id} tabIndex={0} style={{ padding: 14, borderBottom: "1px solid #aaa" }} onClick={event => { if (phone) { origin.current = event.currentTarget; history.inspect(message); setSheet(message.id); } }}><MessageContent message={message} connection={c}/><HistoryExclusion message={message}/></article>)}</div>
    <textarea aria-label="消息" value={draft} onChange={event => setDraft(event.target.value)}/><button disabled={history.sendBlocked}>发送</button>
    <ConversationHistoryStatus history={history}/><ConversationHistoryDialog history={history}/>
    <MessageContextMenu root={root} scope="source" enabled={!phone && f.selected === "source"} messages={f.messages} quoteBlocked={false} quote={() => {}} forward={() => {}} copy={() => {}} copyMessage={() => {}} opened={history.inspect} select={() => {}} remove={() => {}} deletionAvailable historyActions={history.messageActions}/>
    {message && <MessageActionSheet connection={c} message={message} meta="测试用户" quoteBlocked={false} canRetry={false} retryBlocked={false} returnFocus={origin} close={() => setSheet(undefined)} actions={{ copy: () => {}, quote: () => {}, forward: () => {}, retry: () => {}, select: () => {}, delete: () => {}, deletionAvailable: true, history: Object.fromEntries(Object.entries(actions ?? {}).map(([name, action]) => [name, { ...action, run: trigger => { setSheet(undefined); action.run(trigger); } }])) }}/>} 
  </div>;
}
createRoot(document.getElementById("root")!).render(<App/>);
