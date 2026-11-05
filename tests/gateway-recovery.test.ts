import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayChannel } from "../src/gateway/channel.js";
import { GatewayReceipts } from "../src/gateway/receipts.js";
import { GatewayTransport } from "../src/gateway/transport.js";
import { hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { blocksText } from "../src/client-protocol/index.js";

let root: string | undefined; let hub: HubServer | undefined; let channel: GatewayChannel | undefined;
afterEach(async () => { await channel?.disconnect(); channel = undefined; await hub?.close(); hub = undefined; if (root) await rm(root, { recursive: true, force: true }); });
async function until(check: () => Promise<boolean>): Promise<void> { const end = Date.now() + 6000; while (!await check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 20)); } }
it("settles interrupted run and approval cards without rerunning the input or changing another Bot's work", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-interrupted-")); const instance = path.join(root, "instance");
  hub = await HubServer.start({ stateDir: path.join(root, "hub") }); const secret = randomBytes(32).toString("base64url");
  for (const id of ["alpha", "beta"]) await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, id, hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha", "beta"], "Interrupted", "interrupted");
  const { message: input } = await hub.store.sendMessage("owner", { conversationId: c.id, clientMsgId: "input", text: "One operation", attachments: [], mentions: ["alpha", "beta"] });
  const partial = await hub.store.publishBotMessage("alpha", { conversationId: c.id, replyTo: input.id, status: "streaming", blocks: [{ type: "text", text: "Already generated text" }] });
  const approval = await hub.store.publishBotMessage("alpha", { conversationId: c.id, replyTo: input.id, blocks: [{ type: "card", elements: [{ type: "form", children: [{ type: "button", text: "Allow", actionId: "allow" }] }] }] });
  const other = await hub.store.publishBotMessage("beta", { conversationId: c.id, replyTo: input.id, status: "streaming", blocks: [{ type: "text", text: "Other Bot is still working" }] });
  const complete = await hub.store.publishBotMessage("alpha", { conversationId: c.id, replyTo: input.id, blocks: [{ type: "text", text: "Already completed result" }] });
  await mkdir(path.join(instance, "gateway-receipts"), { recursive: true });
  await writeFile(path.join(instance, "gateway-receipts", createHash("sha256").update(`message:${input.id}`).digest("hex") + ".json"), JSON.stringify({ state: "running" }));
  await writeFile(path.join(instance, "gateway-outbox.json"), JSON.stringify({ requests: [2, 3].map((version) => ({ v: 1, type: "instance.request", id: `saved_${version}`, method: "publish", params: { id: partial.id, conversationId: c.id, version, status: "streaming", blocks: [{ type: "text", text: `Already generated text — saved journal ${version}` }] } })) }));
  const invoke = vi.fn(); const options = { url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: instance };
  channel = new GatewayChannel(new GatewayTransport(options)); channel.on("message", invoke); await channel.connect();
  await until(async () => (await hub!.store.pendingForBot("alpha")).length === 0);
  expect(invoke).not.toHaveBeenCalled();
  const recovered = await hub.store.messageForBot("alpha", partial.id); expect(recovered.status).toBe("error"); expect(blocksText(recovered.blocks)).toContain("Already generated text — saved journal 3");
  const closed = await hub.store.messageForBot("alpha", approval.id); expect(closed.status).toBe("error"); expect(JSON.stringify(closed.blocks)).not.toContain('"actionId":"allow"');
  expect(await hub.store.messageForBot("beta", other.id)).toEqual(other);
  expect(await hub.store.messageForBot("alpha", complete.id)).toEqual(complete);
  const beforeRetry = (await hub.store.snapshot("owner", c.id)).seq;
  await hub.store.failDelivery("alpha", input.id, "interrupted"); await hub.store.acknowledgeDelivery("alpha", input.id);
  expect((await hub.store.snapshot("owner", c.id)).seq).toBe(beforeRetry);
  expect(await hub.store.publishBotMessage("alpha", { ...recovered, version: 100, status: "streaming" })).toEqual(recovered);
  await expect(hub.store.publishBotMessage("alpha", { conversationId: c.id, replyTo: input.id, blocks: [{ type: "text", text: "Late output must not restart the turn" }] })).rejects.toThrow("delivery_already_failed");
  await expect(hub.store.failDelivery("unknown", input.id, "interrupted")).rejects.toThrow("delivery_forbidden");
  await hub.store.failDelivery("beta", input.id, "interrupted");
  expect((await hub.store.snapshot("owner", c.id)).messages.filter((m) => m.id.startsWith("recovery_")).map((m) => m.authorId).sort()).toEqual(["alpha", "beta"]);
});
it("publishes and fetches full long replies and replays a large pending journal after a Hub restart", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-long-")); const stateDir = path.join(root, "hub"), instance = path.join(root, "instance");
  hub = await HubServer.start({ stateDir }); const port = Number(new URL(hub.url).port), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const conversation = await hub.store.createConversation("owner", ["alpha"], "Long replies", "long");
  const options = { url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: instance };
  channel = new GatewayChannel(new GatewayTransport(options)); await channel.connect();
  const text = "完整正文🙂\n".repeat(100_000) + "独特尾部检索词";
  const sent = await channel.send(conversation.id, { markdown: text });
  expect(JSON.parse((await channel.fetchMessage(sent.messageId))!.content!).text).toBe(text);
  expect((await hub.store.search("owner", "独特尾部检索词"))[0]!.id).toBe(sent.messageId);
  await channel.disconnect(); channel = undefined; await hub.close(); hub = undefined;
  // Two large pending publications exceed the live queue budget together. Replay
  // must pace writes instead of repeatedly disconnecting before making progress.
  await mkdir(instance, { recursive: true });
  await writeFile(path.join(instance, "gateway-outbox.json"), JSON.stringify({ requests: [1, 2].map((i) => ({ v: 1, type: "instance.request", id: `rpc_saved_${i}`, method: "publish", params: { id: `long_${i}`, conversationId: conversation.id, version: 1, blocks: [{ type: "text", text: text + text }], status: "complete" } })) }));
  hub = await HubServer.start({ stateDir, port }); channel = new GatewayChannel(new GatewayTransport(options)); await channel.connect();
  await until(async () => (await hub!.store.snapshot("owner", conversation.id)).messages.length === 3);
  expect((await hub.store.messageForBot("alpha", "long_2")).blocks).toEqual([{ type: "text", text: text + text }]);
  const fetched = await channel.fetchMessage(sent.messageId); expect(JSON.parse(fetched!.content!).text).toBe(text);
  const forwarded = await hub.attachments.forward("owner", { v: 1, type: "message.forward", sourceMessageId: sent.messageId, clientMsgId: "copy_long", conversationId: conversation.id });
  expect(forwarded.message.blocks).toEqual([{ type: "text", text }]);
}, 20_000);
it("replays a queued offline action across Hub restart and deduplicates an instance receipt", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-recovery-")); const stateDir = path.join(root, "hub"); const instance = path.join(root, "instance");
  hub = await HubServer.start({ stateDir }); const secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const c = await hub.store.createConversation("owner", ["alpha"], "Actions", "create");
  const input = { clientActionId: "once", actionId: "approve" };
  const params = { conversationId: c.id, messageId: "sample", userId: "owner", actionId: "approve", value: { action: "approve" }, values: {} };
  await hub.store.enqueueAction("owner", "once", input, "alpha", c.id, params);
  await hub.store.enqueueAction("owner", "once", input, "alpha", c.id, params);
  expect(await hub.store.pendingActions("alpha")).toHaveLength(1);
  await expect(hub.store.actionExists("owner", "once", { changed: true })).rejects.toThrow("idempotency_conflict");
  await hub.close(); hub = await HubServer.start({ stateDir });
  const options = { url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, stateDir: instance };
  const action = vi.fn(async () => undefined);
  channel = new GatewayChannel(new GatewayTransport(options)); channel.on("cardAction", action); await channel.connect();
  await until(async () => (await hub!.store.pendingActions("alpha")).length === 0);
  expect(action).toHaveBeenCalledTimes(1);
  // Simulate the Hub losing the acknowledgement after the side effect: the
  // completed instance receipt must also survive its own process restart.
  await channel.disconnect(); channel = undefined;
  await hub.store.db.run("UPDATE action_deliveries SET status='pending'");
  channel = new GatewayChannel(new GatewayTransport(options)); channel.on("cardAction", action); await channel.connect();
  await until(async () => (await hub!.store.pendingActions("alpha")).length === 0);
  expect(action).toHaveBeenCalledTimes(1);
});
it("never reruns an interrupted operation and coalesces concurrent duplicates", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-receipts-")); const receipts = new GatewayReceipts(root);
  const run = vi.fn(async () => { await new Promise((r) => setTimeout(r, 10)); return { saved: true }; });
  await Promise.all(Array.from({ length: 8 }, () => receipts.run("once", run)));
  expect(run).toHaveBeenCalledTimes(1); expect(await new GatewayReceipts(root).run("once", run)).toEqual({ ok: true, result: { saved: true } });
  const id = createHash("sha256").update("crashed").digest("hex"); await mkdir(path.join(root, "gateway-receipts"), { recursive: true });
  await writeFile(path.join(root, "gateway-receipts", `${id}.json`), JSON.stringify({ state: "running" }));
  expect(await receipts.run("crashed", run)).toEqual({ ok: false, error: "operation_interrupted" }); expect(run).toHaveBeenCalledTimes(1);
});

it("retries only explicitly idempotent notifications within a fixed window, preserving it across restart", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-notification-retry-")); const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const operation = vi.fn().mockRejectedValueOnce(new Error("uncertain_transport")).mockResolvedValue(null);
    expect(await new GatewayReceipts(root).run("route-alert", operation, 2000)).toMatchObject({ ok: false });
    now.mockReturnValue(2000); expect(await new GatewayReceipts(root).run("route-alert", operation, 2000)).toMatchObject({ ok: true });
    expect(await new GatewayReceipts(root).run("route-alert", operation, 2000)).toMatchObject({ ok: true }); expect(operation).toHaveBeenCalledTimes(2);
    const expired = vi.fn(async () => { throw new Error("offline"); }); await new GatewayReceipts(root).run("expired", expired, 2000);
    now.mockReturnValue(5000); await new GatewayReceipts(root).run("expired", expired, 2000); expect(expired).toHaveBeenCalledTimes(1);
    const command = vi.fn(async () => { throw new Error("command_failed"); }); await new GatewayReceipts(root).run("command", command); await new GatewayReceipts(root).run("command", command); expect(command).toHaveBeenCalledTimes(1);
  } finally { now.mockRestore(); }
});
