import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";
import type { ClientCache, Identity } from "../src/storage.js";
import type { DiffReviewNote, DiffReviewScope } from "../src/diff-review-draft.js";

const html = `<!doctype html><html><body><script type="module">
import { ClientCache } from '/src/storage.ts';
import { RUN_REVIEW_HEAD, reviewAnchor, reviewReferenceKey } from '/src/diff-review-reference.ts';
import { storedDiffReviewDraftSchema } from '/src/diff-review-draft.ts';
const identity={deviceId:'device',hubPublicKey:'hub',publicKey:'key',name:'test',routes:[]};
const cache=new ClientCache('diff-review-storage'); await cache.initializeIdentity(identity);
const scope={conversationId:'conversation',botId:'bot'};
const note=(id='one',comment='请补充错误处理')=>({id,path:'src/example.ts',head:'a'.repeat(40),side:'new',start:2,end:3,excerpt:'const first = 1;\\nreturn first;',comment});
window.reviewFixture={cache,ClientCache,identity,scope,note,RUN_REVIEW_HEAD,reviewAnchor,reviewReferenceKey,storedDiffReviewDraftSchema};document.body.append('ready');
</script></body></html>`;
type Fixture = { cache: ClientCache; ClientCache: typeof ClientCache; identity: Identity; scope: DiffReviewScope; note: (id?: string, comment?: string) => DiffReviewNote };
let server: ViteDevServer, url: string;
test.use({ serviceWorkers: "block" });
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "diff-review-storage-harness", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__review_storage") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__review_storage", html)); });
  } }], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__review_storage";
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await expect(page.locator("body")).toContainText("ready"); });

test("run references survive old-client comment revisions and ACKs without changing the v1 record", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).reviewFixture, note = { ...f.note(), head: f.RUN_REVIEW_HEAD };
    const refs = { [note.id]: { messageId: "message", runId: "run", fileKey: "a".repeat(64), operation: "1-0", anchor: f.reviewAnchor(note) } };
    await f.cache.saveDiffReviewDraft(f.scope, f.identity, [note], undefined, refs);
    const db = await f.cache.db, key = 'diff-review-draft:["conversation","bot"]';
    const old = JSON.parse(await db.get("settings", key));
    const valid = f.storedDiffReviewDraftSchema.safeParse(old).success;
    old.notes[0].comment = "old tab edit"; old.revision = "old-revision"; old.noteVersions[note.id] = "old-version";
    await db.put("settings", JSON.stringify(old), key);
    const loaded = await f.cache.diffReviewDraft(f.scope, f.identity);
    const pending = await f.cache.enqueueDiffReview(f.scope, f.identity, loaded.revision);
    // Corrupt optional reference data cannot roll back a delivered outbox ACK.
    const sidecarKey = f.reviewReferenceKey(f.scope), sidecar = JSON.parse(await db.get("settings", sidecarKey));
    sidecar.refs[note.id].anchor = "different file"; await db.put("settings", JSON.stringify(sidecar), sidecarKey);
    let error = ""; try { await f.cache.diffReviewDraft(f.scope, f.identity); } catch (value) { error = (value as Error).message; }
    await f.cache.removeOutbox(pending.frame.clientMsgId, false, true);
    return { valid, loaded, text: pending.frame.text, error, after: await f.cache.diffReviewDraft(f.scope, f.identity), outbox: await f.cache.outbox() };
  });
  expect(result.valid).toBe(true); expect(result.loaded.references.one.messageId).toBe("message");
  expect(result.text).toContain("运行 run"); expect(result.text).toContain("old tab edit");
  expect(result.error).toBe("diff_review_reference_missing"); expect(result.after.notes).toEqual([]); expect(result.outbox).toEqual([]);
});

test("run references cannot be reassigned and failed saves do not partly change them", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as any).reviewFixture, note = { ...f.note(), head: f.RUN_REVIEW_HEAD };
    const ref = { messageId: "message", runId: "run", fileKey: "a".repeat(64), operation: "1-0", anchor: f.reviewAnchor(note) };
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [note], undefined, { [note.id]: ref });
    let error = ""; try { await f.cache.saveDiffReviewDraft(f.scope, f.identity, [{ ...note, comment: "must not persist" }], saved.revision, { [note.id]: { ...ref, runId: "other" } }); } catch (value) { error = (value as Error).message; }
    return { error, after: await f.cache.diffReviewDraft(f.scope, f.identity) };
  });
  expect(result.error).toBe("diff_review_reference_changed"); expect(result.after.notes[0].comment).toBe("请补充错误处理"); expect(result.after.references.one.runId).toBe("run");
});

test("review notes reload independently of normal text, files, host, conversation and Bot", async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    await f.cache.saveDraft(f.scope.conversationId, "普通文字草稿");
    await f.cache.saveConversationDraft(f.scope.conversationId, { files: [new File([new Uint8Array([0, 1, 255])], "keep.bin")], previewStyle: "card" }, f.identity);
    await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note("one", "")]);
  });
  await page.reload(); await expect(page.locator("body")).toContainText("ready");
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const other = new f.ClientCache("diff-review-other-host"), identity = { ...f.identity, hubPublicKey: "other" };
    try {
      await other.initializeIdentity(identity);
      const files = (await f.cache.conversationDraft(f.scope.conversationId, f.identity)).draft.files;
      return { review: await f.cache.diffReviewDraft(f.scope, f.identity), text: await f.cache.draft(f.scope.conversationId),
        bytes: Array.from(new Uint8Array(await files[0]!.arrayBuffer())),
        otherBot: await f.cache.diffReviewDraft({ ...f.scope, botId: "another-bot" }, f.identity),
        otherConversation: await f.cache.diffReviewDraft({ ...f.scope, conversationId: "another-conversation" }, f.identity),
        otherHost: await other.diffReviewDraft(f.scope, identity) };
    } finally { other.close(); }
  });
  expect(result.review.notes).toHaveLength(1); expect(result.review.notes[0]!.comment).toBe("");
  expect(result.text).toBe("普通文字草稿"); expect(result.bytes).toEqual([0, 1, 255]);
  expect(result.otherBot.notes).toEqual([]); expect(result.otherConversation.notes).toEqual([]); expect(result.otherHost.notes).toEqual([]);
});

test("pending reload reuses its original immutable ID and frame without resetting a failed entry", async ({ page }) => {
  const before = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
    await f.cache.fail(queued.frame.clientMsgId, "permission_denied"); return queued.frame;
  });
  await page.reload(); await expect(page.locator("body")).toContainText("ready");
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const reused = await f.cache.enqueueDiffReview(f.scope, f.identity, "stale-revision");
    let mutationError = ""; try { await f.cache.enqueue({ ...reused.frame, text: "changed" }); } catch (error) { mutationError = (error as Error).message; }
    await f.cache.enqueue(reused.frame);
    const failed = await f.cache.outbox();
    const retried = await f.cache.retryDiffReview(f.scope, f.identity, reused.frame.clientMsgId);
    return { reused, mutationError, failed, retried, outbox: await f.cache.outbox() };
  });
  expect(result.reused.frame).toEqual(before); expect(result.reused.reused).toBe(true);
  expect(result.reused.draft.pendingState).toBe("failed"); expect(result.reused.draft.notes).toHaveLength(1);
  expect(result.mutationError).toBe("diff_review_pending_immutable"); expect(result.failed[0]!.error).toBe("permission_denied");
  expect(result.retried.frame).toEqual(before); expect(result.retried.draft.pendingState).toBe("queued");
  expect(result.outbox).toHaveLength(1); expect(result.outbox[0]!.error).toBeUndefined();
});

test("new messages follow the locale while a locale change never rewrites a pending retry", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const { setLocale } = await import("/src/i18n.ts");
    const { makeDiffReviewExcerpt } = await import("/src/diff-review-draft.ts");
    setLocale("en");
    const marker = makeDiffReviewExcerpt("x".repeat(500));
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
    await f.cache.fail(queued.frame.clientMsgId, "retry"); setLocale("zh");
    const retried = await f.cache.retryDiffReview(f.scope, f.identity, queued.frame.clientMsgId);
    return { marker, queued: queued.frame, retried: retried.frame };
  });
  expect(result.marker).toContain("[truncated]");
  expect(result.queued.text).toContain("Please review and update the code according to these comments:");
  expect(result.queued.text).toContain("File: "); expect(result.queued.text).toContain("Code excerpt:");
  expect(result.queued.text).toContain("请补充错误处理"); expect(result.retried).toEqual(result.queued);
});

test("accepted ACK clears unchanged notes while preserving concurrent changes, new notes and ABA", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture, other = new f.ClientCache(f.cache.databaseName);
    try {
      const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note("unchanged"), f.note("changed"), f.note("aba"), f.note("readded")]);
      const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
      const updated = await other.saveDiffReviewDraft(f.scope, f.identity, [f.note("unchanged"), f.note("changed", "new text"), f.note("aba", "middle"), f.note("new")], queued.draft.revision);
      const again = await other.saveDiffReviewDraft(f.scope, f.identity, [f.note("unchanged"), f.note("changed", "new text"), f.note("aba"), f.note("new"), f.note("readded")], updated.revision);
      await f.cache.acknowledge(queued.frame.clientMsgId, true);
      const after = await other.diffReviewDraft(f.scope, f.identity);
      let stale = ""; try { await other.saveDiffReviewDraft(f.scope, f.identity, [], again.revision); } catch (error) { stale = (error as Error).message; }
      await f.cache.acknowledge(queued.frame.clientMsgId, true);
      return { after, stale, afterDuplicate: await other.diffReviewDraft(f.scope, f.identity), outbox: await f.cache.outbox() };
    } finally { other.close(); }
  });
  expect(result.after.notes.map(note => note.id)).toEqual(["changed", "aba", "new", "readded"]);
  expect(result.after.pending).toBeUndefined(); expect(result.stale).toBe("draft_changed_elsewhere");
  expect(result.afterDuplicate).toEqual(result.after); expect(result.outbox).toEqual([]);
});

test("non-message ACK stays uncertain; explicit retry reuses its ID and failed discard preserves notes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
    let inProgress = ""; try { await f.cache.abandonDiffReview(f.scope, f.identity, queued.frame.clientMsgId); } catch (error) { inProgress = (error as Error).message; }
    await f.cache.acknowledge(queued.frame.clientMsgId);
    const uncertain = await f.cache.diffReviewDraft(f.scope, f.identity);
    const reused = await f.cache.enqueueDiffReview(f.scope, f.identity, uncertain.revision), missing = await f.cache.outbox();
    const retry = await f.cache.retryDiffReview(f.scope, f.identity, queued.frame.clientMsgId);
    await f.cache.fail(queued.frame.clientMsgId, "rejected"); await f.cache.discardFailed(queued.frame.clientMsgId);
    const abandoned = await f.cache.diffReviewDraft(f.scope, f.identity);
    const next = await f.cache.enqueueDiffReview(f.scope, f.identity, abandoned.revision);
    await f.cache.acknowledge(next.frame.clientMsgId);
    const manual = await f.cache.abandonDiffReview(f.scope, f.identity, next.frame.clientMsgId);
    return { inProgress, uncertain, reused, missing, retry, abandoned, next, manual };
  });
  expect(result.inProgress).toBe("diff_review_send_in_progress"); expect(result.uncertain.pendingState).toBe("uncertain");
  expect(result.reused.frame.clientMsgId).toBe(result.retry.frame.clientMsgId); expect(result.missing).toEqual([]);
  expect(result.retry.draft.pendingState).toBe("queued"); expect(result.abandoned.pending).toBeUndefined(); expect(result.abandoned.notes).toHaveLength(1);
  expect(result.next.frame.clientMsgId).not.toBe(result.retry.frame.clientMsgId); expect(result.manual.pending).toBeUndefined(); expect(result.manual.notes).toHaveLength(1);
});

test("accepted ACK reconciles a pending receipt after another cache removed its outbox entry", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture, other = new f.ClientCache(f.cache.databaseName);
    try {
      const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
      const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
      await other.acknowledge(queued.frame.clientMsgId);
      await f.cache.acknowledge(queued.frame.clientMsgId, true);
      const after = await f.cache.diffReviewDraft(f.scope, f.identity);
      let aba = ""; try { await other.saveDiffReviewDraft(f.scope, f.identity, [f.note()]); } catch (error) { aba = (error as Error).message; }
      return { after, aba };
    } finally { other.close(); }
  });
  expect(result.after.notes).toEqual([]); expect(result.after.pending).toBeUndefined(); expect(result.after.revision).toBeTruthy(); expect(result.aba).toBe("draft_changed_elsewhere");
});

test("local failed-send abandonment remains available after device revocation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
    await f.cache.fail(queued.frame.clientMsgId, "device_revoked"); await f.cache.markIdentityRevoked(f.identity);
    const after = await f.cache.abandonDiffReview(f.scope, f.identity, queued.frame.clientMsgId);
    return { after, outbox: await f.cache.outbox() };
  });
  expect(result.after.notes).toHaveLength(1); expect(result.after.pending).toBeUndefined(); expect(result.outbox).toEqual([]);
});

test("identity, revocation, reset and concurrent CAS fence review writes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture, other = new f.ClientCache(f.cache.databaseName);
    const error = async (operation: () => Promise<unknown>) => { try { await operation(); return ""; } catch (value) { return (value as Error).message; } };
    try {
      const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
      const race = await Promise.allSettled([f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note("first")], saved.revision), other.saveDiffReviewDraft(f.scope, f.identity, [f.note("second")], saved.revision)]);
      const foreign = await error(() => f.cache.diffReviewDraft(f.scope, { ...f.identity, deviceId: "other-device" }));
      await f.cache.markIdentityRevoked(f.identity);
      const retained = await f.cache.diffReviewDraft(f.scope, f.identity);
      const revoked = await error(() => f.cache.saveDiffReviewDraft(f.scope, f.identity, [], retained.revision));
      await f.cache.beginReset(); const reset = await error(() => other.saveDiffReviewDraft(f.scope, f.identity, [], retained.revision));
      const fresh = new f.ClientCache(f.cache.databaseName);
      try {
        await fresh.finishReset(); const identity = { ...f.identity, deviceId: "new-device" }; await fresh.initializeIdentity(identity);
        return { winners: race.filter(entry => entry.status === "fulfilled").length, foreign, retained: retained.notes.length, revoked, reset,
          old: await error(() => fresh.diffReviewDraft(f.scope, f.identity)), clean: await fresh.diffReviewDraft(f.scope, identity) };
      } finally { fresh.close(); }
    } finally { other.close(); }
  });
  expect(result).toEqual({ winners: 1, foreign: "draft_identity_changed", retained: 1, revoked: "draft_identity_revoked", reset: "local_reset_in_progress", old: "draft_identity_changed", clean: { notes: [] } });
});

test("transaction failure cannot commit half a pinned pending message", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "outbox") throw new DOMException("forced quota", "QuotaExceededError");
      return original.apply(this, args);
    };
    let error = "";
    try { await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision); } catch (value) { error = (value as Error).name; }
    finally { IDBObjectStore.prototype.put = original; }
    const after = await f.cache.diffReviewDraft(f.scope, f.identity), outbox = await f.cache.outbox();
    const retry = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision);
    return { saved, error, after, outbox, retry };
  });
  expect(result.error).toBe("QuotaExceededError"); expect(result.after).toEqual(result.saved); expect(result.outbox).toEqual([]);
  expect(result.retry.reused).toBe(false); expect(result.retry.draft.pendingState).toBe("queued");
});

test("empty comments and complete message UTF-8 overflow preserve notes without queue mutations", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const error = async (operation: () => Promise<unknown>) => { try { await operation(); return ""; } catch (value) { return (value as Error).message; } };
    const empty = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note("empty", "")]);
    const incomplete = await error(() => f.cache.enqueueDiffReview(f.scope, f.identity, empty.revision));
    const huge = await f.cache.saveDiffReviewDraft(f.scope, f.identity, Array.from({ length: 50 }, (_, index) => f.note(`n-${index}`, "界".repeat(2000))), empty.revision);
    const overflow = await error(() => f.cache.enqueueDiffReview(f.scope, f.identity, huge.revision));
    return { incomplete, overflow, before: huge.revision, after: await f.cache.diffReviewDraft(f.scope, f.identity), outbox: await f.cache.outbox() };
  });
  expect(result.incomplete).toBe("diff_review_comment_required"); expect(result.overflow).toMatch(/^diff_review_message_too_large:\d+:204800$/);
  expect(result.after.revision).toBe(result.before); expect(result.after.notes).toHaveLength(50); expect(result.after.pending).toBeUndefined(); expect(result.outbox).toEqual([]);
});

test("review reads use readonly transactions and retain the reset fence", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
    const modes: string[] = [], original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
      modes.push(args[1] ?? "readonly"); return original.apply(this, args);
    };
    let draft;
    try { draft = await f.cache.diffReviewDraft(f.scope, f.identity); }
    finally { IDBDatabase.prototype.transaction = original; }
    await f.cache.beginReset();
    let error = ""; try { await f.cache.diffReviewDraft(f.scope, f.identity); } catch (value) { error = (value as Error).message; }
    return { modes, notes: draft.notes.length, error };
  });
  expect(result).toEqual({ modes: ["readonly"], notes: 1, error: "local_reset_in_progress" });
});

test("dedicated review signals cover receipts and identity lifecycle without ordinary draft noise", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    let stage = "unrelated"; const events: string[] = [], otherEvents: string[] = [];
    const unsubscribe = f.cache.subscribeDiffReviews(f.scope, () => events.push(stage));
    const unsubscribeOther = f.cache.subscribeDiffReviews({ ...f.scope, botId: "other" }, () => otherEvents.push(stage));
    try {
      await f.cache.saveDraft(f.scope.conversationId, "ordinary text");
      await f.cache.enqueue({ v: 1, type: "message.send", clientMsgId: "ordinary", conversationId: f.scope.conversationId, text: "normal", attachments: [], previewUrl: null });
      await f.cache.fail("ordinary", "rejected"); await f.cache.retryFailed("ordinary"); await f.cache.acknowledge("ordinary", true);
      stage = "save"; const saved = await f.cache.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
      stage = "queue"; const queued = await f.cache.enqueueDiffReview(f.scope, f.identity, saved.revision), id = queued.frame.clientMsgId;
      stage = "retryable"; await f.cache.retryableFailure(id, "retry exhausted");
      stage = "fail"; await f.cache.fail(id, "rejected");
      stage = "retry"; await f.cache.retryFailed(id);
      stage = "uncertain"; await f.cache.acknowledge(id);
      stage = "retry-review"; await f.cache.retryDiffReview(f.scope, f.identity, id);
      stage = "fail"; await f.cache.fail(id, "rejected");
      stage = "abandon"; const abandoned = await f.cache.abandonDiffReview(f.scope, f.identity, id);
      stage = "queue"; const next = await f.cache.enqueueDiffReview(f.scope, f.identity, abandoned.revision);
      stage = "fail"; await f.cache.fail(next.frame.clientMsgId, "rejected");
      stage = "discard"; await f.cache.discardFailed(next.frame.clientMsgId);
      const retained = await f.cache.diffReviewDraft(f.scope, f.identity);
      stage = "queue"; const final = await f.cache.enqueueDiffReview(f.scope, f.identity, retained.revision);
      stage = "accepted"; await f.cache.acknowledge(final.frame.clientMsgId, true);
      stage = "revoked"; await f.cache.markIdentityRevoked(f.identity);
      stage = "logout"; await f.cache.forgetIdentity();
      stage = "identity"; await f.cache.saveIdentity({ ...f.identity, deviceId: "next-device" });
      return { events, otherEvents };
    } finally { unsubscribe(); unsubscribeOther(); }
  });
  expect(result.events).toEqual(["save", "queue", "retryable", "fail", "retry", "uncertain", "retry-review", "fail", "abandon", "queue", "fail", "discard", "queue", "accepted", "revoked", "logout", "identity"]);
  expect(result.otherEvents).toEqual(["revoked", "logout", "identity"]);
});

test("another cache instance broadcasts scoped review changes and logout", async ({ page }) => {
  await page.evaluate(async () => {
    const f = (window as unknown as { reviewFixture: Fixture }).reviewFixture;
    const other = new f.ClientCache(f.cache.databaseName);
    const state = (window as any).reviewSignalFixture = { count: 0, other };
    state.unsubscribe = f.cache.subscribeDiffReviews(f.scope, () => state.count++);
    await other.saveDiffReviewDraft({ ...f.scope, botId: "other" }, f.identity, []);
    await other.saveDiffReviewDraft(f.scope, f.identity, [f.note()]);
  });
  await expect.poll(() => page.evaluate(() => (window as any).reviewSignalFixture.count)).toBe(1);
  await page.evaluate(async () => { await (window as any).reviewSignalFixture.other.forgetIdentity(); });
  await expect.poll(() => page.evaluate(() => (window as any).reviewSignalFixture.count)).toBe(2);
  await page.evaluate(() => { const f = (window as any).reviewSignalFixture; f.unsubscribe(); f.other.close(); });
});
