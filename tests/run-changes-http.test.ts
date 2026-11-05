import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { HubServer } from "../src/hub/server.js";
import { deviceProof } from "../src/hub/auth.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { runChangesSchema, runChangeDetailSchema } from "../src/client-protocol/run-changes.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "run-diff-http-")), hub = await HubServer.start({ stateDir: root });
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pairing = await hub.auth.pair({ deviceId: "device", name: "Fixture", platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "fixture");
  await hub.auth.approve(pairing.code, "local-owner");
  const challenge = await hub.auth.challenge("device", "device", nonce, "fixture"), session = await hub.auth.authenticate("device", sign(null, deviceProof("device", challenge.nonce, nonce), keys.privateKey).toString("base64"));
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Fixture','fixture')");
  const chat = (await hub.store.createConversation("owner", ["bot"], "Recorded", "new")).id;
  const record = createRunRecord(); recordRunEvent(record, { type: "tool_use", toolName: "Edit", toolUseId: "edit" });
  recordRunEvent(record, { type: "tool_result", toolUseId: "edit", changes: [{ path: "/not-an-existing-directory/report.ts", diff: "@@ -1 +1 @@\n-old\n+recorded" }] });
  await new RunJournal(hub.store).write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: record.entries });
  await hub.store.publishBotMessage("bot", { id: "msg", conversationId: chat, status: "complete", blocks: [{ type: "card", elements: [], extra: { nativeRun: JSON.parse(JSON.stringify(summarizeRun(record, "done"))) } }] });
  const headers = { Authorization: `Bearer ${session.token}` }, query = new URLSearchParams({ conversationId: chat, botId: "bot" });
  return { hub, chat, headers, url: `${hub.url}/api/messages/msg/changes?${query}`, async close() { await hub.close(); await rm(root, { recursive: true, force: true }); } };
}
describe("recorded diff real HTTP authorization", () => {
  it("returns saved changes from nonexistent paths without touching workspace APIs", async () => {
    const f = await fixture(), listSpy = vi.spyOn(f.hub.workspaceDiff, "list"), fileSpy = vi.spyOn(f.hub.workspaceDiff, "file");
    try {
      expect((await fetch(f.url)).status).toBe(401);
      expect((await fetch(f.url + "&botId=bot", { headers: f.headers })).status).toBe(400);
      expect((await fetch(f.url.replace("botId=bot", "botId=foreign"), { headers: f.headers })).status).toBe(403);
      const list = runChangesSchema.parse(await (await fetch(f.url, { headers: f.headers })).json());
      const detail = runChangeDetailSchema.parse(await (await fetch(f.url.replace("changes?", "changes/file?") + `&key=${list.items[0]!.key}&revision=${list.revision}`, { headers: f.headers })).json());
      expect(JSON.stringify(detail.hunks)).toContain("recorded"); expect(listSpy).not.toHaveBeenCalled(); expect(fileSpy).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it.each(["device", "member", "message", "owner"])("rejects %s revocation/deletion queued during read", async kind => {
    const f = await fixture(); let entered!: () => void, release!: () => void;
    const began = new Promise<void>(resolve => entered = resolve), gate = new Promise<void>(resolve => release = resolve);
    const list = runChangesSchema.parse(await (await fetch(f.url, { headers: f.headers })).json());
    vi.spyOn(f.hub.runChanges, "read").mockImplementation(async () => { entered(); await gate; return list; });
    try {
      const request = fetch(f.url, { headers: f.headers }); await began;
      if (kind === "device") await f.hub.auth.revoke("device", "local-owner");
      if (kind === "member") await f.hub.store.db.serial(() => f.hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [f.chat]));
      if (kind === "message") await f.hub.store.db.serial(() => f.hub.store.db.run("INSERT INTO message_deletions VALUES('owner','msg',?)", [Date.now()]));
      if (kind === "owner") await f.hub.store.db.serial(() => f.hub.store.db.run("UPDATE users SET role='member' WHERE id='owner'"));
      release(); const response = await request;
      expect(response.status).toBe(kind === "device" ? 401 : kind === "message" ? 404 : 403);
      expect(await response.text()).not.toContain("report.ts");
    } finally { release(); await f.close(); }
  });
});
