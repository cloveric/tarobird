import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { parseDocument } from "yaml";
const exec = promisify(execFile);

async function installer(options: { browserFails?: boolean; python?: string; staleSkill?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scrapling-install-"));
  const venv = path.join(root, "venv"), bin = path.join(root, "bin"), log = path.join(root, "calls");
  const codex = path.join(root, "custom-codex"), claude = path.join(root, "custom-claude");
  await mkdir(path.join(venv, "bin"), { recursive: true });
  // Fixture interpreter: answers the version probe, otherwise reports the runtime.
  await writeFile(path.join(venv, "bin/python"), `#!/bin/sh\ncase "$*" in *version_info*) printf '%s\\n' "${options.python ?? "3.12.1"}"; exit 0;; esac\nprintf 'fixture runtime 0.5\\n'\n`, { mode: 0o755 });
  await writeFile(path.join(venv, "bin/pip"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SCRAPLING_TEST_LOG"\n', { mode: 0o755 });
  await writeFile(path.join(venv, "bin/scrapling"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SCRAPLING_TEST_LOG"\nexit "$SCRAPLING_TEST_EXIT"\n', { mode: 0o755 });
  const stale = "---\nname: scrapling\n---\nscrapling extract stealthy-fetch https://example.com out.md\n";
  if (options.staleSkill) for (const home of [codex, claude]) { await mkdir(path.join(home, "skills/scrapling"), { recursive: true }); await writeFile(path.join(home, "skills/scrapling/SKILL.md"), stale); }
  const run = exec("bash", [path.resolve("scripts/install-scrapling.sh")], { env: { PATH: process.env.PATH, HOME: root, SCRAPLING_VENV: venv, SCRAPLING_BIN_DIR: bin, SCRAPLING_TEST_LOG: log, SCRAPLING_TEST_EXIT: options.browserFails ? "9" : "0", CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude } });
  const skills = async () => Promise.all([codex, claude].map(home => readFile(path.join(home, "skills/scrapling/SKILL.md"), "utf8").catch(() => undefined)));
  const calls = async () => readFile(log, "utf8").catch(() => "");
  return { root, venv, bin, run, skills, calls, stale, cleanup: () => rm(root, { recursive: true, force: true }) };
}

it("upgrades the reviewed runtime and installs the matching Skill", async () => {
  const f = await installer();
  try {
    await f.run;
    expect(await readlink(path.join(f.bin, "scrapling"))).toBe(path.join(f.venv, "bin/scrapling"));
    const source = await readFile("skills/scrapling/SKILL.md", "utf8");
    expect(await f.skills()).toEqual([source, source]);
    expect(await f.calls()).toContain("install -q --upgrade scrapling[fetchers]==0.5");
  } finally { await f.cleanup(); }
});

it("a browser setup failure after the upgrade still leaves the 0.5 Skill matching the 0.5 runtime", async () => {
  const f = await installer({ browserFails: true, staleSkill: true });
  try {
    await expect(f.run).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Browser setup failed") });
    expect(await f.calls()).toContain("install -q --upgrade scrapling[fetchers]==0.5");
    // The runtime cannot be rolled back; the Skill and CLI link must describe it.
    const source = await readFile("skills/scrapling/SKILL.md", "utf8");
    expect(await f.skills()).toEqual([source, source]);
    expect(await readlink(path.join(f.bin, "scrapling"))).toBe(path.join(f.venv, "bin/scrapling"));
  } finally { await f.cleanup(); }
});

it("an unsupported Python stops before changing the runtime, Skill or CLI link", async () => {
  const f = await installer({ python: "3.9.6", staleSkill: true });
  try {
    await expect(f.run).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Python 3.10+") });
    expect(await f.calls()).toBe("");
    expect(await f.skills()).toEqual([f.stale, f.stale]);
    await expect(readlink(path.join(f.bin, "scrapling"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.cleanup(); }
});
it("ships readable skill metadata and 0.5 CLI/Python examples without owner-specific paths", async () => {
  const skill = await readFile("skills/scrapling/SKILL.md", "utf8");
  const metadata = parseDocument(skill.split("---")[1]!);
  expect(metadata.errors).toEqual([]); expect(metadata.toJS().name).toBe("scrapling");
  const snippets = [...skill.matchAll(/```(?:bash|python)\n([\s\S]*?)```/g)].map(m => m[1]).join("\n");
  expect(snippets).not.toContain("DynamicFetcher"); expect(snippets).not.toContain("stealthy-fetch");
  expect(skill).not.toContain("/Users/"); expect(skill).not.toContain("Browser already installed");
});
