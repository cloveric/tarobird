import {
  cloudflareModeSchema,
  cloudflareOriginSchema,
  cloudflareProtocolSchema,
  cloudflareQuickActionProofText,
  cloudflareQuickActionSchema,
  cloudflareUpdateProofText,
  cloudflareUpdateSchema,
  cloudflareViewSchema,
  HOST_CLOUDFLARE_CAPABILITY,
  HOST_CLOUDFLARE_PATH,
  HOST_CLOUDFLARE_QUICK_PATH,
  type CloudflareQuickAction,
  type CloudflareUpdate,
  type CloudflareView,
} from "../client-protocol/cloudflare.js";
import { hashSecret } from "../hub/auth.js";
import type { LocalHostClient } from "./client.js";

export interface CloudflareCommandOptions {
  yes?: boolean;
  mode?: string;
  protocol?: string;
  origins?: string;
  clearOrigins?: boolean;
  from?: unknown;
}

/** Local Host CLI management for DIY Cloudflare Tunnel settings & Quick Tunnel.
 * Mutations require explicit `--yes` and sign a one-use `cloudflare-tunnel`
 * device-action proof with the enrolled local CLI controller key. */
export async function runCloudflareCommand(
  client: LocalHostClient,
  sub: string | undefined,
  argument: string | undefined,
  options: CloudflareCommandOptions = {},
): Promise<CloudflareView> {
  if (!client.supports(HOST_CLOUDFLARE_CAPABILITY)) {
    throw new Error("请先更新目标主机；此版本尚不支持 Cloudflare Tunnel 配置。");
  }
  const readView = async () => cloudflareViewSchema.parse(await client.request(HOST_CLOUDFLARE_PATH));
  if (sub === "status") {
    if (argument || options.yes || options.mode !== undefined || options.protocol !== undefined || options.origins !== undefined || options.clearOrigins || options.from !== undefined) {
      throw new Error("cloudflare status 只读，不接受修改参数。");
    }
    return readView();
  }
  const submitUpdate = async (command: CloudflareUpdate): Promise<CloudflareView> => {
    const parsed = cloudflareUpdateSchema.parse(command);
    const proof = await client.deviceAction({
      operation: "cloudflare-tunnel",
      target: hashSecret(cloudflareUpdateProofText(parsed)),
    });
    return cloudflareViewSchema.parse(await client.request(HOST_CLOUDFLARE_PATH, "PUT", { command: parsed, proof }));
  };
  const submitQuick = async (command: CloudflareQuickAction): Promise<CloudflareView> => {
    const parsed = cloudflareQuickActionSchema.parse(command);
    const proof = await client.deviceAction({
      operation: "cloudflare-tunnel",
      target: hashSecret(cloudflareQuickActionProofText(parsed)),
    });
    return cloudflareViewSchema.parse(await client.request(HOST_CLOUDFLARE_QUICK_PATH, "POST", { command: parsed, proof }));
  };

  if (sub === "set") {
    if (argument) throw new Error("cloudflare set 不接受额外位置参数。");
    if (!options.yes) throw new Error("先用 cloudflare status 核对当前隧道配置，确认修改后加 --yes。");
    if (options.from !== undefined && (options.mode !== undefined || options.protocol !== undefined || options.origins !== undefined || options.clearOrigins)) {
      throw new Error("cloudflare set 使用 --from 时不要同时传 --mode/--protocol/--origins/--clear-origins。");
    }
    if (options.origins !== undefined && options.clearOrigins) {
      throw new Error("--origins 与 --clear-origins 不能同时使用。");
    }
    let command: CloudflareUpdate;
    if (options.from !== undefined) {
      command = cloudflareUpdateSchema.parse(options.from);
    } else {
      const next: CloudflareUpdate = {};
      if (options.mode !== undefined) next.mode = cloudflareModeSchema.parse(options.mode);
      if (options.protocol !== undefined) next.protocol = cloudflareProtocolSchema.parse(options.protocol);
      if (options.clearOrigins) next.origins = [];
      else if (options.origins !== undefined) {
        const parts = options.origins.split(",").map((item) => item.trim()).filter(Boolean);
        next.origins = parts.map((item) => cloudflareOriginSchema.parse(item));
      }
      if (next.mode === undefined && next.protocol === undefined && next.origins === undefined) {
        throw new Error("请至少指定 --mode、--protocol、--origins、--clear-origins 或 --from FILE 之一。");
      }
      command = cloudflareUpdateSchema.parse(next);
    }
    return submitUpdate(command);
  }

  if (sub === "allow" || sub === "revoke") {
    if (options.mode !== undefined || options.protocol !== undefined || options.origins !== undefined || options.clearOrigins || options.from !== undefined) {
      throw new Error(`cloudflare ${sub} 仅接受目标 HTTPS 域名和 --yes。`);
    }
    if (!argument) throw new Error("缺少目标 Cloudflare HTTPS 域名（例如 https://hub.example.com）。");
    const origin = cloudflareOriginSchema.parse(argument);
    if (!options.yes) throw new Error(`先确认 Cloudflare 域名 ${origin}，确认后加 --yes。`);
    const current = await readView();
    const origins = sub === "allow"
      ? (current.origins.includes(origin) ? current.origins : [...current.origins, origin])
      : current.origins.filter((item) => item !== origin);
    return submitUpdate({ origins });
  }

  if (sub === "quick") {
    if (options.mode !== undefined || options.origins !== undefined || options.clearOrigins || options.from !== undefined) {
      throw new Error("cloudflare quick 仅支持 start [--protocol http2|quic] --yes 或 stop --yes。");
    }
    if (argument !== "start" && argument !== "stop") {
      throw new Error("请使用 cloudflare quick start [--protocol http2|quic] --yes 或 cloudflare quick stop --yes。");
    }
    if (argument === "stop" && options.protocol !== undefined) {
      throw new Error("cloudflare quick stop 不接受 --protocol。");
    }
    if (!options.yes) {
      throw new Error(argument === "start"
        ? "启动 Quick Tunnel 将通过 Cloudflare 临时公网地址暴露本机边缘入口，确认后加 --yes。"
        : "停止 Quick Tunnel 将断开当前临时公网地址，确认后加 --yes。");
    }
    const protocol = options.protocol !== undefined ? cloudflareProtocolSchema.parse(options.protocol) : undefined;
    return submitQuick({ action: argument, ...(protocol ? { protocol } : {}) });
  }

  throw new Error("未知 cloudflare 命令。请使用 cloudflare status | set | allow | revoke | quick start|stop。");
}
