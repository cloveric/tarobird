import { describe, expect, it } from "vitest";
import { mergeAgentSignals, ticketSignal } from "../client/src/dispatcher-signal.js";
import { isTicketNotice, listedConversations, notifiesWhileHidden, setTicketConversationsVisible } from "../client/src/dispatcher.js";
import { buildConversationRows, navigationItems, type InboxHost } from "../client/src/conversation-inbox.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";
import type { Conversation, Message } from "../src/client-protocol/index.js";

const ticket = (status: DispatchTicket["status"], updatedAt: number, paused = false, conversationId = "c"): DispatchTicket =>
  ({ id: `tk_${status}_${updatedAt}`, dispatcherBotId: "d", conversationId, title: "T", request: "R", status, paused, attempts: [], createdAt: 1, updatedAt });

describe("dispatcher list avatar", () => {
  it("summarizes open tickets with the ordinary avatar states", () => {
    expect(ticketSignal([])).toEqual({ state: "idle", at: 0 });
    expect(ticketSignal([ticket("queued", 5)])).toEqual({ state: "idle", at: 0 });
    expect(ticketSignal([ticket("needs_review", 5)])).toEqual({ state: "done", at: 5 });
    expect(ticketSignal([ticket("blocked", 6), ticket("needs_review", 5)])).toEqual({ state: "failed", at: 6 });
    expect(ticketSignal([ticket("needs_review", 9), ticket("working", 5)])).toEqual({ state: "working", at: 5 });
    expect(ticketSignal([ticket("working", 9, true)])).toEqual({ state: "idle", at: 0 });
    expect(ticketSignal([ticket("working", 9), ticket("needs_answer", 2)])).toEqual({ state: "ask", at: 2 });
  });
  it("scopes ticket signals to the requested conversation or topic set without bleeding into other chats", () => {
    const tickets = [
      ticket("working", 10, false, "chat_a"),
      ticket("needs_review", 20, false, "topic_1"),
    ];
    expect(ticketSignal(tickets)).toEqual({ state: "working", at: 10 });
    expect(ticketSignal(tickets, "chat_a")).toEqual({ state: "working", at: 10 });
    expect(ticketSignal(tickets, "chat_b")).toEqual({ state: "idle", at: 0 });
    expect(ticketSignal(tickets, ["group_1", "topic_1"])).toEqual({ state: "done", at: 20 });
  });
  it("lets the dispatcher's own state and its tickets share one avatar", () => {
    const working = { state: "working" as const, at: 3 }, done = { state: "done" as const, at: 7 };
    expect(mergeAgentSignals(done, undefined)).toBe(done);
    expect(mergeAgentSignals(done, working)).toBe(working);
    expect(mergeAgentSignals(working, done)).toBe(working);
    expect(mergeAgentSignals({ state: "done", at: 1 }, done)).toBe(done);
    expect(mergeAgentSignals({ state: "ask", at: 1 }, working)).toEqual({ state: "ask", at: 1 });
  });
  it("keeps stopping work active and surfaces a hidden worker question", () => {
    const attempt = { id: "a", botId: "w", engine: "codex" as const, model: "", effort: "" as const, conversationId: "wc", inputMessageId: "m", startedAt: 1 };
    expect(ticketSignal([{ ...ticket("working", 9, true), attempts: [{ ...attempt, stopRequested: "pause" }] }])).toEqual({ state: "working", at: 9 });
    expect(ticketSignal([{ ...ticket("working", 10), attempts: [{ ...attempt, waitingFor: { kind: "approval", messageId: "q" } }] }])).toEqual({ state: "ask", at: 10 });
  });
  it("requires Hub-owned tn_* clientMsgId to classify a Host ticket notice and rejects tk_* Bot-message spoofing", () => {
    const baseSource = { hostId: "hub_local", hostName: "macmini", botId: "peer", botName: "Peer", requestId: "tk_spoof", hops: 1 };
    expect(isTicketNotice({ authorType: "user", clientMsgId: "tn_abc123", botSource: baseSource }, true)).toBe(true);
    expect(isTicketNotice({ authorType: "user", clientMsgId: "bm_abc123", botSource: baseSource }, true)).toBe(false);
    expect(isTicketNotice({ authorType: "user", clientMsgId: undefined, botSource: baseSource }, true)).toBe(false);
    expect(isTicketNotice({ authorType: "user", clientMsgId: "tn_abc123", botSource: { ...baseSource, requestId: "req_1" } }, true)).toBe(false);
    expect(isTicketNotice({ authorType: "user", clientMsgId: "tn_abc123", botSource: baseSource }, false)).toBe(false);
  });
});

describe("hidden ticket conversation that waits for the owner (switch off)", () => {
  const home = { id: "home", type: "direct", title: "Home", ownerId: "owner", botIds: ["d"], createdAt: 1, archived: false } as unknown as Conversation;
  const worker = { ...home, id: "worker", title: "Ticket title", botIds: ["w"], hidden: true, ticket: { ticketId: "tk_1", dispatcherBotId: "d" } } as unknown as Conversation;
  const idle = { preview: "", at: 2, unread: {}, lastContentSeq: 1, attention: {} };
  const waiting = { ...idle, unread: { q: 2 }, attention: { q: { kind: "approval" as const, at: 2 } } };
  const host = (workerActivity: typeof idle): InboxHost => ({ id: "h", name: "Host", connection: {} as never, conversations: [home, worker], activity: { home: idle, worker: workerActivity }, pins: [], bots: [] });
  const approval = (disabled: boolean) => ({ id: "q", conversationId: "worker", authorId: "w", authorType: "bot", status: "complete", createdAt: 2, blocks: [{ type: "card", elements: [{ type: "button", text: "Allow", actionId: "allow", disabled, value: { requestId: "r", cctb_lark: "approval", decision: "allow_once" } }] }] }) as unknown as Message;
  const question = { ...approval(false), blocks: [{ type: "card", elements: [{ type: "button", text: "Send", actionId: "send", value: { requestId: "r", cctb_lark: "ask_user_question", action: "form_submit" } }] }] } as unknown as Message;
  const answer = { ...approval(false), blocks: [{ type: "text", text: "progress" }] } as unknown as Message;

  it("is listed with its attention target while it waits, and hidden again afterwards", () => {
    expect(listedConversations([home, worker]).map(c => c.id)).toEqual(["home"]);
    expect(listedConversations([home, worker], { worker: waiting }).map(c => c.id)).toEqual(["home", "worker"]);
    expect(navigationItems(host(waiting), true).conversations.map(c => c.id)).toEqual(["home", "worker"]);
    const row = buildConversationRows([host(waiting)]).find(r => r.conversation.id === "worker");
    expect(row).toMatchObject({ unread: 1, attention: [{ conversationId: "worker", messageId: "q", kind: "approval" }] });
    expect(navigationItems(host(idle), true).conversations.map(c => c.id)).toEqual(["home"]);
    expect(buildConversationRows([host(idle)]).map(r => r.conversation.id)).toEqual(["home"]);
  });

  it("raises a desktop notice only for an open approval or question", () => {
    expect(notifiesWhileHidden(approval(false))).toBe(true);
    expect(notifiesWhileHidden(question)).toBe(true);
    expect(notifiesWhileHidden(approval(true))).toBe(false);
    expect(notifiesWhileHidden(answer)).toBe(false);
    setTicketConversationsVisible(true);
    try { expect(notifiesWhileHidden(answer)).toBe(true); } finally { setTicketConversationsVisible(false); }
  });
});
