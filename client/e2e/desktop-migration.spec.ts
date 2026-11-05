import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Runs the desktop data migration adapters against the browser engine's real
// IndexedDB (Chromium for Electron, WebKit for the macOS Tauri WebView).
// Data is created with the App's own storage classes on isolated test origins;
// no production profile, keychain or Host is involved. Each origin has its own
// storage, standing in for the old Tauri origin and the new Electron origin.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ENTRY = `
import { ClientCache } from "./storage.js";
import { HostRegistry } from "./host-registry.js";
import { signChallenge } from "./identity.js";
import { exportDesktopData, indexedDbExportSource } from "./desktop-migration-export.js";
import { importDesktopData, indexedDbImportTarget } from "./desktop-migration-import.js";
import { parseRecordLine, MIGRATION_RECEIPT_KEY, MIGRATION_REPAIR_KEY, MIGRATION_LOCAL_KEY } from "./desktop-migration-format.js";
const b64 = (bytes) => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (text) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
const spki = async () => b64(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])).publicKey));
const id = () => crypto.randomUUID().replaceAll("-", "");
async function host(registry, name, identity) { const record = await registry.add(identity, name); await registry.recoverPreparations(); return record; }
function rawMeta(key) { return new Promise((resolve, reject) => { const open = indexedDB.open("tarocub-hosts-v1"); open.onsuccess = () => { const db = open.result, r = db.transaction("meta").objectStore("meta").get(key); r.onsuccess = () => { db.close(); resolve(r.result ?? null); }; r.onerror = () => reject(r.error); }; open.onerror = () => reject(open.error); }); }
window.migrationTest = {
  async seed() {
    const registry = new HostRegistry();
    const deviceId = "device_" + id();
    const identity = { deviceId, keyRef: deviceId, name: "Studio Mac", platform: "macos", publicKey: await spki(), hubPublicKey: await spki(), routes: [{ name: "Direct", url: "https://hub.example" }], deployment: "computer" };
    const main = await host(registry, "主工作室", identity);
    const handle = await registry.open(main.id);
    await handle.cache.enqueue({ v: 1, type: "message.send", conversationId: "conv_1", clientMsgId: "client_" + id(), text: "排队中的消息" });
    await handle.cache.saveDraft("conv_1", "未发送的草稿");
    const image = new Uint8Array(150 * 1024).map((_, i) => (i * 13) % 256);
    await handle.cache.saveConversationDraft("conv_1", { files: [new File([image], "截图 1.png", { type: "image/png", lastModified: 1700000000000 })], previewStyle: "card" }, handle.identity);
    handle.cache.close();
    const preferences = await registry.preferences();
    await registry.savePreferences({ ...preferences, theme: "dark", fontSize: 17 });
    await registry.selectHost(main.id);
    // A registered host whose database disappeared, and a web-key identity.
    const lostDevice = "device_" + id();
    const lost = await host(registry, "Lost", { deviceId: lostDevice, keyRef: lostDevice, name: "Lost", platform: "macos", publicKey: await spki(), hubPublicKey: await spki(), routes: [] });
    await new Promise(r => { const d = indexedDB.deleteDatabase(lost.databaseName); d.onsuccess = d.onerror = d.onblocked = r; });
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    const web = await host(registry, "Web key", { deviceId: "device_" + id(), name: "Web", privateKey: pair.privateKey, publicKey: b64(await crypto.subtle.exportKey("spki", pair.publicKey)), hubPublicKey: await spki(), routes: [] });
    registry.close();
    localStorage.setItem("tarocub-appearance", JSON.stringify({ theme: "dark" }));
    localStorage.setItem("tarobot.voice-settings." + identity.hubPublicKey, "{\\"voice\\":true}");
    localStorage.setItem("third-party-key", "must not move");
    return { main: main.id, lost: lost.id, web: web.id };
  },
  async exportAll() {
    const parts = [], blobs = {}, exportId = crypto.randomUUID();
    let metadata;
    const result = await exportDesktopData(indexedDbExportSource(), {
      begin: async () => exportId, abort: async () => undefined,
      part: async (index, text) => { parts[index] = text; },
      blob: async bytes => { const sha = await hex(bytes); blobs[sha] = b64(bytes); return sha; },
      commit: async meta => { metadata = meta; return { exportId, records: parts.join("").split("\\n").length - 1, bytes: 0 }; },
    }, { appVersion: "1.0.120" });
    // The native writer computes these; mirrored here for the in-browser package.
    const counts = {}; let local = 0, records = 0;
    for (const line of parts.join("").split("\\n").filter(Boolean)) {
      const { d, s } = parseRecordLine(line); records++;
      if (d === "localStorage") local++; else { counts[d] ??= {}; counts[d][s] = (counts[d][s] ?? 0) + 1; }
    }
    const manifest = result.state === "exported" ? { format: "tarobot-desktop-migration", version: 1, exportId, createdAt: 1, installation: "0".repeat(64), source: { app: "tauri", appVersion: "1.0.120" },
      databases: metadata.databases.map(d => ({ name: d.name, version: d.version, stores: counts[d.name] })), localStorage: local,
      parts: parts.map((p, i) => ({ file: String(i).padStart(6, "0") + ".jsonl", bytes: p.length, sha256: "0".repeat(64), records: p.split("\\n").length - 1 })),
      blobs: Object.keys(blobs).map(sha => ({ sha256: sha, bytes: unb64(blobs[sha]).length })), totals: { records, bytes: 0 }, skipped: metadata.skipped, requiresRepair: metadata.requiresRepair } : undefined;
    return { result, pkg: manifest && { manifest, parts, blobs } };
  },
  async importAll(pkg, options = {}) {
    let failures = options.failLocal ?? 0;
    const storage = { setItem: (k, v) => { if (failures-- > 0) throw new DOMException("quota", "QuotaExceededError"); localStorage.setItem(k, v); } };
    const target = await indexedDbImportTarget(indexedDB, storage);
    try {
      return await importDesktopData({ manifest: pkg.manifest, part: async i => pkg.parts[i], blob: async sha => unb64(pkg.blobs[sha]) }, target);
    } catch (error) { return { error: error.message }; }
  },
  async readBack() {
    const registry = new HostRegistry();
    const hosts = await registry.list(), out = { hosts: [], preferences: await registry.preferences(), selected: await registry.selectedHost() };
    for (const record of hosts) {
      const entry = { id: record.id, name: record.name, state: record.state, databaseName: record.databaseName };
      try {
        const handle = await registry.open(record.id);
        const { draft } = await handle.cache.conversationDraft("conv_1", handle.identity);
        entry.identity = { deviceId: handle.identity.deviceId, keyRef: handle.identity.keyRef ?? null, privateKey: handle.identity.privateKey === undefined ? "absent" : "present" };
        entry.outbox = (await handle.cache.outbox()).map(e => ({ id: e.id, text: e.frame.text }));
        entry.draft = await handle.cache.draft("conv_1");
        entry.files = await Promise.all(draft.files.map(async f => ({ name: f.name, type: f.type, lastModified: f.lastModified, sha: await hex(await f.arrayBuffer()) })));
        if (!handle.identity.keyRef) entry.sign = await signChallenge(handle.identity, "n", "c").then(() => "signed", e => e.message);
        handle.cache.close();
      } catch (error) { entry.openError = error.message; }
      out.hosts.push(entry);
    }
    registry.close();
    out.meta = { receipt: await rawMeta(MIGRATION_RECEIPT_KEY), repair: await rawMeta(MIGRATION_REPAIR_KEY), pendingLocal: await rawMeta(MIGRATION_LOCAL_KEY) };
    out.local = Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)]));
    return out;
  },
  async seedLegacyIdentity() {
    const key = await spki(), deviceId = "device_" + id();
    const cache = new ClientCache(); await cache.initializeIdentity({ deviceId, keyRef: deviceId, name: "Electron first run", platform: "macos", publicKey: key, hubPublicKey: await spki(), routes: [] }); cache.close();
  },
  async seedDatabase(name, version) {
    if (version) return new Promise((resolve, reject) => { const open = indexedDB.open(name, version); open.onupgradeneeded = () => open.result.createObjectStore("settings"); open.onsuccess = () => { open.result.close(); resolve(null); }; open.onerror = () => reject(open.error); });
    const cache = new ClientCache(name); await cache.saveDraft("conv_x", "someone else's draft"); cache.close();
  },
  async hostCount() { const registry = new HostRegistry(); const n = (await registry.list()).length; registry.close(); return n; },
};
document.title = "ready";
`;

let bundle = "";
test.beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = require("esbuild") as typeof import("esbuild");
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: SRC, sourcefile: "desktop-migration-e2e-entry.ts", loader: "ts" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl", ".woff2": "empty" },
    define: { "import.meta.env": JSON.stringify({ PROD: false, DEV: false, MODE: "test" }) },
  });
  bundle = result.outputFiles[0]!.text;
});

async function origin(context: BrowserContext, name: string): Promise<Page> {
  await context.route(`https://${name}.migration.test/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/m.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><title>loading</title><script type="module" src="/m.js"></script>' });
  });
  const page = await context.newPage(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`https://${name}.migration.test/`);
  await expect.poll(async () => errors.length ? `error: ${errors.join(" | ")}` : page.title()).toBe("ready");
  return page;
}
type Api = { [name: string]: (...args: unknown[]) => Promise<unknown> };
const call = <T>(page: Page, name: string, ...args: unknown[]) => page.evaluate(([n, a]) => (window as unknown as { migrationTest: Api }).migrationTest[n as string]!(...(a as unknown[])), [name, args] as const) as Promise<T>;
type Package = { manifest: { exportId: string; databases: { name: string; version: number }[] }; parts: string[]; blobs: Record<string, string> };
type ReadBack = { hosts: Record<string, unknown>[]; preferences: { theme: string; fontSize: number }; selected: string; meta: { receipt: string | null; repair: string | null; pendingLocal: string | null }; local: Record<string, string> };

test("real IndexedDB: export from the old origin, import into an empty new origin with identical App-visible data", async ({ context }) => {
  context.on("request", request => { if (!request.url().includes(".migration.test/")) throw new Error(`unexpected network: ${request.url()}`); });
  const source = await origin(context, "source");
  const ids = await call<{ main: string; lost: string; web: string }>(source, "seed");
  const before = await call<ReadBack>(source, "readBack");
  const { result, pkg } = await call<{ result: { state: string; requiresRepair: string[]; skipped: { reason: string }[] }; pkg: Package }>(source, "exportAll");
  expect(result.state).toBe("exported");
  // Shipping must remain able to import installed Tauri 1.0.119's schemas.
  // v10 only adds local workbench stores; v9 import remains explicitly supported.
  expect(pkg.manifest.databases.find(d => d.name === "tarocub-hosts-v1")?.version).toBe(2);
  expect(pkg.manifest.databases.filter(d => d.name !== "tarocub-hosts-v1").map(d => d.version)).toEqual(expect.arrayContaining([10]));
  expect(pkg.manifest.databases.every(d => d.version === (d.name === "tarocub-hosts-v1" ? 2 : 10))).toBe(true);
  expect(result.requiresRepair.sort()).toEqual([ids.lost, ids.web].sort());
  // readBack() above opened the lost host through the App, which recreates an
  // empty cache database: it is then reported empty rather than missing.
  // Either way the host is flagged for repair, never presented as usable.
  expect(result.skipped.map(s => s.reason).sort()).toEqual(["crypto_key_removed", "database_empty"]);
  expect(await call<ReadBack>(source, "readBack")).toEqual(before); // export is readonly

  const target = await origin(context, "target");
  const imported = await call<{ state: string; requiresRepair: string[]; orphanDatabases: string[]; localStorage: string }>(target, "importAll", pkg);
  expect(imported).toMatchObject({ state: "imported", orphanDatabases: [], localStorage: "saved" });
  const after = await call<ReadBack>(target, "readBack");
  const main = (r: ReadBack) => r.hosts.find(h => h.id === ids.main);
  expect(main(after)).toEqual(main(before));
  expect(main(after)).toMatchObject({ state: "ready", draft: "未发送的草稿", outbox: [{ text: "排队中的消息" }], files: [{ name: "截图 1.png", type: "image/png" }] });
  expect(after.preferences).toMatchObject({ theme: "dark", fontSize: 17 });
  expect(after.selected).toBe(ids.main);
  expect(after.meta.receipt).toBe(pkg.manifest.exportId);
  expect(JSON.parse(after.meta.repair!).sort()).toEqual([ids.lost, ids.web].sort());
  expect(after.meta.pendingLocal).toBeNull();
  expect(Object.keys(after.local).sort()).toEqual(Object.keys(before.local).filter(k => k !== "third-party-key").sort());
  // Removed keys are fenced before a HubConnection can start or flush outbox.
  expect(after.hosts.find(h => h.id === ids.web)).toMatchObject({ openError: "host_cache_identity_mismatch" });
  expect(after.hosts.find(h => h.id === ids.lost)?.openError).toBeTruthy();
  expect(await call(target, "importAll", pkg)).toEqual({ state: "already_imported", exportId: pkg.manifest.exportId, localStorage: "saved" });
});

test("real IndexedDB: occupied, mismatched or partially failed targets never merge or become visible early", async ({ context }) => {
  const source = await origin(context, "source2");
  await call(source, "seed");
  const { pkg } = await call<{ pkg: Package }>(source, "exportAll");
  const hostDb = pkg.manifest.databases.find(d => d.name.startsWith("tarocub-host-"))!.name;

  const legacy = await origin(context, "legacy");
  await call(legacy, "seedLegacyIdentity");
  expect(await call(legacy, "importAll", pkg)).toEqual({ state: "target_not_empty", reason: "legacy_identity", database: "tarocub-v1" });

  const busy = await origin(context, "busy");
  await call(busy, "seedDatabase", hostDb);
  expect(await call(busy, "importAll", pkg)).toEqual({ state: "target_not_empty", reason: "database_in_use", database: hostDb });

  const newer = await origin(context, "newer");
  await call(newer, "seedDatabase", hostDb, 11);
  expect(await call(newer, "importAll", pkg)).toEqual({ error: "migration_schema_mismatch" });
  expect(await call(newer, "hostCount")).toBe(0);

  const orphan = await origin(context, "orphan");
  const stray = `tarocub-host-hub_${"f".repeat(64)}-00000000-0000-4000-8000-000000000000`;
  await call(orphan, "seedDatabase", stray);
  expect(await call(orphan, "importAll", pkg)).toMatchObject({ state: "imported", orphanDatabases: [stray] });

  const quota = await origin(context, "quota");
  expect(await call(quota, "importAll", pkg, { failLocal: 1 })).toMatchObject({ state: "imported", localStorage: "failed" });
  expect((await call<ReadBack>(quota, "readBack")).meta.pendingLocal).not.toBeNull();
  expect(await call(quota, "importAll", pkg)).toEqual({ state: "already_imported", exportId: pkg.manifest.exportId, localStorage: "saved" });
  const settled = await call<ReadBack>(quota, "readBack");
  expect(settled.meta.pendingLocal).toBeNull();
  expect(settled.local["tarocub-appearance"]).toBe(JSON.stringify({ theme: "dark" }));
});
