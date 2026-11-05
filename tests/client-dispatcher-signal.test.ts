import { describe, expect, it } from "vitest";
import { mergeAgentSignals, ticketSignal } from "../client/src/dispatcher-signal.js";
import type { DispatchTicket } from "../src/client-protocol/dispatch.js";

const ticket = (status: DispatchTicket["status"], updatedAt: number, paused = false): DispatchTicket =>
  ({ id: `tk_${status}_${updatedAt}`, dispatcherBotId: "d", conversationId: "c", title: "T", request: "R", status, paused, attempts: [], createdAt: 1, updatedAt });

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
});
