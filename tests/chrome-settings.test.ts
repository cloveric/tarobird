import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { chromeSettings } from "../src/runtime/chrome-settings.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "chrome-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const config = (value: unknown) => writeFile(path.join(root, "config.json"), JSON.stringify(value));
async function read() { const result = await chromeSettings(root, "claude", 2); if (!result.ok) throw new Error(result.error); return result.settings; }

it("saves only this Bot's choice, preserving sessions, secrets and other settings", async () => {
  const original = { engine: "claude", model: "opus", privateField: "PRIVATE", workspacePath: "/unchanged" };
  await config(original); await writeFile(path.join(root, "session.json"), "UNCHANGED");
  const before = await read(); expect(before).toMatchObject({ enabled: false, activeTurns: 2 });
  expect(JSON.stringify(before)).not.toContain("PRIVATE");
  expect(await chromeSettings(root, "claude", 2, { revision: before.revision, enabled: true })).toMatchObject({ ok: true, settings: { enabled: true } });
  expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ ...original, claudeChrome: true });
  expect(await readFile(path.join(root, "session.json"), "utf8")).toBe("UNCHANGED");
  if (process.platform !== "win32") expect((await stat(path.join(root, "config.json"))).mode & 0o777).toBe(0o600);
});
it("rejects stale writes even after an on/off cycle and leaves no-op reads untouched", async () => {
  await config({ engine: "claude" }); const initial = await read();
  const original = await readFile(path.join(root, "config.json"), "utf8");
  expect(await chromeSettings(root, "claude", 0, { revision: initial.revision, enabled: false })).toMatchObject({ ok: true });
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(original);
  await chromeSettings(root, "claude", 0, { revision: initial.revision, enabled: true });
  const enabled = await read();
  await chromeSettings(root, "claude", 0, { revision: enabled.revision, enabled: false });
  expect(await chromeSettings(root, "claude", 0, { revision: initial.revision, enabled: true })).toEqual({ ok: false, error: "chrome_conflict" });
});
it("rejects corrupt config, wrong engines and malformed writes without changing disk", async () => {
  await writeFile(path.join(root, "config.json"), "{broken");
  expect(await chromeSettings(root, "claude", 0)).toEqual({ ok: false, error: "chrome_config_unreadable" });
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe("{broken");
  await config({ engine: "codex" });
  expect(await chromeSettings(root, "claude", 0)).toEqual({ ok: false, error: "chrome_engine_changed" });
  expect(await chromeSettings(root, "codex", 0)).toEqual({ ok: false, error: "chrome_unsupported" });
  await config({ engine: "claude", claudeChrome: "true" });
  expect(await chromeSettings(root, "claude", 0)).toEqual({ ok: false, error: "chrome_config_unreadable" });
  await config({ engine: "claude" }); const before = await read();
  await expect(chromeSettings(root, "claude", 0, { revision: before.revision, enabled: "true" })).rejects.toThrow();
  await expect(chromeSettings(root, "claude", 0, { revision: before.revision, enabled: true, other: true })).rejects.toThrow();
  expect((await read()).enabled).toBe(false);
});
