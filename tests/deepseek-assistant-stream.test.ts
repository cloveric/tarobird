import { describe, expect, it } from "vitest";
import { DeepSeekAssistantStream } from "../src/codex/deepseek-assistant-stream.js";

const start = { type: "start", attemptId: "a", revision: 1, startedAfterSeq: 7, turn: 2, step: 3 };
const chunk = (revision: number, index: number, text: string) => ({
  type: "chunk", attemptId: "a", revision, index, time: 1, chunk: { type: "text-delta", index: 0, text },
});
describe("DeepSeek process-local assistant stream", () => {
  it("ignores replay, stops at a gap and admits a new attempt independently", () => {
    const stream = new DeepSeekAssistantStream();
    stream.replace({ revision: 0 }); stream.accept(start);
    expect(stream.accept(chunk(2, 0, "one"))?.text).toBe("one");
    expect(stream.accept(chunk(2, 0, "one"))).toBeUndefined();
    expect(stream.accept(chunk(4, 2, "gap"))).toBeUndefined();
    expect(stream.accept(chunk(5, 3, "tail"))).toBeUndefined();
    stream.accept({ ...start, attemptId: "b", revision: 6 });
    expect(stream.accept({ ...chunk(7, 0, "new"), attemptId: "b" })?.text).toBe("new");
    stream.accept({ type: "end", attemptId: "b", revision: 8, index: 1, outcome: { kind: "abandoned" } });
    expect(stream.accept({ ...chunk(9, 1, "late"), attemptId: "b" })).toBeUndefined();
  });
  it("reconstructs compact text and thinking while preserving dense positions of ignored tool chunks", () => {
    const stream = new DeepSeekAssistantStream();
    const prefix = stream.replace({ revision: 7, activeAttempt: { ...start, nextIndex: 4, stream: [
      { type: "reasoning-chunks", index: 0, time0: 1, dt: [], texts: ["thinking"] },
      { type: "tool-call-chunks", index: 1, time0: 2, dt: [], id: "tool", args: ["{}"] },
      { type: "text-chunks", index: 2, time0: 3, dt: [1], texts: ["hello", " world"] },
    ] } });
    expect(prefix).toMatchObject({ text: "hello world", reasoning: "thinking" });
    expect(stream.accept(chunk(8, 4, "!"))?.text).toBe("hello world!");
    stream.accept({ type: "end", attemptId: "a", revision: 9, index: 5, outcome: { kind: "committed", eventType: "assistant/message", seq: 8 } });
    expect(stream.accept(chunk(10, 5, "late"))).toBeUndefined();
  });
  it.each([
    { revision: -1 },
    { revision: 1, activeAttempt: { ...start, nextIndex: 2, stream: [] } },
    { revision: 1, activeAttempt: { ...start, nextIndex: 1, stream: [{ type: "text-chunks", index: 0, time0: 1, dt: [1], texts: ["x"] }] } },
  ])("rejects a malformed reconnect baseline %j", (baseline) => {
    expect(() => new DeepSeekAssistantStream().replace(baseline)).toThrow();
  });
});
