import { z } from "zod";
import { createSideDeliveryTools, type SideDeliveryBudget } from "./side-delivery.js";
import type { GatewayChannel } from "./channel.js";
import type { SideScope } from "../client-protocol/side.js";
import path from "node:path";
import { CoreSideSessions, SideSessionError, sideErrorCode } from "../core/side-sessions.js";
import { materializeSideAttachments, releaseSideAttachments, sweepSideAttachments } from "../core/side-attachments.js";
import { workspaceArtifactRoot } from "../core/artifact-paths.js";
import { idSchema } from "../client-protocol/index.js";
import { SIDE_ATTACHMENT_COUNT_LIMIT, SIDE_ATTACHMENT_FILE_BYTES, SIDE_ATTACHMENT_IMAGE_BYTES, SIDE_ATTACHMENT_TOTAL_BYTES, SIDE_QUESTION_LIMIT, sideAttachmentRefSchema, sideScopeSchema, type SideCapabilityView } from "../client-protocol/side.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import type { CoreBridgeLike } from "../core/types.js";
import { loadInstanceConfig, readValidatedConfigFile, resolveInstanceWorkspacePath } from "../state/instance-config.js";
import { checkBudgetAvailability, recordBridgeTurnUsage } from "../runtime/bridge-turn.js";
import { appendTimelineEventBestEffort } from "../runtime/timeline-events.js";
import { transcribeSideAudio, type SideTranscribe } from "./side-audio.js";

const SIDE_LEASE_SWEEP_MARGIN_MS = 10 * 60_000;

export type SideAttachmentDownload = (attachmentId: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
/** Streams one Hub attachment through this Bot's own instance credentials. */
export function instanceAttachmentDownload(transport: { httpUrl: string; authHeader: string }): SideAttachmentDownload {
  return async (attachmentId, signal) => {
    // The instance route rechecks that this Bot belongs to the file's conversation.
    const response = await fetch(`${transport.httpUrl}/api/instance/attachments/${encodeURIComponent(attachmentId)}`, { headers: { authorization: transport.authHeader }, signal });
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new SideSessionError("attachment_unavailable"); }
    return response.body;
  };
}

export function gatewaySideSessions(bridge: CoreBridgeLike, stateDir: string, botId: string, bindingReady: (conversationId: string) => Promise<boolean>, download?: SideAttachmentDownload, transcribe?: SideTranscribe, channel?: Pick<GatewayChannel, "uploadSideArtifact"> & Partial<Pick<GatewayChannel, "conversationWorkspace">>) {
  // Private copies sit beside ordinary inbound files, under per-handle names
  // that never collide with message directories; Hub uploads are untouched.
  const attachmentRoot = workspaceArtifactRoot(stateDir, "input", "gateway");
  void sweepSideAttachments(attachmentRoot, 2 * 60 * 60_000 + SIDE_LEASE_SWEEP_MARGIN_MS);
  const config = async () => {
    const cfg = await loadInstanceConfig(stateDir), raw = await readValidatedConfigFile(path.join(stateDir, "config.json"), { forExecution: true });
    return { ...cfg, approvalMode: raw.approvalMode, claudePermissionMode: raw.claudePermissionMode };
  };
  let fingerprint: string | undefined;
  const signature = (value: Awaited<ReturnType<typeof config>>) => JSON.stringify([value.engine, value.model, value.effort, value.approvalMode, value.claudePermissionMode]);
  const scopeKey = (scope: SideScope) => `${scope.userId}:${scope.deviceId}:${scope.conversationId}`;
  const sessionWorkspaces = new Map<string, string | undefined>();
  const conversationWorkspace = async (conversationId: string, cfg: Awaited<ReturnType<typeof config>>) =>
    (await channel?.conversationWorkspace?.(conversationId)) ?? resolveInstanceWorkspacePath(cfg);
  let sessions: CoreSideSessions;
  const deliveryBudgets = new WeakMap<SideScope, SideDeliveryBudget>();
  const create = () => new CoreSideSessions({
    open: async (scope, abortSignal, tools) => {
      // A newly selected native session is applied by the main queue. A side
      // question must not silently borrow the previous, stale parent binding.
      if (!await bindingReady(scope.conversationId)) throw new SideSessionError("no_main_session");
      const cfg = await config(), conversationKey = buildCoreConversationKey(scope.conversationId);
      if (!bridge.openSideSession) throw new SideSessionError("unsupported");
      const workspaceOverride = await conversationWorkspace(scope.conversationId, cfg);
      sessionWorkspaces.set(scopeKey(scope), workspaceOverride);
      return bridge.openSideSession({ chatId: stableCoreNumericId(conversationKey), conversationKey, userId: stableCoreNumericId(`user:gwuser_${scope.userId}`), chatType: "bus", locale: cfg.locale, workspaceOverride, ...(tools === "inherited" ? { tools } : {}), abortSignal });
    },
    ...(channel ? { deliveryTools: async (scope: SideScope, _sideId: string, _requestId: string, signal: AbortSignal, publish: Parameters<typeof createSideDeliveryTools>[0]["publish"]) => {
      const cfg = await config();
      if (signature(cfg) !== fingerprint) throw new SideSessionError("expired");
      const workspaceOverride = await conversationWorkspace(scope.conversationId, cfg);
      const key = scopeKey(scope);
      if (sessionWorkspaces.has(key) && sessionWorkspaces.get(key) !== workspaceOverride) throw new SideSessionError("expired");
      let budget = deliveryBudgets.get(scope);
      if (!budget) { budget = { bytes: 0, files: 0 }; deliveryBudgets.set(scope, budget); }
      return createSideDeliveryTools({ channel, stateDir, workspaceOverride, conversationId: scope.conversationId, signal, budget, publish });
    } } : {}),
    beforeAsk: async (scope) => {
      const cfg = await config();
      if (signature(cfg) !== fingerprint) throw new SideSessionError("expired");
      const key = scopeKey(scope);
      if (sessionWorkspaces.has(key) && sessionWorkspaces.get(key) !== await conversationWorkspace(scope.conversationId, cfg)) {
        throw new SideSessionError("expired");
      }
      if (await checkBudgetAvailability(stateDir, cfg.budgetUsd, cfg.locale)) throw new SideSessionError("budget_exhausted");
    },
    ...(download ? {
      prepareAttachments: async (scope, sideId, requestId, refs, signal) => {
        const files = await materializeSideAttachments({ directory: path.join(attachmentRoot, sideId, requestId), refs, download, signal });
        if (!transcribe) return files;
        // The question carries the same 强制云端/本地转写 overrides as a main message.
        const question = () => { try { return sessions.read(scope, sideId).view?.exchanges.find(exchange => exchange.id === requestId)?.question; } catch { return undefined; } };
        return transcribeSideAudio({ files, refs, transcribe, stateDir, question, signal });
      },
      releaseAttachments: (sideId, requestId) => releaseSideAttachments(attachmentRoot, sideId, requestId),
    } : {}),
    record: async (scope, usage, outcome) => {
      const cfg = await config(), recorded = await recordBridgeTurnUsage(stateDir, usage, cfg.budgetUsd);
      await appendTimelineEventBestEffort(stateDir, { type: "command.handled", instanceName: botId, channel: "gateway", conversationKey: buildCoreConversationKey(scope.conversationId), outcome, detail: "/side", metadata: { command: "side", reachedBudget: recorded?.reachedBudget ?? false } });
    },
  });
  sessions = create();
  const nativeCapability = async (conversationId: string, tools?: "inherited") => {
    const cfg = await config();
    return { cfg, native: bridge.sideCapability?.({ workspaceOverride: await conversationWorkspace(conversationId, cfg), ...(tools ? { tools } : {}) }) };
  };
  /** attachments/audio: only for callers that opted in; strict older clients reject unknown keys.
   * audio reports this Gateway's ASR step; transcripts reach every engine as text. */
  const capability = async (conversationId: string, attachments = false, audio = false, tools?: "inherited", delivery = false): Promise<SideCapabilityView> => {
    const { cfg, native } = await nativeCapability(conversationId, tools);
    const supported = !!bridge.openSideSession && native?.context === "native" && (native.readOnly !== "advisory" || tools === "inherited" && native.toolAccess === "inherited") && native.residue !== "residual";
    const files = supported && attachments && download ? native?.attachments : undefined;
    return { supported, concurrent: native?.concurrent ?? false, liveContext: native?.seesInProgressTurn ?? false, tools: tools === "inherited" && native?.toolAccess === "inherited" ? "inherited" : native?.readOnly === "enforced" ? "read-only" : "none", ...(cfg.engine === "claude" ? { usage: "unavailable" as const } : {}),
      ...(supported && delivery && channel && tools === "inherited" && native?.delivery ? { delivery: true as const } : {}),
      ...(files ? { attachments: { images: files.images, files: files.files, maxCount: SIDE_ATTACHMENT_COUNT_LIMIT, maxFileBytes: SIDE_ATTACHMENT_FILE_BYTES, maxImageBytes: SIDE_ATTACHMENT_IMAGE_BYTES, maxTotalBytes: SIDE_ATTACHMENT_TOTAL_BYTES, ...(audio && transcribe ? { audio: true as const } : {}) } } : {}),
      ...(!supported ? { reason: "unsupported" as const } : {}) };
  };
  const assertScopeWorkspace = async (scope: SideScope, sideId: string, cfg: Awaited<ReturnType<typeof config>>) => {
    const key = scopeKey(scope);
    if (!sessionWorkspaces.has(key)) return;
    const current = await conversationWorkspace(scope.conversationId, cfg);
    if (sessionWorkspaces.get(key) !== current) {
      sessionWorkspaces.delete(key);
      await sessions.close(scope, sideId).catch(() => undefined);
      throw new SideSessionError("expired");
    }
  };
  const scopeWithId = sideScopeSchema.extend({ sideId: idSchema });
  return {
    activeCount: (conversationId?: string) => sessions.activeCount(conversationId),
    hasOpenSession: (conversationId: string) => sessions.hasOpenSession(conversationId),
    close: () => { sessionWorkspaces.clear(); return sessions.closeAll(); },
    async call(method: string, raw: unknown) {
      try {
        const cfg = await config(), next = signature(cfg);
        if (fingerprint && fingerprint !== next) { sessionWorkspaces.clear(); await sessions.closeAll(); sessions = create(); }
        fingerprint = next;
        if (method === "side.status") { const { attachments, audio, tools, delivery, ...scope } = sideScopeSchema.extend({ attachments: z.literal(true).optional(), audio: z.literal(true).optional(), tools: z.literal(true).optional(), delivery: z.literal(true).optional() }).strict().parse(raw); return { ok: true, capability: await capability(scope.conversationId, attachments, audio, tools ? "inherited" : undefined, delivery) }; }
        if (method === "side.open") { const { requestId, tools, delivery, ...scope } = sideScopeSchema.extend({ requestId: idSchema, tools: z.literal("inherited").optional(), delivery: z.literal(true).optional() }).strict().parse(raw); const supported = await capability(scope.conversationId, false, false, tools, delivery); if (delivery && !supported.delivery || tools && supported.tools !== tools) throw new SideSessionError("unsupported"); return sessions.open(scope, requestId, supported); }
        if (method === "side.read") {
          const { sideId, revision, ...scope } = scopeWithId.extend({ revision: z.number().int().nonnegative().optional() }).strict().parse(raw);
          await assertScopeWorkspace(scope, sideId, cfg);
          return { ok: true, ...sessions.read(scope, sideId, revision) };
        }
        if (method === "side.ask") {
          const { sideId, requestId, text, attachments = [], ...scope } = scopeWithId.extend({ requestId: idSchema, text: z.string().trim().max(SIDE_QUESTION_LIMIT), attachments: z.array(sideAttachmentRefSchema).min(1).max(SIDE_ATTACHMENT_COUNT_LIMIT).optional() }).strict()
            .refine(ask => ask.text.length > 0 || !!ask.attachments?.length).parse(raw);
          await assertScopeWorkspace(scope, sideId, cfg);
          return sessions.ask(scope, sideId, requestId, text, attachments, attachments.length && download ? (await nativeCapability(scope.conversationId)).native?.attachments : undefined);
        }
        const { sideId, ...scope } = scopeWithId.strict().parse(raw);
        if (method === "side.stop") { await assertScopeWorkspace(scope, sideId, cfg); return sessions.stop(scope, sideId); }
        if (method === "side.close") { sessionWorkspaces.delete(scopeKey(scope)); return await sessions.close(scope, sideId); }
        throw new SideSessionError("unsupported");
      } catch (error) { if (error instanceof z.ZodError) throw error; return { ok: false, error: sideErrorCode(error) }; }
    },
  };
}
