import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayChannel } from "../src/gateway/channel.js";
import type { GatewayTransport } from "../src/gateway/transport.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { createAppPlatformTools } from "../src/gateway/app-tools.js";
import { WORKBENCH_CAPABILITY, type WorkbenchContext } from "../src/client-protocol/workbench.js";
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY } from "../src/client-protocol/workbench-design.js";
import type { Conversation, Message } from "../src/client-protocol/index.js";

describe("older Host without design comments/history", () => {
  let stateDir: string;
  const target = { deviceId: "desktop", windowId: "controller", tabId: "design-a" };
  const conversation: Conversation = { id: "conv", type: "direct", title: "Design", ownerId: "owner", botIds: ["bot"], archived: false, createdAt: 1 };
  const message = (id: string): Message => ({ id, conversationId: "conv", authorId: "owner", authorType: "user", blocks: [{ type: "text", text: "Restore version 3 of my Baoyu design" }], status: "complete", version: 1, createdAt: 1 });
  beforeEach(async () => { stateDir = await mkdtemp(path.join(os.tmpdir(), "opus-suite-host-")); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it.each([
    ["design.restore", { version: 3 }, 5],
    ["design.comments.reply", { threadId: "c_0123456789", text: "done" }, undefined],
    ["design.history.list", { limit: 20 }, undefined],
  ] as const)("%s reports a definite pre-dispatch refusal", async (operation, payload, expectedRevision) => {
    const calls: unknown[] = [];
    const transport = { capabilities: [WORKBENCH_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY], options: { stateDir }, request: async () => null, deliverySettled() {}, refreshStatus: async () => {}, reconnectAfterDeliveryFailure() {}, isBusy: () => false,
      requestLive: async (method: string, params: unknown) => { calls.push({ method, params }); return null; } } as unknown as GatewayTransport & { onMessage: (...args: unknown[]) => Promise<void> };
    const channel = new GatewayChannel(transport);
    const outcome = new Promise<Record<string, unknown>>((resolve, reject) => channel.on("message", async () => {
      try {
        const tools = createAppPlatformTools({ channel, stateDir, conversationId: "conv", receipts: new GatewayReceipts(stateDir), signal: new AbortController().signal });
        const result = await tools.call({ name: "app_workbench", arguments: { requestId: `r_${operation.replaceAll(".", "_")}`, operation, target, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, callId: operation, sessionId: "s", abortSignal: new AbortController().signal });
        resolve({ ...JSON.parse(result.text), isError: !!result.isError });
      } catch (error) { reject(error); }
    }));
    const context: WorkbenchContext = { target } as WorkbenchContext;
    await transport.onMessage(message(`msg_${operation.replaceAll(".", "_")}`), conversation, undefined, undefined, context);
    const value = await outcome;
    expect(calls).toHaveLength(0); // nothing reached the Host
    expect(value.error).toBe("workbench_design_suite_host_update_required");
    expect(value.status).toBe("not_executed");
    expect(value.hint).toContain("Nothing was dispatched");
  });
});
