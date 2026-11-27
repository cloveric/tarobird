import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { desktopHost } from "../src/hub/desktop.js";
import { inspectHubService } from "../src/hub/service.js";
import { HubStore } from "../src/hub/store.js";
import { HubDatabase } from "../src/hub/database.js";
import { readHostSchema } from "../src/host-cli/schema-guard.js";

// Issue #63: an explicitly stopped desktop host is restartable from the App
// (the native `desktop_host` start) without the CLI; an older database is
// upgraded by the Hub itself, as on any App upgrade; resume never re-enables.
const roots: string[] = [];
const entry = path.resolve("dist/src/index.js");
type Start = { running: boolean; publicKey?: string; hostName?: string; hostEnabled?: boolean; startIssue?: Record<string, unknown> };
async function hostDirectory() {
  // The control socket path is length-limited; keep the host one level deep.
  const root = await mkdtemp(path.join(os.tmpdir(), "t63-")); roots.push(root);
  return path.join(root, "host");
}
afterEach(async () => {
  for (const root of roots.splice(0)) { await desktopHost("stop", path.join(root, "host"), entry).catch(() => undefined); await rm(root, { recursive: true, force: true }); }
});
const start = (directory: string, input?: Record<string, unknown>) => desktopHost("start", directory, entry, input) as Promise<Start>;
const enabled = async (directory: string) => (await readFile(path.join(directory, "desktop-enabled.json"), "utf8")).trim();
async function stoppedAt(directory: string, schema: number) {
  const started = await start(directory, { hostName: "Fixture Mac" });
  await desktopHost("stop", directory, entry);
  const store = await HubStore.open(directory);
  try { await store.db.run("UPDATE meta SET value=? WHERE key='schema_version'", [String(schema)]); }
  finally { await store.db.close(); }
  return started;
}
async function counts(file: string) {
  const db = await HubDatabase.snapshot(file);
  try {
    const result: Record<string, number> = {};
    for (const table of ["bots", "conversations", "messages", "devices"]) result[table] = (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))!.count;
    return result;
  } finally { await db.close(); }
}

describe("explicitly restarting a stopped desktop host", () => {
  it("re-enables only through start; resume keeps an explicitly stopped host stopped", async () => {
    const directory = await hostDirectory();
    const started = await start(directory, { hostName: "Fixture Mac" });
    expect(started.running).toBe(true);
    expect(await enabled(directory)).toBe("true");
    expect(await desktopHost("stop", directory, entry)).toMatchObject({ running: false, hostEnabled: false });
    expect(await enabled(directory)).toBe("false");
    // Automatic recovery must not turn an explicitly stopped host back on.
    for (let attempt = 0; attempt < 2; attempt++) expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: false, hostEnabled: false });
    expect((await inspectHubService(directory)).running).toBe(false);
    expect(await enabled(directory)).toBe("false");
    expect(await start(directory)).toMatchObject({ running: true, publicKey: started.publicKey, hostName: "Fixture Mac" });
    expect(await enabled(directory)).toBe("true");
  }, 60_000);

  it("upgrades an older database on an explicit start, keeping identity and history, like an App upgrade", async () => {
    const directory = await hostDirectory();
    const started = await stoppedAt(directory, 25);
    const database = path.join(directory, "hub.sqlite"), identity = await readFile(path.join(directory, "identity.json"));
    const before = await counts(database), bytes = await readFile(database);
    // Resume with a pending migration neither starts nor touches the database.
    expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: false, hostEnabled: false });
    expect(await readFile(database)).toEqual(bytes);
    expect(await start(directory)).toMatchObject({ running: true, publicKey: started.publicKey, hostName: "Fixture Mac" });
    expect(await readHostSchema(directory)).toBe(28);
    expect(await enabled(directory)).toBe("true");
    expect(await readFile(path.join(directory, "identity.json"))).toEqual(identity);
    expect(await counts(database)).toEqual(before);
    // No backup or other side record: nothing new next to the host.
    await expect(stat(`${directory}.runtime`)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("refuses a database written by a newer schema with a readable reason instead of starting", async () => {
    const directory = await hostDirectory();
    await stoppedAt(directory, 29);
    const database = path.join(directory, "hub.sqlite"), bytes = await readFile(database);
    expect(await start(directory)).toMatchObject({ running: false, hostEnabled: false, startIssue: { code: "schema_incompatible", schema: 29, maxHubSchema: 28 } });
    expect((await inspectHubService(directory)).running).toBe(false);
    expect(await readFile(database)).toEqual(bytes);
    expect(await enabled(directory)).toBe("false");
  }, 60_000);

  it("a start that fails (port in use) leaves the host stopped and starts on the next click", async () => {
    const directory = await hostDirectory();
    await stoppedAt(directory, 27);
    const { port } = JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")) as { port: number };
    const blocker = net.createServer(); await new Promise<void>(resolve => blocker.listen(port, "127.0.0.1", resolve));
    try { await expect(start(directory)).rejects.toThrow("Hub did not become ready"); }
    finally { await new Promise<void>(resolve => blocker.close(() => resolve())); }
    expect(await enabled(directory)).toBe("false");
    expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: false, hostEnabled: false });
    expect(await start(directory)).toMatchObject({ running: true });
    expect(await enabled(directory)).toBe("true");
  }, 90_000);

  it("resume reports a running Hub truthfully when the enabled flag is false or missing, and never starts one", async () => {
    const directory = await hostDirectory();
    const started = await start(directory, { hostName: "Fixture Mac" });
    await writeFile(path.join(directory, "desktop-enabled.json"), "false\n");
    expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: true, publicKey: started.publicKey, hostEnabled: false });
    expect(await enabled(directory)).toBe("false");
    await rm(path.join(directory, "desktop-enabled.json"));
    expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: true, publicKey: started.publicKey, hostEnabled: false });
    await desktopHost("stop", directory, entry); await rm(path.join(directory, "desktop-enabled.json"));
    expect(await desktopHost("resume", directory, entry)).toMatchObject({ running: false, hostEnabled: false });
    expect((await inspectHubService(directory)).running).toBe(false);
  }, 60_000);
});
