import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export function gatewayCrashFixture(options: { stateDir: string; url: string; botId: string; secret: string; responseFile: string; crash: boolean; background?: boolean }) {
  // Load TS in this exact child: crash signals and IPC must not target a CLI wrapper.
  const child = fork(fileURLToPath(new URL("../fixtures/gateway-delivery-crash.ts", import.meta.url)), [], {
    execArgv: ["--require", fileURLToPath(new URL("./gateway-no-feishu.cjs", import.meta.url)), "--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, TAROCUB_CRASH_FIXTURE: JSON.stringify(options), CCTB_DELIVERY_LEDGER: "on" }, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: string[] = []; let output = "";
  child.on("message", (message) => { if (message && typeof message === "object" && "type" in message && typeof message.type === "string") messages.push(message.type); });
  child.stdout?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  child.stderr?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); });
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.once("error", (error) => { output = error.message; resolve(); }); });
  return { child, messages, output: () => output, async kill() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
}
