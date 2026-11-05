import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export function gatewayRestartFixture(options: { stateDir: string; url: string; mode: "kill" | "throw" | "cleanup" | "slow-cleanup" | "stop-startup" | "normal" | "drain" | "drain-interactions"; interaction?: "choice" | "native-choice" | "async-question" | "approval" }, home: string) {
  // Load TS in this exact child: crash signals and IPC must not target a CLI wrapper.
  const child = fork(fileURLToPath(new URL("../fixtures/gateway-restart-loop.ts", import.meta.url)), [], {
    execArgv: ["--require", fileURLToPath(new URL("./gateway-no-feishu.cjs", import.meta.url)), "--import", new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href],
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { TAROBOT_GATEWAY_GUARD_REPORT: process.env.TAROBOT_GATEWAY_GUARD_REPORT, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: home, CCTB_DELIVERY_LEDGER: "on", TAROCUB_RESTART_FIXTURE: JSON.stringify(options) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: string[] = []; let output = "", stderr = "";
  child.on("message", (message) => { if (message && typeof message === "object" && "type" in message && typeof message.type === "string") messages.push(message.type); });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", (error) => { output = error.message; resolve({ code: -1, signal: null }); }); });
  return { child, messages, exited, output: () => output, stderr: () => stderr, async kill() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
}
