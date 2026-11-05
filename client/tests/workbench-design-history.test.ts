import { describe, expect, it } from "vitest";
import { applyDesignFiles, decodeDesignFile, designTextFile, emptyDesign, type DesignDocument } from "../src/workbench-design.js";
import { diffText, editScript, planDesignHistory, planDesignRestore, designHistoryRows, type DesignHistoryIndex } from "../src/workbench-design-history.js";
import { bot, botPublish, memoryDesign } from "./design-session-fixture.js";

const text = (file: { base64: string }) => new TextDecoder().decode(decodeDesignFile(file));
const human = { by: "human" as const, user: { id: "user:u1", name: "Ann" } };
function wire(document: DesignDocument, path: string, content: string) { const file = designTextFile(content, "text/plain"); return { [path]: { base64: file.base64, contentType: file.contentType, ifMatch: document.files[path]?.sha256 ?? null } }; }
const write = (document: DesignDocument, path: string, content: string) => applyDesignFiles(document, wire(document, path, content));

describe("Baoyu history model", () => {
  it("diffs with a valid shortest edit script", () => {
    const random = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const next = random(round + 1), a = Array.from({ length: Math.floor(next() * 12) }, () => "abc"[Math.floor(next() * 3)]), b = Array.from({ length: Math.floor(next() * 12) }, () => "abc"[Math.floor(next() * 3)]);
      const ops = editScript(a, b)!, out: string[] = [];
      let i = 0, j = 0;
      for (const op of ops) { if (op === "=") { expect(a[i]).toBe(b[j]); out.push(b[j]); i++; j++; } else if (op === "-") i++; else out.push(b[j++]); }
      expect([i, j]).toEqual([a.length, b.length]);
      expect(out).toEqual(b);
    }
    const diff = diffText(new TextEncoder().encode("a\nb\nc\n"), new TextEncoder().encode("a\nB\nc\n"));
    expect(diff).toMatchObject({ added: 1, removed: 1, lines: [[" ", "a"], ["-", "b"], ["+", "B"], [" ", "c"]] });
    expect(diffText(new Uint8Array([0, 1]), null)).toMatchObject({ binary: true });
  });
  it("joins one person's nearby edits, keeps Bot requests and restores separate, and stores only bytes that left", () => {
    const d0 = emptyDesign("d"), d1 = write(d0, "project/a.txt", "one"), t = new Date("2026-11-03T00:00:00Z");
    const p1 = planDesignHistory({ before: d0, after: d1, author: human, now: t })!;
    expect(p1).toMatchObject({ expected: -1, put: {}, drop: [] });
    // Version 1 is the document as the history found it; the change is version 2.
    expect(p1.next.versions.map(version => [version.n, version.by, version.initial ?? false])).toEqual([[1, "system", true], [2, "human", false]]);
    const d2 = write(d1, "project/a.txt", "two"), p2 = planDesignHistory({ index: p1.next, before: d1, after: d2, author: human, now: new Date(t.getTime() + 10_000) })!;
    expect(p2.next.versions).toHaveLength(2); // joined into version 2
    // "one" existed only inside the joined version: no version can restore it, so it is not kept.
    expect(p2.put).toEqual({});
    const d3 = write(d2, "project/a.txt", "three"), p3 = planDesignHistory({ index: p2.next, before: d2, after: d3, author: { ...human, by: "agent", requestId: "r1" }, now: new Date(t.getTime() + 11_000) })!;
    expect(p3.next.versions).toHaveLength(3);
    // "two" is the output of version 1 and now leaves the document: kept once.
    expect(Object.keys(p3.put)).toEqual([d2.files["project/a.txt"].sha256]);
    expect(p3.next.objects).toEqual({ [d2.files["project/a.txt"].sha256]: 3 });
    const p4 = planDesignHistory({ index: p3.next, before: d3, after: write(d3, "project/a.txt", "four"), author: human, restoredFrom: 1, now: new Date(t.getTime() + 12_000) })!;
    expect(p4.next.versions.at(-1)).toMatchObject({ restoredFrom: 1 });
    // Nothing tracked changed (an asset upload) → no sidecar.
    const asset = { ...d3, revision: d3.revision + 1, files: { ...d3.files, ["project/assets/" + "a".repeat(32)]: { ...designTextFile("x"), sha256: d3.files["project/a.txt"].sha256 } } };
    expect(planDesignHistory({ index: p3.next, before: d3, after: asset as DesignDocument, author: human })).toBeUndefined();
  });
  it("folds the oldest versions to stay within count and byte budgets", () => {
    let doc = emptyDesign("d"), index: DesignHistoryIndex | undefined;
    for (let i = 0; i < 6; i++) {
      const next = write(doc, "project/a.txt", `v${i}`.repeat(200));
      const plan = planDesignHistory({ index, before: doc, after: next, author: { ...human, requestId: `r${i}` }, budget: { maxVersions: 3 } })!;
      index = plan.next; doc = next;
    }
    expect(index!.versions.map(version => version.n)).toEqual([5, 6, 7]);
    // The base (state after v3) and the superseded outputs of v4 and v5; v6 is live.
    expect(Object.keys(index!.objects)).toHaveLength(3);
    const big = write(doc, "project/a.txt", "z"), tight = planDesignHistory({ index, before: doc, after: big, author: { ...human, requestId: "big" }, budget: { maxObjectBytes: 10 } })!;
    expect(tight.next.versions).toHaveLength(1);
    expect(tight.next.versions[0]).toMatchObject({ objectsOmitted: true });
    expect(tight.next.objects).toEqual({});
  });
  it("records a gap after a save made without history instead of inventing content", () => {
    const d0 = emptyDesign("d"), d1 = write(d0, "project/a.txt", "one"), p1 = planDesignHistory({ before: d0, after: d1, author: human })!;
    const skipped = write(d1, "project/a.txt", "two"), d3 = write(skipped, "project/b.txt", "b");
    const plan = planDesignHistory({ index: p1.next, before: skipped, after: d3, author: { ...human, requestId: "after-gap" } })!;
    expect(plan.next.versions.map(version => version.gap ?? false)).toEqual([false, false, true, false]);
  });
  it("lists rows newest first with file operations", () => {
    const d0 = emptyDesign("d"), d1 = write(d0, "project/a.txt", "one"), p1 = planDesignHistory({ before: d0, after: d1, author: { ...human, requestId: "x" } })!;
    const d2 = applyDesignFiles(d1, { "project/a.txt": { delete: true, ifMatch: d1.files["project/a.txt"].sha256 } }), p2 = planDesignHistory({ index: p1.next, before: d1, after: d2, author: { ...human, requestId: "y" } })!;
    const { rows } = designHistoryRows(p2.next);
    expect(rows.slice(0, 2).map(row => [row.n, row.files])).toEqual([[3, [{ path: "project/a.txt", op: "deleted" }]], [2, [{ path: "project/a.txt", op: "added" }]]]);
    expect(rows[0]).toMatchObject({ current: true });
    expect(rows[2]).toMatchObject({ n: 1, initial: true, by: "system" });
    expect(rows[2].files.map(file => file.op)).toEqual(["added", "added"]);
  });
});

describe("Baoyu history in the session", () => {
  it("records each save atomically and restores a whole version as a new version", async () => {
    const { session, store } = memoryDesign();
    await session.publish("b1", 0, botPublish("first"), () => {}, bot);
    await session.publish("b2", 1, botPublish("second"), () => {}, bot);
    expect(store.history!.versions.map(version => [version.n, version.by, version.user.id, version.requestId])).toEqual([[1, "system", "system", undefined], [2, "agent", "bot:client_bot1", "b1"], [3, "agent", "bot:client_bot1", "b2"]]);
    const restored = await session.restore("r1", 2, { version: 2 }, bot, () => {});
    expect(restored).toMatchObject({ revision: 3, restoredFrom: 2, changed: ["project/note.txt"] });
    expect(text(store.design.files["project/note.txt"])).toBe("first");
    expect(store.history!.versions.at(-1)).toMatchObject({ n: 4, restoredFrom: 2, requestId: "r1", by: "agent" });
    // Same id + same content replays; another payload under that id is refused.
    expect(await session.restore("r1", 2, { version: 2 }, bot, () => {})).toMatchObject({ revision: 3, changed: [] });
    await expect(session.restore("r1", 2, { version: 3 }, bot, () => {})).rejects.toThrow("workbench_request_conflict");
    await expect(session.restore("r2", 2, { version: 3 }, bot, () => {})).rejects.toThrow("design_revision_conflict");
    // The initial version brings back the document as it was before the first recorded change.
    expect(await session.restore("r-initial", 3, { version: 1 }, bot, () => {})).toMatchObject({ revision: 4, restoredFrom: 1, changed: ["project/note.txt"] });
    expect(store.design.files["project/note.txt"]).toBeUndefined();
  });
  it("restores only chosen files, refuses unknown paths and missing objects", async () => {
    const { session, store } = memoryDesign();
    await session.publish("b1", 0, { files: { "project/a.txt": { content: "a1" }, "project/b.txt": { content: "b1" } } }, () => {}, bot);
    await session.publish("b2", 1, { files: { "project/a.txt": { content: "a2" }, "project/b.txt": { content: "b2" } } }, () => {}, bot);
    await session.restore("part", 2, { version: 2, paths: ["project/a.txt"] }, bot, () => {});
    expect([text(store.design.files["project/a.txt"]), text(store.design.files["project/b.txt"])]).toEqual(["a1", "b2"]);
    expect(store.history!.versions.at(-1)).toMatchObject({ restoredPart: true });
    await expect(session.restore("bad", 3, { version: 2, paths: ["project/none.txt"] }, bot, () => {})).rejects.toThrow("design_history_path_not_found");
    await expect(session.restore("asset", 3, { version: 2, paths: [`project/assets/${"a".repeat(32)}`] }, bot, () => {})).rejects.toThrow("design_history_path_not_found");
    store.objects.clear();
    await expect(session.restore("gone", 3, { version: 2, paths: ["project/b.txt"] }, bot, () => {})).rejects.toThrow("design_history_object_missing");
    expect(store.design.revision).toBe(3);
  });
  it("never lets history block a save, and the next save records the gap", async () => {
    const { session, store } = memoryDesign();
    await session.publish("b1", 0, botPublish("first"), () => {}, bot);
    store.quota = true;
    expect(await session.publish("b2", 1, botPublish("second"), () => {}, bot)).toMatchObject({ revision: 2 });
    expect(store.persisted.at(-1)).toBeUndefined(); // retried without the sidecar
    expect(session.getSnapshot().history).toMatchObject({ status: "gap" });
    store.quota = false;
    await session.publish("b3", 2, botPublish("third"), () => {}, bot);
    expect(store.history!.versions.map(version => version.gap ?? false)).toEqual([false, false, true, false]);
    expect(session.getSnapshot().history).toEqual({ status: "ok" });
    // Restoring back to a state lost in the gap fails honestly, not silently.
    await expect(session.restore("lost", 3, { version: 2 }, bot, () => {})).rejects.toThrow("design_history_object_missing");
    expect(store.design.revision).toBe(3);
  });
  it("keeps primary failures primary: only quota/history errors drop the sidecar; a corrupt index is reported", async () => {
    const { DesignSession } = await import("../src/workbench-design-session.js");
    const doc = emptyDesign("d");
    // A storage failure that is not about history must surface, not be retried without history.
    const broken = new DesignSession(structuredClone(doc), async () => structuredClone(doc), async (_expected, _next, sidecar) => { if (sidecar) throw new Error("local_cache_closed"); }, () => {}, { history: { load: async () => undefined, object: async () => undefined }, user: () => ({ id: "u1", name: "Ann" }) });
    await expect(broken.publish("x", 0, botPublish("x"), () => {}, bot)).rejects.toThrow("local_cache_closed");
    const corrupt = memoryDesign();
    corrupt.store.history = { schema: 1, revision: 0 } as never;
    await corrupt.session.publish("c1", 0, botPublish("still saved"), () => {}, bot);
    expect(corrupt.store.design.revision).toBe(1);
    expect(corrupt.session.getSnapshot().history).toMatchObject({ status: "unavailable" });
  });
  it("drops the sidecar only for QuotaExceededError; other history or CAS failures fail as they are", async () => {
    const { DesignSession } = await import("../src/workbench-design-session.js");
    for (const failure of [new Error("design_history_store_failed"), new Error("quota-ish wording only"), new Error("design_history_conflict")]) {
      const doc = emptyDesign("d"); let saved = 0;
      const session = new DesignSession(structuredClone(doc), async () => structuredClone(doc), async (_expected, _next, sidecar) => { if (sidecar) throw failure; saved++; }, () => {}, { history: { load: async () => undefined, object: async () => undefined }, user: () => ({ id: "u1", name: "Ann" }) });
      await expect(session.publish(`x-${failure.message}`, 0, botPublish("x"), () => {}, bot)).rejects.toThrow(failure.message);
      expect(saved).toBe(0);
      expect(session.document.revision).toBe(0);
    }
    // A guard that fails at the commit point is never retried without history either.
    const { session, store } = memoryDesign();
    store.quota = true;
    await expect(session.publish("cancelled", 0, botPublish("x"), () => { throw new Error("workbench_turn_ended"); }, bot)).rejects.toThrow("workbench_turn_ended");
    expect(store.design.revision).toBe(0);
  });
  it("editor saves are the user's; previews are read-only copies; restore from the panel settles the editor first", async () => {
    const { session, store } = memoryDesign();
    const response = await session.request("publish", { files: wire(store.design, "project/a.txt", "typed") }) as { status: number };
    expect(response.status).toBe(200);
    expect(store.history!.versions[0]).toMatchObject({ n: 1, initial: true });
    expect(store.history!.versions[1]).toMatchObject({ by: "human", user: { id: "user:u1", name: "Ann" } });
    await session.publish("b", 1, botPublish("bot"), () => {}, bot);
    const preview = await session.historyPreview(2);
    expect(preview.files["project/note.txt"]).toBeUndefined();
    expect(text(preview.files["project/a.txt"])).toBe("typed");
    let flushed = 0;
    session.bindEditor({ flush: async () => { flushed++; }, reload: async () => {}, retire: async () => {} });
    expect(await session.restoreFromUi(2)).toMatchObject({ changed: ["project/note.txt"], restoredFrom: 2 });
    expect(flushed).toBeGreaterThan(0);
    expect(store.history!.versions.at(-1)).toMatchObject({ by: "human", restoredFrom: 2 });
    const list = await session.historyList({ limit: 2 });
    expect(list.result.rows.map(row => row.n)).toEqual([4, 3]);
    expect(list.result.more).toBe(true);
    const diff = await session.historyDiff({ version: 3, path: "project/note.txt" });
    expect(diff.result.lines).toEqual([["+", "bot"]]);
    const readOnly = memoryDesign(undefined, { readOnly: true });
    await expect(readOnly.session.publish("x", 0, botPublish("no"), () => {}, bot)).rejects.toThrow("design_read_only");
    await expect(readOnly.session.restore("x", 0, { version: 1 }, bot, () => {})).rejects.toThrow("design_read_only");
    expect(await readOnly.session.request("publish", { files: {} })).toMatchObject({ status: 403 });
  });
  it("restore plan excludes assets and is a no-op when nothing differs", async () => {
    const d0 = emptyDesign("d"), d1 = write(d0, "project/a.txt", "one"), plan = planDesignHistory({ before: d0, after: d1, author: { ...human, requestId: "x" } })!;
    expect(await planDesignRestore(plan.next, { version: 2 }, d1, async () => undefined)).toEqual({});
    // Version 1 (initial) differs only by the file added afterwards.
    expect(await planDesignRestore(plan.next, { version: 1 }, d1, async () => undefined)).toEqual({ "project/a.txt": null });
    await expect(planDesignRestore(plan.next, { version: 9 }, d1, async () => undefined)).rejects.toThrow("design_history_version_not_found");
  });
});

describe("Baoyu history panel helpers and preview", () => {
  const word = (zh: string) => zh;
  it("restores within the document's own format only", async () => {
    const { session, store } = memoryDesign();
    await session.publish("b1", 0, botPublish("first"), () => {}, bot);
    // A history version naming a PPT index inside a canvas document (e.g. from a corrupted index) cannot be restored.
    const deck = designTextFile('{"v":4,"order":[]}', "application/json");
    store.history = { ...store.history!, versions: [...store.history!.versions, { n: 9, first: store.history!.versions[0].first, at: store.history!.versions[0].at, by: "agent", user: { id: "agent", name: "Bot" }, revision: 1, changes: { "project/deck.json": deck.sha256 } }], next: 10 };
    store.objects.set(deck.sha256, deck);
    await expect(session.restore("cross", 1, { version: 9, paths: ["project/deck.json"] }, bot, () => {})).rejects.toThrow("design_format_mismatch");
    expect(store.design.format ?? "canvas").toBe("canvas");
    expect(store.design.files["project/deck.json"]).toBeUndefined();
    expect(store.design.revision).toBe(1);
  });
  it("labels an incomplete history for the panel", async () => {
    const { historyStatusText } = await import("../src/WorkbenchDesignHistory.js");
    const word = (zh: string) => zh;
    expect(historyStatusText({ status: "gap", code: "QuotaExceededError" }, word)).toContain("未能记入历史");
    expect(historyStatusText({ status: "unavailable" }, word)).toContain("无法读取");
    expect(historyStatusText({ status: "ok" }, word)).toBeUndefined();
    expect(historyStatusText(undefined, word)).toBeUndefined();
  });
  it("labels authors and notes honestly", async () => {
    const { historyAuthorLabel, historyNotes, historyErrorText } = await import("../src/WorkbenchDesignHistory.js");
    expect(historyAuthorLabel({ by: "agent", name: "Helper Bot" }, word)).toBe("Helper Bot · Bot");
    expect(historyAuthorLabel({ by: "system", name: "" }, word)).toBe("系统记录");
    expect(historyNotes({ n: 3, first: "", at: "", by: "human", name: "Ann", userId: "user:u1", revision: 3, files: [], restoredFrom: 1, restoredPart: true, gap: true }, word)).toEqual(["部分恢复自 #1", "此处有未记录的修改"]);
    expect(historyErrorText(new Error("design_artboard_missing"), word)).toContain("恢复整版");
    expect(historyErrorText(new Error("design_revision_conflict"), word)).toContain("刚被修改");
    expect(historyErrorText(new Error("anything"), word)).toContain("设计保持原样");
  });
  it("previews in a session that refuses every write", async () => {
    const { DesignSession } = await import("../src/workbench-design-session.js");
    const preview = DesignSession.preview(emptyDesign("p"));
    expect(await preview.request("session", {})).toMatchObject({ status: 200, body: { canEdit: false, role: "viewer" } });
    expect(await preview.request("publish", { files: {} })).toMatchObject({ status: 403 });
    expect(await preview.request("db.write", { op: "set", path: "a/b", data: {} })).toMatchObject({ status: 403 });
    await expect(preview.publish("x", 0, botPublish("no"), () => {})).rejects.toThrow("design_read_only");
    await expect(preview.request("upload", { base64: "", contentType: "text/plain" })).rejects.toThrow("design_read_only");
  });
});
