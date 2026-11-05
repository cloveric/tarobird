import { describe, expect, it } from "vitest";
import { DesignShareClient, DesignShareError, DesignShareManager, joinDesignShare, type DesignShareTransport } from "../src/workbench-design-collaboration.js";
import { DesignSession } from "../src/workbench-design-session.js";
import { emptyDesign, encodeDesignFile, type DesignDocument } from "../src/workbench-design.js";
import type { DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";

function transport(behaviour: { throwing?: string; rejecting?: boolean } = {}) {
  const listeners = new Set<(frame: DesignShareServerFrame) => void>(), sent: { requestId: string }[] = [];
  const value: DesignShareTransport = {
    send: frame => { if (behaviour.throwing) throw new Error(behaviour.throwing); sent.push(frame); return behaviour.rejecting ? Promise.reject(new Error("socket")) : undefined; },
    onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { value, sent, emit: (frame: DesignShareServerFrame) => { for (const listener of listeners) listener(frame); } };
}
const list = { op: "list" as const, conversationId: "c" };

describe("DesignShareClient over the connection's raw transport", () => {
  it("correlates results and routes other frames to listeners", async () => {
    const t = transport(), client = new DesignShareClient(t.value, 1_000), seen: string[] = [];
    client.on(frame => seen.push(frame.type));
    const pending = client.request(list, "r1");
    t.emit({ v: 1, type: "design.share.event", shareId: "ds_" + "a".repeat(24), generation: 1, event: { type: "comments" } });
    t.emit({ v: 1, type: "design.share.result", requestId: "r1", ok: true, result: { shares: [] } });
    expect(await pending).toEqual({ shares: [] });
    expect(seen).toEqual(["design.share.event"]);
    const refused = client.request(list, "r2");
    t.emit({ v: 1, type: "design.share.result", requestId: "r2", ok: false, error: "conversation_forbidden" });
    await expect(refused).rejects.toMatchObject({ code: "conversation_forbidden" });
  });
  it("fails at once when the transport refuses synchronously, without a lingering request", async () => {
    const client = new DesignShareClient(transport({ throwing: "design_share_app_unavailable" }).value, 60_000);
    await expect(client.request(list, "r1")).rejects.toMatchObject({ code: "design_share_app_unavailable" });
    expect((client as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
  it("reports asynchronous send failures and dropped sockets as unknown outcomes", async () => {
    await expect(new DesignShareClient(transport({ rejecting: true }).value, 60_000).request(list)).rejects.toMatchObject({ code: "design_share_outcome_unknown" });
    const client = new DesignShareClient(transport().value, 60_000), a = client.request(list, "a"), b = client.request(list, "b");
    client.abortPending();
    await expect(a).rejects.toBeInstanceOf(DesignShareError);
    await expect(b).rejects.toMatchObject({ code: "design_share_outcome_unknown" });
  });
});

describe("connection status retires share sessions", () => {
  it("aborts pending requests and reports offline at once; online is reported again", async () => {
    let status: (online: boolean) => void = () => {};
    const listeners = new Set<(frame: DesignShareServerFrame) => void>();
    const client = new DesignShareClient({ send: () => undefined, onFrame: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, onStatus: listener => { status = listener; return () => {}; } }, 60_000);
    const seen: boolean[] = []; client.onStatus(online => seen.push(online));
    const pending = client.request(list, "p1");
    status(false);
    await expect(pending).rejects.toMatchObject({ code: "design_share_outcome_unknown" });
    expect(client.online).toBe(false);
    status(true);
    expect(client.online).toBe(true);
    expect(seen).toEqual([false, true]);
  });
});

// Independent review addendum (sharing-cache-readonly-repro): a joined copy kept
// every file version it ever saw. The simulated source holds only its current
// version and counts fetches, so a cache hit is visible from outside.
describe("joined copy content cache", () => {
  it("reuses active files, re-fetches superseded ones and keeps no bytes from a refused save", async () => {
    const path = "project/image.png", base = emptyDesign("cache"), stagedBytes = new Map<string, string>(), fetches = new Map<string, number>();
    let current: DesignDocument = base, accept = true, receive: (frame: DesignShareServerFrame) => void = () => {};
    const file = (n: number) => encodeDesignFile(new Uint8Array(3000).fill(n), "image/png");
    const install = (n: number) => { const next = file(n); current = { ...current, revision: current.revision + 1, files: { ...current.files, [path]: next } }; return next.sha256; };
    const count = (sha: string) => fetches.get(sha) ?? 0;
    const value: DesignShareTransport = { onFrame: listener => { receive = listener; return () => {}; }, send: frame => {
      const request = frame.request as Record<string, any>; let result: unknown, error: string | undefined;
      if (request.op === "join") result = { role: "editor", sourceOnline: true };
      else if (request.op === "leave") result = { left: true };
      else if (request.op === "call" && request.call === "list") result = { id: current.id, format: "canvas", revision: current.revision, files: Object.fromEntries(Object.entries(current.files).map(([key, { sha256, size, contentType }]) => [key, { sha256, size, contentType }])) };
      else if (request.op === "fetch") {
        fetches.set(request.sha256, count(request.sha256) + 1);
        const found = Object.values(current.files).find(item => item.sha256 === request.sha256); if (!found) throw new Error("source holds only active files");
        result = { offset: 0, base64: found.base64, eof: true };
      } else if (request.op === "stage") { stagedBytes.set(request.sha256, request.base64); result = { staged: true }; }
      else if (request.op === "commit") {
        if (!accept) error = "design_revision_conflict";
        else { const files = { ...current.files }; for (const [key, entry] of Object.entries(request.files as Record<string, any>)) files[key] = { base64: stagedBytes.get(entry.sha256)!, sha256: entry.sha256, size: entry.size, contentType: entry.contentType } as never;
          current = { ...current, revision: current.revision + 1, files }; result = { revision: current.revision }; }
      } else throw new Error(`unexpected ${request.op}`);
      queueMicrotask(() => receive({ v: 1, type: "design.share.result", requestId: frame.requestId, ok: !error, ...(error ? { error } : { result }) } as never));
    } };
    const first = install(1), client = new DesignShareClient(value);
    const mirror = await joinDesignShare(client, { shareId: `ds_${"a".repeat(24)}`, windowId: "w", user: () => ({ id: "guest", name: "Guest" }) });
    const second = install(2); await mirror.resume(); expect(count(second)).toBe(1);
    // An unchanged active file is still served from the cache.
    await mirror.resume(); expect(count(second)).toBe(1);
    const mainSha = mirror.session.document.files["project/Main.dc.html"]?.sha256; if (mainSha) expect(count(mainSha)).toBe(1);
    // A superseded version is not kept: going back to it fetches again.
    install(1); await mirror.resume(); expect(count(first)).toBe(2);
    // A committed save keeps its own bytes; nothing is fetched for them afterwards.
    const saved = file(3);
    expect(((await mirror.session.request("publish", { files: { [path]: { base64: saved.base64, contentType: saved.contentType, ifMatch: first } } })) as { status: number }).status).toBe(200);
    await mirror.resume(); expect(mirror.session.document.files[path]!.sha256).toBe(saved.sha256); expect(count(saved.sha256)).toBe(0);
    // A refused save leaves no cache entry: when the source later holds those bytes, they are fetched.
    accept = false; const refused = file(4);
    expect(((await mirror.session.request("publish", { files: { [path]: { base64: refused.base64, contentType: refused.contentType, ifMatch: saved.sha256 } } })) as { status: number }).status).toBeGreaterThanOrEqual(400);
    install(4); await mirror.resume(); expect(count(refused.sha256)).toBe(1);
    await mirror.leave({ discard: true }); client.dispose();
  });
});

// Root after-k review (sharing-initial-open-independent-after-k): a first open
// still on the wire when the window is closed or the design deleted must not
// leave a source behind, and its cleanup must not touch a later share.
describe("a first share open cancelled while on the wire", () => {
  const view = { shareId: `ds_${"c".repeat(24)}`, conversationId: "chat", designId: "doc", format: "canvas", title: "Doc", generation: 1, ownerUserId: "owner", ownerName: "Owner", role: "owner", revision: 0, sourceOnline: true };
  function harness() {
    const calls: string[] = [], held: Array<() => void> = []; let receive: (frame: DesignShareServerFrame) => void = () => {}, holdOpen = true, onOpen = () => {};
    const reply = (requestId: string, result: unknown) => receive({ v: 1, type: "design.share.result", requestId, ok: true, result } as never);
    const client = new DesignShareClient({ onFrame: listener => { receive = listener; return () => {}; }, send: frame => {
      const request = frame.request as Record<string, any>; calls.push(request.op === "close" ? `close:${request.shareId}` : request.op);
      if (request.op === "open" && holdOpen) { held.push(() => reply(frame.requestId, view)); onOpen(); return; }
      queueMicrotask(() => reply(frame.requestId, request.op === "open" || request.op === "attach" ? view : {}));
    } }, 2_000);
    const document = emptyDesign("doc"), session = new DesignSession(document, async () => document, async () => {}, () => {});
    const opened = () => new Promise<void>(resolve => { if (held.length) resolve(); else onOpen = resolve; });
    return { calls, client, session, manager: new DesignShareManager(client), opened, release: () => { holdOpen = false; for (const fn of held.splice(0)) fn(); } };
  }
  const input = { conversationId: "chat", windowId: "w", title: "Doc" };
  it("forget (window closed) during the first open: no source, the Host binding is detached, a later share works", async () => {
    const h = harness(), first = h.manager.share(h.session, input); await h.opened();
    await h.manager.forget(h.session);
    expect(h.manager.sourceFor(h.session)).toBeUndefined();
    h.release(); await expect(first).rejects.toThrow("design_share_source_stopped");
    expect(h.manager.sourceFor(h.session)).toBeUndefined(); expect(h.calls).toEqual(["open", "detach"]);
    // A valid share afterwards serves normally, and nothing detaches it.
    await expect(h.manager.share(h.session, input)).resolves.toMatchObject({ shareId: view.shareId });
    expect(h.manager.sourceFor(h.session)?.source.attached).toBe(true); expect(h.calls).toEqual(["open", "detach", "open"]);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(h.calls.at(-1)).toBe("open");
    await h.manager.pause(h.session); h.client.dispose();
  });
  it("close (design deleted) during the first open ends the share it just opened", async () => {
    const h = harness(), first = h.manager.share(h.session, input); await h.opened();
    await h.manager.close(h.session); h.release();
    await expect(first).rejects.toThrow("design_share_source_stopped");
    expect(h.calls).toEqual(["open", `close:${view.shareId}`]); expect(h.manager.sourceFor(h.session)).toBeUndefined();
    h.client.dispose();
  });
  it("forget before the open is sent: nothing reaches the Host", async () => {
    const h = harness(); let release!: () => void; const flushed = new Promise<void>(resolve => { release = resolve; });
    h.session.flush = () => flushed;
    const first = h.manager.share(h.session, input); await h.manager.forget(h.session); release();
    await expect(first).rejects.toThrow("design_share_source_stopped"); expect(h.calls).toEqual([]);
    h.client.dispose();
  });
  it("a share started while a cancelled open is still on the wire waits for its cleanup", async () => {
    const h = harness(), first = h.manager.share(h.session, input); await h.opened();
    void h.manager.forget(h.session);
    const second = h.manager.share(h.session, input);
    await new Promise(resolve => setTimeout(resolve, 10)); expect(h.calls).toEqual(["open"]);
    h.release(); await expect(first).rejects.toThrow("design_share_source_stopped");
    await expect(second).resolves.toMatchObject({ shareId: view.shareId });
    expect(h.calls).toEqual(["open", "detach", "open"]); expect(h.manager.sourceFor(h.session)?.source.attached).toBe(true);
    await h.manager.pause(h.session); h.client.dispose();
  });
  // Root review n: two share() calls begun before one forget/close both belong to the cancelled lifetime.
  for (const how of ["forget", "close"] as const) it(`two share calls begun before ${how}: both are cancelled, no second open, a later share works`, async () => {
    const h = harness(), settle = (promise: Promise<unknown>) => promise.then(() => "fulfilled", (error: { code?: string }) => error.code);
    const first = settle(h.manager.share(h.session, input)); await h.opened();
    const second = settle(h.manager.share(h.session, input));
    await h.manager[how](h.session); h.release();
    expect(await Promise.all([first, second])).toEqual(["design_share_source_stopped", "design_share_source_stopped"]);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.manager.sourceFor(h.session)).toBeUndefined();
    expect(h.calls).toEqual(["open", how === "close" ? `close:${view.shareId}` : "detach"]);
    // A share begun after the cancellation still works.
    await expect(h.manager.share(h.session, input)).resolves.toMatchObject({ shareId: view.shareId });
    expect(h.manager.sourceFor(h.session)?.source.attached).toBe(true);
    await h.manager.pause(h.session); h.client.dispose();
  });
  it("a share queued behind a cancelled open is itself cancelled by a later forget", async () => {
    const h = harness(), first = h.manager.share(h.session, input); await h.opened();
    void h.manager.forget(h.session);
    const queued = h.manager.share(h.session, input);
    void h.manager.forget(h.session); h.release();
    await expect(first).rejects.toThrow("design_share_source_stopped"); await expect(queued).rejects.toThrow("design_share_source_stopped");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.calls).toEqual(["open", "detach"]); expect(h.manager.sourceFor(h.session)).toBeUndefined();
    h.client.dispose();
  });
});
