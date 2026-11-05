import { z } from "zod";
import type { EngineApprovalDecision, EngineApprovalScopes } from "./adapter.js";

// Installed Codex 0.159.3 PermissionsRequestApprovalParams. Never strip unknown
// permission constraints: an unsupported profile must receive no grant.
const text = z.string().min(1).max(4096);
const specialPath = z.union([
  z.object({ kind: z.enum(["root", "minimal", "tmpdir", "slash_tmp"]) }).strict(),
  z.object({ kind: z.literal("project_roots"), subpath: text.nullish() }).strict(),
  z.object({ kind: z.literal("unknown"), path: text, subpath: text.nullish() }).strict(),
]);
const filePath = z.discriminatedUnion("type", [
  z.object({ type: z.literal("path"), path: text }).strict(),
  z.object({ type: z.literal("glob_pattern"), pattern: text }).strict(),
  z.object({ type: z.literal("special"), value: specialPath }).strict(),
]);
const permissions = z.object({
  fileSystem: z.object({
    entries: z.array(z.object({ path: filePath, access: z.enum(["read", "write", "deny"]) }).strict()).max(128).nullish(),
    globScanMaxDepth: z.number().int().positive().nullish(),
    read: z.array(text).max(128).nullish(), write: z.array(text).max(128).nullish(),
  }).strict().nullish(),
  network: z.object({ enabled: z.boolean().nullish() }).strict().nullish(),
}).strict();
const requestSchema = z.object({
  threadId: text, turnId: text, itemId: text, cwd: text,
  environmentId: text.nullish(), reason: z.string().max(4096).nullish(),
  startedAtMs: z.number().int(), permissions,
});

export const deniedCodexPermissions = () => ({ permissions: {}, scope: "turn" as const });

export function normalizeCodexPermissions(value: unknown) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const request = parsed.data;
  const toolInput = { reason: request.reason, cwd: request.cwd, environmentId: request.environmentId, permissions: request.permissions };
  // The shared approval card has a 16k UTF-8 element budget. Do not offer an
  // approval button for a profile whose complete details would be truncated.
  if (Buffer.byteLength(JSON.stringify(toolInput, null, 2), "utf8") > 14_000) return undefined;
  const granted = JSON.stringify(request.permissions);
  return {
    threadId: request.threadId, turnId: request.turnId, itemId: request.itemId,
    cwd: request.cwd, toolInput,
    toolName: "Codex additional permissions",
    approvalScopes: { once: "turn", session: "session" } satisfies EngineApprovalScopes,
    response(decision: EngineApprovalDecision) {
      // Ignore updatedInput: users approve exactly the displayed native profile,
      // not a callback-supplied replacement or an adapter-created superset.
      return decision.behavior === "allow"
        ? { permissions: JSON.parse(granted) as z.infer<typeof permissions>, scope: decision.scope === "session" ? "session" as const : "turn" as const }
        : deniedCodexPermissions();
    },
  };
}
