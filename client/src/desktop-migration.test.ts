import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HOST_STORES, MIGRATION_LIMITS, REGISTRY_DATABASE, decodeValue, encodeRecordLine, encodeValue, parseRecordLine, type MigrationManifest,
} from "./desktop-migration-format.js";
import { EXPORT_ID_HEADER, exportDesktopData, migrationExportError, tauriExportSink, type ExportMetadata, type ExportSink, type ExportSource } from "./desktop-migration-export.js";
import { importDesktopData, type ImportTarget, type RegistryRecords, type StoredRecord } from "./desktop-migration-import.js";

const HUB = `hub_${"a".repeat(64)}`, HOST_DB = `tarocub-host-${HUB}-${randomUUID()}`;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

class MemorySource implements ExportSource {
  constructor(readonly dbs: Map<string, { version: number; stores: Map<string, [unknown, unknown][]> }>, readonly local: [string, string][] = []) {}
  async database(name: string) { const db = this.dbs.get(name); return db && { version: db.version }; }
  async *records(name: string, store: string) { for (const [key, value] of this.dbs.get(name)?.stores.get(store) ?? []) yield { key, value }; }
  *localStorage() { yield* this.local; }
}
/** Mirrors the native writer's authoritative bookkeeping (see desktop_migration.rs). */
class MemorySink implements ExportSink {
  id = randomUUID(); parts: string[] = []; blobs = new Map<string, Uint8Array>(); aborted = false; manifest?: MigrationManifest;
  async begin() { return this.id; }
  async part(index: number, text: string) { expect(index).toBe(this.parts.length); this.parts.push(text); }
  async blob(bytes: Uint8Array) { const digest = sha(bytes); this.blobs.set(digest, bytes.slice()); return digest; }
  async abort() { this.aborted = true; }
  async commit(metadata: ExportMetadata) {
    const counts = new Map<string, Record<string, number>>(); let local = 0, records = 0;
    for (const line of this.parts.join("").split("\n").filter(Boolean)) {
      const { d, s } = parseRecordLine(line); records++;
      if (d === "localStorage") local++; else { const stores = counts.get(d) ?? {}; stores[s] = (stores[s] ?? 0) + 1; counts.set(d, stores); }
    }
    expect(new Set(metadata.databases.map(d => d.name))).toEqual(new Set(counts.keys()));
    const bytes = this.parts.reduce((n, p) => n + Buffer.byteLength(p), 0) + [...this.blobs.values()].reduce((n, b) => n + b.length, 0);
    this.manifest = { format: "tarobot-desktop-migration", version: 1, exportId: this.id, createdAt: 1, installation: "0".repeat(64), source: { app: "tauri", appVersion: metadata.appVersion },
      databases: metadata.databases.map(d => ({ name: d.name, version: d.version, stores: counts.get(d.name)! })), localStorage: local,
      parts: this.parts.map((p, i) => ({ file: `${String(i).padStart(6, "0")}.jsonl`, bytes: Buffer.byteLength(p), sha256: sha(Buffer.from(p)), records: p.split("\n").length - 1 })),
      blobs: [...this.blobs].map(([digest, b]) => ({ sha256: digest, bytes: b.length })), totals: { records, bytes }, skipped: metadata.skipped, requiresRepair: metadata.requiresRepair };
    return { exportId: this.id, records, bytes };
  }
  source() { return { manifest: this.manifest!, part: async (i: number) => this.parts[i]!, blob: async (s: string) => this.blobs.get(s) ?? Promise.reject(new Error("missing")) }; }
}
class MemoryTarget implements ImportTarget {
  dbs = new Map<string, Map<string, Map<string, StoredRecord>>>(); local = new Map<string, string>(); meta = new Map<string, string>();
  marker?: string; hosts = 0; candidates = 0; failCommit = 0; failLocal = 0; writes = 0; markers = new Map<string, string>(); names?: string[];
  constructor(readonly hostVersion = 9, readonly registryVersion = 2) {}
  store(d: string, s: string) { const db = this.dbs.get(d) ?? new Map(); this.dbs.set(d, db); const store = db.get(s) ?? new Map(); db.set(s, store); return store; }
  async state() {
    const local = this.meta.get("desktopMigrationLocalStorage");
    return { hosts: this.hosts, candidates: this.candidates, registryVersion: this.registryVersion, ...(this.marker ? { importedExportId: this.marker } : {}), ...(local ? { pendingLocalStorage: JSON.parse(local) } : {}) };
  }
  async inspect(d: string) {
    const db = this.dbs.get(d); if (!db) return { exists: false, records: 0 };
    const records = [...db.values()].reduce((n, s) => n + s.size, 0) + (this.markers.has(d) ? 1 : 0);
    return { exists: true, records, ...(this.markers.has(d) ? { marker: this.markers.get(d) } : {}) };
  }
  async databases() { return this.names ?? [...this.dbs.keys()]; }
  async prepare() { return this.hostVersion; }
  async claim(d: string, stores: readonly string[], exportId: string) { this.writes++; for (const s of stores) this.store(d, s).clear(); this.markers.set(d, exportId); }
  async put(d: string, s: string, records: StoredRecord[]) { this.writes++; for (const r of records) this.store(d, s).set(JSON.stringify(r.key), r); }
  async commitRegistry(records: RegistryRecords, exportId: string, extras: { repair: string[]; local: [string, string][] }) {
    if (this.failCommit-- > 0) throw new Error("simulated_crash");
    for (const [s, list] of Object.entries(records)) { const store = this.store(REGISTRY_DATABASE, s); store.clear(); for (const r of list) store.set(JSON.stringify(r.key), r); }
    this.hosts = records.hosts.length; this.marker = exportId;
    if (extras.repair.length) this.meta.set("desktopMigrationRepair", JSON.stringify(extras.repair));
    if (extras.local.length) this.meta.set("desktopMigrationLocalStorage", JSON.stringify(extras.local));
  }
  async setLocalStorage(entries: [string, string][]) { if (this.failLocal-- > 0) throw new Error("QuotaExceededError"); for (const [k, v] of entries) this.local.set(k, v); }
  async finishLocalStorage() { this.meta.delete("desktopMigrationLocalStorage"); }
}

const draftFile = () => new File([new Uint8Array(70 * 1024).map((_, i) => i % 251)], "设计稿 v2.pdf", { type: "application/pdf", lastModified: 1_700_000_000_000 });
function sampleSource(extra?: (stores: Map<string, [unknown, unknown][]>) => void) {
  const host = new Map<string, [unknown, unknown][]>([
    ["settings", [["identity", { deviceId: "device_x", keyRef: "device_x", publicKey: "pk", hubPublicKey: "hk", platform: "macos" }], ["outboxOrder", "1700000000001"]]],
    ["outbox", [["client_1", { id: "client_1", order: 1, frame: { v: 1, type: "message.send", clientMsgId: "client_1", conversationId: "c1", text: "hi" } }]]],
    ["conversationDrafts", [["c1", { text: "draft", files: [{ bytes: new Uint8Array([1, 2, 3]).buffer, name: "a.bin", type: "", lastModified: 5 }], size: 3, active: 1, revision: "r", owner: "o" }]]],
    ["messages", [["m1", { id: "m1", conversationId: "c1", status: "complete", createdAt: new Date(0), extra: { $t: "user-data" }, score: -0, missing: undefined }]]],
    ["downloadChunks", [[["att", "rev", 0], { attachmentId: "att", revision: "rev", index: 0, bytes: new Uint8Array(10) }]]],
    ["attachmentData", [["att-1", draftFile()]]],
  ]);
  extra?.(host);
  return new MemorySource(new Map([
    [REGISTRY_DATABASE, { version: 2, stores: new Map<string, [unknown, unknown][]>([["hosts", [[HUB, { id: HUB, databaseName: HOST_DB, registrationId: "r", state: "ready" }]]], ["meta", [["preferences", "{}"], ["selectedHost", HUB]]]]) }],
    [HOST_DB, { version: 9, stores: host }],
  ]), [["tarocub-appearance", "{\"theme\":\"dark\"}"], ["tarobot:desktop-join-intent:v1", "x"], ["unrelated-site-key", "secret"]]);
}
async function normalize(value: unknown): Promise<unknown> {
  if (value instanceof File) return { file: value.name, type: value.type, lastModified: value.lastModified, sha: sha(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof Blob) return { blob: value.type, sha: sha(new Uint8Array(await value.arrayBuffer())) };
  if (value instanceof ArrayBuffer) return { buffer: sha(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { view: Object.getPrototypeOf(value).constructor.name, sha: sha(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  if (value instanceof Date) return { date: value.getTime() };
  if (Object.is(value, -0)) return "-0";
  if (Array.isArray(value)) return Promise.all(value.map(normalize));
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await normalize(v)])));
  return value;
}

describe("desktop migration codec", () => {
  it("preserves lone UTF-16 units in nested values, property names and IndexedDB keys through the existing JSON-blob format", async () => {
    const blobs = new Map<string, Uint8Array>();
    const put = async (bytes: Uint8Array) => { const id = sha(bytes); blobs.set(id, bytes.slice()); return id; };
    const get = async (id: string) => blobs.get(id)!;
    const key = ["message", "\ud800", "\udfff"];
    const value = { summary: "truncated emoji \ud83d", nested: [{ "\ud800-key": "\udfff" }], literal: "\\ud800", emoji: "😀" };
    const record = parseRecordLine(await encodeRecordLine({ d: HOST_DB, s: "messages", k: await encodeValue(key, put), v: await encodeValue(value, put) }, put));
    expect(record.k).toMatchObject({ $t: "json" });
    expect(record.v).toMatchObject({ $t: "json" });
    expect(blobs.size).toBe(2);
    expect(await decodeValue(record.k, get)).toEqual(key);
    expect(await decodeValue(record.v, get)).toEqual(value);
    // Native JSONL contains only hashes; the ASCII JSON escapes remain in the
    // authenticated blob where the existing JS decoder can recover them.
    expect(JSON.stringify(record)).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/);
    expect(blobs.get((record.v as { ref: string }).ref)).toEqual(new TextEncoder().encode(JSON.stringify(value)));
  });

  it("keeps normal emoji and literal surrogate escape text inline", async () => {
    const put = async () => { throw new Error("unexpected blob"); };
    for (const text of ["😀中文", "\\ud800", "\\\\udfff", "\\\\\\ud800", 'a\\"b', "\\ud83d\\ude00"]) {
      const record = parseRecordLine(await encodeRecordLine({ d: HOST_DB, s: "messages", k: "m", v: { text } }, put));
      expect(record.v).toEqual({ text });
    }
  });

  it("preserves bounded native error codes without exposing their details", () => {
    expect(migrationExportError("migration_record_invalid")).toBe("migration_record_invalid");
    expect(migrationExportError("legacy_source_in_use")).toBe("legacy_source_in_use");
    expect(migrationExportError(new Error("migration_value_too_large:private data"))).toBe("migration_value_too_large");
    for (const error of ["native private text", new Error("TypeError: private text"), { message: "migration_record_invalid" }, "migration_" + "a".repeat(101), null]) {
      expect(migrationExportError(error)).toBe("migration_export_failed");
    }
  });

  it("preserves own prototype-like keys as data through JSON and structured cloning", async () => {
    const value = JSON.parse('{"__proto__":{"kept":true},"constructor":{"prototype":{"safe":2}},"nested":{"$t":"user-data","__proto__":[{"__proto__":"leaf"}]},"array":[{"__proto__":null}]}');
    const encoded = await encodeValue(value, async () => { throw new Error("unexpected blob"); });
    const decoded = await decodeValue(JSON.parse(JSON.stringify(encoded)), async () => { throw new Error("unexpected blob"); }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.hasOwn(decoded, "__proto__")).toBe(true);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(value));
    expect(JSON.stringify(structuredClone(decoded))).toBe(JSON.stringify(value));
    expect(Object.getOwnPropertyDescriptor(decoded, "__proto__")).toMatchObject({ writable: true, enumerable: true, configurable: true, value: { kept: true } });
    expect(Object.hasOwn(Object.prototype, "kept")).toBe(false);
  });

  it("round-trips every supported structured-clone value and escapes $t objects", async () => {
    const blobs = new Map<string, Uint8Array>(), put = async (b: Uint8Array) => { blobs.set(sha(b), b.slice()); return sha(b); };
    const view = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4);
    const value = { file: draftFile(), blob: new Blob(["小"], { type: "text/plain" }), buffer: new Uint8Array(100_000).fill(3).buffer, view, floats: new Float64Array([1.5, NaN]),
      data: new DataView(new Uint8Array([1, 2]).buffer), date: new Date(1234), bad: new Date(NaN), nums: [NaN, Infinity, -Infinity, -0, 1], none: undefined, big: 12345678901234567890n,
      tagged: { $t: "date", v: 1 }, nested: [{ deep: { $t: ["x"] } }], nul: null };
    const encoded = await encodeValue(value, put);
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
    expect(blobs.size).toBe(2); // the 70 KiB file and 100 KB buffer; smaller bytes stay inline
    const decoded = await decodeValue(encoded, async digest => blobs.get(digest)!) as typeof value;
    expect(await normalize(decoded)).toEqual(await normalize(value));
    expect(decoded.big).toBe(value.big); expect(Number.isNaN(decoded.floats[1])).toBe(true); expect(Object.hasOwn(decoded, "none")).toBe(true);
  });

  it("fails on cycles and unsupported types, and reports non-extractable keys", async () => {
    const put = async () => "0".repeat(64);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const bad of [cyclic, new Map(), new Set([1]), () => 1, Symbol("x"), new (class Custom {})(), /x/, new Error("e")]) {
      await expect(encodeValue({ bad }, put)).rejects.toThrow(/migration_value_/);
    }
    const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    const report = { unexportable: [] as string[] };
    const encoded = await encodeValue({ identity: { privateKey, deviceId: "d" } }, put, report);
    expect(report.unexportable).toEqual(["$.identity.privateKey"]);
    expect(await decodeValue(encoded, put as never)).toEqual({ identity: { privateKey: undefined, deviceId: "d" } });
    await expect(decodeValue({ $t: "unknown" }, put as never)).rejects.toThrow("migration_record_invalid");
    await expect(decodeValue({ $t: "bytes", kind: "Uint8Array", size: 2, b64: "AAAA" }, put as never)).rejects.toThrow("migration_record_invalid");
  });

  it("moves an oversized value into a JSON blob and allowlists databases and stores", async () => {
    const blobs = new Map<string, Uint8Array>(), put = async (b: Uint8Array) => { blobs.set(sha(b), b.slice()); return sha(b); };
    const text = "x".repeat(MIGRATION_LIMITS.line + 10);
    const line = await encodeRecordLine({ d: HOST_DB, s: "messages", k: "m", v: { text } }, put);
    expect(Buffer.byteLength(line)).toBeLessThan(1024);
    const record = parseRecordLine(line.trimEnd());
    expect(await decodeValue(record.v, async d => blobs.get(d)!)).toEqual({ text });
    await expect(encodeRecordLine({ d: HOST_DB, s: "syncMessages", k: 1, v: 1 }, put)).rejects.toThrow("migration_store_not_allowed");
    for (const bad of [`{"d":"${HOST_DB}","s":"syncState","k":1,"v":1}`, `{"d":"other","s":"settings","k":1,"v":1}`, `{"d":"${HOST_DB}","s":"outbox","k":1,"v":1,"x":1}`, "[]"]) {
      expect(() => parseRecordLine(bad)).toThrow("migration_record_invalid");
    }
  });
});

describe("desktop migration export and import", () => {
  it("upgrades v9-v11 to v12 and preserves full Design files and receipts", async () => {
    for (const version of [9,10,11]) {
      const source=sampleSource();source.dbs.get(HOST_DB)!.version=version;
      const sink=new MemorySink();await exportDesktopData(source,sink,{appVersion:"1.0.122"});
      expect(await importDesktopData(sink.source(),new MemoryTarget(12))).toMatchObject({state:"imported"});
    }
    const design={schema:1,id:"design",revision:3,files:{"project/assets/image":{base64:"YQ==".repeat(400000),contentType:"image/png",sha256:"a".repeat(64),size:1200000}},receipts:[{id:"edit",fingerprint:"abc",revision:3}]};
    const source=sampleSource(stores=>stores.set("workbenchDesign",[[["scope","design"],design]]));source.dbs.get(HOST_DB)!.version=12;
    const sink=new MemorySink();await exportDesktopData(source,sink,{appVersion:"1.0.122"});
    const target=new MemoryTarget(12);expect(await importDesktopData(sink.source(),target)).toMatchObject({state:"imported"});
    expect([...target.dbs.get(HOST_DB)!.get("workbenchDesign")!.values()][0].value).toEqual(design);
    await expect(importDesktopData(sink.source(),new MemoryTarget(11))).rejects.toThrow("migration_schema_mismatch");
  });

  it("upgrades v9/v10 only to additive v11 and preserves Markdown content and undo history", async () => {
    for (const version of [9, 10]) {
      const source = sampleSource(); source.dbs.get(HOST_DB)!.version = version;
      const sink = new MemorySink(); await exportDesktopData(source, sink, { appVersion: "1.0.121" });
      const target = new MemoryTarget(11); expect(await importDesktopData(sink.source(), target)).toMatchObject({ state: "imported" });
      expect(target.dbs.get(HOST_DB)!.get("outbox")!.size).toBe(1);
    }
    const note = { schema: 1, id: "note", revision: 2, content: "# 保留😀\n" + "内容".repeat(30000), undo: ["原文"], redo: [], receipts: [{ id: "edit", fingerprint: "abc", revision: 2 }] };
    const source = sampleSource(stores => stores.set("workbenchMarkdown", [[["scope", "note"], note]])); source.dbs.get(HOST_DB)!.version = 11;
    const sink = new MemorySink(); await exportDesktopData(source, sink, { appVersion: "1.0.121" });
    const target = new MemoryTarget(11); expect(await importDesktopData(sink.source(), target)).toMatchObject({ state: "imported" });
    expect([...target.dbs.get(HOST_DB)!.get("workbenchMarkdown")!.values()][0].value).toEqual(note);
    await expect(importDesktopData(sink.source(), new MemoryTarget(10))).rejects.toThrow("migration_schema_mismatch");
  });

  it("imports v9 into the additive v10 schema and preserves large v10 whiteboards on export and import", async () => {
    const old = new MemorySink(); await exportDesktopData(sampleSource(), old, {appVersion:"1.0.120"});
    const upgraded = new MemoryTarget(10); expect(await importDesktopData(old.source(),upgraded)).toMatchObject({state:"imported"});
    expect(upgraded.dbs.get(HOST_DB)!.get("outbox")!.size).toBe(1);
    const board={id:"board",revision:3,scene:{elements:[{id:"image",fileId:"image_file"}],appState:{}},files:{image_file:{dataURL:"data:image/png;base64,"+"a".repeat(2*1024*1024)}}};
    const source=sampleSource(stores=>{stores.set("workbenchBoards",[[["scope","board"],board]]);stores.set("workbenchLayouts",[["scope",{schema:1,revision:4,tabs:[{id:"board",kind:"whiteboard",title:"Keep"}]}]]);});
    source.dbs.get(HOST_DB)!.version=10;
    const sink=new MemorySink();await exportDesktopData(source,sink,{appVersion:"1.0.121"});
    const target=new MemoryTarget(10);expect(await importDesktopData(sink.source(),target)).toMatchObject({state:"imported"});
    expect([...target.dbs.get(HOST_DB)!.get("workbenchBoards")!.values()][0].value).toEqual(board);
    expect([...target.dbs.get(HOST_DB)!.get("workbenchLayouts")!.values()][0].value).toEqual(source.dbs.get(HOST_DB)!.stores.get("workbenchLayouts")![0][1]);
  });
  it("exports readonly and imports an identical registry, host database and TaroBird localStorage", async () => {
    const source = sampleSource(), sink = new MemorySink();
    const exported = await exportDesktopData(source, sink, { appVersion: "1.0.120" });
    expect(exported).toMatchObject({ state: "exported", exportId: sink.id, records: 12, requiresRepair: [] });
    const target = new MemoryTarget();
    const result = await importDesktopData(sink.source(), target);
    expect(result).toMatchObject({ state: "imported", exportId: sink.id, records: 12, localStorage: "saved" });
    for (const [name, db] of source.dbs) for (const [store, records] of db.stores) {
      const imported = [...target.dbs.get(name)!.get(store)!.values()];
      expect(target.markers.get(name) ?? sink.id).toBe(sink.id);
      expect(await normalize(imported.map(r => [r.key, r.value]))).toEqual(await normalize(records));
    }
    expect(target.marker).toBe(sink.id);
    expect([...target.local.keys()]).toEqual(["tarocub-appearance", "tarobot:desktop-join-intent:v1"]);
    expect(await importDesktopData(sink.source(), target)).toEqual({ state: "already_imported", exportId: sink.id, localStorage: "saved" });
    expect(target.meta.has("desktopMigrationLocalStorage")).toBe(false);
  });

  it("marks hosts with a non-extractable key for repair instead of inventing an identity", async () => {
    const { privateKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
    const source = sampleSource(stores => stores.set("settings", [["identity", { deviceId: "device_w", privateKey, publicKey: "pk" }]]));
    const sink = new MemorySink(), exported = await exportDesktopData(source, sink, { appVersion: "1.0.120" });
    expect(exported).toMatchObject({ state: "exported", requiresRepair: [HUB], skipped: [{ d: HOST_DB, s: "settings", reason: "crypto_key_removed" }] });
    const target = new MemoryTarget(); expect(await importDesktopData(sink.source(), target)).toMatchObject({ state: "imported", requiresRepair: [HUB] });
    expect(target.dbs.get(HOST_DB)!.get("settings")!.get(JSON.stringify("identity"))!.value).toEqual({ deviceId: "device_w", privateKey: undefined, publicKey: "pk" });
    // Persisted with the registry so the App can refuse to connect these hosts.
    expect(JSON.parse(target.meta.get("desktopMigrationRepair")!)).toEqual([HUB]);
  });

  it("skips only oversized optional cache entries and fails the whole export on unsupported required data", async () => {
    const huge = new ArrayBuffer(MIGRATION_LIMITS.blob + 1);
    const sink = new MemorySink();
    const exported = await exportDesktopData(sampleSource(stores => stores.get("attachmentData")!.push(["att-2", huge])), sink, { appVersion: "1.0.120" });
    expect(exported).toMatchObject({ state: "exported", skipped: [{ s: "attachmentData", reason: "too_large" }] });
    const failing = new MemorySink();
    await expect(exportDesktopData(sampleSource(stores => stores.get("settings")!.push(["bad", new Map()])), failing, { appVersion: "1.0.120" })).rejects.toThrow(/migration_value_unsupported/);
    expect(failing.aborted).toBe(true); expect(failing.manifest).toBeUndefined();
    const none = new MemorySink();
    expect(await exportDesktopData(new MemorySource(new Map()), none, { appVersion: "1.0.120" })).toMatchObject({ state: "exported", records: 1 });
    expect(none.manifest?.databases[0]?.name).toBe(REGISTRY_DATABASE);
  });

  it("refuses non-empty targets, survives an interrupted commit and rejects manifest or schema mismatches before visibility", async () => {
    const sink = new MemorySink(); await exportDesktopData(sampleSource(), sink, { appVersion: "1.0.120" });
    const occupied = new MemoryTarget(); occupied.hosts = 1;
    expect(await importDesktopData(sink.source(), occupied)).toEqual({ state: "target_not_empty", reason: "hosts" });
    expect(occupied.writes).toBe(0);
    const other = new MemoryTarget(); other.marker = randomUUID();
    expect((await importDesktopData(sink.source(), other)).state).toBe("target_not_empty");
    const crashing = new MemoryTarget(); crashing.failCommit = 1;
    await expect(importDesktopData(sink.source(), crashing)).rejects.toThrow("simulated_crash");
    expect(crashing.marker).toBeUndefined();
    expect(await importDesktopData(sink.source(), crashing)).toMatchObject({ state: "imported" });
    expect(crashing.dbs.get(HOST_DB)!.get("outbox")!.size).toBe(1);
    const tampered = sink.source(); tampered.manifest = structuredClone(tampered.manifest);
    tampered.manifest.databases.find(d => d.name === HOST_DB)!.stores.outbox = 2;
    const target = new MemoryTarget();
    await expect(importDesktopData(tampered, target)).rejects.toThrow("migration_manifest_mismatch");
    expect(target.marker).toBeUndefined();
    await expect(importDesktopData(sink.source(), new MemoryTarget(14))).rejects.toThrow("migration_schema_mismatch");
    await expect(importDesktopData(sink.source(), new MemoryTarget(9, 3))).rejects.toThrow("migration_schema_mismatch");
    expect(HOST_STORES).not.toContain("syncState");
  });
});

describe("desktop migration target safety and contracts", () => {
  it("a refreshed verified snapshot may replace only its predecessor's uncommitted claims", async () => {
    const old = new MemorySink(); await exportDesktopData(sampleSource(), old, { appVersion: "1.0.119" });
    const fresh = new MemorySink(); await exportDesktopData(sampleSource(), fresh, { appVersion: "1.0.120" });
    const interrupted = new MemoryTarget(); interrupted.failCommit = 1;
    await expect(importDesktopData(old.source(), interrupted)).rejects.toThrow("simulated_crash");
    expect(interrupted.marker).toBeUndefined();
    const source = { ...fresh.source(), replacesExportId: old.id };
    expect(await importDesktopData(source, interrupted)).toMatchObject({ state: "imported", exportId: fresh.id });
    expect(interrupted.dbs.get(HOST_DB)!.get("outbox")!.size).toBe(1);
    const committed = new MemoryTarget(); await importDesktopData(old.source(), committed);
    expect(await importDesktopData(source, committed)).toMatchObject({ state: "target_not_empty", reason: "previous_import" });
    const unrelated = new MemoryTarget(); unrelated.markers.set(HOST_DB, randomUUID()); unrelated.store(HOST_DB, "outbox").set('"other"', { key: "other", value: {} });
    expect(await importDesktopData(source, unrelated)).toMatchObject({ state: "target_not_empty", reason: "database_in_use" });
    expect(unrelated.writes).toBe(0);
  });
  it("refuses a legacy identity or a database it does not own, but resumes its own interrupted claim", async () => {
    const sink = new MemorySink(); await exportDesktopData(sampleSource(), sink, { appVersion: "1.0.120" });
    const legacy = new MemoryTarget(); legacy.store("tarocub-v1", "settings").set('"identity"', { key: "identity", value: {} });
    expect(await importDesktopData(sink.source(), legacy)).toEqual({ state: "target_not_empty", reason: "legacy_identity", database: "tarocub-v1" });
    const busy = new MemoryTarget(); busy.store(HOST_DB, "outbox").set('"x"', { key: "x", value: {} });
    expect(await importDesktopData(sink.source(), busy)).toEqual({ state: "target_not_empty", reason: "database_in_use", database: HOST_DB });
    expect(busy.writes).toBe(0);
    const resumed = new MemoryTarget(); resumed.markers.set(HOST_DB, sink.id); resumed.store(HOST_DB, "outbox").set('"stale"', { key: "stale", value: {} });
    expect(await importDesktopData(sink.source(), resumed)).toMatchObject({ state: "imported" });
    expect([...resumed.store(HOST_DB, "outbox").keys()]).toEqual(['"client_1"']);
    const other = `tarocub-host-hub_${"c".repeat(64)}-${randomUUID()}`;
    const orphaned = new MemoryTarget(); orphaned.store(other, "outbox").set('"o"', { key: "o", value: {} });
    expect(await importDesktopData(sink.source(), orphaned)).toMatchObject({ state: "imported", orphanDatabases: [other] });
    expect(orphaned.store(other, "outbox").size).toBe(1);
    const candidate = new MemoryTarget(); candidate.candidates = 1;
    expect(await importDesktopData(sink.source(), candidate)).toEqual({ state: "target_not_empty", reason: "network_candidates" });
  });

  it("keeps a localStorage failure retryable instead of losing it after the registry commits", async () => {
    const sink = new MemorySink(); await exportDesktopData(sampleSource(), sink, { appVersion: "1.0.120" });
    const target = new MemoryTarget(); target.failLocal = 2;
    expect(await importDesktopData(sink.source(), target)).toMatchObject({ state: "imported", localStorage: "failed" });
    expect(target.local.size).toBe(0); expect(target.meta.has("desktopMigrationLocalStorage")).toBe(true);
    expect(await importDesktopData(sink.source(), target)).toEqual({ state: "already_imported", exportId: sink.id, localStorage: "failed" });
    expect(await importDesktopData(sink.source(), target)).toEqual({ state: "already_imported", exportId: sink.id, localStorage: "saved" });
    expect([...target.local.keys()]).toEqual(["tarocub-appearance", "tarobot:desktop-join-intent:v1"]);
    expect(target.meta.has("desktopMigrationLocalStorage")).toBe(false);
  });

  it("reports a registered host whose source database is missing or empty as requiring repair", async () => {
    const source = sampleSource();
    const ghost = `tarocub-host-hub_${"d".repeat(64)}-${randomUUID()}`, empty = `tarocub-host-hub_${"e".repeat(64)}-${randomUUID()}`;
    source.dbs.get(REGISTRY_DATABASE)!.stores.get("hosts")!.push([`hub_${"d".repeat(64)}`, { id: `hub_${"d".repeat(64)}`, databaseName: ghost }], [`hub_${"e".repeat(64)}`, { id: `hub_${"e".repeat(64)}`, databaseName: empty }]);
    source.dbs.set(empty, { version: 9, stores: new Map() });
    const sink = new MemorySink();
    const exported = await exportDesktopData(source, sink, { appVersion: "1.0.120" });
    expect(exported).toMatchObject({ state: "exported", requiresRepair: [`hub_${"d".repeat(64)}`, `hub_${"e".repeat(64)}`] });
    expect((exported as { skipped: { reason: string }[] }).skipped.map(s => s.reason)).toEqual(["database_missing", "database_empty"]);
  });

  it("binds every native export request to the ID returned by begin", async () => {
    const calls: [string, unknown, unknown][] = [], id = randomUUID();
    const sink = tauriExportSink(async <T,>(command: string, args?: unknown, options?: unknown) => { calls.push([command, args, options]); return (command === "desktop_migration_begin" ? id : command === "desktop_migration_blob" ? "f".repeat(64) : null) as T; });
    await expect(sink.part(0, "x\n")).rejects.toThrow("migration_export_not_started");
    await sink.begin(); await sink.part(0, "x\n"); await sink.blob(new Uint8Array([1])); await sink.abort();
    expect(calls.slice(1)).toEqual([
      ["desktop_migration_part", { exportId: id, index: 0, text: "x\n" }, undefined],
      ["desktop_migration_blob", new Uint8Array([1]), { headers: { [EXPORT_ID_HEADER]: id } }],
      ["desktop_migration_abort", { exportId: id }, undefined],
    ]);
  });
});
