import { expect, test, type Page } from "@playwright/test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Electron main modules are plain ESM without declarations.
import { DesktopMigration } from "../electron/migration-service.mjs";
// @ts-expect-error Electron main modules are plain ESM without declarations.
import { MigrationStore, installationBinding, macKey } from "../electron/migration.mjs";

// An import whose Chromium registry commit landed before main's receipt and
// profile marker. Real IndexedDB, the real startup gate and the real main state
// machine with HMAC-signed, installation-bound exports; only the old WebKit
// profile is a fixture directory and the IPC hop is exposeFunction.
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ENTRY = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ClientCache } from "./storage.js";
import { HostRegistry } from "./host-registry.js";
import { exportDesktopData, indexedDbExportSource } from "./desktop-migration-export.js";
import { DesktopMigrationGate } from "./DesktopMigrationGate.js";
const b64 = (bytes) => { let s = ""; for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b); return btoa(s); };
const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
const spki = async () => b64(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])).publicKey));
function meta(key, value) { return new Promise((resolve, reject) => { const open = indexedDB.open("tarocub-hosts-v1"); open.onsuccess = () => { const db = open.result, tx = db.transaction("meta", value === undefined ? "readonly" : "readwrite"), store = tx.objectStore("meta"); const r = value === undefined ? store.get(key) : store.put(value, key); r.onsuccess = () => { db.close(); resolve(r.result ?? null); }; r.onerror = () => reject(r.error); }; open.onerror = () => reject(open.error); }); }
window.migrationTest = {
  async seed() {
    const registry = new HostRegistry(), deviceId = "device_" + crypto.randomUUID().replaceAll("-", "");
    const record = await registry.add({ deviceId, keyRef: deviceId, name: "Studio Mac", platform: "macos", publicKey: await spki(), hubPublicKey: await spki(), routes: [] }, "主工作室");
    await registry.recoverPreparations();
    const handle = await registry.open(record.id); await handle.cache.saveDraft("conv_1", "已提交的草稿"); handle.cache.close(); registry.close();
    localStorage.setItem("tarocub-appearance", JSON.stringify({ theme: "dark" }));
  },
  async exportAll() {
    const parts = [], blobs = {}, exportId = crypto.randomUUID(); let metadata;
    const result = await exportDesktopData(indexedDbExportSource(), {
      begin: async () => exportId, abort: async () => undefined, part: async (index, text) => { parts[index] = text; },
      blob: async bytes => { const sha = await hex(bytes); blobs[sha] = b64(bytes); return sha; },
      commit: async value => { metadata = value; return { exportId, records: parts.join("").split("\\n").length - 1, bytes: 0 }; },
    }, { appVersion: "1.0.119" });
    return { state: result.state, parts, blobs, metadata };
  },
  seedCodec: value => meta("codecProbe", JSON.parse(value)),
  async readCodec() { const value = await meta("codecProbe"); return { json: JSON.stringify(value), ownProto: Object.hasOwn(value, "__proto__"), ordinaryPrototype: Object.getPrototypeOf(value) === Object.prototype, polluted: ({}).kept ?? null }; },
  mount() { createRoot(document.getElementById("root")).render(createElement(DesktopMigrationGate, null, createElement("div", { id: "opened" }, "OPEN"))); },
  async readBack() {
    const registry = new HostRegistry(), hosts = await registry.list(), drafts = [];
    for (const record of hosts) { const handle = await registry.open(record.id); drafts.push(await handle.cache.draft("conv_1")); handle.cache.close(); }
    registry.close();
    return { importedExportId: await meta("desktopMigration"), pendingLocal: await meta("desktopMigrationLocalStorage"), drafts, appearance: localStorage.getItem("tarocub-appearance") };
  },
  /** An interruption before the pending localStorage copy was applied. */
  async unapplyLocalStorage() { await meta("desktopMigrationLocalStorage", JSON.stringify([["tarocub-appearance", localStorage.getItem("tarocub-appearance")]])); localStorage.removeItem("tarocub-appearance"); },
  forgeCommittedExport: id => meta("desktopMigration", id),
};
document.title = "ready";
`;
// Desktop shell stand-in: same bridge shape as preload; replies cross as base64.
const SHIM = `window.tarobotDesktop = { version: 1, engine: "electron", platform: "darwin", on: () => () => {}, openSocket: async () => { throw new Error("unexpected_socket"); },
  async invoke(command, args) {
    let reply;
    try { reply = await window.nativeInvoke(command, args ?? {}); } catch (error) { const code = /([a-z][a-z_]{2,})\\s*$/.exec(String(error?.message ?? error)); throw new Error(code ? code[1] : "fixture_error"); }
    if (command === "desktop_migration_read") reply.data = Uint8Array.from(atob(reply.data), c => c.charCodeAt(0));
    return reply;
  } };`;

let bundle = "";
test.beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = require("esbuild") as typeof import("esbuild");
  const result = await build({
    stdin: { contents: ENTRY, resolveDir: SRC, sourcefile: "desktop-migration-committed-entry.tsx", loader: "tsx" },
    bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", logLevel: "silent", jsx: "automatic",
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".webp": "dataurl", ".woff2": "empty" },
    define: { "import.meta.env": JSON.stringify({ PROD: false, DEV: false, MODE: "test" }) },
  });
  bundle = result.outputFiles[0]!.text;
});

type Native = { migration: DesktopMigration; crashOnComplete: boolean; calls: string[] };
const labs: string[] = [];
test.afterEach(async () => { for (const root of labs.splice(0)) await rm(root, { recursive: true, force: true }); });
async function origin(page: Page, name: string, native?: Native): Promise<void> {
  await page.context().route(`https://${name}.migration.test/**`, route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/m.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><title>loading</title><div id="root"></div>${native ? `<script>${SHIM}</script>` : ""}<script type="module" src="/m.js"></script>` });
  });
  if (native) await page.exposeFunction("nativeInvoke", async (command: string, args: Record<string, unknown>) => {
    native.calls.push(command);
    if (command === "net_document") return "fixture-document";
    if (!command.startsWith("desktop_migration_")) throw new Error(`fixture_unhandled_${command}`);
    // Quit/crash after the renderer's registry commit, before main's receipt.
    if (command === "desktop_migration_complete" && native.crashOnComplete) throw new Error("native_document_retired");
    const reply = await native.migration.request(command, args);
    return command === "desktop_migration_read" ? { ...reply, data: Buffer.from(reply.data).toString("base64") } : reply;
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`https://${name}.migration.test/`);
  await expect.poll(async () => errors.length ? `error: ${errors.join(" | ")}` : page.title()).toBe("ready");
}

/** The Rust writer's layout and authoritative bookkeeping, signed for `marker`. */
async function signedExport(state: string, marker: Buffer, pkg: { parts: string[]; blobs: Record<string, string>; metadata: { databases: { name: string; version: number }[]; skipped: unknown[]; requiresRepair: string[] } }) {
  const exportId = randomUUID(), dir = path.join(state, "desktop-migration", "exports", exportId), sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
  await mkdir(path.join(dir, "parts"), { recursive: true }); await mkdir(path.join(dir, "blobs"));
  const counts: Record<string, Record<string, number>> = {}; let local = 0, records = 0, bytes = 0;
  for (const [index, text] of pkg.parts.entries()) {
    await writeFile(path.join(dir, "parts", `${String(index).padStart(6, "0")}.jsonl`), text); bytes += Buffer.byteLength(text);
    for (const line of text.split("\n").filter(Boolean)) { const { d, s } = JSON.parse(line); records++; if (d === "localStorage") local++; else (counts[d] ??= {})[s] = (counts[d]![s] ?? 0) + 1; }
  }
  for (const [digest, value] of Object.entries(pkg.blobs)) { const blob = Buffer.from(value, "base64"); await writeFile(path.join(dir, "blobs", digest), blob); bytes += blob.length; }
  const manifest = Buffer.from(JSON.stringify({ format: "tarobot-desktop-migration", version: 1, exportId, createdAt: Date.now(), installation: installationBinding(marker), source: { app: "tauri", appVersion: "1.0.119" },
    databases: pkg.metadata.databases.map(d => ({ name: d.name, version: d.version, stores: counts[d.name] })), localStorage: local,
    parts: pkg.parts.map((text, i) => ({ file: `${String(i).padStart(6, "0")}.jsonl`, bytes: Buffer.byteLength(text), sha256: sha(text), records: text.split("\n").length - 1 })),
    blobs: Object.entries(pkg.blobs).map(([digest, value]) => ({ sha256: digest, bytes: Buffer.from(value, "base64").length })), totals: { records, bytes },
    skipped: pkg.metadata.skipped, requiresRepair: pkg.metadata.requiresRepair }));
  await writeFile(path.join(dir, "manifest.json"), manifest);
  await writeFile(path.join(dir, "manifest.mac"), createHmac("sha256", macKey(marker)).update(manifest).digest("hex"));
  return exportId;
}

async function lab(page: Page, name: string, codec?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tarobot-committed-import-")), state = path.join(root, "state"), profile = path.join(state, "electron-profile");
  labs.push(root);
  const webkit = path.join(root, "WebKit", "com.tarobot.client"), source = path.join(webkit, "WebsiteData", "Default", "salt", "salt", "IndexedDB", "v1", "tauri_localhost_0");
  await mkdir(source, { recursive: true }); await mkdir(profile, { recursive: true });
  const marker = Buffer.alloc(32, 7); await writeFile(path.join(state, "tarobot-client-installation-v1"), marker);
  const legacyWrite = async (text: string, at: number) => { const file = path.join(source, "IndexedDB.sqlite3"); await writeFile(file, text); await utimes(file, at, at); };
  await legacyWrite("legacy v1", 1_700_000_000);
  const legacy = await page.context().newPage(); await origin(legacy, `legacy-${name}`);
  await legacy.evaluate(() => (window as any).migrationTest.seed());
  if (codec) await legacy.evaluate(value => (window as any).migrationTest.seedCodec(value), codec);
  const pkg = await legacy.evaluate(() => (window as any).migrationTest.exportAll());
  expect(pkg.state).toBe("exported");
  const start = (): DesktopMigration => new DesktopMigration({ stateDir: state, profile, legacyRequired: true, legacyWebviewDirs: [webkit], store: new MigrationStore(state), reader: { run: () => signedExport(state, marker, pkg) } });
  const native: Native = { migration: start(), crashOnComplete: true, calls: [] };
  await origin(page, `electron-${name}`, native);
  const restart = async (crashOnComplete = false) => {
    native.migration = start(); native.crashOnComplete = crashOnComplete; native.calls = [];
    await page.reload(); await expect.poll(() => page.title()).toBe("ready");
    await page.evaluate(() => (window as any).migrationTest.mount());
  };
  const exports = async () => (await readdir(path.join(state, "desktop-migration", "exports"))).sort();
  const json = async (file: string) => JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  await test.info().attach("lab", { body: root });
  return { root, state, profile, native, start, restart, exports, json, legacyWrite };
}

test("real IndexedDB export and import preserve special object keys without changing prototypes", async ({ page }) => {
  const original = '{"__proto__":{"kept":true},"constructor":{"prototype":{"kept":"nested"}},"list":[{"$t":"user-value","__proto__":{"kept":"array"}}]}';
  const f = await lab(page, "codec", original);
  f.native.crashOnComplete = false;
  await page.evaluate(() => (window as any).migrationTest.mount());
  await expect(page.locator("#opened")).toHaveText("OPEN");
  expect(await page.evaluate(() => (window as any).migrationTest.readCodec())).toEqual({ json: original, ownProto: true, ordinaryPrototype: true, polluted: null });
  await f.restart();
  await expect(page.locator("#opened")).toHaveText("OPEN");
  expect(await page.evaluate(() => (window as any).migrationTest.readCodec())).toEqual({ json: original, ownProto: true, ordinaryPrototype: true, polluted: null });
});

test("an interrupted committed import resumes from its verified export, retries localStorage and keeps the source notice", async ({ page }) => {
  const f = await lab(page, "resume");
  // Session 1 (any build): export A, registry commit, then quit before receipt/marker.
  await page.evaluate(() => (window as any).migrationTest.mount());
  await expect(page.locator("code")).toHaveText("native_document_retired");
  const committed = (await page.evaluate(() => (window as any).migrationTest.readBack())).importedExportId as string;
  expect((await f.exports())).toEqual([committed]);
  await page.evaluate(() => (window as any).migrationTest.unapplyLocalStorage());
  // An older copy wrote the source; the unfixed build then re-exported it as B and rebound the source to B.
  await f.legacyWrite("legacy v2 with one more message", 1_700_000_100);
  const old = f.start();
  expect(await old.request("desktop_migration_inspect", {})).toEqual({ state: "transition_required" });
  const newer = (await old.request("desktop_migration_prepare", {})).manifest.exportId as string;
  expect((await f.json(path.join(f.profile, "tarobot-legacy-source-v1.json"))).exportId).toBe(newer);
  // Session 2 (fixed): finishes A, never imports B, and reapplies localStorage.
  await f.restart();
  await expect(page.locator("#opened")).toHaveText("OPEN");
  await expect(page.locator(".desktop-migration-notice")).toBeVisible();
  expect(f.native.calls.filter(c => c.startsWith("desktop_migration_"))).toEqual(["desktop_migration_inspect", "desktop_migration_complete"]);
  expect(await f.exports()).toEqual([committed, newer].sort());
  expect(await f.json(path.join(f.profile, "tarobot-desktop-profile-v1.json"))).toEqual({ version: 1, mode: "imported", exportId: committed });
  expect((await f.json(path.join(f.state, "desktop-migration", "receipts", `${committed}.json`))).exportId).toBe(committed);
  expect(await f.json(path.join(f.state, "desktop-migration", "receipts", `${newer}.json`))).toBeNull();
  expect(await page.evaluate(() => (window as any).migrationTest.readBack())).toEqual({ importedExportId: committed, pendingLocal: null, drafts: ["已提交的草稿"], appearance: JSON.stringify({ theme: "dark" }) });
  // Acknowledging is durable; the next start opens quietly from the profile.
  await page.getByRole("button", { name: "知道了" }).click();
  await expect.poll(async () => Array.isArray((await f.json(path.join(f.profile, "tarobot-legacy-source-v1.json"))).acknowledged)).toBe(true);
  await f.restart();
  await expect(page.locator("#opened")).toHaveText("OPEN");
  await expect(page.locator(".desktop-migration-notice")).toHaveCount(0);
});

test("a committed import is finished only from an export main verifies", async ({ page }) => {
  const f = await lab(page, "forged");
  await page.evaluate(() => (window as any).migrationTest.mount());
  await expect(page.locator("code")).toHaveText("native_document_retired");
  const committed = (await page.evaluate(() => (window as any).migrationTest.readBack())).importedExportId as string;
  const mac = path.join(f.state, "desktop-migration", "exports", committed, "manifest.mac"), original = await readFile(mac, "utf8");
  await writeFile(mac, original.replace(/^./, c => c === "0" ? "1" : "0"));
  await f.restart();
  await expect(page.locator("code")).toHaveText("migration_signature_invalid");
  await writeFile(mac, original);
  await page.evaluate(id => (window as any).migrationTest.forgeCommittedExport(id), randomUUID());
  await f.restart();
  await expect(page.locator("code")).toHaveText("migration_export_missing");
  // Refusals never mint a profile, import a newer snapshot or take another export.
  expect(await f.json(path.join(f.profile, "tarobot-desktop-profile-v1.json"))).toBeNull();
  expect(await f.exports()).toEqual([committed]);
});
