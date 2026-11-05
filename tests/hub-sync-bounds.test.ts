import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { HubStore } from "../src/hub/store.js";

it("pages large replay events by bytes without losing sequence or message text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sync-bounds-")), store = await HubStore.open(root);
  try {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    const conversation = await store.createConversation("owner", ["bot"], "Replay", "replay");
    const text = "x".repeat(1024 * 1024), ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push((await store.publishBotMessage("bot", { conversationId: conversation.id, blocks: [{ type: "text", text }] })).id);
    const seen: string[] = [], seqs: number[] = []; let cursor = 0, more = true, pages = 0;
    while (more) {
      const page = await store.sync("owner", conversation.id, cursor);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4 * 1024 * 1024);
      for (const event of page.events) {
        seqs.push(event.seq); cursor = event.seq;
        if (event.kind === "message.created") {
          const message = event.payload as { id: string; blocks: { text: string }[] };
          seen.push(message.id); expect(message.blocks[0]!.text).toBe(text);
        }
      }
      more = page.more; pages++; expect(pages).toBeLessThan(30);
    }
    expect(pages).toBeGreaterThan(1); expect(seen).toEqual(ids);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  } finally { await store.db.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
