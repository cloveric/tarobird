import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { voiceRoutingModeSchema } from "../client-protocol/voice-settings.js";

const receiptSchema = z.object({ requestId: z.string(), digest: z.string(), revision: z.string(), at: z.number(), actor: z.string() });
const policyFields = {
  revision: z.string(), directory: z.string(),
  thresholdSeconds: z.number().int().min(60).max(7200), receipts: z.array(receiptSchema).max(32),
};
export const hostVoicePolicySchema = z.union([
  z.object({ ...policyFields, format: z.literal(2), mode: voiceRoutingModeSchema }).strict(),
  z.object({ ...policyFields, format: z.literal(1), enabled: z.boolean() }).strict().transform(({ enabled, ...policy }) => ({
    ...policy, format: 2 as const, mode: enabled ? "auto" as const : "local" as const,
  })),
]);
export type HostVoicePolicy = z.infer<typeof hostVoicePolicySchema>;
export const voicePolicyFile = (hostDir: string) => path.join(hostDir, "voice-settings.json");

/** Legacy configuration is case-insensitive; unknown explicit modes must not
 * grant upload permission. An absent mode preserves threshold-based routing. */
export function legacyVoiceMode(mode: string | undefined, directory: string | undefined): "local" | "cloud" | "auto" {
  if (!directory?.trim()) return "local";
  const normalized = mode?.trim().toLowerCase();
  return !normalized ? "auto" : normalized === "auto" || normalized === "cloud" ? normalized : "local";
}

export class VoicePolicyReadError extends Error {
  constructor(readonly reason: "file" | "permissions" | "oversized" | "format" | "future" | "unreadable") { super(`voice_settings_unavailable_${reason}`); }
}

/** A tiny bounded, private, regular file. Missing means legacy configuration;
 * unreadable/corrupt is different and must never re-enable an old cloud route. */
export function readHostVoicePolicy(hostDir: string): HostVoicePolicy | undefined {
  let fd: number;
  let expected;
  try {
    const file = voicePolicyFile(hostDir);
    expected = lstatSync(file);
    if (!expected.isFile() || expected.isSymbolicLink()) throw new VoicePolicyReadError("file");
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error instanceof VoicePolicyReadError ? error : new VoicePolicyReadError("unreadable"); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev) throw new VoicePolicyReadError("file");
    if (info.size > 32768) throw new VoicePolicyReadError("oversized");
    if (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077))) throw new VoicePolicyReadError("permissions");
    const bytes = Buffer.alloc(32769);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 32768) throw new VoicePolicyReadError("oversized");
    const data = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (typeof data?.format === "number" && data.format > 2) throw new VoicePolicyReadError("future");
    return hostVoicePolicySchema.parse(data);
  } catch (error) { throw error instanceof VoicePolicyReadError ? error : new VoicePolicyReadError("format"); }
  finally { closeSync(fd); }
}

/** Only a Hub-launched worker supplies TAROBOT_HOST_DIR. Read on each new
 * transcription and prompt, so saving never restarts an active task. */
export function hostVoiceEnvironment<T extends { TAROBOT_HOST_DIR?: string; TINGWU_ASR_DIR?: string; ASR_CLOUD_THRESHOLD_SECONDS?: string; ASR_CLOUD_MODE?: string }>(env: T): T {
  if (!env.TAROBOT_HOST_DIR) return env;
  try {
    const policy = readHostVoicePolicy(env.TAROBOT_HOST_DIR);
    if (!policy) return env;
    return { ...env, TINGWU_ASR_DIR: policy.mode !== "local" ? policy.directory : "", ASR_CLOUD_MODE: policy.mode, ASR_CLOUD_THRESHOLD_SECONDS: String(policy.thresholdSeconds) };
  } catch {
    // Preserve local transcription if policy is damaged; never guess permission
    // to upload audio. The settings GET reports the explicit diagnostic.
    return { ...env, TINGWU_ASR_DIR: "" };
  }
}
