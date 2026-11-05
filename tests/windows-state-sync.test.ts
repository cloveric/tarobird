import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fault = vi.hoisted(() => ({ diskError: false }));
// Model the Windows FlushFileBuffers contract on every CI platform. This is
// about the actual handle access, not a list of expected implementation flags.
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if ((await handle.stat()).isFile()) {
        if (fault.diskError) throw Object.assign(new Error("disk flush failed"), { code: "EIO" });
        if (args[1] === "r") throw Object.assign(new Error("FlushFileBuffers requires write access"), { code: "EPERM" });
      }
      return sync();
    };
    return handle;
  } };
});

import { JsonStore } from "../src/state/json-store.js";
import { updateInstanceConfig } from "../src/state/instance-config.js";
import { personaSettings } from "../src/runtime/persona-settings.js";
import { effortSettings } from "../src/runtime/effort-settings.js";
import { permissionSettings } from "../src/runtime/permissions-settings.js";
import { registerInstance, deregisterInstance, readRegistry } from "../src/bus/bus-registry.js";

let root: string;
beforeEach(async () => { fault.diskError = false; root = await mkdtemp(path.join(os.tmpdir(), "tb-sync-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("creates and replaces durable identity/state without truncation on Windows", async () => {
  const file = path.join(root, "identity.json"), store = new JsonStore<Record<string, string>>(file);
  await store.write({ publicKey: "fixture-key", privateKey: "fixture-private" });
  await store.write({ publicKey: "same-key", privateKey: "same-private" });
  expect(await store.read({})).toMatchObject({ publicKey: "same-key", privateKey: "same-private" });
  expect(await readdir(root)).toEqual(["identity.json"]);
});

it("retains previous identity and removes the temporary file on a real flush failure", async () => {
  const file = path.join(root, "identity.json"), store = new JsonStore(file);
  await writeFile(file, '{"publicKey":"keep"}');
  fault.diskError = true;
  await expect(store.write({ publicKey: "replacement" })).rejects.toMatchObject({ code: "EIO" });
  expect(await readFile(file, "utf8")).toBe('{"publicKey":"keep"}');
  expect(await readdir(root)).toEqual(["identity.json"]);
});

it("updates Bot configuration and safely backs up malformed configuration", async () => {
  const file = path.join(root, "config.json");
  await updateInstanceConfig(root, config => { config.engine = "codex"; });
  expect(JSON.parse(await readFile(file, "utf8")).engine).toBe("codex");
  await writeFile(file, "{broken");
  await updateInstanceConfig(root, config => { config.engine = "claude"; });
  const backups = (await readdir(root)).filter(name => name.includes(".corrupt."));
  expect(backups).toHaveLength(1);
  expect(await readFile(path.join(root, backups[0]), "utf8")).toBe("{broken");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ engine: "claude", approvalMode: "normal" });
});

it("persists persona edits and their previous version on Windows", async () => {
  const workspace = path.join(root, "workspace"), file = path.join(workspace, "AGENTS.md");
  const instructions = "# Bot instructions\n\nKeep the owner's working rules.\n";
  await mkdir(workspace); await writeFile(file, instructions);
  const before = await personaSettings(root, 0);
  if (!before.ok) throw new Error(before.error);
  const saved = await personaSettings(root, 0, { revision: before.settings.revision, text: "first" });
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error);
  const firstDocument = await readFile(file, "utf8");
  expect(firstDocument).toContain("\nfirst\n");
  const second = await personaSettings(root, 0, { revision: saved.settings.revision, text: "second" });
  expect(second).toMatchObject({ ok: true, settings: { text: "second" } });
  if (!second.ok) throw new Error(second.error);
  const secondDocument = await readFile(file, "utf8");
  expect(secondDocument.startsWith(instructions)).toBe(true);
  expect(secondDocument).toContain("\nsecond\n");
  expect(await readFile(`${file}.previous`, "utf8")).toBe(firstDocument);
  await expect(stat(path.join(root, "agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
  // A failed Windows flush must preserve both the current document and backup.
  fault.diskError = true;
  expect(await personaSettings(root, 0, { revision: second.settings.revision, text: "unsaved" })).toEqual({ ok: false, error: "persona_unwritable" });
  expect(await readFile(file, "utf8")).toBe(secondDocument);
  expect(await readFile(`${file}.previous`, "utf8")).toBe(firstDocument);
  expect((await readdir(workspace)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

it.skipIf(process.platform === "win32")("can recover a read-only malformed POSIX config without weakening its backup permissions", async () => {
  const file = path.join(root, "config.json");
  await writeFile(file, "{broken"); await chmod(file, 0o400);
  await updateInstanceConfig(root, config => { config.engine = "codex"; });
  const backup = (await readdir(root)).find(name => name.includes(".corrupt."))!;
  expect(await readFile(path.join(root, backup), "utf8")).toBe("{broken");
  expect((await stat(path.join(root, backup))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ approvalMode: "normal", engine: "codex" });
});

it("saves effort and approval settings without losing unrelated configuration", async () => {
  await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", model: "gpt-5.5", effort: "high", approvalMode: "bypass", workspacePath: "fixture-workspace" }));
  const effort = await effortSettings(root, "codex", 0); if (!effort.ok) throw new Error(effort.error);
  expect(await effortSettings(root, "codex", 0, { revision: effort.settings.revision, effort: "low" })).toMatchObject({ ok: true });
  const permission = await permissionSettings(root, "codex", 0); if (!permission.ok) throw new Error(permission.error);
  expect(await permissionSettings(root, "codex", 0, { revision: permission.settings.revision, choice: "normal" })).toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))).toMatchObject({ effort: "low", approvalMode: "normal", workspacePath: "fixture-workspace" });
});

it("keeps sibling registrations when Windows services join and leave the bus", async () => {
  await registerInstance(root, "first", 1234, "fixture-secret-first");
  await registerInstance(root, "second", 1235, "fixture-secret-second");
  await deregisterInstance(root, "first");
  expect(Object.keys((await readRegistry(root)).instances)).toEqual(["second"]);
});
