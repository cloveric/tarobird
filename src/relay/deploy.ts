import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { relayServerSchema } from "./config.js";
import { ntfyDeploymentSchema, peerRelayDeploymentSchema, prepareCompanions } from "./companions.js";
import { companionStatusSchema } from "./health.js";
import { relayUpdateConfigSchema } from "./update.js";

const runtimeSchema = z.object({ version: z.string().regex(/^24\.\d+\.\d+$/), x64: z.string().regex(/^[a-f0-9]{64}$/), arm64: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const relayDeploymentSchema = z.object({ relay: relayServerSchema, runtime: runtimeSchema.optional(), updates: relayUpdateConfigSchema.optional(), ntfy: ntfyDeploymentSchema.optional(), peerRelay: peerRelayDeploymentSchema.optional() }).strict();
export type RelayDeployment = z.infer<typeof relayDeploymentSchema>;
type Fetch = typeof globalThis.fetch;
const root = "/opt/tarocub-relay";
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export function validateSshHost(host: string): string {
  if (!/^(?:[a-z_][a-z0-9_.-]*@)?(?:[a-z0-9_][a-z0-9_.-]*|\[[a-f0-9:]+\])$/i.test(host) || host.length > 253) throw new Error("Invalid SSH host or alias");
  return host;
}
async function officialText(url: string, fetcher: Fetch): Promise<string> {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("Cannot read official Node.js release metadata");
  const text = await response.text(); if (text.length > 2_000_000) throw new Error("Node.js metadata too large"); return text;
}
/** Resolve once on the operator's computer; the SSH installer receives exact
 * version and checksums and never executes downloaded shell scripts. */
export async function resolveRelayRuntime(fetcher: Fetch = globalThis.fetch): Promise<z.infer<typeof runtimeSchema>> {
  const releases = z.array(z.object({ version: z.string(), lts: z.union([z.string(), z.boolean()]) }).passthrough()).parse(JSON.parse(await officialText("https://nodejs.org/dist/index.json", fetcher)));
  const version = releases.find((r) => /^v24\.\d+\.\d+$/.test(r.version) && r.lts)?.version.slice(1);
  if (!version) throw new Error("No Node.js 24 LTS release found");
  const sums = await officialText(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, fetcher);
  const checksum = (arch: string) => sums.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).find((parts) => parts[1] === `node-v${version}-linux-${arch}.tar.xz`)?.[0];
  return runtimeSchema.parse({ version, x64: checksum("x64"), arm64: checksum("arm64") });
}
function encodedFile(name: string, content: string | Buffer): string {
  // Names are fixed by this module. Data can never become shell syntax.
  return `base64 --decode > "$stage/${name}" <<'TAROCUB_DATA'\n${Buffer.from(content).toString("base64")}\nTAROCUB_DATA\n`;
}
export async function prepareRelayDeployment(configFile: string, bundleFile: string, fetcher: Fetch = globalThis.fetch): Promise<{ script: string; summary: Record<string, unknown> }> {
  const config = relayDeploymentSchema.parse(JSON.parse(await readFile(configFile, "utf8")));
  const relay = config.relay; const runtime = config.runtime ?? await resolveRelayRuntime(fetcher);
  if (relay.publicHost !== "0.0.0.0" || relay.tunnelHost !== "0.0.0.0") throw new Error("Deployment expects IPv4 public listeners on 0.0.0.0");
  const healthPort = relay.healthPort ?? 9877;
  const companions = await prepareCompanions(config, configFile);
  if (relay.localTls) throw new Error("Deployment owns localTls; configure ntfy instead");
  if (config.ntfy && (config.ntfy.serverName.toLowerCase() === relay.serverName.toLowerCase() || new Set([relay.publicPort, relay.tunnelPort, healthPort, config.ntfy.tlsPort, config.ntfy.healthPort]).size !== 5 || relay.publicPort !== 443)) throw new Error("ntfy requires a separate domain, distinct loopback ports and public TCP 443");
  if (new Set([relay.publicPort, relay.tunnelPort, healthPort]).size !== 3) throw new Error("Relay ports must be distinct");
  const file = (value: string) => readFile(path.resolve(path.dirname(configFile), value));
  const [bundle, ca, cert, key] = await Promise.all([readFile(bundleFile), file(relay.tls.ca), file(relay.tls.cert), file(relay.tls.key)]);
  if (!bundle.length || bundle.length > 10 * 1024 * 1024) throw new Error("Relay bundle missing or too large; run npm run build");
  if ([ca, cert, key].some((v) => v.length > 64 * 1024)) throw new Error("Tunnel credentials too large");
  const authority = new X509Certificate(ca); const server = new X509Certificate(cert);
  if (!authority.ca || server.ca || !server.verify(authority.publicKey) || !server.checkPrivateKey(createPrivateKey(key)) || [authority, server].some((cert) => Date.parse(cert.validTo) <= Date.now() || Date.parse(cert.validFrom) > Date.now())) throw new Error("Invalid, expired or mismatched tunnel credentials");
  const remote = { ...relay, healthPort, ...(config.ntfy ? { localTls: { serverName: config.ntfy.serverName, targetPort: config.ntfy.tlsPort } } : {}), tls: { ca: `${root}/current/ca.pem`, cert: `${root}/current/server.pem`, key: `${root}/current/server.key` } };
  const files = { "relay.mjs": bundle, "relay.json": JSON.stringify(remote, null, 2) + "\n", "ca.pem": ca, "server.pem": cert, "server.key": key, ...companions.files };
  const revision = hash(Buffer.concat([...Object.values(files).map((v) => Buffer.from(v)), Buffer.from(JSON.stringify(runtime)), Buffer.from(JSON.stringify(config.updates ?? null)), Buffer.from(JSON.stringify(config.ntfy?.archive ?? null)), Buffer.from(JSON.stringify(config.peerRelay?.archive ?? null))])).slice(0, 24);
  const unit = `[Unit]
Description=TaroBird TLS passthrough relay
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=tarocub-relay
Group=tarocub-relay
ExecStart=${root}/current/node ${root}/current/relay.mjs --config ${root}/current/relay.json
Restart=always
RestartSec=3
TimeoutStopSec=15
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
UMask=0077
[Install]
WantedBy=multi-user.target
`;
  const health = `#!/bin/sh\nset -eu\n${companions.health}if ! curl --fail --silent --max-time 5 http://127.0.0.1:${healthPort}/health >/dev/null; then systemctl restart tarocub-relay.service; fi\n`;
  const healthUnit = "[Unit]\nDescription=Check the TaroBird relay process\n[Service]\nType=oneshot\nExecStart=/usr/bin/flock -n -E 0 /opt/tarocub-relay/deploy.lock /opt/tarocub-relay/check-health\n";
  const healthTimer = "[Unit]\nDescription=TaroBird relay health interval\n[Timer]\nOnBootSec=60\nOnUnitActiveSec=60\nRandomizedDelaySec=5\n[Install]\nWantedBy=timers.target\n";
  const updateUnit = `[Unit]\nDescription=Install a signed TaroBird relay release\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=${root}/current/node ${root}/current/relay.mjs update --config ${root}/updates.json\nTimeoutStartSec=180\nSuccessExitStatus=75\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=true\nReadWritePaths=${root}\nRestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX\n`;
  const updateTimer = "[Unit]\nDescription=Daily signed TaroBird relay updates\n[Timer]\nOnBootSec=15min\nOnUnitActiveSec=24h\nRandomizedDelaySec=1h\nPersistent=true\n[Install]\nWantedBy=timers.target\n";
  const firewallService = "[Unit]\nDescription=TaroBird dedicated relay firewall\nBefore=tarocub-relay.service\nAfter=network-pre.target\nWants=network-pre.target\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/opt/tarocub-relay/apply-firewall\n[Install]\nWantedBy=multi-user.target\n";
  // Atomic nft transaction replaces only our own table. It never flushes the host ruleset.
  const firewallApply = "#!/bin/sh\nset -eu\ntmp=$(mktemp)\ntrap 'rm -f \"$tmp\"' EXIT\nif nft list table inet tarocub_relay >/dev/null 2>&1; then echo 'delete table inet tarocub_relay' > \"$tmp\"; fi\ncat /opt/tarocub-relay/firewall.nft >> \"$tmp\"\nnft --check --file \"$tmp\"\nnft --file \"$tmp\"\n";
  const script = `#!/bin/bash
set -Eeuo pipefail
umask 077
test "$(id -u)" = 0 || { echo 'Root or passwordless sudo is required' >&2; exit 1; }
command -v apt-get >/dev/null || { echo 'Supported VPS: Debian or Ubuntu with systemd' >&2; exit 1; }
${companions.preflight}test -d /run/systemd/system || { echo 'systemd must be running' >&2; exit 1; }
ssh_port="$TAROCUB_SSH_PORT"
case "$ssh_port" in ''|*[!0-9]*) echo 'Cannot determine current SSH port' >&2; exit 1;; esac
test "$ssh_port" -ge 1 && test "$ssh_port" -le 65535
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils nftables unattended-upgrades util-linux
install -d -m 0755 ${root} ${root}/releases
exec 9>${root}/deploy.lock
flock -n 9 || { echo 'Another relay deployment is running' >&2; exit 1; }
if ! id tarocub-relay >/dev/null 2>&1; then useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin tarocub-relay; fi
test "$(id -u tarocub-relay)" != 0
test "$(getent passwd tarocub-relay | cut -d: -f6,7)" = '/nonexistent:/usr/sbin/nologin' || { echo 'Existing tarocub-relay account is not a dedicated service account' >&2; exit 1; }
${Object.entries(files).map(([name, value]) => encodedFile(name, value)).join("")}
${encodedFile("relay.service", unit)}${encodedFile("health", health)}${encodedFile("health.service", healthUnit)}${encodedFile("health.timer", healthTimer)}${encodedFile("firewall.service", firewallService)}${encodedFile("firewall-apply", firewallApply)}
${Object.entries(companions.transient).map(([name, value]) => encodedFile(name, value)).join("")}
${Object.entries(companions.units).map(([name, value]) => encodedFile(name, value)).join("")}
${config.updates ? encodedFile("updates.json", JSON.stringify(config.updates) + "\n") + encodedFile("update.service", updateUnit) + encodedFile("update.timer", updateTimer) : ""}
revision=${revision}
version=${runtime.version}
case "$(uname -m)" in x86_64) arch=x64; checksum=${runtime.x64};; aarch64|arm64) arch=arm64; checksum=${runtime.arm64};; *) echo 'Supported VPS architectures: x64, arm64' >&2; exit 1;; esac
release=${root}/releases/$revision
if ! test -f "$release/.complete"; then
  final_release="$release"
  release="$stage/release"
  install -d -m 0750 "$release"
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 300 --output "$stage/node.tar.xz" "https://nodejs.org/dist/v$version/node-v$version-linux-$arch.tar.xz"
  printf '%s  %s\n' "$checksum" "$stage/node.tar.xz" | sha256sum --check --status
  tar -xJf "$stage/node.tar.xz" -C "$stage" --strip-components=2 "node-v$version-linux-$arch/bin/node"
  test "$("$stage/node" --version)" = "v$version"
  "$stage/node" --check "$stage/relay.mjs"
  install -d -o root -g tarocub-relay -m 0750 "$release"
  for file in ${Object.keys(files).join(" ")}; do install -o root -g tarocub-relay -m 0640 "$stage/$file" "$release/$file"; done
  install -o root -g tarocub-relay -m 0750 "$stage/node" "$release/node"
  ${companions.stage}
  touch "$release/.complete"
  if test -e "$final_release"; then echo 'Incomplete existing release requires operator inspection' >&2; exit 1; fi
  mv "$release" "$final_release"
  release="$final_release"
fi
previous=$(readlink ${root}/current || true)
if test -n "$previous"; then
 case "$previous" in ${root}/releases/*) test "$(dirname "$previous")" = ${root}/releases;; *) echo 'Unexpected current release path' >&2; exit 1;; esac
 ${!config.ntfy ? `test ! -f "$previous/ntfy.json" || { echo 'Existing ntfy must stay in the deployment configuration; decommission it separately' >&2; exit 1; }` : ""}
 ${!config.peerRelay ? `test ! -f "$previous/peer-relay.json" || { echo 'Existing peer relay must stay in the deployment configuration; decommission it separately' >&2; exit 1; }` : ""}
 test -f "$previous/.complete" || { echo 'Previous release is incomplete' >&2; exit 1; }
fi
managed_files='${["/etc/systemd/system/tarocub-relay.service", "/etc/systemd/system/tarocub-relay-health.service", "/etc/systemd/system/tarocub-relay-health.timer", "/etc/systemd/system/tarocub-relay-firewall.service", "/etc/systemd/system/tarocub-relay-update.service", "/etc/systemd/system/tarocub-relay-update.timer", "/etc/systemd/system/tarocub-ntfy.service", "/etc/systemd/system/tarocub-tailscaled.service", `${root}/check-health`, `${root}/apply-firewall`, `${root}/firewall.nft`, `${root}/updates.json`].join(" ")}'
managed_services='tarocub-relay.service tarocub-relay-health.timer tarocub-relay-firewall.service tarocub-relay-update.timer tarocub-ntfy.service tarocub-tailscaled.service'
mkdir "$stage/backup" "$stage/service-state"
for file in $managed_files; do
 if test -L "$file"; then echo 'Managed file must not be a symlink' >&2; exit 1; fi
 if test -e "$file"; then cp -a --parents "$file" "$stage/backup"; fi
done
for service in $managed_services; do
 state=$(systemctl is-enabled "$service" 2>/dev/null || true)
 test "$state" != masked || { echo 'Managed service is masked' >&2; exit 1; }
 if test "$state" = enabled; then touch "$stage/service-state/$service.enabled"; fi
 if systemctl is-active --quiet "$service"; then touch "$stage/service-state/$service.active"; fi
done
rollback() {
 trap - ERR
 set +e
 rollback_failed=0
 for service in $managed_services; do if systemctl is-active --quiet "$service"; then systemctl stop "$service" >/dev/null 2>&1 || rollback_failed=1; fi; done
 for file in $managed_files; do
  if test -e "$stage/backup$file"; then cp -a "$stage/backup$file" "$file" || rollback_failed=1; else rm -f "$file" || rollback_failed=1; fi
 done
 if test -n "$previous"; then ln -sfn "$previous" ${root}/rollback; mv -Tf ${root}/rollback ${root}/current || rollback_failed=1; else rm -f ${root}/current || rollback_failed=1; fi
 systemctl daemon-reload || rollback_failed=1
 if test -f ${root}/firewall.nft; then ${root}/apply-firewall || rollback_failed=1; else if nft list table inet tarocub_relay >/dev/null 2>&1; then nft delete table inet tarocub_relay || rollback_failed=1; fi; fi
 for service in $managed_services; do
  if test -f "$stage/service-state/$service.enabled"; then systemctl enable "$service" >/dev/null 2>&1 || rollback_failed=1; elif test -f "/etc/systemd/system/$service"; then systemctl disable "$service" >/dev/null 2>&1 || rollback_failed=1; fi
  if test -f "$stage/service-state/$service.active"; then systemctl start "$service" || rollback_failed=1; fi
 done
 if test -n "$previous" && test -f "$previous/peer-relay.json" && test -f "$stage/service-state/tarocub-tailscaled.service.active"; then
  "$previous/node" -e 'const fs=require("fs"),{execFileSync}=require("child_process"),r=process.argv[1],p=JSON.parse(fs.readFileSync(r+"/peer-relay.json","utf8"));let restored=false;for(let i=0;i<5;i++){try{execFileSync(r+"/tailscale",["--socket=/run/tarocub-tailscale/tailscaled.sock","set","--relay-server-port="+p.port,"--relay-server-static-endpoints="+p.staticEndpoints.join(",")],{timeout:5000,stdio:"ignore"});restored=true;break}catch{if(i<4)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)}}if(!restored)process.exit(1);' "$previous" || rollback_failed=1
 fi
 if test "$rollback_failed" = 1; then echo 'Relay deployment failed; rollback also requires operator repair' >&2; else echo 'Relay deployment failed; previous managed configuration restored' >&2; fi
}
trap 'code=$?; rollback; exit "$code"' ERR
${companions.services.map((service, i) => `companion_changed_${i}=0
if ! cmp -s "$stage/${service}" /etc/systemd/system/${service}; then companion_changed_${i}=1; fi
for file in ${service === "tarocub-ntfy.service" ? "ntfy ntfy.json ntfy-cert.pem ntfy-key.pem" : "tailscale tailscaled"}; do if ! cmp -s "$release/$file" "$previous/$file"; then companion_changed_${i}=1; fi; done`).join("\n")}
changed=0
install_changed() { if ! cmp -s "$1" "$2"; then install -o root -g root -m "$3" "$1" "$2"; changed=1; fi; }
install_changed "$stage/relay.service" /etc/systemd/system/tarocub-relay.service 0644
install_changed "$stage/health" ${root}/check-health 0755
install_changed "$stage/health.service" /etc/systemd/system/tarocub-relay-health.service 0644
install_changed "$stage/health.timer" /etc/systemd/system/tarocub-relay-health.timer 0644
install_changed "$stage/firewall.service" /etc/systemd/system/tarocub-relay-firewall.service 0644
install_changed "$stage/firewall-apply" ${root}/apply-firewall 0755
${config.updates ? `install_changed "$stage/updates.json" ${root}/updates.json 0600\ninstall_changed "$stage/update.service" /etc/systemd/system/tarocub-relay-update.service 0644\ninstall_changed "$stage/update.timer" /etc/systemd/system/tarocub-relay-update.timer 0644` : "systemctl disable --now tarocub-relay-update.timer >/dev/null 2>&1 || true"}
${Object.keys(companions.units).map((name) => `install_changed "$stage/${name}" /etc/systemd/system/${name} 0644`).join("\n")}
cat > "$stage/firewall.nft" <<NFT
table inet tarocub_relay {
 chain input {
  type filter hook input priority 10; policy drop;
  ct state established,related accept
  iifname "lo" accept
  iifname "tailscale0" accept
  ip protocol icmp accept
  meta l4proto ipv6-icmp accept
  tcp dport { $ssh_port, ${relay.publicPort}, ${relay.tunnelPort} } accept
  ${config.peerRelay ? `udp dport ${config.peerRelay.port} accept` : ""}
 }
}
NFT
firewall_changed=0
if ! cmp -s "$stage/firewall.nft" ${root}/firewall.nft; then install -m 0600 "$stage/firewall.nft" ${root}/firewall.nft; firewall_changed=1; fi
${root}/apply-firewall
if test "$previous" != "$release"; then ln -sfn "$release" ${root}/next; mv -Tf ${root}/next ${root}/current; changed=1; fi
systemctl daemon-reload
${companions.services.map((service, i) => `systemctl enable ${service} >/dev/null
if test "$companion_changed_${i}" = 1; then systemctl restart ${service}; else systemctl start ${service}; fi`).join("\n")}
${companions.activate}
systemctl enable tarocub-relay.service tarocub-relay-health.timer tarocub-relay-firewall.service >/dev/null
if test "$changed" = 1; then systemctl restart tarocub-relay.service; else systemctl start tarocub-relay.service; fi
systemctl start tarocub-relay-health.timer
${config.updates ? "systemctl enable --now tarocub-relay-update.timer >/dev/null" : ""}
healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do if systemctl is-active --quiet tarocub-relay.service && curl --fail --silent --max-time 2 http://127.0.0.1:${healthPort}/health > "$stage/status.json"; then healthy=1; break; fi; sleep 1; done
test "$healthy" = 1
${companions.verify}
trap - ERR
# Distribution security updates use the OS-signed repositories. Application
# updates use an optional pinned Ed25519 release feed; Node updates use redeploy.
printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > /etc/apt/apt.conf.d/52tarocub-security-updates
printf 'TAROCUB_DEPLOYED revision=%s changed=%s firewallChanged=%s\n' "$revision" "$changed" "$firewall_changed"
cat "$stage/status.json"
`;
  return { script, summary: { service: "tarocub-relay", revision, serverName: relay.serverName, ports: { public: relay.publicPort, tunnel: relay.tunnelPort, health: `127.0.0.1:${healthPort}`, ssh: "preserve current SSH server port" }, runtime: runtime.version, files: Object.keys(files), firewall: "dedicated VPS: allow established traffic, loopback, Tailscale, ICMP, SSH, public and tunnel ports; drop other inbound traffic", updates: config.updates ? { relay: "daily signed release feed", url: config.updates.url, minRelease: config.updates.minRelease, os: "signed distribution security updates", node: "idempotent redeploy" } : "OS security updates; relay code and Node runtime updated by idempotent redeploy", companions: companions.summary, rollback: "restore previous release, managed unit/config files, service states and firewall on failure", secrets: "only explicit tunnel and optional companion credentials are transferred; no Hub identity or Hub TLS key is read; enrollment keys are removed with the private temporary staging directory" } };
}
export type SshRunner = (host: string, command: string, input?: string) => Promise<string>;
export const runRelaySsh: SshRunner = (host, command, input) => new Promise((resolve, reject) => {
  const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "--", validateSshHost(host), command], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; let error = "";
  child.stdout.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-128_000); }); child.stderr.on("data", (chunk: Buffer) => { error = (error + chunk.toString()).slice(-4000); });
  child.on("error", reject); child.stdin.on("error", () => undefined); child.stdin.end(input);
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("SSH relay operation timed out")); }, 15 * 60_000); timer.unref();
  child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`SSH relay operation failed (${code}): ${error}`)); });
});
export async function deployRelay(host: string, plan: Awaited<ReturnType<typeof prepareRelayDeployment>>, runner: SshRunner = runRelaySsh): Promise<string> {
  validateSshHost(host);
  // SSH_CONNECTION is evaluated only on the remote host, before sudo strips it.
  const output = await runner(host, "set -- $SSH_CONNECTION; test -n \"$4\" || exit 1; if test \"$(id -u)\" = 0; then TAROCUB_SSH_PORT=$4 bash -s; else sudo -n env TAROCUB_SSH_PORT=$4 bash -s; fi", plan.script);
  const marker = output.indexOf(`TAROCUB_DEPLOYED revision=${String(plan.summary.revision)} `);
  if (marker < 0) throw new Error("Relay installation returned no verified receipt");
  relayHealthSchema.parse(JSON.parse(output.slice(output.indexOf("\n", marker) + 1)));
  return output;
}
const relayHealthSchema = z.object({ service: z.literal("tarocub-relay"), connected: z.boolean(), pending: z.number().int().min(0), connections: z.number().int().min(0), publicPort: z.number().int().min(1).max(65535), tunnelPort: z.number().int().min(1).max(65535) });
export async function inspectRemoteRelay(host: string, runner: SshRunner = runRelaySsh): Promise<unknown> {
  validateSshHost(host);
  const command = `if test "$(id -u)" = 0; then cat ${root}/current/relay.json; else sudo -n cat ${root}/current/relay.json; fi`;
  const config = relayServerSchema.parse(JSON.parse(await runner(host, command)));
  if (!config.healthPort) throw new Error("Remote health endpoint is not configured");
  const health = relayHealthSchema.parse(JSON.parse(await runner(host, `curl --fail --silent --show-error --max-time 5 http://127.0.0.1:${config.healthPort}/health`)));
  const inspect = `${root}/current/node ${root}/current/relay.mjs inspect`;
  const companions = companionStatusSchema.parse(JSON.parse(await runner(host, `if test "$(id -u)" = 0; then ${inspect}; else sudo -n ${inspect}; fi`)));
  return Object.keys(companions).length ? { ...health, companions } : health;
}
