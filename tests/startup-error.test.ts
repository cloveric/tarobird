import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { transform } from "esbuild";
import { desktopStartupError } from "../src/runtime/startup-error.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it("keeps coded causes without serializing paths, secrets, arbitrary names or cyclic causes", () => {
  const error = Object.assign(new Error("private path and token"), { code: "ERR_DLOPEN_FAILED", path: "C:\\private" });
  expect(desktopStartupError(error, "desktop_module")).toBe("TAROBOT_STARTUP_V1|phase=desktop_module|error=ERR_DLOPEN_FAILED|kind=Error");
  expect(desktopStartupError(new Error("wrapper", { cause: error }), "desktop_command")).toContain("|error=ERR_DLOPEN_FAILED|");
  error.name = "private-name"; error.code = "private-code";
  Object.assign(error, { cause: error });
  expect(desktopStartupError(error, "desktop_module")).toBe("TAROBOT_STARTUP_V1|phase=desktop_module");
  expect(desktopStartupError("private string", "desktop_module")).toBe("TAROBOT_STARTUP_V1|phase=desktop_module");
});

async function entrypointFixture(desktopModule?: string, corruptAddon = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-startup-error-")); directories.push(directory);
  await mkdir(path.join(directory, "runtime")); await mkdir(path.join(directory, "hub"));
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  for (const source of ["index", "runtime/startup-error"]) {
    const result = await transform(await readFile(path.resolve(`src/${source}.ts`), "utf8"), { loader: "ts", format: "esm" });
    await writeFile(path.join(directory, `${source}.js`), result.code);
  }
  if (desktopModule) await writeFile(path.join(directory, "hub/desktop.js"), desktopModule);
  if (corruptAddon) await writeFile(path.join(directory, "hub/bad.node"), "deliberately invalid native addon fixture");
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(process.execPath, [path.join(directory, "index.js"), "desktop-host", "status", path.join(directory, "unused")], { timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ code: Number(error?.code ?? 0), stdout, stderr });
    });
    child.stdin!.end("null");
  });
}

it("reports module import failures before the host command can run", async () => {
  const missing = await entrypointFixture();
  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr.split("\n")[0]).toBe("TAROBOT_STARTUP_V1|phase=desktop_module|error=ERR_MODULE_NOT_FOUND|kind=Error");
  const native = await entrypointFixture('throw Object.assign(new Error("找不到指定的模块。private-path"), {code:"ERR_DLOPEN_FAILED"})');
  expect(native.code).toBe(1);
  expect(native.stderr.split("\n")[0]).toBe("TAROBOT_STARTUP_V1|phase=desktop_module|error=ERR_DLOPEN_FAILED|kind=Error");
});

it("preserves Node's actual dlopen error code, which its message does not contain", async () => {
  const failed = await entrypointFixture('import {createRequire} from "node:module"; createRequire(import.meta.url)("./bad.node");', true);
  expect(failed.code).toBe(1);
  const [marker, ...message] = failed.stderr.trim().split("\n");
  expect(marker).toBe("TAROBOT_STARTUP_V1|phase=desktop_module|error=ERR_DLOPEN_FAILED|kind=Error");
  expect(message.join("\n")).not.toContain("ERR_DLOPEN_FAILED");
  expect(message.join("\n")).toContain("bad.node");
});

it("distinguishes command execution failures and leaves successful JSON replies intact", async () => {
  const failed = await entrypointFixture('export async function runDesktopHostCli() { throw Object.assign(new Error("localized private data"), {code:"SQLITE_CANTOPEN"}) }');
  expect(failed.code).toBe(1);
  expect(failed.stderr.split("\n")[0]).toBe("TAROBOT_STARTUP_V1|phase=desktop_command|error=SQLITE_CANTOPEN|kind=Error");
  const success = await entrypointFixture('export async function runDesktopHostCli() { console.log(JSON.stringify({available:true,running:false})) }');
  expect(success).toEqual({ code: 0, stdout: '{"available":true,"running":false}\n', stderr: "" });
});
