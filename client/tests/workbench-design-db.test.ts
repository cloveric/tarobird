import { describe, expect, it } from "vitest";
import { decodeDesignFile, emptyDesign } from "../src/workbench-design.js";
import { canonicalJson, designDbPath, mergePatch, planDesignDbWrite } from "../src/workbench-design-db.js";
import { DesignLifecycleFence, sanitizePresencePatch } from "../src/workbench-design-collaboration.js";
import { memoryDesign } from "./design-session-fixture.js";

type Reply = { status: number; body: Record<string, any> };
const call = async (session: { request(op: string, payload: unknown): Promise<unknown> }, op: string, payload: unknown = {}) => await session.request(op, payload) as Reply;

describe("Baoyu DB channel (dashboard/motion)", () => {
  it("validates document paths and maps the caller's own documents", () => {
    expect(designDbPath("datasets/sales", {})).toEqual({ path: "datasets/sales", file: "project/db/datasets/sales.json" });
    expect(designDbPath("/data/users/me/runs/", { userId: "u1" }).path).toBe("data/users/u1/runs");
    for (const bad of ["datasets", "a/b/c", "a/__proto__", "a/..", "a/.hidden", "a/b c", "a/x:y", "", Array(18).fill("a").join("/")]) expect(() => designDbPath(bad, { userId: "u1" }), bad).toThrow();
    expect(() => designDbPath("data/users/me/x", {})).toThrow("design_db_user_required");
  });
  it("merge-patches with delete markers and rejects prototype keys at any depth", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: { __delete__: true }, e: 4 }, f: null })).toEqual({ a: 1, b: { d: 3, e: 4 } });
    expect(() => planDesignDbWrite(emptyDesign("d"), { op: "set", path: "a/b", data: { x: [{ constructor: 1 }] } }, { userId: "u1" })).toThrow("design_invalid_db_document");
    expect(() => planDesignDbWrite(emptyDesign("d"), { op: "set", path: "a/b", data: JSON.parse('{"__proto__":{"polluted":1}}') }, { userId: "u1" })).toThrow("design_invalid_db_document");
    expect(() => planDesignDbWrite(emptyDesign("d"), { op: "set", path: "a/b", data: { x: { __delete__: true } } }, { userId: "u1" })).toThrow("design_invalid_db_write");
    expect(() => planDesignDbWrite(emptyDesign("d"), { op: "set", path: "a/b", data: { text: "x".repeat(256 * 1024) } }, { userId: "u1" })).toThrow("design_db_too_large");
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] })).toBe(canonicalJson({ a: [2, { c: 0, d: 1 }], b: 1 }));
  });
  it("writes through the session: base CAS, own-write rebase, merged concurrent changes, one history version", async () => {
    const { session, store } = memoryDesign();
    const events: unknown[] = []; session.onEvent(event => events.push(event));
    expect((await call(session, "db.write", { op: "set", path: "datasets/sales", data: { rows: [1] } })).body).toMatchObject({ ok: true, writes: [{ op: "set", created: true }] });
    expect(store.design.revision).toBe(1);
    expect(JSON.parse(new TextDecoder().decode(decodeDesignFile(store.design.files["project/db/datasets/sales.json"])))).toEqual({ rows: [1] });
    expect((await call(session, "db-write", { op: "update", path: "datasets/sales", data: { title: "Q4" }, base: { rows: [1] } })).status).toBe(200);
    expect((await call(session, "db.read", { path: "datasets/sales" })).body).toEqual({ exists: true, data: { rows: [1], title: "Q4" } });
    expect((await call(session, "db.list")).body.docs).toEqual({ "datasets/sales": { rows: [1], title: "Q4" } });
    expect(events).toContainEqual({ type: "db-change", changes: [{ path: "datasets/sales", data: { rows: [1], title: "Q4" } }] });
    expect((await call(session, "db.write", { op: "delete", path: "datasets/none" })).body).toMatchObject({ ok: true, writes: [{ existed: false }] });
    expect((await call(session, "db.write", { op: "delete", path: "datasets/sales", base: { rows: [1], title: "Q4" } })).status).toBe(200);
    expect(store.design.files["project/db/datasets/sales.json"]).toBeUndefined();
    // The initial version plus one version: the user's nearby edits joined.
    expect(store.history!.versions.map(version => version.initial ?? false)).toEqual([true, false]);
    expect(store.design.revision).toBe(3); // the no-op delete wrote nothing
  });
  it("a page's delete then set before it hears back is its own race, not a conflict (dashboard save)", async () => {
    const { session, store } = memoryDesign();
    await call(session, "db.write", { op: "set", path: "data/users/me/check", data: { ok: false } });
    expect((await call(session, "db.write", { op: "delete", path: "data/users/me/check", base: { ok: false } })).status).toBe(200);
    // The runtime still holds the deleted document as its base.
    const again = await call(session, "db.write", { op: "set", path: "data/users/me/check", data: { ok: true }, base: { ok: false } });
    expect(again).toMatchObject({ status: 200, body: { ok: true } });
    expect(again.body.merged).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(decodeDesignFile(store.design.files["project/db/data/users/u1/check.json"])))).toEqual({ ok: true });
  });
  it("merges another writer's concurrent change field by field and reports the conflict", async () => {
    const { session, store } = memoryDesign();
    await call(session, "db.write", { op: "set", path: "datasets/sales", data: { rows: [1], title: "A", note: "n" } });
    // Someone else (another device through the source) changes the title and rows.
    const other = await session.requestForShare({ kind: "call", payload: { call: "db.write", payload: { op: "update", path: "datasets/sales", data: { title: "B", rows: [5] }, base: { rows: [1], title: "A", note: "n" } } },
      from: { userId: "u2", name: "Bo", role: "editor", requestId: "r-other" }, admit: async () => {}, pull: async () => { throw new Error("unused"); } }) as Reply;
    expect(other.status).toBe(200);
    // This page still has the old base; it changes rows and note.
    const mine = await call(session, "db.write", { op: "update", path: "datasets/sales", data: { rows: [2], note: "mine" }, base: { rows: [1], title: "A", note: "n" } });
    expect(mine).toMatchObject({ status: 200, body: { merged: true, conflicts: ["rows"] } });
    expect(JSON.parse(new TextDecoder().decode(decodeDesignFile(store.design.files["project/db/datasets/sales.json"])))).toEqual({ rows: [2], title: "B", note: "mine" });
    // A missing base cannot overwrite another writer's document.
    expect((await call(session, "db.write", { op: "set", path: "datasets/other", data: { a: 1 } })).status).toBe(200);
    await session.requestForShare({ kind: "call", payload: { call: "db.write", payload: { op: "set", path: "datasets/other", data: { a: 2 }, base: { a: 1 } } }, from: { userId: "u2", name: "Bo", role: "editor", requestId: "r2" }, admit: async () => {}, pull: async () => { throw new Error("unused"); } });
    expect((await call(session, "db.write", { op: "set", path: "datasets/other", data: { a: 3 } })).status).toBe(409);
  });
  it("lists one collection keyed by document id", async () => {
    const { session } = memoryDesign();
    await call(session, "db.write", { op: "set", path: "film/meta", data: { t: 1 } });
    await call(session, "db.write", { op: "set", path: "film/meta/scenes/s1", data: { n: 1 } });
    expect((await call(session, "db.list", { path: "film" })).body.docs).toEqual({ meta: { t: 1 } });
    expect((await call(session, "db.list", { path: "film/meta/scenes" })).body.docs).toEqual({ s1: { n: 1 } });
    expect(Object.keys((await call(session, "db.list")).body.docs).sort()).toEqual(["film/meta", "film/meta/scenes/s1"]);
    expect((await call(session, "db.list", { path: "film/meta" })).status).toBe(400);
  });
  it("keeps another person's documents private and Bots read-only there", async () => {
    const { session } = memoryDesign();
    expect((await call(session, "db.write", { op: "set", path: "data/users/me/prefs", data: { dark: true } })).status).toBe(200);
    expect((await call(session, "db.read", { path: "data/users/u1/prefs" })).body).toEqual({ exists: true, data: { dark: true } });
    expect((await call(session, "db.write", { op: "set", path: "data/users/u2/prefs", data: {} })).status).toBe(403);
    const doc = await session.refresh();
    expect(planDesignDbWrite.bind(null, doc, { op: "set", path: "data/users/u1/prefs", data: {}, base: { dark: true } }, { bot: true })).toThrow("design_db_forbidden");
    const viewer = memoryDesign(undefined, { role: () => "viewer" });
    expect((await call(viewer.session, "db.write", { op: "set", path: "a/b", data: {} })).status).toBe(403);
    expect((await call(viewer.session, "db.read", { path: "a/b" })).body).toEqual({ exists: false });
  });
});

describe("Baoyu collaboration guards", () => {
  it("relays bounded presence and never a page-chosen name", () => {
    expect(sanitizePresencePatch({ who: { n: "Owner", c: "#d25f25" }, cursor: { x: 1, y: 2 } })).toEqual({ who: { c: "#d25f25" }, cursor: { x: 1, y: 2 } });
    expect(sanitizePresencePatch({ who: { c: "red;background:url(x)" } })).toEqual({ who: {} });
    expect(sanitizePresencePatch({ cursor: null }, { cursor: { x: 1 } })).toEqual({});
    expect(sanitizePresencePatch(JSON.parse('{"constructor":1}'))).toBeUndefined();
    expect(sanitizePresencePatch({ "bad key": 1 })).toBeUndefined();
    expect(sanitizePresencePatch({ big: "x".repeat(5000) })).toBeUndefined();
    expect(sanitizePresencePatch(Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`k${i}`, i])))).toBeUndefined();
  });
  it("does not let a late event resurrect a retired document", () => {
    const fence = new DesignLifecycleFence();
    expect(fence.accepts("d", 1)).toBe(true);
    fence.retire("d", 3);
    expect([fence.accepts("d", 2), fence.accepts("d", 3), fence.accepts("d", 4)]).toEqual([false, false, true]);
    fence.retire("d", 1);
    expect(fence.accepts("d", 3)).toBe(false);
  });
});
