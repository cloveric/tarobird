import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { channelProfile } from "./channel-profile.js";
import { MAX_FILE_BYTES } from "../client-protocol/index.js";

import { isCredentialStylePath } from "../runtime/credential-files.js";
import { appAnyFilePathAllowed } from "./file-send-policy.js";

export type CoreSendPathKind = "file" | "image" | "audio" | "video";
export type CoreSendToolName = "send.file" | "send.image" | "send.audio" | "send.video" | "send.batch";
export type CoreFileRejectReason =
  | "outside-workspace"
  | "credentials-file"
  | "not-found"
  | "permission-denied"
  | "read-error"
  | "too-large"
  | "batch-too-large"
  | "upload-failed"
  | "delivery-uncertain";

// Feishu documents a 30 MB bot-file limit, but the upload endpoint used by the
// SDK rejects payloads once the file itself crosses roughly 26 MiB. Keep the
// preflight boundary at the verified limit so the agent can repair the output
// before the user sees an opaque HTTP 400 / code 9499 failure.
export const CORE_FILE_UPLOAD_MAX_BYTES = 26 * 1024 * 1024;
export const CORE_BATCH_UPLOAD_MAX_BYTES = 120 * 1024 * 1024;

export interface CoreDeliveryPreflightInput {
  stateDir?: string;
  requestOutputDir?: string;
  workspaceOverride?: string;
  allowAnyAbsolutePath?: boolean;
  /** Compatibility hook for focused unit tests that supply one explicit root. */
  explicitAllowedRoots?: readonly string[];
}

export interface ResolvedCoreDeliveryRoots {
  allowedRoots: string[];
  workspaceRoot?: string;
  allowAnyAbsolutePath: boolean;
}

export type CorePathPreflightResult =
  | {
      ok: true;
      realPath: string;
      fileIdentity: string;
      fileBytes: number;
      workspaceRoot?: string;
    }
  | {
      ok: false;
      reason: Exclude<CoreFileRejectReason, "batch-too-large" | "upload-failed" | "delivery-uncertain">;
      realPath?: string;
      detail?: string;
      fileBytes?: number;
      workspaceRoot?: string;
    };

export interface CoreSendArtifact {
  path: string;
  kind: CoreSendPathKind;
  caption?: string;
}

export type NormalizedCoreSendTool =
  | {
      ok: true;
      artifacts: CoreSendArtifact[];
      message: string;
    }
  | {
      ok: false;
      reason: "requires_path" | "string_array" | "file_entries" | "image_entries";
      field?: string;
    };

const SEND_TOOL_NAMES: ReadonlySet<string> = new Set([
  "send.file",
  "send.image",
  "send.audio",
  "send.video",
  "send.batch",
]);

const LARK_BATCH_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
]);

export function isCoreSendToolName(name: string): name is CoreSendToolName {
  return SEND_TOOL_NAMES.has(name);
}

/**
 * Parse exactly the artifact shapes understood by the real Lark sender. Both
 * delivery and the follow-up guard use this function so the protocol cannot
 * drift into two subtly different implementations again.
 */
export function normalizeCoreSendTool(name: CoreSendToolName, payload: unknown): NormalizedCoreSendTool {
  const record = payloadObject(payload);
  if (name !== "send.batch") {
    const filePath = typeof record?.path === "string" ? record.path.trim() : "";
    if (!filePath) {
      return { ok: false, reason: "requires_path" };
    }
    const kind = name.slice("send.".length) as CoreSendPathKind;
    const caption = typeof record?.caption === "string" && record.caption.trim()
      ? record.caption.trim()
      : undefined;
    return {
      ok: true,
      artifacts: [{ path: filePath, kind, ...(caption ? { caption } : {}) }],
      message: "",
    };
  }

  const invalidField = invalidStringArrayField(record, ["audios", "videos"]);
  if (invalidField) {
    return { ok: false, reason: "string_array", field: invalidField };
  }
  const fileEntries = normalizeCoreBatchPathEntries(record?.files);
  if (fileEntries === null) {
    return { ok: false, reason: "file_entries", field: "files" };
  }
  const imageEntries = normalizeCoreBatchPathEntries(record?.images);
  if (imageEntries === null) {
    return { ok: false, reason: "image_entries", field: "images" };
  }

  const artifacts: CoreSendArtifact[] = imageEntries.map((image) => ({
    path: image.path,
    kind: "image",
    ...(image.caption ? { caption: image.caption } : {}),
  }));
  for (const file of fileEntries) {
    // Models occasionally put generated PNG/JPEG paths under `files`, which
    // makes Feishu fan them out as download bubbles. Batch image paths are
    // unambiguous enough to repair here; explicit send.file keeps file semantics.
    const kind = LARK_BATCH_IMAGE_EXTENSIONS.has(path.extname(file.path).toLowerCase())
      ? "image"
      : "file";
    artifacts.push({
      path: file.path,
      kind,
      ...(file.caption ? { caption: file.caption } : {}),
    });
  }
  for (const filePath of stringArray(record?.audios)) {
    artifacts.push({ path: filePath, kind: "audio" });
  }
  for (const filePath of stringArray(record?.videos)) {
    artifacts.push({ path: filePath, kind: "video" });
  }
  return {
    ok: true,
    artifacts,
    message: typeof record?.message === "string" ? record.message : "",
  };
}

export function extractWholeResponseFileBlock(text: string): { fileName: string; body: string } | null {
  const fileMatch = text.match(/```file:([^\n`]+)\n([\s\S]*?)```/u);
  if (!fileMatch || text.replace(fileMatch[0], "").trim().length > 0) {
    return null;
  }
  const fileName = path.basename((fileMatch[1] ?? "").trim());
  const body = fileMatch[2] ?? "";
  if (!fileName || Buffer.byteLength(body, "utf8") === 0) {
    return null;
  }
  return { fileName, body };
}

export function preflightCoreInlineFile(
  file: { fileName: string; body: string },
): { ok: true; fileBytes: number } | { ok: false; reason: "credentials-file" | "too-large"; fileBytes: number } {
  const fileBytes = Buffer.byteLength(file.body, "utf8");
  if (isCredentialStylePath(file.fileName)) {
    return { ok: false, reason: "credentials-file", fileBytes };
  }
  if (fileBytes > (channelProfile() === "gateway" ? MAX_FILE_BYTES : CORE_FILE_UPLOAD_MAX_BYTES)) {
    return { ok: false, reason: "too-large", fileBytes };
  }
  return { ok: true, fileBytes };
}

export async function resolveCoreDeliveryRoots(
  input: CoreDeliveryPreflightInput,
): Promise<ResolvedCoreDeliveryRoots> {
  const workspaceRoot = input.stateDir
    ? await resolveRoot(path.join(input.stateDir, "workspace"))
    : undefined;
  const candidates = [
    workspaceRoot,
    input.requestOutputDir ? await resolveRoot(input.requestOutputDir) : undefined,
    input.workspaceOverride ? await resolveRoot(input.workspaceOverride) : undefined,
    ...(input.explicitAllowedRoots
      ? await Promise.all(input.explicitAllowedRoots.map(async (root) => await resolveRoot(root)))
      : []),
    ...(input.stateDir ? [await codexGeneratedImagesRoot()] : []),
  ].filter((root): root is string => Boolean(root));

  return {
    allowedRoots: [...new Set(candidates)],
    ...(workspaceRoot ? { workspaceRoot } : {}),
    allowAnyAbsolutePath: channelProfile() === "gateway"
      ? await appAnyFilePathAllowed(input.stateDir)
      : input.allowAnyAbsolutePath === true || coreAnyFilePathAllowed(),
  };
}

/** The exact local checks applied before the sender reads and uploads a path. */
export async function preflightCoreDeliveryPath(
  rawPath: string,
  roots: ResolvedCoreDeliveryRoots,
): Promise<CorePathPreflightResult> {
  const candidate = rawPath.trim();
  if (!candidate) {
    return { ok: false, reason: "not-found", workspaceRoot: roots.workspaceRoot };
  }

  let realPath: string;
  try {
    realPath = await realpath(candidate);
  } catch (error) {
    return {
      ok: false,
      reason: coreFileRejectReasonFromError(error),
      detail: errorDetail(error),
      workspaceRoot: roots.workspaceRoot,
    };
  }
  if (isCredentialStylePath(candidate, realPath)) {
    return {
      ok: false,
      reason: "credentials-file",
      realPath,
      workspaceRoot: roots.workspaceRoot,
    };
  }
  if (
    !(roots.allowAnyAbsolutePath && path.isAbsolute(candidate))
    && !roots.allowedRoots.some((root) => pathIsWithin(realPath, root))
  ) {
    return {
      ok: false,
      reason: "outside-workspace",
      realPath,
      workspaceRoot: roots.workspaceRoot,
    };
  }

  try {
    const fileStat = await stat(realPath);
    if (!fileStat.isFile()) {
      return {
        ok: false,
        reason: "read-error",
        realPath,
        detail: "path is not a regular file",
        workspaceRoot: roots.workspaceRoot,
      };
    }
    if (fileStat.size > (channelProfile() === "gateway" ? MAX_FILE_BYTES : CORE_FILE_UPLOAD_MAX_BYTES)) {
      return {
        ok: false,
        reason: "too-large",
        realPath,
        detail: `${fileStat.size} bytes > ${CORE_FILE_UPLOAD_MAX_BYTES}`,
        fileBytes: fileStat.size,
        workspaceRoot: roots.workspaceRoot,
      };
    }
    return {
      ok: true,
      realPath,
      fileIdentity: fileStat.ino > 0
        ? `inode:${fileStat.dev}:${fileStat.ino}`
        : `path:${canonicalPathKey(realPath)}`,
      fileBytes: fileStat.size,
      workspaceRoot: roots.workspaceRoot,
    };
  } catch (error) {
    return {
      ok: false,
      reason: coreFileRejectReasonFromError(error),
      realPath,
      detail: errorDetail(error),
      workspaceRoot: roots.workspaceRoot,
    };
  }
}

function canonicalPathKey(filePath: string): string {
  const normalized = filePath.normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeCoreBatchPathEntries(value: unknown): Array<{ path: string; caption?: string }> | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: Array<{ path: string; caption?: string }> = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      if (!entry.trim()) {
        return null;
      }
      out.push({ path: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const pathValue = (entry as { path?: unknown }).path;
    if (typeof pathValue !== "string" || !pathValue.trim()) {
      return null;
    }
    const captionRaw = (entry as { caption?: unknown }).caption;
    const caption = typeof captionRaw === "string" && captionRaw.trim() ? captionRaw.trim() : undefined;
    out.push(caption ? { path: pathValue, caption } : { path: pathValue });
  }
  return out;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function invalidStringArrayField(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const value = payload[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      return key;
    }
  }
  return null;
}

async function resolveRoot(root: string): Promise<string> {
  return await realpath(root).catch(() => path.resolve(root));
}

function pathIsWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function coreAnyFilePathAllowed(): boolean {
  return /^(?:1|true|yes|on)$/i.test((process.env.TAROBOT_ALLOW_ANY_FILE_PATH ?? process.env.CCTB_LARK_ALLOW_ANY_FILE_PATH ?? "").trim());
}

async function codexGeneratedImagesRoot(): Promise<string | undefined> {
  const home = (process.env.CODEX_HOME ?? "").trim()
    || (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  if (!home) {
    return undefined;
  }
  try {
    return await realpath(path.join(home, "generated_images"));
  } catch {
    return undefined;
  }
}

function coreFileRejectReasonFromError(
  error: unknown,
): "not-found" | "permission-denied" | "read-error" {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  if (code === "ENOENT") {
    return "not-found";
  }
  if (code === "EACCES" || code === "EPERM") {
    return "permission-denied";
  }
  return "read-error";
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
