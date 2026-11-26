import { z } from "zod";

export const PLUGIN_MANIFEST_VERSION = 1 as const;
export const PLUGIN_HOST_PROTOCOL = "tarobird.plugin.v1" as const;

export const pluginPlatformSchema = z.enum(["desktop", "phone"]);
export type PluginPlatform = z.infer<typeof pluginPlatformSchema>;

export const pluginCapabilitySchema = z.enum([
  "theme.read",
  "storage.device",
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
    signature: z.string().trim().min(16).max(512).optional(),
    url: z.string().trim().min(1).max(1024).refine(
      (value) => value.startsWith("/") || /^https?:\/\//i.test(value),
      "artifact_url_invalid",
    ).optional(),
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

export const pluginHostRequestSchema = z.discriminatedUnion("method", [
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
    case "credentials.get":
    case "credentials.set":
    case "credentials.remove":
      return "storage.device";
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

export function canonicalPluginSignaturePayload(manifest: PluginManifest): string {
  return JSON.stringify([
    "tarobird/plugin-manifest/v1",
    manifest.id,
    manifest.version,
    manifest.source.repository,
    manifest.source.commit.toLowerCase(),
    manifest.artifact.sha256.toLowerCase(),
    manifest.artifact.sizeBytes,
    manifest.entry,
    [...manifest.platforms].sort(),
    [...manifest.domains].sort(),
    [...manifest.capabilities].sort(),
    manifest.requiresHost,
    manifest.official,
  ]);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (typeof Buffer !== "undefined") {
    const raw = Buffer.from(value, "base64");
    const copy = new Uint8Array(new ArrayBuffer(raw.byteLength));
    copy.set(raw);
    return copy;
  }
  const binary = atob(value);
  const copy = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) copy[i] = binary.charCodeAt(i);
  return copy;
}

export async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyPluginArtifactHash(content: string | Uint8Array, expectedSha256: string): Promise<boolean> {
  const actual = await sha256Hex(content);
  return actual.toLowerCase() === expectedSha256.trim().toLowerCase();
}

export async function verifyOfficialPluginSignature(manifest: PluginManifest, publicKeySpkiBase64: string): Promise<boolean> {
  if (!manifest.artifact.signature) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      base64ToBytes(publicKeySpkiBase64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const payload = new TextEncoder().encode(canonicalPluginSignaturePayload(manifest));
    const payloadCopy = new Uint8Array(new ArrayBuffer(payload.byteLength));
    payloadCopy.set(payload);
    return await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      base64ToBytes(manifest.artifact.signature),
      payloadCopy,
    );
  } catch {
    return false;
  }
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
