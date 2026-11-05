// Real Gateway worker and Claude adapter; only the external CLI stream is fake.
import { EventEmitter } from "node:events";
import { runGatewayWorker } from "../../src/gateway/worker.js";
import { GatewayTransport } from "../../src/gateway/transport.js";
import { ClaudeStreamAdapter } from "../../src/codex/claude-stream-adapter.js";

const options = JSON.parse(process.env.TAROBOT_NATIVE_DRAIN_FIXTURE!);
class Child extends EventEmitter {
  lines: string[] = [];
  stdin = { write: (text: string, done?: (error?: Error | null) => void) => { this.lines.push(text); done?.(null); return true; } };
  stdout = new EventEmitter(); stderr = new EventEmitter();
}
const child = new Child();
const emit = (frame: object) => child.stdout.emit("data", JSON.stringify({ session_id: "native-drain", ...frame }) + "\n");
const connect = GatewayTransport.prototype.connect;
let releaseDelivery!: () => void;
const delivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
GatewayTransport.prototype.connect = async function () {
  const adapter = (this.options as unknown as { bridge: { adapter: ClaudeStreamAdapter } }).bridge.adapter;
  if (!(adapter instanceof ClaudeStreamAdapter)) throw Error("Actual Claude adapter not selected");
  (adapter as unknown as { spawnClaude: () => Child }).spawnClaude = () => child;
  const boot = this.onBoot;
  this.onBoot = async () => {
    await boot?.();
    const foreground = adapter.sendUserMessage("native-drain", { text: "Start an isolated task", files: [], onEngineEvent: event => {
      if (event.type === "task_notification") {
        process.send?.({ type: "fixture.delivery", status: event.status, reason: event.reason });
        return delivery;
      }
    } });
    const deadline = Date.now() + 5000;
    while (!child.lines.length) { if (Date.now() > deadline) throw Error("No fixture input"); await new Promise(resolve => setTimeout(resolve, 5)); }
    emit({ type: "system", subtype: "init" });
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "agent-start", name: "Agent", input: { description: "Review", run_in_background: true } }] } });
    emit({ type: "system", subtype: "task_started", task_id: "background", tool_use_id: "agent-start", task_type: "local_agent", description: "Review", is_backgrounded: true });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "agent-start", content: "Started" }] } });
    emit({ type: "result", result: "Foreground complete" }); await foreground;
    process.send?.({ type: "fixture.foreground-finished", tasks: await adapter.listTasks("native-drain") });
  };
  return connect.call(this);
};
process.on("message", value => {
  const type = (value as { type?: string })?.type;
  if (type === "fixture.task-finished") {
    emit({ type: "system", subtype: "task_notification", task_id: "background", tool_use_id: "agent-start", status: "completed" });
    emit({ type: "system", subtype: "init" });
    process.send?.({ type: "fixture.review-started" });
  } else if (type === "fixture.review-finished") {
    emit({ type: "result", task_id: "background", status: "completed", result: "Reviewed", origin: { kind: "task-notification" } });
  } else if (type === "fixture.delivery-finished") releaseDelivery();
});
try { await runGatewayWorker(["run", "--state-dir", options.stateDir, "--bot-id", "alpha", "--hub-url", options.url]); }
catch (error) { console.error(error instanceof Error ? error.message : "fixture_failed"); process.exit(1); }
