// Real Gateway worker; the engine is a local stand-in process. Adapters start
// a process-tree kill in destroy() without awaiting it (as Codex does).
import { spawn } from "node:child_process";
import { runGatewayWorker } from "../../src/gateway/worker.js";
import { GatewayTransport } from "../../src/gateway/transport.js";
import { Bridge } from "../../src/runtime/bridge.js";
import { killProcessTree } from "../../src/codex/process-tree.js";

const options = JSON.parse(process.env.TAROBOT_ENGINE_SHUTDOWN_FIXTURE!) as { stateDir: string; url: string };
// Ignores SIGTERM, as a CLI finishing a background task may; owns one tool.
const engine = spawn(process.execPath, ["-e", `
  const tool = require("node:child_process").spawn("sleep", ["300"], { stdio: "ignore" });
  process.on("SIGTERM", () => {});
  process.stdout.write(String(tool.pid) + "\\n");
  setInterval(() => {}, 1000);
`], { stdio: ["ignore", "pipe", "ignore"] });
const tool = new Promise<number>(resolve => engine.stdout!.once("data", (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
const destroy = Bridge.prototype.destroy;
Bridge.prototype.destroy = async function () {
  killProcessTree(engine.pid);
  return destroy.call(this);
};
const connect = GatewayTransport.prototype.connect;
GatewayTransport.prototype.connect = async function () {
  const boot = this.onBoot;
  this.onBoot = async () => { await boot?.(); process.send?.({ type: "boot-complete", engine: engine.pid, tool: await tool }); };
  return connect.call(this);
};
try { await runGatewayWorker(["run", "--state-dir", options.stateDir, "--bot-id", "alpha", "--hub-url", options.url]); }
catch (error) { console.error(error instanceof Error ? error.message : "fixture_failed"); process.exit(1); }
