import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayChannel } from "../src/gateway/channel.js";
import type { GatewayTransport } from "../src/gateway/transport.js";
import { WORKBENCH_DESIGN_OPEN_CAPABILITY } from "../src/client-protocol/workbench-design.js";
import type { Conversation, Message } from "../src/client-protocol/index.js";

describe("optional native Design lease never loses ordinary chat", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
  const conversation: Conversation = { id: "chat", type: "direct", title: "Design", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
  const message: Message = { id: "native_source", conversationId: "chat", authorId: "owner", authorType: "user", status: "complete", version: 1, createdAt: 1, blocks: [{ type: "text", text: "继续聊天" }] };
  const admission = { reviewAdmission: "native" as const, nativeInput: { id: "input", onProgress: () => {} } };
  async function fixture(begin: () => Promise<unknown>) {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "design-lease-")); directories.push(stateDir);
    const durable = vi.fn(async () => null);
    const live = vi.fn(async (method: string) => method === "workbench.turn.begin" ? await begin() : null);
    const channel = new GatewayChannel({ capabilities: ["workbench.v1", WORKBENCH_DESIGN_OPEN_CAPABILITY], options: { stateDir }, request: durable, requestLive: live, refreshStatus: async () => {}, isBusy: () => false } as unknown as GatewayTransport);
    return { channel, durable, live };
  }
  for (const cause of ["malformed", "unavailable"] as const) it(`continues exactly one native turn after ${cause} optional lease metadata`, async () => {
    const f = await fixture(async () => { if (cause === "unavailable") throw new Error("bot_offline"); return { workbench: { target: 42 } }; });
    const received = vi.fn(async () => { expect(await f.channel.workbenchContext()).toBeUndefined(); });
    f.channel.on("message", received);
    await expect(f.channel.dispatchNativeTurn(message, conversation, admission)).resolves.toBeUndefined();
    expect(received).toHaveBeenCalledTimes(1);
    expect(f.channel.hasPendingAdmission("chat")).toBe(false);
    expect(f.channel.isBusy()).toBe(false);
    expect(f.durable).not.toHaveBeenCalledWith(expect.stringMatching(/^workbench\.turn\./), expect.anything());
    expect(f.live.mock.calls.map(call => call[0])).toEqual(["workbench.turn.begin", "workbench.turn.end"]);
  });
  it("uses live-only lease calls and exposes the frozen context to the native turn", async () => {
    const target = { deviceId: "phone", windowId: "opener" }, workbench = { target, openTarget: target };
    const f = await fixture(async () => ({ workbench }));
    const received = vi.fn(async () => { expect(await f.channel.workbenchContext()).toEqual(workbench); });
    f.channel.on("message", received);
    await f.channel.dispatchNativeTurn(message, conversation, admission);
    expect(received).toHaveBeenCalledTimes(1);
    expect(f.live.mock.calls.map(call => call[0])).toEqual(["workbench.turn.begin", "workbench.turn.end"]);
    expect(f.durable).not.toHaveBeenCalledWith(expect.stringMatching(/^workbench\.turn\./), expect.anything());
    expect(f.channel.isBusy()).toBe(false);
  });
});
