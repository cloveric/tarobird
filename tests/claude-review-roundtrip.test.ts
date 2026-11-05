import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import type { GatewayChannel } from "../src/gateway/channel.js";
import { HubServer } from "../src/hub/server.js";
import { hashSecret } from "../src/hub/auth.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import type { CoreBridgeLike } from "../src/core/types.js";
import { blocksText } from "../src/client-protocol/index.js";

async function until(check: () => Promise<boolean>) { await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 8000, interval: 10 }); }
it("carries a real Hub review-input record through Gateway and Core, replying to it once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-roundtrip-"));
  const stateDir = path.join(root, "bot"); await mkdir(stateDir);
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "en", workspacePath: path.join(root, "workspace") }));
  const hub = await HubServer.start({ stateDir: path.join(root, "hub") }); let channel: GatewayChannel | undefined;
  const secret = randomBytes(32).toString("base64url");
  try {
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
    const runtime = createCoreServiceRuntime(); let release!: () => void;
    const engine = vi.fn<CoreBridgeLike["handleAuthorizedMessage"]>(async input => {
      expect(input.reviewAdmission).toBe("native"); expect(input.text).toBe("Check the second result");
      expect(input.appPlatformTools).toBeDefined();
      input.nativeInput!.onProgress({ state: "queued" });
      await new Promise<void>(resolve => { release = resolve; });
      input.nativeInput!.onProgress({ state: "dequeued" }); input.nativeInput!.onProgress({ state: "received" });
      return { text: "NEW_REPLY_IN_OWN_BUBBLE" };
    });
    const bridge: CoreBridgeLike = { handleAuthorizedMessage: engine, supportsSteering: () => true, inFlightSendBehavior: async () => "steer", steerActiveTurn: vi.fn(), backgroundInputTarget: async () => "review-token", nativeInputCapability: async () => ({ cancel: true, sendNow: true, modelReceipt: true }) };
    channel = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, bridge, runtime, engine: "claude" });
    await until(async () => (await hub.store.bots("owner"))[0]?.online === 1);
    const conversation = await hub.store.createConversation("owner", ["alpha"], "Review", "review-roundtrip");
    const call = (method: string, params: object) => (hub as unknown as { callBot(botId: string, method: string, params: object): Promise<any> }).callBot("alpha", method, params);
    expect(await call("steer.status", { conversationId: conversation.id, backgroundReview: true })).toMatchObject({ targetId: "review-token", targetKind: "background-review" });
    const request = { conversationId: conversation.id, botId: "alpha", requestId: "human-input", targetId: "review-token", mode: "message" as const, text: "Check the second result" };
    const { message } = await hub.store.beginSteeringRecord("owner", request);
    const { botId: _botId, ...command } = request;
    const params = { ...command, userId: "owner", messageId: message.id };
    expect(await call("steer", params)).toEqual({ outcome: "accepted" });
    expect(engine).toHaveBeenCalledTimes(1); expect(runtime.activeRuns.size).toBe(1);
    // Checking the same request cannot run the engine a second time.
    expect(await call("steer", params)).toEqual({ outcome: "accepted" });
    expect(engine).toHaveBeenCalledTimes(1); release();
    await until(async () => runtime.activeRuns.size === 0 && !channel!.isBusy());
    const rows = await hub.store.db.all<{ id: string; reply_to: string; blocks_json: string }>("SELECT id,reply_to,blocks_json FROM messages WHERE author_type='bot'");
    const replies = rows.filter(row => blocksText(JSON.parse(row.blocks_json)).includes("NEW_REPLY_IN_OWN_BUBBLE"));
    expect(replies).toHaveLength(1); expect(replies[0]!.reply_to).toBe(message.id);
    const stored = await hub.store.db.get<{ blocks_json: string }>("SELECT blocks_json FROM messages WHERE id=?", [message.id]);
    expect(JSON.parse(stored!.blocks_json)).toContainEqual(expect.objectContaining({ type: "steering", nativeInput: expect.objectContaining({ state: "received" }) }));
    expect(await hub.store.pendingForBot("alpha")).toEqual([]);
  } finally { await channel?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
});
