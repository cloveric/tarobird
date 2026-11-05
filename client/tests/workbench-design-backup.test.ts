import { describe, expect, it } from "vitest";
import { createDesignBackup, parseDesignBackup, serializeDesignBackup, type DesignBackupContent } from "../src/workbench-design-backup.js";
import { applyDesignFiles, decodeDesignFile, designTextFile, emptyDesignDocument, type DesignDocument } from "../src/workbench-design.js";
import { planDesignHistory, planDesignRestore, type DesignHistoryIndex } from "../src/workbench-design-history.js";
import type { DesignCommentsDoc } from "../src/workbench-design-comments.js";
const content = (file: { base64: string }) => new TextDecoder().decode(decodeDesignFile(file));
const path = "project/Main.dc.html", original = "<h1>Original</h1>", edited = "<h1>Edited</h1>", current = "<h1>Current</h1>";
function write(document: DesignDocument, text: string) {
  const file = designTextFile(text, "text/html");
  return applyDesignFiles(document, { [path]: { base64: file.base64, contentType: file.contentType, ifMatch: document.files[path].sha256 } });
}
function fixture(): DesignBackupContent {
  const d0 = emptyDesignDocument("old-design", "Old name"), before = write(d0, original), first = write(before, edited), document = write(first, current);
  const h1 = planDesignHistory({ before, after: first, author: { by: "agent", user: { id: "bot:trusted", name: "Trusted Bot" }, requestId: "first" } })!;
  const h2 = planDesignHistory({ index: h1.next, before: first, after: document, author: { by: "human", user: { id: "user:owner", name: "Owner" }, requestId: "second" } })!;
  const objects = { ...h1.put, ...h2.put }; for (const sha of h2.drop) delete objects[sha];
  document.receipts.push({ id: "old-request", fingerprint: "fingerprint", revision: document.revision });
  const comments: DesignCommentsDoc = { schema: 1, revision: 7, receipts: [{ id: "old-comment", fingerprint: "x", revision: 7 }], threads: [{ id: "c_0123456789", anchor: "main:title", label: "Title", location: { file: path }, status: "open", createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z", agent: { status: "delivered", sentAt: "2026-11-03T00:00:00Z", messageId: "old-message" }, messages: [{ id: "m_0123456789", author: { kind: "agent", name: "Trusted Bot", principal: "bot:trusted" }, text: "Keep the words", at: "2026-11-03T00:00:00Z" }] }] };
  return { title: "History project", document, comments, history: h2.next, objects };
}

describe("complete Baoyu project backup", () => {
  it.each(["canvas", "slides"] as const)("imports existing v1 %s backups under a new identity", format => {
    const document = emptyDesignDocument("old", "Legacy", format); document.receipts.push({ id: "receipt", fingerprint: "x", revision: 0 });
    const imported = parseDesignBackup(JSON.stringify({ format: "tarobot-design", version: 1, title: "Legacy", document }), "new");
    expect(imported).toMatchObject({ title: "Legacy", document: { id: "new", revision: 0, receipts: [] } });
    expect(imported.document.files).toEqual(document.files); expect(imported.document.format ?? "canvas").toBe(format);
    expect(imported.history).toBeUndefined(); expect(imported.comments).toBeUndefined(); expect(document.receipts).toHaveLength(1);
  });

  it("round-trips comments, content and restorable history without trusting exported identities or receipts", async () => {
    const input = fixture(), exported = createDesignBackup(input), imported = parseDesignBackup(serializeDesignBackup(input), "new-design");
    expect(exported).toMatchObject({ format: "tarobot-design", version: 2 });
    expect(exported.comments!.threads[0].messages[0].author.principal).toBe("bot:trusted");
    expect(imported.document).toMatchObject({ id: "new-design", revision: 0, receipts: [] });
    expect(imported.document.files).toEqual(input.document.files);
    expect(imported.comments).toMatchObject({ revision: 0, receipts: [] });
    expect(imported.comments!.threads[0].agent).toBeUndefined();
    expect(imported.comments!.threads[0].messages[0]).toMatchObject({ text: "Keep the words", author: { kind: "user", name: "Trusted Bot", principal: expect.stringMatching(/^imported:/) } });
    expect(imported.history).toMatchObject({ revision: 0, baseRevision: 0 });
    for (const version of imported.history!.versions) {
      expect(version.by).toBe("human"); expect(version.user.id).toMatch(/^imported:/); expect(version.revision).toBe(0); expect(version.requestId).toBeUndefined();
    }
    const baseline = await planDesignRestore(imported.history, { version: 1 }, imported.document, async sha => imported.objects![sha]);
    expect(content(baseline[path]!)).toBe(original);
    const changes = await planDesignRestore(imported.history, { version: 2 }, imported.document, async sha => imported.objects![sha]);
    expect(content(changes[path]!)).toBe(edited);
    expect(() => createDesignBackup(imported)).not.toThrow();
    expect(input.document.id).toBe("old-design"); expect(input.comments!.threads[0].agent).toBeDefined();
  });

  it("keeps a documented quota gap explicit across export/import instead of manufacturing old bytes", () => {
    const input = fixture();
    input.document = write(input.document, "<h1>History quota skipped this edit</h1>");
    const imported = parseDesignBackup(serializeDesignBackup(input), "gap-import");
    expect(imported.history!.versions.at(-1)).toMatchObject({ gap: true, by: "human", revision: 0 });
    expect(imported.history!.versions.at(-1)!.changes[path]).toBe(input.document.files[path].sha256);
    expect(() => createDesignBackup(imported)).not.toThrow();
  });

  it("accepts intentionally omitted history bytes but preserves the omission flag", () => {
    const input = fixture(); input.history!.objects = {}; input.objects = {}; input.history!.versions[0].objectsOmitted = true;
    const imported = parseDesignBackup(serializeDesignBackup(input), "omitted-import");
    expect(imported.history!.versions[0].objectsOmitted).toBe(true); expect(imported.objects).toEqual({});
  });

  it.each(["missing", "hash", "size", "base64"] as const)("rejects %s history object corruption before storage", kind => {
    const input = fixture(), hash = Object.keys(input.objects!)[0], file = input.objects![hash];
    if (kind === "missing") delete input.objects![hash];
    if (kind === "hash") file.sha256 = "a".repeat(64);
    if (kind === "size") file.size++;
    if (kind === "base64") file.base64 = btoa("different bytes");
    expect(() => createDesignBackup(input)).toThrow(/design_backup_object_(?:missing|corrupt)/);
  });

  it("rejects unmarked lost history bytes and detached extra objects", () => {
    const input = fixture(); input.history!.objects = {}; input.objects = {};
    expect(() => createDesignBackup(input)).toThrow("design_backup_object_missing");
    const extra = fixture(), file = designTextFile("not in any version"); extra.objects![file.sha256] = file; extra.history!.objects[file.sha256] = file.size;
    expect(() => createDesignBackup(extra)).toThrow("design_backup_orphan_objects");
    expect(() => createDesignBackup({ title: "No history", document: extra.document, objects: extra.objects })).toThrow("design_backup_orphan_objects");
  });

  it.each(["order", "next", "future", "timestamp", "head"] as const)("rejects a %s inconsistency in the history index", kind => {
    const input = fixture(), history = input.history!;
    if (kind === "order") history.versions.reverse();
    if (kind === "next") history.next = history.versions.at(-1)!.n;
    if (kind === "future") history.versions.at(-1)!.revision = input.document.revision + 1;
    if (kind === "timestamp") history.versions[0].at = "not-a-date";
    if (kind === "head") history.versions.at(-1)!.changes[path] = history.versions[0].changes[path];
    expect(() => createDesignBackup(input)).toThrow("design_backup_history_invalid");
  });

  it("rejects history capacity overflow before decoding object bytes", () => {
    const input = fixture(); input.history!.objects[Object.keys(input.history!.objects)[0]] = 64 * 1024 * 1024 + 1;
    expect(() => createDesignBackup(input)).toThrow("design_backup_history_limit");
  });

  it("rejects executable envelope keys, invalid new IDs, current-file corruption and invalid JSON", () => {
    const input = fixture();
    expect(() => parseDesignBackup(JSON.stringify({ ...createDesignBackup(input), hooks: { command: "execute" } }), "new")).toThrow();
    expect(() => parseDesignBackup(serializeDesignBackup(input), "../foreign")).toThrow();
    const bad = fixture(); bad.document.files[path].base64 = btoa("corrupt"); expect(() => createDesignBackup(bad)).toThrow("design_file_corrupt");
    expect(() => parseDesignBackup("{", "new")).toThrow("design_invalid_backup");
  });
});
