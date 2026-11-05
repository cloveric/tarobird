import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseRecordedPatch, recordedEdits, summarizeRecordedChanges, wholeFilePatch } from "../src/core/recorded-diff.js";
import { HubRunChanges } from "../src/hub/run-changes.js";
import { HubStore } from "../src/hub/store.js";
import { RunJournal } from "../src/hub/run-journal.js";
import { createRunRecord, recordRunEvent, summarizeRun } from "../src/core/run-record.js";
import { runChangesSchema, runChangeDetailSchema } from "../src/client-protocol/run-changes.js";
import { RUN_RETENTION_MS, type RunEntry } from "../src/client-protocol/run.js";

const patch = "@@ -1,2 +1,3 @@\n const keep = 1;\n-old();\n+newCall();\n+done();";
const edit = (seq = 1, other: Partial<RunEntry> = {}): RunEntry => ({ seq, revision: 1, kind: "tool", status: "done", name: "Edit", at: 10,
  changes: [{ path: "/project/app.ts", diff: patch }], ...other });
describe("recorded patch evidence", () => {
  it("preserves actual coordinates and counts, and treats raw text honestly", () => {
    expect(parseRecordedPatch(patch)).toMatchObject({ format: "unified", additions: 2, deletions: 1, partial: false });
    expect(parseRecordedPatch(patch).hunks[0]!.lines[2]).toMatchObject({ text: "newCall();", newLine: 2, oldLine: null });
    expect(parseRecordedPatch("plain file")).toMatchObject({ format: "raw", additions: null, deletions: null });
    expect(parseRecordedPatch("- \n+ new")).toMatchObject({ format: "signed", additions: null, deletions: null });
    expect(parseRecordedPatch("-old\n+new").hunks[0]!.lines.every(line => line.oldLine === null && line.newLine === null)).toBe(true);
    expect(parseRecordedPatch("").format).toBe("empty"); expect(parseRecordedPatch("GIT binary patch").format).toBe("binary");
  });
  it("does not invent positions from malformed, clipped or overlapping hunks", () => {
    for (const value of ["@@ -1,2 +1,2 @@\n-old\n+new", patch + "\n@@ -1 +1 @@\n-x\n+y", "-unpositioned\n+missing\n" + patch]) {
      const result = parseRecordedPatch(value); expect(result.partial).toBe(true);
      expect(result.hunks.flatMap(h => h.lines).every(line => line.oldLine === null && line.newLine === null)).toBe(true);
    }
  });
  it("bounds rows and preserves complete captured counts for large patches", () => {
    const result = parseRecordedPatch(wholeFilePatch("x\n".repeat(3000), "add"), 200);
    expect(result.additions).toBe(3000); expect(result.rows).toBe(3001);
    expect(result.hunks.flatMap(h => h.lines)).toHaveLength(199);
    expect(parseRecordedPatch(wholeFilePatch("a\nb", "delete"))).toMatchObject({ additions: 0, deletions: 2, partial: false });
    expect(parseRecordedPatch(wholeFilePatch("", "add"))).toMatchObject({ additions: 0, deletions: 0, partial: false });
  });
  it("counts receipts once, excludes failed/child work, and marks missing evidence", () => {
    const result = summarizeRecordedChanges([edit(), edit(2), edit(3, { status: "error" }), edit(4, { scope: { id: "child", kind: "subagent" } }), edit(5, { changes: undefined })]);
    expect(result).toMatchObject({ files: 1, edits: 2, additions: 4, deletions: 2, unavailable: 2, childEdits: 1 });
    expect(summarizeRecordedChanges([edit(1, { changes: [{ path: "app.ts", diff: patch }] }), edit(2, { changes: [{ path: "app.ts", diff: patch }] })]).files).toBe(2);
    expect(summarizeRecordedChanges([edit(1, { changes: [{ path: "/project/.env", diff: patch }] })]).additions).toBeNull();
  });
  it("recognizes the shared capture budget boundary and empty later patches", () => {
    const data = recordedEdits([edit(1, { truncated: true, changes: [{ path: "/one", diff: "x".repeat(32768) }, { path: "/two", diff: "" }] })]);
    expect(data.partial).toBe(true); expect(data.edits.every(value => value.partial)).toBe(true);
    expect(data.edits[1]!.stats.additions).toBeNull();
  });
});

describe("historical run changes use stored evidence only", () => {
  let root: string, store: HubStore, reader: HubRunChanges, chat: string, record: ReturnType<typeof createRunRecord>;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "recorded-diff-")); store = await HubStore.open(root); reader = new HubRunChanges(store);
    await store.db.run("INSERT INTO users VALUES('other','Other','member')");
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    chat = (await store.createConversation("owner", ["bot"], "Recorded changes", "create")).id;
    record = createRunRecord();
    for (let seq = 0; seq < 2; seq++) {
      recordRunEvent(record, { type: "tool_use", toolName: "Edit", toolUseId: `edit-${seq}` });
      recordRunEvent(record, { type: "tool_result", toolUseId: `edit-${seq}`, changes: [{ path: path.join(root, "project.ts"), diff: patch.replace("newCall", `change${seq}`) }] });
    }
    await new RunJournal(store).write("bot", { conversationId: chat, messageId: "msg", runId: record.id, entries: record.entries });
    await publish();
  });
  afterEach(async () => { await store.db.close(); await rm(root, { recursive: true, force: true }); });
  async function publish(status = "done", extra = {}) {
    await store.publishBotMessage("bot", { id: "msg", conversationId: chat, blocks: [{ type: "card", elements: [], extra: { nativeRun: { ...JSON.parse(JSON.stringify(summarizeRun(record, status))), ...extra } } }], status: status === "running" ? "streaming" : "complete" });
  }
  const read = (query = {}, user = "owner") => reader.read(user, "msg", { conversationId: chat, botId: "bot", ...query }, new AbortController().signal, async () => {});
  it("works without a Git repo, lists no patch bodies, and stays historical after file changes/deletion", async () => {
    const list = runChangesSchema.parse(await read()); expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("change0");
    expect(list.items[0]).toMatchObject({ additions: 4, deletions: 2, edits: 2 });
    const query = { key: list.items[0]!.key, revision: list.revision };
    const first = runChangeDetailSchema.parse(await read(query));
    expect(first.operations).toHaveLength(2); expect(JSON.stringify(first.hunks)).toContain("change0");
    await writeFile(path.join(root, "project.ts"), "unrelated later content");
    expect(await read(query)).toEqual(first);
    await rm(path.join(root, "project.ts")); expect(await read(query)).toEqual(first);
    expect(JSON.stringify((await read({ ...query, operation: first.operations[1]!.id })))).toContain("change1");
  });
  it("rejects wrong conversation, wrong bot, nonmember and per-user deletion", async () => {
    await expect(read({ conversationId: "elsewhere" })).rejects.toMatchObject({ code: "run_changes_forbidden" });
    await expect(read({ botId: "foreign" })).rejects.toMatchObject({ code: "run_changes_forbidden" });
    await expect(read({}, "other")).rejects.toMatchObject({ code: "conversation_forbidden" });
    await store.db.run("INSERT INTO message_deletions(user_id,message_id,deleted_at) VALUES(?,?,?)", ["owner", "msg", Date.now()]);
    await expect(read()).rejects.toMatchObject({ code: "message_not_found" });
  });
  it("retains historical visibility if the bot is later removed, without reading its workspace", async () => {
    await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='bot'", [chat]);
    expect(runChangesSchema.parse(await read()).items).toHaveLength(1);
  });
  it("requires refreshed metadata when evidence or details-availability changes", async () => {
    const list = runChangesSchema.parse(await read());
    await publish("done", { detailsUnavailable: true });
    await expect(read({ key: list.items[0]!.key, revision: list.revision })).rejects.toMatchObject({ code: "run_changes_changed" });
    expect(runChangesSchema.parse(await read()).partial).toBe(true);
  });
  it("distinguishes active, expired, missing and interrupted evidence", async () => {
    await publish("running"); expect(runChangesSchema.parse(await read()).state).toBe("active");
    await publish("done", { phase: "interrupted" }); expect(runChangesSchema.parse(await read()).partial).toBe(true);
    await publish("done", { endedAt: Date.now() - RUN_RETENTION_MS - 1 });
    expect(runChangesSchema.parse(await read())).toMatchObject({ state: "expired", partial: true, items: [] });
    await publish(); await store.db.run("DELETE FROM run_journal");
    expect(runChangesSchema.parse(await read()).state).toBe("not_recorded");
  });
  it("cancels promptly but retains admission until the queued operation settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const abort = new AbortController();
    const first = reader.read("owner", "msg", { conversationId: chat, botId: "bot" }, abort.signal, () => gate);
    const second = reader.read("owner", "msg", { conversationId: chat, botId: "bot" }, new AbortController().signal, () => gate);
    abort.abort(); await expect(first).rejects.toMatchObject({ code: "request_aborted" });
    await expect(read()).rejects.toMatchObject({ code: "run_changes_busy" });
    release(); await second;
    expect(runChangesSchema.parse(await read()).state).toBe("recorded");
  });
});
