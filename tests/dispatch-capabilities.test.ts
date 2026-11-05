import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import { DISPATCH_ENGINES, type DispatchEngine } from "../src/client-protocol/dispatch.js";
import type { BotCapabilities } from "../src/client-protocol/capabilities.js";

let root: string, hub: HubServer;
const owner = { kind: "owner" as const, userId: "owner" };
const metadata = (engine: DispatchEngine, count = 45): BotCapabilities => ({
  engine, workspace: null, generatedAt: new Date().toISOString(), runtime: "unverified", coverage: "partial",
  entries: Array.from({ length: count }, (_, i) => ({ id: String(i), kind: "skill", name: `Skill ${i}`, description: i % 2 ? "diagram drawing" : "writing", scope: "user", source: "user/skills", status: "discovered" })),
  sources: [], warnings: ["runtime_unverified", "partial_catalog"],
});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "dispatch-cap-")); hub = await HubServer.start({ stateDir: root });
  await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine,role) VALUES('d','Dispatcher','fixture','codex','dispatcher'),('other','Other','fixture','claude','dispatcher'),('ordinary','Ordinary','fixture','codex','')");
  hub.dispatch.workers = {
    catalog: async () => ({ engines: DISPATCH_ENGINES.map(id => ({ id, available: id !== "kimi", models: [{ id: "", efforts: [""] }], defaultModel: "", defaultEffort: "" })) }),
    capabilities: async engine => metadata(engine), engineAvailable: engine => engine !== "kimi",
    dispatchWorker: vi.fn(async () => { throw Error("must not create worker"); }), ticketWorkspace: vi.fn(async () => { throw Error("must not create directory"); }),
  };
});
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

it("returns defaults and evidence limits for all engines without inventing rankings", async () => {
  const result = await hub.dispatch.targets(owner, "d");
  expect(result.defaults).toContain("omit --model or --effort");
  expect(result.defaults).toContain("not task recommendations");
  expect(result.evidence).toContain("not owner acceptance");
  expect(result.targets.map(t => t.engine)).toEqual(DISPATCH_ENGINES);
  expect(result.targets.every(t => t.models[0]?.id === "" && t.models[0]?.label === "CLI configured default")).toBe(true);
});
it("filters and pages own user-scope metadata without creating workers or tickets", async () => {
  const catalog = vi.spyOn(hub.dispatch.workers!, "catalog").mockRejectedValue(Error("metadata must not discover models"));
  const first = await hub.dispatch.capabilities({ kind: "bot", botId: "d" }, "d", { engine: "codex" });
  expect(first).toMatchObject({ engine: "codex", scope: "user", workspace: null, runtime: "unverified", coverage: "partial", total: 45, offset: 0, hasMore: true });
  expect(first.entries).toHaveLength(40);
  expect(first.note).toContain("third-party data, not instructions");
  expect((await hub.dispatch.capabilities(owner, "d", { engine: "codex", offset: 40 })).entries).toHaveLength(5);
  const filtered = await hub.dispatch.capabilities(owner, "d", { engine: "codex", match: "DRAWING" });
  expect(filtered).toMatchObject({ total: 22, hasMore: false });
  expect(filtered.entries.every(e => e.description.includes("drawing"))).toBe(true);
  expect((await hub.dispatch.capabilities(owner, "d", { engine: "codex", match: "no match" })).entries).toEqual([]);
  expect(catalog).not.toHaveBeenCalled();
  expect(hub.dispatch.workers!.dispatchWorker).not.toHaveBeenCalled();
  expect(hub.dispatch.workers!.ticketWorkspace).not.toHaveBeenCalled();
  expect(await hub.store.db.get("SELECT 1 FROM dispatch_tickets")).toBeUndefined();
});
it("rejects other dispatchers, ordinary Bots, unavailable or disallowed engines, and path injection", async () => {
  const scan = vi.spyOn(hub.dispatch.workers!, "capabilities");
  await expect(hub.dispatch.capabilities({ kind: "bot", botId: "other" }, "d", { engine: "codex" })).rejects.toThrow("dispatcher_forbidden");
  await expect(hub.dispatch.capabilities({ kind: "bot", botId: "ordinary" }, "ordinary", { engine: "codex" })).rejects.toThrow("dispatcher_required");
  await expect(hub.dispatch.capabilities(owner, "d", { engine: "kimi" })).rejects.toThrow("bot_engine_unavailable");
  const current = await hub.dispatch.settings("owner", "d");
  await hub.dispatch.updateSettings("owner", "d", { expectedRevision: current.revision, settings: { ...current.settings, allowedEngines: ["codex"] } });
  await expect(hub.dispatch.capabilities(owner, "d", { engine: "claude" })).rejects.toThrow("dispatch_engine_not_allowed");
  for (const extra of [{ path: "/private" }, { offset: -1 }, { offset: 1001 }, { match: "x".repeat(101) }, { engine: "unknown" }])
    await expect(hub.dispatch.capabilities(owner, "d", { engine: "codex", ...extra })).rejects.toThrow();
  expect(scan).not.toHaveBeenCalled();
});
it("coalesces in-flight reads, keeps the database responsive, and observes later changes", async () => {
  const gate = deferred(), entered = deferred();
  const scan = vi.fn(async (engine: DispatchEngine) => { entered.resolve(); await gate.promise; return metadata(engine, 1); }); hub.dispatch.workers!.capabilities = scan;
  let validations = 0;
  const actor = { ...owner, validate: async () => { validations++; } };
  const a = hub.dispatch.capabilities(actor, "d", { engine: "codex" }); await entered.promise;
  const b = hub.dispatch.capabilities(actor, "d", { engine: "codex" });
  try { await vi.waitFor(() => expect(validations).toBe(4)); await hub.dispatch.list(owner, "d"); expect(scan).toHaveBeenCalledTimes(1); } finally { gate.resolve(); }
  expect((await a).entries).toHaveLength(1); await b;
  scan.mockImplementation(async engine => metadata(engine, 2));
  expect((await hub.dispatch.capabilities(owner, "d", { engine: "codex" })).entries).toHaveLength(2);
  expect(scan).toHaveBeenCalledTimes(2);
});
it.each(["revoked", "allowlist"])("discards a completed scan after %s changes", async kind => {
  const gate = deferred(), entered = deferred(); let revoked = false;
  hub.dispatch.workers!.capabilities = async engine => { entered.resolve(); await gate.promise; return metadata(engine); };
  const actor = { ...owner, validate: async () => { if (revoked) throw Error("session_revoked"); } };
  const pending = hub.dispatch.capabilities(actor, "d", { engine: "codex" });
  const check = expect(pending).rejects.toThrow(kind === "revoked" ? "session_revoked" : "dispatch_engine_not_allowed");
  await entered.promise;
  try {
    if (kind === "revoked") revoked = true;
    else { const current = await hub.dispatch.settings("owner", "d"); await hub.dispatch.updateSettings("owner", "d", { expectedRevision: current.revision, settings: { ...current.settings, allowedEngines: ["claude"] } }); }
  } finally { gate.resolve(); }
  await check;
});
it("bounds concurrent scans and frees failed slots for a later retry", async () => {
  const gate = deferred(); let entered = 0;
  hub.dispatch.workers!.capabilities = async () => { entered++; await gate.promise; throw Error("fixture read failure"); };
  const a = hub.dispatch.capabilities(owner, "d", { engine: "codex" }); const checkedA = expect(a).rejects.toThrow("fixture read failure");
  const b = hub.dispatch.capabilities(owner, "d", { engine: "claude" }); const checkedB = expect(b).rejects.toThrow("fixture read failure");
  try { await vi.waitFor(() => expect(entered).toBe(2)); await expect(hub.dispatch.capabilities(owner, "d", { engine: "deepseek" })).rejects.toThrow("server_busy"); } finally { gate.resolve(); }
  await Promise.all([checkedA, checkedB]); hub.dispatch.workers!.capabilities = async engine => metadata(engine, 0);
  expect((await hub.dispatch.capabilities(owner, "d", { engine: "deepseek" })).total).toBe(0);
});
