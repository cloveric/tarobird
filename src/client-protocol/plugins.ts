import { z } from "zod";

export const PLUGIN_MANIFEST_VERSION = 1 as const;
export const PLUGIN_HOST_PROTOCOL = "tarobird.plugin.v1" as const;

export const pluginPlatformSchema = z.enum(["desktop", "phone"]);
export type PluginPlatform = z.infer<typeof pluginPlatformSchema>;

export const pluginCapabilitySchema = z.enum([
  "theme.read",
  "storage.device",
  "credentials.device",
  "files.export",
  "network.domains",
  "clipboard.write",
  "workbench.canvas",
  "chat.draft",
  "canvas.agent",
]);
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;

export const pluginIconSchema = z.enum([
  "canvas",
  "notes",
  "clock",
  "puzzle",
  "sparkles",
  "code",
]);
export type PluginIcon = z.infer<typeof pluginIconSchema>;

export const pluginContributionSchema = z.object({
  kind: z.enum(["workbench-item", "side-panel"]),
  id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/),
  title: z.string().trim().min(1).max(80),
  titleZh: z.string().trim().min(1).max(80).optional(),
  icon: pluginIconSchema.optional(),
}).strict();
export type PluginContribution = z.infer<typeof pluginContributionSchema>;

export const pluginManifestSchema = z.object({
  schemaVersion: z.literal(PLUGIN_MANIFEST_VERSION),
  id: z.string().min(3).max(80).regex(/^[a-z0-9][a-z0-9._-]{1,78}[a-z0-9]$/),
  name: z.string().trim().min(1).max(80),
  nameZh: z.string().trim().min(1).max(80).optional(),
  version: z.string().trim().min(1).max(32).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().trim().min(1).max(320),
  descriptionZh: z.string().trim().min(1).max(320).optional(),
  icon: pluginIconSchema.default("puzzle"),
  source: z.object({
    repository: z.string().trim().min(1).max(256),
    commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/i),
  }).strict(),
  artifact: z.object({
    sha256: z.string().trim().regex(/^[0-9a-f]{64}$/i),
    sizeBytes: z.number().int().positive().max(64 * 1024 * 1024),
  }).strict(),
  attribution: z.object({
    author: z.string().trim().min(1).max(120),
    license: z.string().trim().min(1).max(64),
    homepage: z.string().trim().max(256).optional(),
    notice: z.string().trim().max(512).optional(),
  }).strict().optional(),
  entry: z.string().trim().min(1).max(160).refine(
    (value) => !value.startsWith("/") && !value.includes("..") && !/^[a-zA-Z]+:/.test(value),
    "entry_must_be_relative",
  ),
  platforms: z.array(pluginPlatformSchema).min(1).max(2),
  contributions: z.array(pluginContributionSchema).min(1).max(8),
  domains: z.array(z.string().trim().min(1).max(160)).max(32),
  capabilities: z.array(pluginCapabilitySchema).max(16),
  requiresHost: z.boolean().default(false),
  official: z.boolean(),
}).strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

const binaryPayload = z.instanceof(Uint8Array).refine(value => value.byteLength <= 32 * 1024 * 1024);
const canvasRequest = { protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64) };
const canvasDataKey = z.string().min(1).max(256);
export const pluginHostRequestSchema = z.discriminatedUnion("method", [
  z.object({ ...canvasRequest, method: z.literal("canvas.nodes.list") }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.nodes.enable"), enabled: z.boolean() }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.nodes.install"), url: z.string().min(1).max(1024) }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.nodes.remove"), pluginId: z.string().min(1).max(128) }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.nodes.render"), pluginId: z.string().min(1).max(128),
    node: z.object({ text: z.string().max(16384), title: z.string().max(160).optional() }).strict() }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.data.get"), key: canvasDataKey }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.data.put"), key: canvasDataKey, value: binaryPayload }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.data.remove"), key: canvasDataKey }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.data.keys") }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.provider.request"), url: z.string().url().max(1024),
    httpMethod: z.enum(["GET", "POST"]), headers: z.object({ authorization: z.string().max(16384).optional(), accept: z.string().max(256).optional(), "content-type": z.string().max(256).optional() }).strict(), body: binaryPayload.optional() }).strict(),
  z.object({ ...canvasRequest, method: z.literal("canvas.prompts.request"), url: z.string().url().max(1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("host.hello") }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("theme.get") }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.get"), key: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.set"), key: z.string().min(1).max(128), value: z.string().max(4 * 1024 * 1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.remove"), key: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.list") }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.clear") }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("credentials.get"), key: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("credentials.set"), key: z.string().min(1).max(128), value: z.string().max(16 * 1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("credentials.remove"), key: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("clipboard.write"), text: z.string().max(64 * 1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("workbench.status") }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("workspace.export"), filename: z.string().trim().min(1).max(200), content: z.union([z.string().max(16 * 1024 * 1024), binaryPayload]), mime: z.string().trim().min(1).max(128).optional() }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("domains.request"), domain: z.string().trim().min(1).max(256), reason: z.string().trim().max(256).optional() }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("canvas.agent.connect"), clientId: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("canvas.agent.disconnect"), clientId: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("canvas.agent.state"), clientId: z.string().min(1).max(128), snapshot: z.object({ projectId: z.string().max(128), title: z.string().max(256) }).nullable() }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("canvas.agent.activate"), clientId: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("canvas.agent.result"), clientId: z.string().min(1).max(128), requestId: z.string().min(1).max(128), result: z.unknown().optional(), error: z.object({ code: z.string().max(128), message: z.string().max(512) }).optional() }).strict(),
]);
export type PluginHostRequest = z.infer<typeof pluginHostRequestSchema>;

export const pluginHostResponseSchema = z.object({
  protocol: z.literal(PLUGIN_HOST_PROTOCOL),
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(128).optional(),
}).strict();
export type PluginHostResponse = z.infer<typeof pluginHostResponseSchema>;

export function requiredCapabilityForMethod(method: PluginHostRequest["method"]): PluginCapability | null {
  switch (method) {
    case "host.hello":
      return null;
    case "theme.get":
      return "theme.read";
    case "storage.get":
    case "storage.set":
    case "storage.remove":
    case "storage.list":
    case "storage.clear":
    case "canvas.nodes.list":
    case "canvas.nodes.enable":
    case "canvas.nodes.install":
    case "canvas.nodes.remove":
    case "canvas.nodes.render":
    case "canvas.data.get":
    case "canvas.data.put":
    case "canvas.data.keys":
    case "canvas.data.remove":
      return "storage.device";
    case "credentials.get":
    case "credentials.set":
    case "credentials.remove":
      return "credentials.device";
    case "workspace.export":
      return "files.export";
    case "canvas.provider.request":
    case "canvas.prompts.request":
    case "domains.request":
      return "network.domains";
    case "clipboard.write":
      return "clipboard.write";
    case "workbench.status":
      return "workbench.canvas";
    case "canvas.agent.connect":
    case "canvas.agent.disconnect":
    case "canvas.agent.state":
    case "canvas.agent.activate":
    case "canvas.agent.result":
      return "canvas.agent";
  }
}

export type PluginCryptoBackend = {
  sha256(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
};

let registeredCryptoBackend: PluginCryptoBackend | undefined;

export function registerPluginCryptoBackend(backend: PluginCryptoBackend | undefined): void {
  registeredCryptoBackend = backend;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  if (registeredCryptoBackend) {
    return bytesToHex(await registeredCryptoBackend.sha256(bytes));
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("plugin_crypto_unavailable");
  }
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyPluginArtifactHash(content: string | Uint8Array, expectedSha256: string): Promise<boolean> {
  const actual = await sha256Hex(content);
  return actual.toLowerCase() === expectedSha256.trim().toLowerCase();
}

export function comparePluginVersions(a: string, b: string): number {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function formatPluginSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
