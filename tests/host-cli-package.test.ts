import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verifyHostLauncher, verifyWindowsRuntime } from "../scripts/verify-host-launcher.mjs";
import { hostUpdateCompatibilitySchema } from "../src/host-cli/update.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary: string[] = [];
afterEach(async () => { for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true }); });
async function fixture() { const folder = await mkdtemp(path.join(os.tmpdir(), "host-package-")); temporary.push(folder); await mkdir(path.join(folder, "bin")); return folder; }

function peFixture(library = "KERNEL32.dll", delayed = false) {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(240, 148);
  bytes.writeUInt16LE(0x20b, 152); bytes.writeUInt16LE(2, 220); bytes.writeUInt32LE(16, 260);
  // A single section at RVA 0x1000 / file offset 512 with a terminated import table.
  bytes.writeUInt32LE(0x1000, 404); bytes.writeUInt32LE(512, 408); bytes.writeUInt32LE(512, 412);
  const directory = 264 + (delayed ? 13 : 1) * 8;
  bytes.writeUInt32LE(0x1000, directory); bytes.writeUInt32LE(delayed ? 64 : 40, directory + 4);
  if (delayed) bytes.writeUInt32LE(1, 512);
  bytes.writeUInt32LE(0x1080, 512 + (delayed ? 4 : 12)); bytes.write(library, 640);
  bytes.write("TAROBOT_WINDOWS_STATE_PROBE_V1", 768);
  return bytes;
}

it("rejects missing, console and linked launchers before a package can be verified", async () => {
  const folder = await fixture(), launcher = path.join(folder, "bin/tarobot-host-launcher.exe");
  await expect(verifyHostLauncher(folder)).rejects.toThrow("host_package_windows_launcher_missing");
  const bytes = peFixture(); bytes.writeUInt16LE(3, 220);
  await writeFile(launcher, bytes); await expect(verifyHostLauncher(folder)).rejects.toThrow("host_package_windows_launcher_invalid");
  bytes.writeUInt16LE(2, 220); await writeFile(launcher, bytes); await expect(verifyHostLauncher(folder)).resolves.toBeUndefined();
  await rm(launcher); await writeFile(path.join(folder, "external.exe"), bytes); await symlink(path.join(folder, "external.exe"), launcher);
  await expect(verifyHostLauncher(folder)).rejects.toThrow("host_package_windows_launcher_unsafe");
});

it.each([false, true])("rejects unbundled VC runtimes including delayed imports (%s)", async delayed => {
  const folder = await fixture(), launcher = path.join(folder, "bin/tarobot-host-launcher.exe");
  for (const name of ["VCRUNTIME140.dll", "vcruntime140_1.dll", "MSVCP140.dll", "CONCRT140.dll"]) {
    await writeFile(launcher, peFixture(name, delayed));
    await expect(verifyHostLauncher(folder)).rejects.toThrow("windows_runtime_requires_vc_redist");
  }
  expect(verifyWindowsRuntime(peFixture("api-ms-win-crt-runtime-l1-1-0.dll", delayed))).toEqual(["api-ms-win-crt-runtime-l1-1-0.dll"]);
});

it("rejects an old launcher without the read-only Windows state probe", async () => {
  const folder = await fixture(), bytes = peFixture();
  bytes.fill(0, 768);
  await writeFile(path.join(folder, "bin/tarobot-host-launcher.exe"), bytes);
  await expect(verifyHostLauncher(folder)).rejects.toThrow("host_package_windows_launcher_probe_missing");
});

it("rejects corrupt import tables instead of silently skipping dependency checks", () => {
  const bytes = peFixture(); bytes.writeUInt32LE(0xffffff00, 524);
  expect(() => verifyWindowsRuntime(bytes)).toThrow("windows_runtime_invalid_pe");
  expect(() => verifyWindowsRuntime(peFixture().subarray(0, 600))).toThrow("windows_runtime_invalid_pe");
});

it("requires the extracted App and host payload rather than accepting just an installer shell", async () => {
  const folder = await fixture();
  const run = () => promisify(execFile)(process.execPath, [path.join(root, "scripts/verify-windows-runtime.mjs"), folder]);
  await writeFile(path.join(folder, "setup.exe"), peFixture());
  await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("windows_runtime_incomplete_installer: tarocub-client.exe") });
  for (const file of ["tarocub-client.exe", "host/node.exe", "host/node_modules/sqlite3/build/Release/node_sqlite3.node"]) {
    await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
    await writeFile(path.join(folder, file), peFixture());
  }
  await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("windows_runtime_incomplete_installer: host/bin/tarobot-host-launcher.exe") });
  await mkdir(path.join(folder, "host/bin"));
  await writeFile(path.join(folder, "host/bin/tarobot-host-launcher.exe"), peFixture());
  await expect(run()).resolves.toMatchObject({ stderr: "" });
});

it("checks Electron resources/host and all native helpers in the extracted installer", async () => {
  const folder = await fixture();
  const files = ["tarocub-client.exe", "resources/app.asar", "resources/host/node.exe", "resources/host/bin/tarobot-host-launcher.exe", "resources/host/node_modules/sqlite3/build/Release/node_sqlite3.node", "resources/native/tarobot-desktop-core.exe", "resources/native/tarobot-desktop-native.node", "resources/native/tarobot-desktop-updater.exe"];
  for (const file of files) { await mkdir(path.dirname(path.join(folder, file)), { recursive: true }); await writeFile(path.join(folder, file), peFixture()); }
  const run = () => promisify(execFile)(process.execPath, [path.join(root, "scripts/verify-windows-runtime.mjs"), folder]);
  await expect(run()).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("windows_runtime_incomplete_installer: resources/native/tarobot-migration-exporter.exe") });
  await writeFile(path.join(folder, "resources/native/tarobot-migration-exporter.exe"), peFixture());
  await expect(run()).resolves.toMatchObject({ stderr: "" });
});

it.skipIf(process.platform === "win32")("fails standalone packaging on macOS/Linux when no Windows cross-builder is available", async () => {
  const folder = await fixture();
  for (const directory of ["scripts", "client/dist", "dist"]) await mkdir(path.join(folder, directory), { recursive: true });
  for (const script of ["build-host-launcher.mjs", "macos-artifact-paths.mjs"]) await cp(path.join(root, "scripts", script), path.join(folder, "scripts", script));
  await writeFile(path.join(folder, "dist/standalone-graph.json"), '{"inputs":{}}');
  await writeFile(path.join(folder, "dist/relay-runtime.mjs"), "export {};");
  await expect(promisify(execFile)(process.execPath, [path.join(root, "scripts/package-standalone.mjs")], {
    cwd: folder, env: { ...process.env, CARGO: path.join(folder, "no-cross-builder"), CARGO_TARGET_DIR: path.join(folder, "target") },
  })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("no-cross-builder") });
  await expect(stat(path.join(folder, "dist/standalone-package/package.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("makes direct npm pack and installed-package verification enforce the same launcher guard", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  expect(hostUpdateCompatibilitySchema.safeParse(manifest.tarobotHostUpdate).success).toBe(true);
  expect(manifest.tarobotHostCapabilities).toContain("windows-state-admission-v1");
  expect(manifest.scripts.prepack).toBe("node scripts/verify-host-launcher.mjs");
  expect(manifest.files).toContain("scripts/verify-host-launcher.mjs");
  const folder = await fixture();
  await expect(promisify(execFile)(process.execPath, [path.join(root, "scripts/verify-standalone-package.mjs"), folder])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("host_package_windows_launcher_missing") });
});
