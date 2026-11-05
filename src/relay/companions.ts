import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { localTlsRouteSchema } from "./config.js";

const root = "/opt/tarocub-relay";
const archive = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), x64: z.string().regex(/^[a-f0-9]{64}$/), arm64: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const ntfyDeploymentSchema = z.object({
  serverName: localTlsRouteSchema.shape.serverName,
  tlsPort: z.number().int().min(1024).max(65535).default(8443),
  healthPort: z.number().int().min(1024).max(65535).default(2586),
  tls: z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict(),
  username: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  passwordHash: z.string().regex(/^\$2[aby]\$(?:0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/),
  archive: archive.refine((v) => (() => { const [major, minor] = v.version.split(".").map(Number); return major > 2 || major === 2 && minor >= 28; })(), "ntfy 2.28 or later required"),
}).strict();
const endpoint = z.string().refine((v) => {
  const match = /^(\[[0-9a-f:]+\]|[0-9.]+):(\d+)$/.exec(v);
  return !!match && isIP(match[1].replace(/^\[|\]$/g, "")) !== 0 && Number(match[2]) >= 1 && Number(match[2]) <= 65535;
}, "Static endpoints must be literal IP:port pairs");
export const peerRelayDeploymentSchema = z.object({
  port: z.number().int().min(1).max(65535).default(443),
  staticEndpoints: z.array(endpoint).max(8).default([]),
  hostname: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  authKeyFile: z.string().min(1).optional(),
  archive: archive.refine((v) => { const [major, minor] = v.version.split(".").map(Number); return major > 1 || major === 1 && minor >= 86; }, "Tailscale 1.86 or later required"),
}).strict();
export type CompanionInput = { ntfy?: z.infer<typeof ntfyDeploymentSchema>; peerRelay?: z.infer<typeof peerRelayDeploymentSchema> };
export type CompanionPlan = {
  files: Record<string, string | Buffer>; transient: Record<string, string | Buffer>; units: Record<string, string>;
  stage: string; preflight: string; activate: string; verify: string; health: string; services: string[];
  summary: Record<string, unknown>;
};
function downloadBinary(kind: "ntfy" | "tailscale", version: string, sums: { x64: string; arm64: string }): string {
  const location = kind === "ntfy" ? `https://github.com/binwiederhier/ntfy/releases/download/v${version}/ntfy_${version}_linux_$pkg_arch.tar.gz` : `https://pkgs.tailscale.com/stable/tailscale_${version}_$pkg_arch.tgz`;
  const prefix = kind === "ntfy" ? `ntfy_${version}_linux_$pkg_arch` : `tailscale_${version}_$pkg_arch`;
  return `case "$arch" in x64) pkg_arch=amd64; pkg_sum=${sums.x64};; arm64) pkg_arch=arm64; pkg_sum=${sums.arm64};; esac
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --tlsv1.2 --max-time 300 --max-filesize 104857600 --output "$stage/${kind}.tgz" "${location}"
printf '%s  %s\\n' "$pkg_sum" "$stage/${kind}.tgz" | sha256sum --check --status
tar -xzf "$stage/${kind}.tgz" -C "$stage" --strip-components=1 "${prefix}/${kind}"${kind === "tailscale" ? ` "${prefix}/tailscaled"` : ""}
install -o root -g tarocub-relay -m 0750 "$stage/${kind}" "$release/${kind}"
${kind === "tailscale" ? 'install -o root -g tarocub-relay -m 0750 "$stage/tailscaled" "$release/tailscaled"\n' : ""}`;
}
export async function prepareCompanions(input: CompanionInput, configFile: string): Promise<CompanionPlan> {
  const plan: CompanionPlan = { files: {}, transient: {}, units: {}, stage: "", preflight: "", activate: "", verify: "", health: "", services: [], summary: {} };
  if (input.ntfy) {
    const n = ntfyDeploymentSchema.parse(input.ntfy);
    const [cert, key] = await Promise.all([readFile(path.resolve(path.dirname(configFile), n.tls.cert)), readFile(path.resolve(path.dirname(configFile), n.tls.key))]);
    if (cert.length > 64 * 1024 || key.length > 64 * 1024) throw new Error("ntfy TLS credentials too large");
    const certificate = new X509Certificate(cert);
    if (certificate.ca || !certificate.checkHost(n.serverName) || !certificate.checkPrivateKey(createPrivateKey(key)) || Date.parse(certificate.validTo) <= Date.now() || Date.parse(certificate.validFrom) > Date.now()) throw new Error("Invalid, expired or mismatched ntfy TLS credentials");
    plan.files["ntfy-cert.pem"] = cert; plan.files["ntfy-key.pem"] = key;
    // JSON is a YAML subset. Never interpolate credentials into shell commands.
    plan.files["ntfy.json"] = JSON.stringify({
      "base-url": `https://${n.serverName}`, "listen-http": `127.0.0.1:${n.healthPort}`, "listen-https": `127.0.0.1:${n.tlsPort}`,
      "cert-file": `${root}/current/ntfy-cert.pem`, "key-file": `${root}/current/ntfy-key.pem`,
      "cache-file": "/var/lib/tarocub-ntfy/cache.db", "cache-duration": "12h", "auth-file": "/var/lib/tarocub-ntfy/auth.db",
      "auth-default-access": "deny-all", "auth-users": [`${n.username}:${n.passwordHash}:user`],
      "auth-access": ["*:up*:write-only", `${n.username}:up*:read-write`],
      "enable-signup": false, "enable-login": false, "enable-reservations": false,
      "behind-proxy": false, "attachment-cache-dir": "", "log-level": "warn", "message-size-limit": "4K",
      "visitor-subscription-limit": 128, "visitor-request-limit-burst": 120, "visitor-request-limit-replenish": "1s",
    }, null, 2) + "\n";
    plan.units["tarocub-ntfy.service"] = `[Unit]
Description=TaroBird encrypted UnifiedPush distributor
After=network-online.target
[Service]
User=tarocub-relay
Group=tarocub-relay
ExecStart=${root}/current/ntfy serve --config ${root}/current/ntfy.json
Restart=always
RestartSec=3
StateDirectory=tarocub-ntfy
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
[Install]
WantedBy=multi-user.target
`;
    plan.stage += downloadBinary("ntfy", n.archive.version, n.archive);
    plan.services.push("tarocub-ntfy.service");
    plan.verify += `ntfy_healthy=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 if systemctl is-active --quiet tarocub-ntfy.service && curl --fail --silent --max-time 2 http://127.0.0.1:${n.healthPort}/v1/health | "$release/node" -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{if(JSON.parse(s).healthy!==true)process.exit(1)});'; then ntfy_healthy=1; break; fi
 sleep 1
done
test "$ntfy_healthy" = 1
`;
    plan.health += `if ! curl --fail --silent --max-time 5 http://127.0.0.1:${n.healthPort}/v1/health >/dev/null; then systemctl restart tarocub-ntfy.service; fi\n`;
    plan.summary.ntfy = { domain: n.serverName, version: n.archive.version, tls: `127.0.0.1:${n.tlsPort}`, health: `127.0.0.1:${n.healthPort}`, access: "authenticated subscriber; anonymous writes only to up* topics; encrypted push payloads", updates: "pinned archive via redeploy" };
  }
  if (input.peerRelay) {
    const p = peerRelayDeploymentSchema.parse(input.peerRelay);
    if (p.authKeyFile) {
      const filename = path.resolve(path.dirname(configFile), p.authKeyFile), metadata = await stat(filename);
      if (!metadata.isFile() || metadata.size > 4096 || (metadata.mode & 0o077)) throw new Error("Tailscale auth key must be a private file (0600)");
      const value = (await readFile(filename, "utf8")).trim();
      if (!/^tskey-auth-[A-Za-z0-9-]{10,}$/.test(value)) throw new Error("Invalid Tailscale auth key file");
      plan.transient["tailscale-auth.key"] = value + "\n";
    }
    // Do not replace a separately managed tailscaled, which may carry the SSH
    // session. This installer owns only its explicitly named daemon and state.
    plan.preflight += `if systemctl is-active --quiet tailscaled.service; then echo 'Existing Tailscale service detected; use a dedicated VPS without a separately managed tailscaled' >&2; exit 1; fi\ntest -c /dev/net/tun || { echo 'Tailscale requires /dev/net/tun' >&2; exit 1; }\n`;
    plan.files["peer-relay.json"] = JSON.stringify({ port: p.port, staticEndpoints: p.staticEndpoints, hostname: p.hostname }) + "\n";
    plan.units["tarocub-tailscaled.service"] = `[Unit]
Description=TaroBird Tailscale peer relay
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=${root}/current/tailscaled --state=/var/lib/tarocub-tailscale/tailscaled.state --socket=/run/tarocub-tailscale/tailscaled.sock
Restart=always
RestartSec=5
StateDirectory=tarocub-tailscale
StateDirectoryMode=0700
RuntimeDirectory=tarocub-tailscale
RuntimeDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
[Install]
WantedBy=multi-user.target
`;
    plan.stage += downloadBinary("tailscale", p.archive.version, p.archive);
    plan.services.push("tarocub-tailscaled.service");
    const cli = `${root}/current/tailscale --socket=/run/tarocub-tailscale/tailscaled.sock`;
    const running = `"$release/node" -e 'const fs=require("fs");if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).BackendState!=="Running")process.exit(1)' "$stage/tailscale-status.json"`;
    plan.activate += `for attempt in 1 2 3 4 5; do if ${cli} status --json > "$stage/tailscale-status.json" 2>/dev/null; then break; fi; sleep 1; done
if ! ${running}; then
 ${p.authKeyFile ? `if ! ${cli} up --auth-key="file:$stage/tailscale-auth.key" --hostname=${p.hostname} --timeout=30s > "$stage/tailscale-login.log" 2>&1; then echo 'Tailscale authentication failed; check auth key and tailnet policy' >&2; false; fi` : "echo 'Tailscale requires an authKeyFile for its first installation' >&2; false"}
fi
${cli} set --relay-server-port=${p.port} --relay-server-static-endpoints='${p.staticEndpoints.join(",")}'
${cli} status --json > "$stage/tailscale-status.json"
${running}
`;
    plan.verify += `systemctl is-active --quiet tarocub-tailscaled.service\n${cli} debug prefs > "$stage/tailscale-prefs.json"\n"$release/node" -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")),c=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));if(p.RelayServerPort!==c.port||JSON.stringify(p.RelayServerStaticEndpoints||[])!==JSON.stringify(c.staticEndpoints))process.exit(1)' "$stage/tailscale-prefs.json" "$release/peer-relay.json"\n`;
    plan.health += "if ! systemctl is-active --quiet tarocub-tailscaled.service; then systemctl restart tarocub-tailscaled.service; fi\n";
    plan.summary.peerRelay = { udpPort: p.port, version: p.archive.version, hostname: p.hostname, policy: "tailnet relay grant required; no tailnet policy is modified", updates: "pinned archive via redeploy" };
  }
  plan.files["companion-health.json"] = JSON.stringify({ ...(input.ntfy ? { ntfyPort: input.ntfy.healthPort } : {}), peerRelay: !!input.peerRelay }) + "\n";
  return plan;
}
