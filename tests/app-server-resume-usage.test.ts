import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { EngineStreamEvent } from "../src/codex/adapter.js";
import { CodexAppServerAdapter } from "../src/codex/app-server-adapter.js";

class FakeStream extends EventEmitter { emitData(chunk: string) { this.emit("data", chunk); } }
class FakeWritable {
  lines: string[] = [];
  write(chunk: string, callback?: (error?: Error | null) => void): boolean { const text = chunk.toString().trim(); if (text) this.lines.push(text); callback?.(null); return true; }
}
class FakeChild extends EventEmitter {
  stdin = new FakeWritable(); stdout = new FakeStream(); stderr = new FakeStream();
  kill() { return true; }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 0)); }
  throw new Error("Condition was not met in time");
}

// Codex 0.163 replays the previous turn's usage when a thread is resumed. On a
// fresh adapter (host restart) that notification can land between the new
// turn/start request and its response; it must not become the new turn's id.
describe("Codex resumed-thread usage replay", () => {
  it("does not adopt the previous turn id from replayed usage before turn/start answers", async () => {
    const child = new FakeChild();
    const adapter = new CodexAppServerAdapter("codex", "/tmp/resume-usage", (() => child) as never);
    const frames = () => child.stdin.lines.map((line) => JSON.parse(line) as { id?: number; method?: string });
    const respond = async (method: string, result: unknown) => {
      await waitFor(() => frames().some((frame) => frame.method === method));
      child.stdout.emitData(JSON.stringify({ id: frames().find((frame) => frame.method === method)!.id, result }) + "\n");
    };
    const emit = (method: string, params: Record<string, unknown>) => child.stdout.emitData(JSON.stringify({ method, params }) + "\n");
    try {
      const events: EngineStreamEvent[] = [];
      const turn = adapter.sendUserMessage("existing-thread", { text: "Marker?", files: [], onEngineEvent: (event) => { events.push(event); } });
      await respond("initialize", {});
      await respond("thread/resume", { thread: { id: "existing-thread" } });
      await waitFor(() => frames().some((frame) => frame.method === "turn/start"));
      emit("thread/tokenUsage/updated", { threadId: "existing-thread", turnId: "previous-turn", tokenUsage: { last: { inputTokens: 999, outputTokens: 999, totalTokens: 1998 }, modelContextWindow: 100_000 } });
      await respond("turn/start", { turn: { id: "new-turn" } });
      emit("item/agentMessage/delta", { threadId: "existing-thread", turnId: "new-turn", delta: "PEAR-2" });
      emit("thread/tokenUsage/updated", { threadId: "existing-thread", turnId: "new-turn", tokenUsage: { last: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }, modelContextWindow: 100_000 } });
      emit("turn/completed", { threadId: "existing-thread", turn: { id: "new-turn", status: "completed", items: [{ type: "agentMessage", text: "PEAR-2" }] } });
      await expect(turn).resolves.toMatchObject({ text: "PEAR-2", usage: { inputTokens: 10, outputTokens: 2 } });
      expect(events).toContainEqual(expect.objectContaining({ type: "assistant_text", text: "PEAR-2" }));
    } finally { adapter.destroy(); }
  });
});
