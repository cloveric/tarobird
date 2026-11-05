import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_RETENTION_MS, runPageSchema, type RunEntry, type RunSummary } from "../src/client-protocol/run.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { HubStore } from "../src/hub/store.js";

describe("run journal latest and earlier pages", () => {
  let root: string, store: HubStore, journal: RunJournal, chat: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "run-tail-")); store = await HubStore.open(root); journal = new RunJournal(store);
    await store.db.run("INSERT INTO users VALUES('other','Other','member')");
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    chat = (await store.createConversation("owner", ["bot"], "Run", "create")).id;
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
  async function seed(count: number, scoped = false, output = "") {
    for (let seq = 1; seq <= count; seq++) {
      const entry: RunEntry = { seq, revision: 1, kind: "tool", status: "done", at: Date.now(), name: "Read", text: `step-${seq}${seq % 3 === 0 ? " match" : ""}`, output,
        ...(scoped && seq % 2 === 0 ? { scope: { id: "child", kind: "subagent", label: "Review child" } as const } : {}) };
      const request = { conversationId: chat, messageId: "message", runId: "run", entries: [entry] };
      if (entry.scope) await journal.writeScoped("bot", request); else await journal.write("bot", request);
    }
    const summary: RunSummary = { version: 1, id: "run", revision: 1, phase: "done", startedAt: Date.now(), updatedAt: Date.now(), endedAt: Date.now(), count, completed: count, failed: 0, truncated: false };
    await store.publishBotMessage("bot", { id: "message", conversationId: chat, blocks: [{ type: "card", elements: [], extra: { nativeRun: summary } }] });
  }
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  it("jumps to the latest 40 and pages backwards without changing forward cursors", async () => {
    await seed(120);
    const latest = await journal.read("owner", "message", 0, "", false, { tail: true });
    expect(latest.entries.map(entry => entry.seq)).toEqual(range(81, 120));
    expect(latest).toMatchObject({ previous: 81, next: null, expired: false });
    const middle = await journal.read("owner", "message", 0, "", false, { before: latest.previous! });
    expect(middle.entries.map(entry => entry.seq)).toEqual(range(41, 80));
    expect(middle).toMatchObject({ previous: 41, next: 80 });
    const oldest = await journal.read("owner", "message", 0, "", false, { before: middle.previous! });
    expect(oldest.entries.map(entry => entry.seq)).toEqual(range(1, 40));
    expect(oldest).toMatchObject({ previous: null, next: 40 });
    const forwards = await journal.read("owner", "message", middle.next!);
    expect(forwards.entries).toEqual(latest.entries); expect(forwards.previous).toBe(81);
    const legacy = await journal.read("owner", "message", 0);
    expect(legacy.entries.map(entry => entry.seq)).toEqual(range(1, 40));
    expect(legacy.next).toBe(40); expect(legacy.previous).toBeNull();
    expect(runPageSchema.parse(latest).previous).toBe(81);
    const { previous: _previous, ...oldHubResponse } = legacy;
    expect(runPageSchema.parse(oldHubResponse)).not.toHaveProperty("previous");
  });
  it("uses one ordered cursor for root and scoped entries and applies search to both directions", async () => {
    await seed(180, true);
    const latest = await journal.read("owner", "message", 0, "", true, { tail: true });
    expect(latest.entries.map(entry => entry.seq)).toEqual(range(141, 180));
    expect(latest.entries.filter(entry => entry.scope)).toHaveLength(20);
    const matched = await journal.read("owner", "message", 0, "match", true, { tail: true });
    expect(matched.entries.map(entry => entry.seq)).toEqual(range(21, 60).map(seq => seq * 3));
    expect(matched.previous).toBe(63);
    const earlier = await journal.read("owner", "message", 0, "match", true, { before: matched.previous! });
    expect(earlier.entries.map(entry => entry.seq)).toEqual(range(1, 20).map(seq => seq * 3));
    expect(earlier).toMatchObject({ previous: null, next: 60 });
    expect((await journal.read("owner", "message", 60, "match", true)).previous).toBe(63);
    const scopeSearch = await journal.read("owner", "message", 0, "Review child", true, { tail: true });
    expect(scopeSearch.entries.map(entry => entry.seq)).toEqual(range(51, 90).map(seq => seq * 2));
    const rootOnly = await journal.read("owner", "message", 0, "", false, { tail: true });
    expect(rootOnly.entries.every(entry => !entry.scope)).toBe(true);
    expect(rootOnly.entries.at(-1)?.seq).toBe(179);
    const empty = await journal.read("owner", "message", 0, "not-found", true, { tail: true });
    expect(empty).toMatchObject({ entries: [], next: null, previous: null });
    expect((await journal.read("owner", "message", 0, "", true, { before: 1 })).entries).toEqual([]);
  });
  it("keeps the newest contiguous page within the byte budget without skipping older entries", async () => {
    await seed(24, false, "x".repeat(60_000));
    let before: number | undefined; const pages: number[][] = [];
    do {
      const page = await journal.read("owner", "message", 0, "", false, before ? { before } : { tail: true });
      expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThan(512 * 1024);
      expect(page.entries).toHaveLength(8);
      pages.unshift(page.entries.map(entry => entry.seq));
      before = page.previous ?? undefined;
    } while (before);
    expect(pages).toEqual([range(1, 8), range(9, 16), range(17, 24)]);
    expect((await journal.read("owner", "message", 0, "", false, { before: 17 })).next).toBe(16);
  });
  it("keeps retention and terminal status rules on reverse reads", async () => {
    await seed(50);
    await store.db.run("UPDATE run_journal SET updated_at=? WHERE seq<=10", [Date.now() - RUN_RETENTION_MS - 1]);
    const latest = await journal.read("owner", "message", 0, "", false, { tail: true });
    expect(latest.entries.map(entry => entry.seq)).toEqual(range(11, 50));
    expect(latest.previous).toBeNull();
    await store.db.run("UPDATE run_journal SET payload=json_set(payload,'$.status','running') WHERE seq=50");
    expect((await journal.read("owner", "message", 0, "", false, { tail: true })).entries.at(-1)?.status).toBe("unknown");
    const old = Date.now() - RUN_RETENTION_MS - 1;
    await store.db.run("UPDATE messages SET blocks_json=json_set(blocks_json,'$[0].extra.nativeRun.endedAt',?) WHERE id='message'", [old]);
    expect(await journal.read("owner", "message", 0, "", false, { tail: true })).toMatchObject({ expired: true, entries: [], next: null, previous: null });
  });
  it("never exposes reverse pages to nonmembers or personal-deletion owners", async () => {
    await seed(45);
    await expect(journal.read("other", "message", 0, "", true, { tail: true })).rejects.toThrow();
    await store.db.run("INSERT INTO conversation_members(conversation_id,member_id,member_type) VALUES(?,'other','user')", [chat]);
    expect((await journal.read("other", "message", 0, "", true, { before: 41 })).entries).toHaveLength(40);
    await store.deleteMessages("owner", chat, { messageIds: ["message"] });
    await expect(journal.read("owner", "message", 0, "", true, { before: 41 })).rejects.toThrow("message_not_found");
    expect((await journal.read("other", "message", 0, "", true, { tail: true })).entries).toHaveLength(40);
  });
});
