import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { hostProcessEnvironment } from "../src/host-cli/environment.js";
import { resolveEngineExecutable } from "../src/runtime/engine-process.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const home = await mkdtemp(path.join(os.tmpdir(), "cli-discovery-")); roots.push(home); return home; }
async function file(home: string, relative: string, text = "#!/bin/sh\nexit 0\n") {
  const target = path.join(home, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text); await chmod(target, 0o700); return target;
}
it.runIf(process.platform !== "win32").each([".volta/bin", ".bun/bin", ".asdf/shims", ".local/share/mise/shims"])("discovers %s with a minimal GUI PATH", async directory => {
  const home = await fixture(), cli = await file(home, `${directory}/discovery-cli`);
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBe(cli);
});
it.runIf(process.platform !== "win32")("selects only nvm's default version and keeps the inherited PATH ahead of fallbacks", async () => {
  const home = await fixture();
  const chosen = await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/versions/node/v24.1.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "lts/example\n"); await file(home, ".nvm/alias/lts/example", "v22.12.0\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain("v24.1.0");
  const inherited = await file(home, "selected/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: path.dirname(inherited) } }))).toBe(inherited);
  expect(hostProcessEnvironment({ home, env }).PATH).toBe(env.PATH);
});
it.runIf(process.platform !== "win32")("bounds nvm alias traversal and never executes a profile or guesses an unselected version", async () => {
  const home = await fixture(); await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "loop\n"); await file(home, ".nvm/alias/loop", "default\n");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  await file(home, ".nvm/alias/default", "../../outside\n");
  expect(hostProcessEnvironment({ home, env: {} }).PATH).not.toContain("versions/node");
});
it.runIf(process.platform !== "win32")("honors an explicit nvm root instead of silently choosing the home-directory installation", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  await file(home, ".nvm/alias/default", "22\n");
  const configured = path.join(home, "configured-nvm");
  const chosen = await file(configured, "versions/node/v24.1.0/bin/discovery-cli");
  await file(configured, "alias/default", "24\n");
  const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin", NVM_DIR: configured } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(chosen);
  expect(env.PATH).not.toContain(path.join(home, ".nvm/versions/node"));
});
it.runIf(process.platform !== "win32")("follows fnm's default alias including a macOS path containing spaces", async () => {
  const home = await fixture(), root = path.join(home, "Library/Application Support/fnm");
  const cli = await file(home, "Library/Application Support/fnm/node-versions/v22.12.0/installation/bin/discovery-cli");
  await mkdir(path.join(root, "aliases"), { recursive: true });
  await symlink(path.dirname(path.dirname(cli)), path.join(root, "aliases/default"));
  const env = hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(root, "aliases/default/bin/discovery-cli"));
});
it.runIf(process.platform !== "win32")("resolves nvm's stable alias like node instead of preferring an even major", async () => {
  const home = await fixture();
  await file(home, ".nvm/versions/node/v22.12.0/bin/discovery-cli");
  const latest = await file(home, ".nvm/versions/node/v23.5.0/bin/discovery-cli");
  for (const alias of ["stable", "node"]) {
    await file(home, ".nvm/alias/default", `${alias}\n`);
    const env = hostProcessEnvironment({ home, env: { PATH: "/usr/bin:/bin" } });
    expect(resolveEngineExecutable("discovery-cli", env)).toBe(latest);
    expect(env.PATH).not.toContain("v22.12.0");
  }
});
// fnm uses the first existing base directory: XDG data, then ~/.fnm, then (macOS)
// Application Support. A directory fnm itself would not use is never searched.
it.runIf(process.platform !== "win32").each([
  { name: "XDG data on macOS", platform: "darwin" as const, installed: [".local/share/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory on macOS", platform: "darwin" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "the legacy home directory on Linux", platform: "linux" as const, installed: [".fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of Application Support", platform: "darwin" as const, installed: [".local/share/fnm", "Library/Application Support/fnm"], chosen: ".local/share/fnm" },
  { name: "the legacy home directory ahead of Application Support", platform: "darwin" as const, installed: [".fnm", "Library/Application Support/fnm"], chosen: ".fnm" },
  { name: "XDG data ahead of the legacy home directory", platform: "linux" as const, installed: [".local/share/fnm", ".fnm"], chosen: ".local/share/fnm" },
])("follows fnm's base directory order: $name", async ({ platform, installed, chosen }) => {
  const home = await fixture();
  for (const root of installed) await file(home, `${root}/aliases/default/bin/discovery-cli`);
  const env = hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } });
  expect(resolveEngineExecutable("discovery-cli", env)).toBe(path.join(home, chosen, "aliases/default/bin/discovery-cli"));
  for (const root of installed.filter(root => root !== chosen)) expect(env.PATH).not.toContain(path.join(home, root));
});
it.runIf(process.platform !== "win32")("does not search an fnm directory that fnm itself would not use", async () => {
  const home = await fixture();
  // fnm selects the existing XDG directory even though it has no default alias.
  await mkdir(path.join(home, ".local/share/fnm"), { recursive: true });
  await file(home, ".fnm/aliases/default/bin/discovery-cli");
  await file(home, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  for (const platform of ["darwin", "linux"] as const) expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform, env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
  // An explicit root still wins over every default location.
  const configured = path.join(home, "configured-fnm"), chosen = await file(configured, "aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home, platform: "darwin", env: { PATH: "/usr/bin:/bin", FNM_DIR: configured } }))).toBe(chosen);
  // Application Support is a macOS location only.
  const linuxHome = await fixture(); await file(linuxHome, "Library/Application Support/fnm/aliases/default/bin/discovery-cli");
  expect(resolveEngineExecutable("discovery-cli", hostProcessEnvironment({ home: linuxHome, platform: "linux", env: { PATH: "/usr/bin:/bin" } }))).toBeUndefined();
});
