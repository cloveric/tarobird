import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { attachGateway } from "../src/gateway/service.js";
import { HubServer } from "../src/hub/server.js";
import { HubPromptQueue } from "../src/hub/prompt-queue.js";
import { hashSecret } from "../src/hub/auth.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { blocksText } from "../src/client-protocol/index.js";
import type { GatewayChannel } from "../src/gateway/channel.js";

it.each([false, true])("keeps the queue editable behind a stop fence and resumes on readiness or a new binding (%s)", async newBinding => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-queue-fence-")), stateDir = path.join(root, "bot");
  await mkdir(stateDir); await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude", locale: "zh" }));
  const hub = await HubServer.start({ stateDir: root }), secret = randomBytes(32).toString("base64url");
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('alpha','Claude',?,'claude')", [hashSecret(secret)]);
  let gateway: GatewayChannel | undefined, release = () => {}, blocked = false, observedBlocked = false;
  const calls: string[] = [], runtime = createCoreServiceRuntime();
  try {
    gateway = await attachGateway({ stateDir, url: hub.instanceUrl.replace("http", "ws") + "/instance", botId: "alpha", secret, engine: "claude", runtime, bridge: {
      canStartQueuedTurn: async () => { if (blocked) observedBlocked = true; return !blocked; },
      handleAuthorizedMessage: async input => {
        calls.push(input.text);
        if (input.text === "active") { await new Promise<void>(resolve => { release = resolve; }); blocked = true; }
        return { text: blocked ? "Native stop remains unconfirmed" : "Done" };
      },
    } });
    const chat = await hub.store.createConversation("owner", ["alpha"], "Queue fence", "direct"), queue = new HubPromptQueue(hub.store);
    const send = async (text: string) => (await hub.store.sendMessage("owner", { conversationId: chat.id, clientMsgId: text, text, attachments: [] })).message;
    await send("active"); await expect.poll(() => calls).toEqual(["active"]);
    const second = await send("second"), third = await send("third"), fourth = await send("cancelled"); release();
    await expect.poll(() => observedBlocked || calls.length > 1).toBe(true);
    expect(calls).toEqual(["active"]);
    let snapshot = await queue.read("owner", "alpha", chat.id);
    expect(snapshot.items.filter(item => item.state === "queued").map(item => blocksText(item.message.blocks))).toEqual(["second", "third", "cancelled"]);
    snapshot = await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "edit", revision: snapshot.revision, action: { type: "edit", messageId: second.id, text: "edited" } });
    snapshot = await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "move", revision: snapshot.revision, action: { type: "move", messageId: third.id, beforeId: second.id } });
    snapshot = await queue.mutate("owner", chat.id, { botId: "alpha", requestId: "cancel", revision: snapshot.revision, action: { type: "cancel", messageId: fourth.id } });
    expect(snapshot.items.filter(item => item.state === "queued").map(item => blocksText(item.message.blocks))).toEqual(["third", "edited"]);
    expect(calls).toEqual(["active"]);
    if (newBinding) gateway.canSteerConversation = async () => false; // new selection must reach binding preparation
    else blocked = false; // late native confirmation or explicit recovery, without a new user message
    await expect.poll(() => calls, { timeout: 6000 }).toEqual(["active", "third", "edited"]);
  } finally { release(); await gateway?.disconnect(); await hub.close(); await rm(root, { recursive: true, force: true }); }
}, 20_000); // Resumption waits for the 2 s blocked-pull recheck; the final poll alone allows 6 s.
