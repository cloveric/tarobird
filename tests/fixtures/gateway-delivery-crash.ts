// Isolated real-process crash harness. It uses production Gateway dispatch and
// recovery with a deterministic engine; never loads an installed engine or fleet.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { attachGateway } from "../../src/gateway/service.js";
import { createCoreServiceRuntime } from "../../src/core/runtime.js";
import { GatewayTransport } from "../../src/gateway/transport.js";

const options = z.object({ stateDir: z.string(), url: z.string(), botId: z.string(), secret: z.string(), responseFile: z.string(), crash: z.boolean(), background: z.boolean().default(false) }).parse(JSON.parse(process.env.TAROCUB_CRASH_FIXTURE ?? "{}"));
const forbidden = async (): Promise<never> => { throw new Error("feishu_forbidden"); };
// Observe the real recovery barrier without changing its ordering or adding a
// production-only test hook. Calls/RPCs alone do not prove that boot has settled.
const connect = GatewayTransport.prototype.connect;
GatewayTransport.prototype.connect = function () {
  const boot = this.onBoot;
  this.onBoot = async () => { await boot?.(); process.send?.({ type: "boot-complete" }); };
  return connect.call(this);
};
const channel = await attachGateway({ ...options, runtime: createCoreServiceRuntime({ createDocument: forbidden, createChat: forbidden, detectLarkCli: forbidden }),
  bridge: { handleAuthorizedMessage: async (input) => {
    process.send?.({ type: "engine" }); const text = await readFile(options.responseFile, "utf8");
    if (options.background) { await input.onEngineEvent?.({ type: "task_notification", text }); return { text: "Main response after notification" }; }
    return { text };
  } },
});
if (options.crash) {
  const beforePublish = async (content: unknown) => {
    if (!JSON.stringify(content).includes("LONG_LEDGER_END")) return;
    process.send?.({ type: "before-publish" }); await new Promise<void>(() => {});
  };
  const send = channel.send.bind(channel), update = channel.updateCard.bind(channel);
  channel.send = async (...args) => { await beforePublish(args[1]); return send(...args); };
  channel.updateCard = async (...args) => { await beforePublish(args[1]); return update(...args); };
}
process.send?.({ type: "ready" });
