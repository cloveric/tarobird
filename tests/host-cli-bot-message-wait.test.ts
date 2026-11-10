import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalHostClient } from "../src/host-cli/client.js";
import { runBotMessagesCommand } from "../src/host-cli/bot-messages.js";

vi.mock("node:timers/promises", async original => ({ ...await original<typeof import("node:timers/promises")>(), setTimeout: vi.fn() }));
const target = { hostId: "hub_fixture", hostName: "Fixture", botId: "receiver", botName: "Receiver", conversationId: "chat_fixture", conversationName: "Collaboration" };
let polls: number[], finishAt: number, close: ReturnType<typeof vi.fn>;
const request = vi.fn(async (_path: string, _method: string, input: { operation: string }) => {
  if (input.operation === "resolve") return target;
  expect(input.operation).toBe("wait"); // Never resubmit the task.
  polls.push(Date.now());
  return { status: Date.now() >= finishAt ? "completed" : "pending", files: [] };
});
beforeEach(() => {
  vi.stubEnv("TAROBOT_INSTANCE", undefined); vi.stubEnv("TAROBOT_ACTIVE_INSTANCE", undefined);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(0);
  polls = []; finishAt = Infinity; close = vi.fn(); request.mockClear();
  vi.spyOn(LocalHostClient, "connect").mockResolvedValue({ request, close, ready: { expiresAt: Infinity } } as unknown as LocalHostClient);
  vi.mocked(delay).mockImplementation(async (ms, _value, options) => { options?.signal?.throwIfAborted(); vi.setSystemTime(Date.now() + Number(ms)); });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const wait = (timeout: string, signal?: AbortSignal) => runBotMessagesCommand("unused-fixture", "wait", { to: "Fixture/receiver/chat_fixture", "source-bot": "sender", message: "msg_fixture", timeout }, signal);

it("polls immediately, reduces long waits to at most 605 reads per hour, and respects the deadline", async () => {
  expect(await wait("3600")).toMatchObject({ status: "timeout", deliveryStatus: "pending" });
  expect(polls[0]).toBe(0); expect(polls.at(-1)).toBe(3_600_000);
  expect(polls.length).toBeLessThanOrEqual(605);
  expect(Math.max(...polls.slice(1).map((at, i) => at - polls[i]!))).toBeLessThanOrEqual(6000);
  expect(close).toHaveBeenCalledOnce();
});
it.each([0, 1000, 5000, 60_001])("returns completion at %i ms within six seconds, without another poll", async completed => {
  finishAt = completed;
  expect(await wait("120")).toMatchObject({ status: "completed" });
  expect(polls.at(-1)!).toBeGreaterThanOrEqual(completed);
  expect(polls.at(-1)! - completed).toBeLessThanOrEqual(6000);
  expect(polls.filter(at => at >= completed)).toHaveLength(1);
});
it("keeps a zero-timeout read to one poll", async () => {
  expect(await wait("0")).toMatchObject({ status: "timeout" }); expect(polls).toEqual([0]);
});
it("stops during the waiting interval without another request", async () => {
  const controller = new AbortController();
  vi.mocked(delay).mockImplementationOnce(async (_ms, _value, options) => { controller.abort(); options?.signal?.throwIfAborted(); });
  await expect(wait("120", controller.signal)).rejects.toThrow();
  expect(polls).toEqual([0]); expect(close).toHaveBeenCalledOnce();
});
it("does not retry an uncertain response", async () => {
  request.mockImplementationOnce(async () => target).mockRejectedValueOnce(new Error("disconnected"));
  await expect(wait("120")).rejects.toThrow("disconnected");
  expect(request).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
});
