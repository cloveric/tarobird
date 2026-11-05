import { NATIVE_INPUT_CAPABILITY } from "../src/client-protocol/native-input.js";
import { STEERING_OUTCOME_CAPABILITY } from "../src/client-protocol/steering-outcome.js";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { GatewayTransport } from "../src/gateway/transport.js";
import { RUN_SCOPES_CAPABILITY } from "../src/client-protocol/run.js";

it.each([["input.progress", NATIVE_INPUT_CAPABILITY, "native_input_unsupported"], ["run.scope.write", RUN_SCOPES_CAPABILITY, "run_scopes_unsupported"], ["steer.outcome", STEERING_OUTCOME_CAPABILITY, "steering_outcome_unsupported"]])("retires optional %s before replay to a rolled-back Hub", async (method, _capability, error) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-scope-rollback-"));
  const requests = [method, "run.write", "publish"].map((method, index) => ({ v: 1, type: "instance.request", id: `saved_${index}`, method, params: { receipt: index } }));
  await writeFile(path.join(root, "gateway-outbox.json"), JSON.stringify({ requests }));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const received: unknown[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [] }));
    else if (frame.type === "instance.request") { received.push(frame); if (frame.method === method) ws.close(4001); else ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: null })); }
  }));
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  try {
    await transport.connect();
    await expect.poll(() => received.length).toBe(2);
    expect(received).toEqual(requests.slice(1));
    await expect(transport.request(method, { receipt: "new" })).rejects.toThrow(error);
    await expect.poll(async () => JSON.parse(await readFile(path.join(root, "gateway-outbox.json"), "utf8")).requests).toEqual([]);
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it.each([["input.progress", NATIVE_INPUT_CAPABILITY, "native_input_unsupported"], ["run.scope.write", RUN_SCOPES_CAPABILITY, "run_scopes_unsupported"], ["steer.outcome", STEERING_OUTCOME_CAPABILITY, "steering_outcome_unsupported"]])("rejects in-flight %s after capability loss while replaying the final reply", async (method, capability, errorCode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-scope-reconnect-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  let supportsScopes = true;
  const before: string[] = [], after: string[] = [];
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: supportsScopes ? [capability] : [] }));
    else if (frame.type === "instance.request") {
      (supportsScopes ? before : after).push(frame.method);
      if (!supportsScopes) {
        if (frame.method === method) ws.close(4001);
        else ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: "reply-saved" }));
      }
    }
  }));
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  try {
    await transport.connect(); await expect.poll(() => transport.capabilities.includes(capability)).toBe(true);
    const scope = transport.request(method, { receipt: "scope" }).catch(error => error.message);
    const reply = transport.request("publish", { text: "complete final reply" });
    await expect.poll(() => before.length).toBe(2);
    supportsScopes = false; for (const ws of server.clients) ws.close();
    await expect(scope).resolves.toBe(errorCode);
    await expect(reply).resolves.toBe("reply-saved");
    expect(after).toEqual(["publish"]);
    expect(JSON.parse(await readFile(path.join(root, "gateway-outbox.json"), "utf8")).requests).toEqual([]);
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

it("replays native progress after a lost ACK without duplicating the message or regressing its receipt", async () => {
  const { HubStore } = await import("../src/hub/store.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "native-progress-reconnect-"));
  const store = await HubStore.open(root);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const ids: string[] = []; let loseAck = true;
  server.on("connection", ws => ws.on("message", raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "instance.hello") ws.send(JSON.stringify({ v: 1, type: "instance.ready", capabilities: [NATIVE_INPUT_CAPABILITY] }));
    else if (frame.type === "instance.request") {
      ids.push(frame.id);
      void store.applyNativeInputProgress("bot", frame.params).then(() => {
        if (loseAck) { loseAck = false; ws.close(); }
        else ws.send(JSON.stringify({ v: 1, type: "instance.result", id: frame.id, result: null }));
      });
    }
  }));
  const transport = new GatewayTransport({ stateDir: root, botId: "bot", secret: "fixture", url: `ws://127.0.0.1:${(server.address() as { port: number }).port}/instance` });
  try {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','test')");
    const chat = await store.createConversation("owner", ["bot"], "Receipts", "direct");
    await store.beginSteering("owner", { conversationId: chat.id, botId: "bot", requestId: "input", targetId: "turn", text: "One message", mode: "message" });
    await transport.connect(); await expect.poll(() => transport.capabilities.includes(NATIVE_INPUT_CAPABILITY)).toBe(true);
    const identity = { conversationId: chat.id, userId: "owner", requestId: "input", targetId: "turn" };
    await transport.request("input.progress", { ...identity, progress: { state: "queued" } });
    expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
    await transport.request("input.progress", { ...identity, progress: { state: "received" } });
    const messages = (await store.snapshot("owner", chat.id)).messages;
    expect(messages).toHaveLength(1); expect(messages[0]!.version).toBe(3);
    expect(messages[0]!.blocks).toContainEqual(expect.objectContaining({ type: "steering", outcome: "accepted", nativeInput: { state: "received" } }));
  } finally { await transport.disconnect(); for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await store.db.close(); await rm(root, { recursive: true, force: true }); }
});
