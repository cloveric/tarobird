import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HubFileCenter, type FileCenterRoots } from "../src/hub/file-center.js";
import { HubServer } from "../src/hub/server.js";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { attachGateway } from "../src/gateway/service.js";
import { createCoreServiceRuntime } from "../src/core/runtime.js";
import { fileCenterStatusSchema } from "../src/client-protocol/file-center.js";
import { collectFileInventory, updateFileInventoryLabel } from "../src/ui/file-inventory.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-files-")); roots.push(root);
  const workspace = path.join(root, "shared"), instances = ["alpha", "beta"].map((name) => ({ name, stateDir: path.join(root, "bots", name) }));
  await mkdir(path.join(workspace, "outputs"), { recursive: true }); await writeFile(path.join(workspace, "outputs", "report.md"), "Report contents");
  const old = new Date("2024-01-01T00:00:00Z"); for (const file of [path.join(workspace, "outputs", "report.md"), path.join(workspace, "outputs")]) await utimes(file, old, old);
  for (const instance of instances) { await mkdir(instance.stateDir, { recursive: true }); await writeFile(path.join(instance.stateDir, "config.json"), JSON.stringify({ workspacePath: workspace, locale: "zh" })); }
  return { root, workspace, instances };
}
async function scan(center: HubFileCenter) { await center.start(); await vi.waitFor(async () => expect((await center.status()).scanning).toBe(false), { timeout: 5000 }); return (await center.status()).inventory!; }

it("scans only registered roots, deduplicates shared workspaces and does not follow symbolic links", async () => {
  const { root, workspace, instances } = await fixture();
  const unrelated = path.join(root, ".cctb", "unconnected"); await mkdir(path.join(unrelated, "workspace", "private"), { recursive: true });
  await writeFile(path.join(unrelated, "config.json"), "{}"); await writeFile(path.join(unrelated, "workspace", "private", "hidden.txt"), "Must not appear");
  await symlink(path.join(unrelated, "workspace"), path.join(workspace, "outside-link"));
  const center = new HubFileCenter(root, async () => ({ instances, warnings: ["offline Bot omitted"] }), { home: root });
  try {
    const result = await scan(center); const output = result.units.find((u) => u.name === "outputs")!;
    expect(output.instances).toEqual(["alpha", "beta"]); expect(result.units.filter((u) => u.name === "outputs")).toHaveLength(1);
    expect(output.fileCount).toBe(1); expect(output.logicalBytes).toBeGreaterThanOrEqual("Report contents".length);
    expect(result.units.find((u) => u.name === "outside-link")).toMatchObject({ kind: "symlink", fileCount: 0, symlinkCount: 1 });
    expect(JSON.stringify(result)).not.toContain("hidden.txt"); expect(result.units.some((u) => u.instances.includes("unconnected"))).toBe(false);
    expect(result.warnings).toContain("offline Bot omitted"); expect(result.totalAllocatedBytes).toBe(result.units.reduce((sum, u) => sum + u.allocatedBytes, 0));
  } finally { await center.close(); }
});

it("persists revisioned labels, rejects stale concurrent edits and restores automatic classification", async () => {
  const { root, instances, workspace } = await fixture(); const source = async () => ({ instances, warnings: [] });
  const center = new HubFileCenter(root, source, { home: root });
  const id = (await scan(center)).units.find((u) => u.name === "outputs")!.id;
  try {
    const changes = await Promise.allSettled([
      center.label({ unitId: id, expectedRevision: 0, category: "source", important: true, note: "Keep this report" }),
      center.label({ unitId: id, expectedRevision: 0, category: "cache", note: "competing update" }),
    ]);
    expect(changes.filter((c) => c.status === "fulfilled")).toHaveLength(1);
    expect(changes.find((c) => c.status === "rejected")).toMatchObject({ reason: { code: "file_label_conflict" } });
    let unit = (await center.status()).inventory!.units.find((u) => u.id === id)!;
    expect(unit.labelRevision).toBe(1); expect(unit.categorySource).toBe("user");
    await center.label({ unitId: id, expectedRevision: 1, category: "source", important: true, note: "Keep" });
    expect((await center.status()).inventory!.units.find((u) => u.id === id)).toMatchObject({ category: "source", safety: "important", note: "Keep", labelRevision: 2 });
    const saved = await readFile(path.join(root, "file-center-labels.json"), "utf8"); expect(saved).toContain("Keep");
    if (process.platform !== "win32") expect((await stat(path.join(root, "file-center-labels.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(workspace, "outputs", "report.md"), "utf8")).toBe("Report contents");
    await center.close(); const restarted = new HubFileCenter(root, source, { home: root });
    try {
      expect((await scan(restarted)).units.find((u) => u.id === id)).toMatchObject({ note: "Keep", labelRevision: 2 });
      await restarted.label({ unitId: id, expectedRevision: 2, category: null, important: false, note: null });
      unit = (await restarted.status()).inventory!.units.find((u) => u.id === id)!;
      expect(unit).toMatchObject({ category: "deliverable", categorySource: "system", safety: "review", important: false, labelRevision: 3 }); expect(unit.note).toBeUndefined();
      await expect(restarted.label({ unitId: id, expectedRevision: 0, note: "old" })).rejects.toMatchObject({ code: "file_label_conflict" });
      await expect(restarted.label({ unitId: "0".repeat(24), expectedRevision: 0, note: "unknown" })).rejects.toMatchObject({ code: "file_unit_not_found" });
    } finally { await restarted.close(); }
  } finally { await center.close(); }
});

it("keeps credential protection after relabeling and refuses malformed durable labels", async () => {
  const { root, instances, workspace } = await fixture(); await writeFile(path.join(workspace, "outputs", "fixture.key"), "not a real key");
  const center = new HubFileCenter(root, async () => ({ instances, warnings: [] }), { home: root });
  try {
    const id = (await scan(center)).units.find((u) => u.name === "outputs")!.id;
    await center.label({ unitId: id, expectedRevision: 0, category: "cache", important: false });
    expect((await center.status()).inventory!.units.find((u) => u.id === id)?.safety).toBe("protected");
    const corrupt = JSON.stringify({ version: 1, units: { [id]: { category: "invalid", revision: 1, updatedAt: new Date().toISOString() } } });
    await writeFile(path.join(root, "file-center-labels.json"), corrupt);
    await expect(center.status()).rejects.toThrow(); await expect(center.start()).rejects.toThrow();
    await expect(center.label({ unitId: id, expectedRevision: 1, note: "overwrite" })).rejects.toThrow();
    expect(await readFile(path.join(root, "file-center-labels.json"), "utf8")).toBe(corrupt);
  } finally { await center.close(); }
});

it("imports existing Console labels only for indexed units and never resurrects a cleared label", async () => {
  const { root, instances } = await fixture();
  const unit = (await collectFileInventory({ HOME: root }, { instances })).units[0]!;
  await updateFileInventoryLabel({ HOME: root }, { unitId: unit.id, important: true, note: "Existing Console note" });
  await updateFileInventoryLabel({ HOME: root }, { unitId: "f".repeat(24), note: "unrelated private note" });
  const legacy = await readFile(path.join(root, ".cctb", "file-inventory-labels.json"), "utf8");
  const center = new HubFileCenter(root, async () => ({ instances, warnings: [] }), { home: root });
  try {
    expect((await scan(center)).units.find((u) => u.id === unit.id)).toMatchObject({ important: true, note: "Existing Console note", labelRevision: 1 });
    expect(await readFile(path.join(root, "file-center-labels.json"), "utf8")).not.toContain("unrelated private note");
    await center.label({ unitId: unit.id, expectedRevision: 1, important: false, note: null });
    const rescanned = (await scan(center)).units.find((u) => u.id === unit.id)!;
    expect(rescanned.important).toBe(false); expect(rescanned.note).toBeUndefined(); expect(rescanned.labelRevision).toBe(2);
    expect(await readFile(path.join(root, ".cctb", "file-inventory-labels.json"), "utf8")).toBe(legacy);
    await writeFile(path.join(root, ".cctb", "file-inventory-labels.json"), '{"version":1,"units":[]}');
    expect((await scan(center)).warnings).toContain("旧文件标注无法读取，本次未导入旧标注。");
    expect(await readFile(path.join(root, ".cctb", "file-inventory-labels.json"), "utf8")).toBe('{"version":1,"units":[]}');
  } finally { await center.close(); }
});

it("shares one scan, retains the previous result on cancellation or failure, and rechecks reveal roots", async () => {
  const { root, instances } = await fixture(); const reveal = vi.fn();
  let get = async (): Promise<FileCenterRoots> => ({ instances, warnings: [] }); const source = vi.fn(() => get());
  const center = new HubFileCenter(root, source, { home: root, reveal });
  try {
    const before = await scan(center), unit = before.units[0]!;
    await center.reveal(unit.id); expect(reveal).toHaveBeenCalledWith(unit.absolutePath);
    let release!: (value: FileCenterRoots) => void; get = () => new Promise((resolve) => { release = resolve; });
    await center.start(); await center.start(); expect(source).toHaveBeenCalledTimes(3);
    expect((await center.status()).scanning).toBe(true); center.cancel(); release({ instances, warnings: [] });
    await vi.waitFor(async () => expect((await center.status()).scanning).toBe(false));
    expect(await center.status()).toMatchObject({ error: "scan_cancelled", inventory: { generatedAt: before.generatedAt } });
    get = async () => { throw new Error("source unavailable"); }; await scan(center);
    expect(await center.status()).toMatchObject({ error: "scan_failed", inventory: { generatedAt: before.generatedAt } });
    get = async () => ({ instances: [], warnings: [] }); await expect(center.reveal(unit.id)).rejects.toMatchObject({ code: "file_reveal_unavailable" });
    expect(reveal).toHaveBeenCalledTimes(1);
  } finally { await center.close(); }
});

async function token(hub: HubServer, id: string, userId = "owner") {
  const keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
  const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
  await hub.auth.approve(pair.code, "local-owner", userId);
  const challenge = await hub.auth.challenge(id, id, nonce, id);
  return (await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"))).token;
}
it("requires a paired owner at the HTTP boundary and gets registered roots through the real Gateway", async () => {
  const { root, instances } = await fixture(); const hub = await HubServer.start({ stateDir: path.join(root, "hub") });
  const secret = randomBytes(32).toString("base64url"); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha',?)", [hashSecret(secret)]);
  const channel = await attachGateway({ stateDir: instances[0]!.stateDir, url: hub.url.replace("http", "ws") + "/instance", botId: "alpha", secret, runtime: createCoreServiceRuntime(), bridge: { handleAuthorizedMessage: async () => ({ text: "unused" }) } });
  try {
    const owner = await token(hub, "desktop"), phone = await token(hub, "phone"); await hub.store.db.run("INSERT INTO users VALUES('guest','Guest','member')"); const guest = await token(hub, "guest", "guest");
    const http = (auth: string, endpoint: string, method = "GET", body?: unknown) => fetch(hub.url + endpoint, { method, headers: { Authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    for (const [url, method] of [["/api/files", "GET"], ["/api/files/scan", "POST"], ["/api/files/labels", "PATCH"], ["/api/files/reveal", "POST"]]) {
      expect((await http("", url!, method)).status).toBe(401); expect((await http(guest, url!, method)).status).toBe(403);
    }
    expect((await http(owner, "/api/files/scan", "POST")).status).toBe(202);
    await vi.waitFor(async () => expect(fileCenterStatusSchema.parse(await (await http(owner, "/api/files")).json()).scanning).toBe(false), { timeout: 5000 });
    const state = fileCenterStatusSchema.parse(await (await http(owner, "/api/files")).json()), unit = state.inventory!.units[0]!;
    expect(unit.instances).toEqual(["alpha"]);
    expect(await (await http(phone, `/api/files?revision=${encodeURIComponent(state.revision)}`)).json()).toEqual({ unchanged: true });
    expect((await http(owner, "/api/files/labels", "PATCH", { unitId: unit.id, expectedRevision: 0, note: "Shared note" })).status).toBe(200);
    expect(await (await http(phone, `/api/files?revision=${encodeURIComponent(state.revision)}`)).json()).not.toHaveProperty("unchanged");
    expect(fileCenterStatusSchema.parse(await (await http(phone, "/api/files")).json()).inventory!.units.find((u) => u.id === unit.id)?.note).toBe("Shared note");
    expect((await http(phone, "/api/files/labels", "PATCH", { unitId: unit.id, expectedRevision: 0, note: "Stale note" })).status).toBe(409);
    expect((await http(owner, "/api/files/reveal", "POST", { unitId: unit.id, path: "/private" })).status).toBe(400);
    expect((await http(owner, "/api/files/delete", "POST", { unitId: unit.id })).status).toBe(404);
    await hub.auth.revoke("phone", "local-owner"); expect((await http(phone, "/api/files")).status).toBe(401);
  } finally { await channel.disconnect(); await hub.close(); }
}, 20_000);
