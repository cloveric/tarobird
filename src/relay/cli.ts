import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { relayServerSchema, loadRelayTls } from "./config.js";
import { RelayServer } from "./server.js";

export async function runRelayCli(argv: string[]): Promise<void> {
  if (argv[0] === "release") { const { runRelayReleaseCli } = await import("./release-cli.js"); await runRelayReleaseCli(argv.slice(1)); return; }
  if (argv[0] === "inspect") { const { inspectRelayCompanions } = await import("./health.js"); console.log(JSON.stringify(await inspectRelayCompanions("/opt/tarocub-relay"))); return; }
  const args = parseArgs({ args: argv, options: { config: { type: "string" }, "lock-held": { type: "boolean" }, help: { type: "boolean", short: "h" } }, allowPositionals: true });
  if (args.positionals[0] === "update" && args.values.config) { const { runRelayUpdate } = await import("./update.js"); await runRelayUpdate(args.values.config, args.values["lock-held"]); return; }
  if (args.values.help || !args.values.config) { console.log("TaroBird TLS passthrough relay\n  tarobot relay --config <relay.json>\nRequires a dedicated tunnel CA, server certificate and allowed Mac client fingerprint.\nThe Hub domain certificate and private key must remain on the Mac."); return; }
  const config = relayServerSchema.parse(JSON.parse(await readFile(args.values.config, "utf8")));
  const relay = await RelayServer.start({ ...config, tls: await loadRelayTls(config.tls), onWarning: (code) => console.error(`Relay: ${code}`) });
  console.log(`TaroBird relay ready: public=${relay.status.publicPort}, tunnel=${relay.status.tunnelPort}`);
  let shutdown: (() => void) | undefined;
  try { await new Promise<void>((resolve) => { shutdown = resolve; process.once("SIGINT", resolve); process.once("SIGTERM", resolve); }); }
  finally { if (shutdown) { process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown); } await relay.close(); }
}
