import { z } from "zod";
import { MAX_CLOUDFLARE_ROUTES } from "./routes.js";
import { edgeOriginSchema } from "./tls-identity.js";
import { isLoopbackOrUnspecified } from "./loopback-address.js";

export const HOST_CLOUDFLARE_CAPABILITY = "host-routes.cloudflare.v1";
export const HOST_CLOUDFLARE_PATH = "/api/host-routes/cloudflare";
export const HOST_CLOUDFLARE_QUICK_PATH = "/api/host-routes/cloudflare/quick";

export const cloudflareModeSchema = z.enum(["quick", "named"]);
export type CloudflareMode = z.infer<typeof cloudflareModeSchema>;
export const cloudflareProtocolSchema = z.enum(["http2", "quic"]);
export type CloudflareProtocol = z.infer<typeof cloudflareProtocolSchema>;

export const cloudflareOriginSchema = edgeOriginSchema.refine((origin) => {
  try { return !isLoopbackOrUnspecified(new URL(origin).hostname); }
  catch { return false; }
}, "Cloudflare origin must be a public HTTPS origin");

export const cloudflareConfigSchema = z.object({
  v: z.literal(1),
  mode: cloudflareModeSchema,
  protocol: cloudflareProtocolSchema,
  origins: z.array(cloudflareOriginSchema).max(MAX_CLOUDFLARE_ROUTES).refine(
    (items) => new Set(items).size === items.length,
    "Duplicate Cloudflare origin",
  ),
}).strict();
export type CloudflareConfig = z.infer<typeof cloudflareConfigSchema>;

export const cloudflareUpdateSchema = z.object({
  mode: cloudflareModeSchema.optional(),
  protocol: cloudflareProtocolSchema.optional(),
  origins: z.array(cloudflareOriginSchema).max(MAX_CLOUDFLARE_ROUTES).refine(
    (items) => new Set(items).size === items.length,
    "Duplicate Cloudflare origin",
  ).optional(),
}).strict();
export type CloudflareUpdate = z.infer<typeof cloudflareUpdateSchema>;

export const cloudflareQuickActionSchema = z.object({
  action: z.enum(["start", "stop"]),
  protocol: cloudflareProtocolSchema.optional(),
}).strict();
export type CloudflareQuickAction = z.infer<typeof cloudflareQuickActionSchema>;

/** Stable, domain-separated signed intent for Cloudflare settings updates. */
export function cloudflareUpdateProofText(command: CloudflareUpdate): string {
  const v = cloudflareUpdateSchema.parse(command);
  return JSON.stringify([
    "tarobot/cloudflare-update/v1",
    v.mode ?? null,
    v.protocol ?? null,
    v.origins ?? null,
  ]);
}

/** Stable, domain-separated signed intent for Quick Tunnel lifecycle actions. */
export function cloudflareQuickActionProofText(command: CloudflareQuickAction): string {
  const v = cloudflareQuickActionSchema.parse(command);
  return JSON.stringify([
    "tarobot/cloudflare-quick/v1",
    v.action,
    v.protocol ?? null,
  ]);
}

export const cloudflareViewSchema = z.object({
  v: z.literal(1),
  installed: z.boolean(),
  version: z.string().max(120).optional(),
  running: z.boolean(),
  activeUrl: cloudflareOriginSchema.optional(),
  lastError: z.string().max(240).optional(),
  mode: cloudflareModeSchema,
  protocol: cloudflareProtocolSchema,
  origins: z.array(cloudflareOriginSchema).max(MAX_CLOUDFLARE_ROUTES),
  loopbackTarget: z.string().url(),
  commands: z.object({
    quickHttp2: z.string(),
    quickQuic: z.string(),
    namedHttp2: z.string(),
    namedQuic: z.string(),
  }).strict(),
}).strict();
export type CloudflareView = z.infer<typeof cloudflareViewSchema>;

export function cloudflareCommands(loopbackTarget: string): CloudflareView["commands"] {
  const target = new URL(loopbackTarget).origin;
  const extra = target.startsWith("https://") ? " --no-tls-verify" : "";
  return {
    quickHttp2: `cloudflared tunnel --protocol http2${extra} --url ${target}`,
    quickQuic: `cloudflared tunnel${extra} --url ${target}`,
    namedHttp2: `cloudflared tunnel --protocol http2 run${extra} --url ${target} <your-tunnel-name>`,
    namedQuic: `cloudflared tunnel run${extra} --url ${target} <your-tunnel-name>`,
  };
}
