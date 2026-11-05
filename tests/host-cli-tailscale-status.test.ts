import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TAILSCALE_STATUS_ARGS, tailscaleDiagnostic } from "../src/host-cli/tailscale-status.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "tailscale-status-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function fake(name: string, body: string): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`); await chmod(file, 0o755);
  return file;
}
const status = JSON.stringify({
  BackendState: "Running", Version: "1.80.0",
  Self: { Online: true, HostName: "private-host-name", DNSName: "private-host.tailnet-fixture.ts.net.", TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"] },
  Peer: { "nodekey:fixture": { HostName: "someone-else", TailscaleIPs: ["100.64.0.99"] } },
});

it("runs a fixed argv and reports only this node's sanitized state", async () => {
  const argv = path.join(directory, "argv.txt");
  const command = await fake("tailscale", `printf '%s ' "$@" > '${argv}'\ncat <<'JSON'\n${status}\nJSON`);
  const result = await tailscaleDiagnostic(["100.64.0.7", "100.64.0.8"], { commands: [command] });
  expect(result).toEqual({ available: true, backendState: "Running", online: true, addresses: [{ address: "100.64.0.7", held: true }, { address: "100.64.0.8", held: false }] });
  expect((await readFile(argv, "utf8")).trim()).toBe(TAILSCALE_STATUS_ARGS.join(" "));
  expect(JSON.stringify(result)).not.toMatch(/private-host|someone-else|100\.64\.0\.99|ts\.net|Peer/);
});

it("bounds missing, slow, failing, malformed and oversized tailscale output", async () => {
  expect(await tailscaleDiagnostic([], { commands: [path.join(directory, "absent")] })).toEqual({ available: false, reason: "missing" });
  const started = Date.now();
  expect(await tailscaleDiagnostic([], { commands: [await fake("slow", "sleep 5")], timeoutMs: 200 })).toEqual({ available: false, reason: "timeout" });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(await tailscaleDiagnostic([], { commands: [await fake("fail", "exit 1")] })).toEqual({ available: false, reason: "failed" });
  expect(await tailscaleDiagnostic([], { commands: [await fake("garbage", "echo not-json")] })).toEqual({ available: false, reason: "invalid" });
  // Valid JSON beyond the output cap is still refused.
  const huge = await fake("huge", `printf '{"BackendState":"Running","Pad":"'; head -c 300000 /dev/zero | tr '\\0' a; printf '"}'`);
  expect(await tailscaleDiagnostic([], { commands: [huge] })).toEqual({ available: false, reason: "invalid" });
  // The first missing candidate falls through to the next fixed location.
  expect(await tailscaleDiagnostic([], { commands: [path.join(directory, "absent"), await fake("ok", `echo '{"BackendState":"Stopped","Self":null}'`)] })).toEqual({ available: true, backendState: "Stopped", addresses: [] });
});

it("reports a signed-out node whose real CLI response has null TailscaleIPs", async () => {
  const command = await fake("signed-out", `echo '{"BackendState":"NeedsLogin","Self":{"Online":false,"TailscaleIPs":null},"AuthURL":"https://login.invalid/private","Peer":null}'`);
  expect(await tailscaleDiagnostic(["100.64.0.7"], { commands: [command] })).toEqual({
    available: true, backendState: "NeedsLogin", online: false, addresses: [{ address: "100.64.0.7", held: false }],
  });
});
