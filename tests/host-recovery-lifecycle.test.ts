import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
}

it("the production entrypoint exits after worker startup cleanup even if a handle remains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-fatal-exit-"));
  let child: ChildProcess | undefined;
  try {
    await mkdir(path.join(root, "workspace"));
    await writeFile(path.join(root, "config.json"), JSON.stringify({ engine: "codex", workspacePath: path.join(root, "workspace") }));
    await writeFile(path.join(root, "gateway.key"), "invalid-fixture-key", { mode: 0o600 });
    const preload = path.join(root, "hold.mjs"); await writeFile(preload, "setInterval(() => {}, 1000);\n");
    child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, path.resolve("dist/src/index.js"), "gateway", "run", "--state-dir", root, "--bot-id", "fixture", "--hub-url", "ws://127.0.0.1:9/instance"], { env: { ...process.env, HOME: root }, stdio: "ignore" });
    await vi.waitFor(() => expect(child!.exitCode).toBe(1), { timeout: 10_000 });
    expect(await readFile(path.join(root, "service.lifecycle.log.jsonl"), "utf8")).toContain("invalid_gateway_key");
    await expect(readFile(path.join(root, "instance.lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await stop(child); await rm(root, { recursive: true, force: true }); }
}, 15_000);

it.each(["throw", "rejection"])("records a fatal %s without swallowing Node's exit", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "host-crash-monitor-"));
  let child: ChildProcess | undefined;
  try {
    const monitor = pathToFileURL(path.resolve("dist/src/runtime/service-lifecycle-log.js")).href;
    const source = `import { monitorServiceCrashes } from ${JSON.stringify(monitor)}; monitorServiceCrashes(${JSON.stringify(root)}, 'fixture', 'hub'); setImmediate(() => { ${mode === "throw" ? "throw new Error('fixture_fatal')" : "void Promise.reject(new Error('fixture_fatal'))"}; });`;
    child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: "ignore" });
    await vi.waitFor(() => expect(child!.exitCode).toBe(1));
    const event = JSON.parse((await readFile(path.join(root, "service.lifecycle.log.jsonl"), "utf8")).trim());
    expect(event).toMatchObject({ type: mode === "throw" ? "process.uncaught_exception" : "process.unhandled_rejection", detail: "fixture_fatal", metadata: { channel: "hub" } });
  } finally { await stop(child); await rm(root, { recursive: true, force: true }); }
});
