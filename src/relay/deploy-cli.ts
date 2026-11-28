import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { probeScreenUdp } from "./screen-udp-probe.js";
import { defaultHubDirectory } from "../hub/config.js";
import { deployRelay, inspectRemoteRelay, prepareRelayDeployment, validateSshHost } from "./deploy.js";

export async function runRelayDeploymentCli(argv: string[]): Promise<void> {
  const args = parseArgs({ args: argv, allowPositionals: true, options: { host: { type: "string" }, config: { type: "string" }, "state-dir": { type: "string" }, "dry-run": { type: "boolean" }, "screen-udp": { type: "string" }, help: { type: "boolean", short: "h" } } });
  const [command] = args.positionals;
  if (args.values.help || !args.values.host) { console.log("hub relay deploy --host <SSH alias> [--config <relay-deploy.json>] [--screen-udp <public IPv4>] [--dry-run]\nhub relay status --host <SSH alias>\nDedicated Debian/Ubuntu VPS with systemd; known SSH host and root/passwordless sudo required.\nDry run validates inputs and prints a redacted plan without connecting to SSH."); return; }
  if (command === "status") { console.log(JSON.stringify(await inspectRemoteRelay(args.values.host), null, 2)); return; }
  if (command !== "deploy") throw new Error("Unknown relay deployment command");
  validateSshHost(args.values.host);
  const config = path.resolve(args.values.config ?? path.join(args.values["state-dir"] ?? defaultHubDirectory(), "relay-deploy.json"));
  const plan = await prepareRelayDeployment(config, fileURLToPath(new URL("../../relay-runtime.mjs", import.meta.url)), undefined, { screenUdpAddress: args.values["screen-udp"] });
  if (args.values["dry-run"]) console.log(JSON.stringify({ host: args.values.host, ...plan.summary }, null, 2));
  else {
    console.log(await deployRelay(args.values.host, plan));
    if (plan.udpCheck) {
      const reachable = await probeScreenUdp(plan.udpCheck.address, plan.udpCheck.port);
      console.log(JSON.stringify({ screenUdpReachableFromOperator: reachable, port: plan.udpCheck.port }));
      if (!reachable) console.error("UDP probe timed out. Check the VPS security group and firewall for the shared tunnel port.");
    }
  }
}
