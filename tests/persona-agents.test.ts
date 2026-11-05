import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { personaSettings } from "../src/runtime/persona-settings.js";

let root: string, file: string;
const start = "<!-- TaroBot persona: start -->", end = "<!-- TaroBot persona: end -->";
const block = (text: string) => `${start}\n${text}\n${end}`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "persona-agents-"));
  await mkdir(path.join(root, "workspace")); file = path.join(root, "workspace", "AGENTS.md");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function snapshot() { const result = await personaSettings(root, 0); if (!result.ok) throw new Error(result.error); return result.settings; }
async function save(text: string) { return personaSettings(root, 0, { revision: (await snapshot()).revision, text }); }

it("edits and clears only the persona section, preserving surrounding rules byte for byte", async () => {
  const prefix = "\ufeff# Project\r\nKeep all these rules.\r\n\r\n", suffix = "\r\n\r\n## Tests\r\nRun focused tests.\r\n";
  await writeFile(file, prefix + block("A") + suffix);
  expect((await snapshot()).text).toBe("A");
  expect(await save("用中文回答。\nKeep it concise.\n")).toMatchObject({ ok: true });
  expect(await readFile(file, "utf8")).toBe(prefix + block("用中文回答。\nKeep it concise.\n") + suffix);
  await save("");
  expect(await readFile(file, "utf8")).toBe(prefix + block("") + suffix);
  expect(await readFile(file + ".previous", "utf8")).toContain("Keep it concise.");
});

it("migrates the legacy persona once without replacing an existing AGENTS.md", async () => {
  await writeFile(file, "# Existing rules\nPreserve me.\n");
  await writeFile(path.join(root, "agent.md"), "Legacy persona");
  expect((await snapshot()).text).toBe("Legacy persona");
  expect(await readFile(file, "utf8")).toContain("# Existing rules\nPreserve me.\n");
  expect(await readFile(file, "utf8")).toContain(block("Legacy persona"));
  expect(await readFile(path.join(root, "agent.md.migrated"), "utf8")).toBe("Legacy persona");
  await expect(readFile(path.join(root, "agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await save(""); expect((await snapshot()).text).toBe("");
  // Explicit host-side deletion/emptying must not restore the archived persona.
  await writeFile(file, ""); expect((await snapshot()).text).toBe("");
});

it("treats an existing empty persona section as authoritative during migration", async () => {
  await writeFile(file, block("")); await writeFile(path.join(root, "agent.md"), "Old persona");
  expect((await snapshot()).text).toBe("");
  expect(await readFile(file, "utf8")).toBe(block(""));
});

it.each(["\n", "\r\n"])("accepts a manually cleared section with adjacent marker lines (%j)", async newline => {
  const prefix = `# Rules${newline}Keep these rules.${newline}${newline}`, suffix = `${newline}## More rules${newline}`;
  const original = prefix + start + newline + end + suffix;
  await writeFile(file, original);
  await writeFile(path.join(root, "agent.md"), "Old persona must not return");
  expect((await snapshot()).text).toBe("");
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await save("New persona")).toMatchObject({ ok: true });
  expect(await readFile(file, "utf8")).toBe(prefix + block("New persona") + suffix);
});

it("reads a Windows CRLF section and preserves persona whitespace on edits", async () => {
  await writeFile(file, `${start}\r\nA\r\n${end}\r\n`);
  expect((await snapshot()).text).toBe("A");
  await save("B\r"); expect((await snapshot()).text).toBe("B\r");
});

it.each(["New legacy content", ""])("archives rollback changes without reviving a cleared persona: %s", async legacy => {
  const original = "Keep rules\n" + block("");
  await writeFile(file, original);
  await writeFile(path.join(root, "agent.md"), legacy);
  await writeFile(path.join(root, "agent.md.migrated"), "Earlier backup");
  expect(await personaSettings(root, 0)).toMatchObject({ ok: true, settings: { text: "" } });
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readFile(path.join(root, "agent.md.migrated"), "utf8")).toBe("Earlier backup");
  const archive = (await readdir(root)).find(name => /^agent\.md\.migrated\.[a-f0-9]{64}$/.test(name));
  expect(archive).toBeTruthy(); expect(await readFile(path.join(root, archive!), "utf8")).toBe(legacy);
  await expect(readFile(path.join(root, "agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects stale saves after other AGENTS.md rules change", async () => {
  await writeFile(file, "# Rules\n" + block("A"));
  const before = await snapshot();
  await writeFile(file, "# Edited rules\n" + block("A"));
  expect(await personaSettings(root, 0, { revision: before.revision, text: "B" })).toEqual({ ok: false, error: "persona_conflict" });
  expect(await readFile(file, "utf8")).toBe("# Edited rules\n" + block("A"));
});

it.each([`${start}\nbroken`, `${end}\n${start}`, block("A") + "\n" + block("B")])("rejects ambiguous persona boundaries without overwriting the file", async content => {
  await writeFile(file, content);
  expect(await personaSettings(root, 0)).toEqual({ ok: false, error: "persona_unreadable" });
  expect(await readFile(file, "utf8")).toBe(content);
});

it("isolates Bots even when their configured project workspace is shared", async () => {
  const other = path.join(root, "other-bot"), project = path.join(root, "shared-project");
  await mkdir(other); await mkdir(project);
  await writeFile(path.join(project, "AGENTS.md"), "Shared project rules");
  for (const dir of [root, other]) await writeFile(path.join(dir, "config.json"), JSON.stringify({ workspacePath: project }));
  await save("Alpha only");
  const before = await personaSettings(other, 0); if (!before.ok) throw new Error(before.error);
  await personaSettings(other, 0, { revision: before.settings.revision, text: "Beta only" });
  expect(await readFile(file, "utf8")).toContain("Alpha only");
  expect(await readFile(path.join(other, "workspace", "AGENTS.md"), "utf8")).not.toContain("Alpha only");
  expect(await readFile(path.join(project, "AGENTS.md"), "utf8")).toBe("Shared project rules");
});

it("refuses a linked default workspace instead of editing another Bot or project", async () => {
  const shared = path.join(root, "shared"); await mkdir(shared); await writeFile(path.join(shared, "AGENTS.md"), "private");
  await rm(path.join(root, "workspace"), { recursive: true }); await symlink(shared, path.join(root, "workspace"), "dir");
  expect(await personaSettings(root, 0)).toEqual({ ok: false, error: "persona_unreadable" });
  expect(await readFile(path.join(shared, "AGENTS.md"), "utf8")).toBe("private");
});
