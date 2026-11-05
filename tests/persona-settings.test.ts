import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { personaSettings } from "../src/runtime/persona-settings.js";
import { readBotPersona } from "../src/runtime/bot-instructions.js";
import { PERSONA_MAX_LENGTH } from "../src/client-protocol/persona.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "persona-settings-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function snapshot() { const result = await personaSettings(root, () => 2); if (!result.ok) throw new Error(result.error); return result.settings; }
it("creates a missing persona, backs up edits and preserves sessions/config", async () => {
  await writeFile(path.join(root, "config.json"), "untouched config"); await writeFile(path.join(root, "session.json"), "untouched session");
  const before = await snapshot(); expect(before.text).toBe(""); expect(before.activeTurns).toBe(2);
  expect(await personaSettings(root, 0, { revision: before.revision, text: "用中文回答，先结论。" })).toMatchObject({ ok: true });
  const next = await snapshot();
  expect(await personaSettings(root, 0, { revision: next.revision, text: "" })).toMatchObject({ ok: true, settings: { text: "" } });
  expect(readBotPersona(await readFile(path.join(root, "workspace", "AGENTS.md.previous"), "utf8"))).toBe(next.text);
  expect((await stat(path.join(root, "workspace", "AGENTS.md"))).mode & 0o777).toBe(0o600);
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe("untouched config");
  expect(await readFile(path.join(root, "session.json"), "utf8")).toBe("untouched session");
});
it("rejects stale/concurrent revisions and host-side edits", async () => {
  const before = await snapshot();
  const results = await Promise.all(["A", "B"].map(text => personaSettings(root, 0, { revision: before.revision, text })));
  expect(results.filter(result => result.ok)).toHaveLength(1);
  expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: "persona_conflict" }]);
  const next = await snapshot(); await writeFile(path.join(root, "workspace", "AGENTS.md"), "edited on host");
  expect(await personaSettings(root, 0, { revision: next.revision, text: "stale" })).toEqual({ ok: false, error: "persona_conflict" });
  expect(await readFile(path.join(root, "workspace", "AGENTS.md"), "utf8")).toBe("edited on host");
});
it("refuses symlinks, malformed text and oversized existing instructions", async () => {
  const file = path.join(root, "agent.md"), other = path.join(root, "other.md");
  await writeFile(other, "private"); await symlink(other, file);
  expect(await personaSettings(root, 0)).toEqual({ ok: false, error: "persona_unreadable" });
  await rm(file); await writeFile(file, Buffer.from([0xff, 0xfe]));
  expect(await personaSettings(root, 0)).toEqual({ ok: false, error: "persona_unreadable" });
  await writeFile(file, "a".repeat(PERSONA_MAX_LENGTH + 1));
  expect(await personaSettings(root, 0)).toEqual({ ok: false, error: "persona_too_large" });
});

it("does not accept edits longer than the native adapters can read", async () => {
  expect(PERSONA_MAX_LENGTH).toBe(16_000);
  const before = await snapshot();
  await expect(personaSettings(root, 0, { revision: before.revision, text: "x".repeat(16_001) })).rejects.toThrow();
  expect((await snapshot()).text).toBe("");
});
