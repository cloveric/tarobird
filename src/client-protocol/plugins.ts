import { z } from "zod";

export const PLUGIN_MANIFEST_VERSION = 1 as const;
export const PLUGIN_HOST_PROTOCOL = "tarobird.plugin.v1" as const;

/** Canonical Ed25519 SPKI public key (base64) used to verify official TaroBird plugin manifests.
 * Single source of truth shared between protocol, client registry, and tests.
 * When #176 replaces the placeholder Infinite Canvas stub with its on-demand build artifact,
 * update this single constant alongside the re-signed official catalog entries. */
export const OFFICIAL_PLUGIN_PUBLIC_KEY = "MCowBQYDK2VwAyEA7/nusIR2Ti+6dCmyfncq80Vgcxmlx4Cp751ViG3P7vk=";

export const pluginPlatformSchema = z.enum(["desktop", "phone"]);
export type PluginPlatform = z.infer<typeof pluginPlatformSchema>;

export const pluginCapabilitySchema = z.enum([
  "theme.read",
  "storage.device",
  "clipboard.write",
  "workbench.canvas",
  "chat.draft",
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
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.set"), key: z.string().min(1).max(128), value: z.string().max(256 * 1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("storage.remove"), key: z.string().min(1).max(128) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("clipboard.write"), text: z.string().max(64 * 1024) }).strict(),
  z.object({ protocol: z.literal(PLUGIN_HOST_PROTOCOL), id: z.string().min(1).max(64), method: z.literal("workbench.status") }).strict(),
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
      return "storage.device";
    case "clipboard.write":
      return "clipboard.write";
    case "workbench.status":
      return "workbench.canvas";
  }
}

export function canonicalPluginSignaturePayload(manifest: PluginManifest): string {
  const canonicalContributions = [...manifest.contributions]
    .map((item) => [
      item.kind,
      item.id,
      item.title,
      item.titleZh ?? null,
      item.icon ?? null,
    ] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return JSON.stringify([
    "tarobird/plugin-manifest/v1",
    manifest.schemaVersion,
    manifest.id,
    manifest.name,
    manifest.nameZh ?? null,
    manifest.version,
    manifest.description,
    manifest.descriptionZh ?? null,
    manifest.icon,
    manifest.source.repository,
    manifest.source.commit.toLowerCase(),
    manifest.artifact.sha256.toLowerCase(),
    manifest.artifact.sizeBytes,
    manifest.entry,
    [...manifest.platforms].sort(),
    canonicalContributions,
    [...manifest.domains].sort(),
    [...manifest.capabilities].sort(),
    manifest.requiresHost,
    manifest.official,
  ]);
}

const ED25519_SPKI_PREFIX = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

export type PluginCryptoBackend = {
  sha256(bytes: Uint8Array): Uint8Array | Promise<Uint8Array>;
  verifyEd25519(publicKeySpkiBase64: string, signatureBase64: string, payload: Uint8Array): boolean | Promise<boolean>;
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

export async function verifyOfficialPluginSignature(manifest: PluginManifest, publicKeySpkiBase64: string): Promise<boolean> {
  if (!manifest.artifact.signature) return false;
  const payload = new TextEncoder().encode(canonicalPluginSignaturePayload(manifest));
  if (registeredCryptoBackend) {
    try {
      return Boolean(await registeredCryptoBackend.verifyEd25519(publicKeySpkiBase64, manifest.artifact.signature, payload));
    } catch {
      return false;
    }
  }
  if (!globalThis.crypto?.subtle) return false;
  try {
    const spki = base64ToBytes(publicKeySpkiBase64.trim());
    if (spki.length !== 44 || ED25519_SPKI_PREFIX.some((byte, index) => spki[index] !== byte)) {
      return false;
    }
    const sig = base64ToBytes(manifest.artifact.signature.trim());
    if (sig.length !== 64) return false;
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      spki,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const payloadCopy = new Uint8Array(new ArrayBuffer(payload.byteLength));
    payloadCopy.set(payload);
    return await globalThis.crypto.subtle.verify(
      "Ed25519",
      key,
      sig,
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
