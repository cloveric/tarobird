// Transport-only fixture: no external model calls or real instance configuration.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
const args = process.argv.slice(2), arg = (name) => args[args.indexOf(name) + 1];
const stateDir = arg("--state-dir"), botId = arg("--bot-id");
const config = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
const secret = (await readFile(path.join(stateDir, "gateway.key"), "utf8")).trim();
const ws = new WebSocket(arg("--hub-url"));
ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "instance.hello", botId, secret, engine: config.engine, model: config.model ?? "", effort: config.effort ?? "" })));
process.on("message", (message) => {
  if (message.type === "fixture.stderr") {
    process.stderr.write("Authorization: Basic ");
    setTimeout(() => process.stderr.write("Zml4dHVyZTpzZWNyZXQ=\n"), 30);
    return;
  }
  if (message.type === "shutdown.now") process.exit(0);
  if (message.type === "restart.whenIdle" || message.type === "drain.whenIdle") {
    if (process.env.TAROCUB_FIXTURE_ACK === "none") return;
    if (process.env.TAROCUB_FIXTURE_ACK === "wrong") { process.send?.({ type: "restart.queued", requestId: "wrong_request", pid: process.pid }); return; }
    if (process.env.TAROCUB_FIXTURE_ACK === "wrong_pid") { process.send?.({ type: "restart.queued", requestId: message.requestId, pid: process.pid + 1 }); return; }
    if (message.requestId && process.send) process.send({ type: "restart.queued", requestId: message.requestId, pid: process.pid }, () => process.exit(75));
    else process.exit(75);
  }
});
process.on("SIGTERM", () => process.exit(0)); process.on("disconnect", () => { if (process.env.TAROCUB_FIXTURE_HOLD_DISCONNECT !== "1") process.exit(0); });
