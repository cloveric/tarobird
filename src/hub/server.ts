import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "./workbench-design-sharing.js";
import { DESIGN_SHARE_CLIENT_CAPABILITY } from "../client-protocol/workbench-design-sharing.js";
import { HubRemoteScreen } from "./remote-screen.js";
import { RemoteScreenSockets } from "./remote-screen-sockets.js";
import { signedScreenConfigureSchema, screenStopSchema, SCREEN_MAX_CONTROL_BYTES } from "../client-protocol/remote-screen.js";
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from "./workbench.js";
import { readWorkbenchTurnMetadata, type WorkbenchContextReceipt } from "./workbench-history.js";
import type { WorkbenchContext } from "../client-protocol/workbench.js";
import { WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY, workbenchRequestSchema, workbenchContextSchema, workbenchPublishedSource, workbenchOpenerOnly } from "../client-protocol/workbench.js";
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY } from "../client-protocol/workbench-design.js";
import { PAIRING_INVITES_PATH, PAIRING_INVITE_REVOKE_PATH } from "../client-protocol/pairing-invites.js";
import { ConversationBatchOperations } from './conversation-batch.js';
import { nativeInputControlRequestSchema } from "../client-protocol/steering.js";
import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY, nativeInputControlResultSchema } from "../client-protocol/native-input.js";
import { STEERING_OUTCOME_CAPABILITY } from "../client-protocol/steering-outcome.js";
import { HubWidgetSettings } from "./widget-settings.js";
import { automaticBackupSummary, readBackupSettings, updateBackupSettings } from "./backup-settings.js";
import { backupSettingsUpdateSchema } from "../client-protocol/backup-settings.js";
import { HubSideSessions } from "./side-sessions.js";
import { sideOpenSchema, sideAskSchema } from "../client-protocol/side.js";
import { WIDGET_POLICY_CAPABILITY, widgetSettingsUpdateSchema } from "../client-protocol/widget-settings.js";
import { widgetBlock } from "../client-protocol/widget.js";
import { validateWidget } from "../runtime/widget.js";
import { HubVoiceSettings, VoiceSettingsError } from "./voice-settings.js";
import { VOICE_POLICY_CAPABILITY, voiceSettingsUpdateSchema, type VoiceSettingsState } from "../client-protocol/voice-settings.js";
import { QwenAsrSetup, AsrSetupError } from "../runtime/qwen-asr-setup.js";
import { asrInstallSchema } from "../client-protocol/asr-setup.js";
import { acquireHostIdentityAdmission, acquireExistingHostIdentityAdmission, HostDirectoryError } from "../host-cli/windows-state-admission.js";
import { chromePatchSchema, chromeResultSchema } from "../client-protocol/chrome.js";
import { networkCanonical } from "../client-protocol/private-network.js";
import { BotMessages } from "./bot-messages.js";
import { HubAgentBuses } from "./agent-bus.js";
import { HubGroupDiscussions } from "./group-discussions.js";
import { GROUP_DISCUSSION_WORKER_CAPABILITY, GROUP_PARALLEL_CAPABILITY } from "../client-protocol/group-discussion.js";
import { AGENT_BUS_WORKER_CAPABILITY } from "../client-protocol/agent-bus.js";
import { BOT_TRANSFER_BYTES } from "./bot-message-transport.js";
import { botLocalRequestSchema, TargetResolutionError } from "../client-protocol/bot-messages.js";
import { HubPromptQueue, supportsPromptQueueEngine } from "./prompt-queue.js";
import { ATTACHMENT_ADMIN_DELETE_PATH, ATTACHMENT_ADMIN_LIST_PATH, ATTACHMENT_ADMIN_SUMMARY_PATH, attachmentAdminDeleteSchema, attachmentAdminListQuerySchema } from "../client-protocol/attachment-admin.js";
import { attachmentAdminList, attachmentAdminSummary, retireAttachments } from "./attachment-admin.js";
import { PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY, promptQueueMutationSchema } from "../client-protocol/prompt-queue.js";
import { RunJournal } from "./run-journal.js";
import { HubRunChanges } from "./run-changes.js";
import { runChangesQuerySchema, runChangeFileQuerySchema } from "../client-protocol/run-changes.js";
import { RUN_CAPABILITY, RUN_RECOVERY_CAPABILITY, RUN_SCOPES_CAPABILITY } from "../client-protocol/run.js";
import { BACKGROUND_TASK_GROUP_CAPABILITY } from "../client-protocol/background-task-group.js";
import { ConversationFolders } from "./conversation-folders.js";
import { HostProfile } from "./host-profile.js";
import { hostNameSchema } from "../client-protocol/host-profile.js";
import { PrivateNetwork } from "./private-network.js";
import { certificateAuthorityFromChain, lanInterfaceKey, HostRoutes, type ManagedListener } from "./host-routes.js";
import { HOST_ROUTES_PATH } from "../client-protocol/host-routes.js";
import { markDeviceNameAlias } from "./network-device-name.js";
import { networkCommandSchema } from "../client-protocol/private-network.js";
import { exchangeNetworkPeer, MAX_NETWORK_BYTES } from "./network-peer.js";
import { permissionPatchSchema, permissionResultSchema } from "../client-protocol/permissions.js";
import { personaPatchSchema, personaResultSchema } from "../client-protocol/persona.js";
import { steerRequestSchema, steerResultSchema, steerStatusSchema } from "../client-protocol/steering.js";
import { ENGINE_TASKS_CAPABILITY, engineSessionRecoverySchema, engineTaskSnapshotSchema, engineTaskStopSchema, engineTaskControlResultSchema } from "../client-protocol/engine-tasks.js";
import { deviceActionProofSchema } from "../client-protocol/device-actions.js";
import { effortPatchSchema, effortResultSchema } from "../client-protocol/effort.js";
import { modelPatchSchema, modelResultSchema } from "../client-protocol/model.js";
import { HubAvatars } from "./avatars.js";
import { avatarTargetSchema } from "../client-protocol/avatars.js";
import { readCollaboration, saveCollaboration } from "./collaboration.js";
import { readBotDiagnostics } from "../runtime/diagnostics.js";
import { searchPageQuerySchema, searchQuerySchema } from "../client-protocol/search.js";
import { conversationFilesQuerySchema } from "../client-protocol/conversation-files.js";
import { conversationFiles } from "./conversation-files.js";
import { readBotCapabilities } from "../runtime/bot-capabilities.js";
import { botCapabilitiesSchema } from "../client-protocol/capabilities.js";
import { readBotDashboard } from "../runtime/bot-dashboard.js";
import { botDashboardSchema } from "../client-protocol/dashboard.js";
import { scheduleMutationSchema, scheduleResultSchema, scheduledTasksSchema } from "../client-protocol/schedules.js";
import { diagnosticQuerySchema, diagnosticPageSchema } from "../client-protocol/diagnostics.js";
import { readHubDiagnostics } from "./diagnostics.js";
import { FRAGMENT_CAPABILITY } from "../client-protocol/fragments.js";
import { fileLabelPatchSchema, fileUnitIdSchema } from "../client-protocol/file-center.js";
import { HubFileCenter, type FileCenterRoots } from "./file-center.js";
import { HubWorkspaceDiff } from "./workspace-diff.js";
import { workspaceChangesQuerySchema, workspaceFileDiffQuerySchema } from "../client-protocol/workspace-diff.js";
import { nodeFrameReader, writeFrame } from "../client-protocol/fragments-node.js";
import { linkUrlSchema } from "../client-protocol/links.js";
import { HubLinkPreviews } from "./link-previews.js";
import { BotManager, createBotSchema, type BotManagerOptions } from "./bot-manager.js";
import { deleteBotSchema, renameBotSchema } from "../client-protocol/bots.js";
import { type RouteAlert } from "./route-monitor.js";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { attachmentResponse } from "./attachment-response.js";
import { AUTH_STATUS_CAPABILITY } from "../client-protocol/auth-status.js";
import { desktopControllerEnrollmentSchema, desktopControllerMarkerKey } from "./local-controller.js";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createTlsServer, type ServerOptions as TlsOptions } from "node:https";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { CAPABILITIES, CHUNK_BYTES, MAX_FRAME_BYTES, blocksText, idSchema, messageSchema, pairingSchema, parseClientFrame, type Block, type CardElement, type ClientFrame, type Conversation, type HubEvent, type Json, type Message } from "../client-protocol/index.js";
import { DISPATCH_CAPABILITY } from "../client-protocol/dispatch.js";
import { HubDispatch } from "./dispatch.js";
import type { Bot } from "./store.js";
/** Dispatcher engine workers are listed only to dispatch.v1 clients, which hide them. */
const listedBots = (bots: Bot[], capabilities: string[]) => capabilities.includes(DISPATCH_CAPABILITY) ? bots : bots.filter(bot => bot.role !== "worker");
import { CARD_EXTRA_STREAM_CAPABILITY, messageDelta } from "../client-protocol/stream.js";
import { CONVERSATION_SYNC_CAPABILITY, SNAPSHOT_ACTIVITY_CAPABILITY, SNAPSHOT_DELTA_CAPABILITY, SNAPSHOT_DELTA_THRESHOLD, SNAPSHOT_EVENT_THRESHOLD, SYNC_LINEAGE_CAPABILITY } from "../client-protocol/snapshot.js";
import { botPublishSchema, instanceFrameSchema } from "../client-protocol/instance.js";
import { HubAttachments } from "./attachments.js";
import { HubAuth, hashSecret, parsePublicKey, type AuthSession } from "./auth.js";
import { assertSafeBind, isLoopback, NATIVE_ORIGINS, type ListenerExposure } from "./network.js";
import { HubError, HubStore, newId } from "./store.js";
import { NOTIFICATION_OPTION_KEYS, notificationPreferencesSchema, pushSubscriptionSchema, pushRotationSchema } from "../client-protocol/push.js";
import { allowedApnsTopics, assertApnsTopicAllowed, createPushSender, validatePushDestination, type PushConfig } from "./push/providers.js";
import { PushWorker } from "./push/worker.js";
import { effectivePreferences, parseNotificationOptions, parsePreferences } from "./push/model.js";
import type { GoogleDocs } from "../gdocs/client.js";
import { googleDocsErrorCode } from "../gdocs/errors.js";
import { googleDocsStatus } from "../gdocs/settings.js";
import { hubServiceCommand } from "./service.js";
import { redactSecrets } from "../runtime/secret-redaction.js";
import { RelaySources } from "../relay/sources.js";
import { exportGoogleDocument } from "./google-export.js";
import { ShutdownErrors } from "./shutdown.js";

const SNAPSHOT_WINDOW_MESSAGES = 32, SNAPSHOT_WINDOW_BYTES = 1024 * 1024;
type SnapshotTransfer = { id: string; sent: number; received: number; bytes: number; pending: { count: number; bytes: number }[]; changed?: () => void };
type Client = { foreground: boolean; ws: WebSocket; session?: AuthSession; rejected?: "device_revoked" | "session_expired"; capabilities: string[]; cursors: Record<string, number>; syncLineages: Record<string, string>; conversationIds: Set<string>; readySent: boolean; pendingPublications: unknown[]; syncing: boolean; pendingSync: Set<string>; syncingConversations: Set<string>; syncFailures: Set<string>; streams: Map<string, Message>; snapshot?: SnapshotTransfer };
/** Older gateways parse turn metadata strictly and predate design.open: give
 * them the context exactly as an older App would have frozen it. */
function gatewayWorkbenchMetadata<T extends { workbench?: WorkbenchContext }>(metadata: T, designOpen: boolean): T {
  if (designOpen || !metadata.workbench?.openTarget) return metadata;
  const { workbench, ...rest } = metadata, { openTarget: _opener, ...context } = workbench;
  return (workbenchOpenerOnly(workbench) ? rest : { ...rest, workbench: context }) as T;
}
type BotConnection = { designOpen: boolean; nativeInput: boolean; nativeReviewInput: boolean; engineTasks: boolean; ws: WebSocket; botId: string; queueCapable: boolean; queuePull: boolean; queueAdvertised: boolean; botMessages: boolean; agentBus: boolean; groupDiscussion: boolean; voicePolicy: boolean; widgetPolicy: boolean; replayQueue: boolean; ready: boolean };
type Rpc = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; ws: WebSocket };
export interface HubTlsListener { exposure?: ListenerExposure; host: string; port: number; tls: TlsOptions; managed?: boolean }
export interface HubServerOptions { voiceSettings?: HubVoiceSettings; asrSetup?: QwenAsrSetup; /** Internal lease duration override for isolated tests. */ drainLeaseMs?: number; relaySources?: RelaySources; exposure?: ListenerExposure; maxFileBytes?: number; managedBots?: BotManagerOptions; stateDir: string; host?: string; port?: number; tls?: TlsOptions; instancePort?: number; tlsListeners?: HubTlsListener[]; push?: PushConfig; origins?: string[]; clientDir?: string; googleDocs?: () => Promise<GoogleDocs>; onWarning?: (code: string) => void; networkExchange?: typeof exchangeNetworkPeer }
export class HubServer {
  private readonly relaySources: RelaySources;
  private readonly fragmentSockets = new WeakSet<WebSocket>();
  private readonly requestGuards = new WeakMap<IncomingMessage, () => Promise<void>>();
  private readonly downloads = new Map<AbortController, AuthSession>();
  readonly http: Server;
  readonly linkPreviews: HubLinkPreviews;
  readonly fileCenter: HubFileCenter;
  readonly workspaceDiff: HubWorkspaceDiff;
  readonly runChanges: HubRunChanges;
  readonly widgetSettings: HubWidgetSettings;
  private readonly sideSessions: HubSideSessions;
  readonly voiceSettings: HubVoiceSettings;
  readonly asrSetup: QwenAsrSetup;
  readonly profile: HostProfile;
  readonly network: PrivateNetwork;
  readonly hostRoutes: HostRoutes;
  readonly botMessages: BotMessages;
  readonly agentBuses: HubAgentBuses;
  readonly dispatch: HubDispatch;
  readonly groupDiscussions: HubGroupDiscussions;
  private readonly networkAbort = new AbortController();
  private networkTick?: Promise<void>;
  private readonly networkSources = new Map<string, { remaining: number; updatedAt: number; until: number }>();
  private readonly listeners: { server: Server; host: string; port: number; tls: boolean; instance: boolean; managed?: boolean; retired?: boolean; authority?: string }[] = [];
  private readonly listenerStarts = new Map<Server, Promise<void>>();
  readonly remoteScreen: HubRemoteScreen;
  private readonly screenSockets: RemoteScreenSockets;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
  private clients = new Set<Client>();
  private bots = new Map<string, BotConnection>();
  private readonly dispatchTails = new Map<string, Promise<void>>();
  private permissionOperations = new Map<string, Promise<void>>();
  private effortOperations = new Map<string, Promise<void>>();
  private pendingRpc = new Map<string, Rpc>();
  private actionDispatch = new Set<string>();
  private stopping = false;
  private readonly workbench: WorkbenchBroker;
  private readonly designSharing: DesignShareBroker;
  /** /steer calls awaiting their Bot, by steering record. A review turn may
   * begin once, only while its own call is in flight on the same socket. */
  private readonly steersInFlight = new Map<string, { botId: string; conversationId: string; connection: BotConnection; calls: number; begun: boolean; ended: boolean }>();
  /** Native review turns started from a steering record: live until the
   * Gateway ends them or its socket closes. Records never self-authorize. */
  private readonly nativeTurns = new Map<string, { botId: string; conversationId: string; connection: BotConnection }>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly httpTasks = new Set<Promise<unknown>>();
  private readonly connections = new Set<Socket>();
  private botManager?: BotManager;
  private hostDrainControl: Promise<void> = Promise.resolve();
  private hostDrainLease?: { id: string; expiresAt: number; timer: ReturnType<typeof setTimeout> };
  private controllerEnrollment: Promise<void> = Promise.resolve();
  /** Only the token-authenticated local control pipe invokes this. No HTTP
   * bootstrap, platform inference, or external writable database connection. */
  enrollLocalController(raw: unknown): Promise<void> {
    return this.enrollController(raw);
  }
  prepareLocalDesktopController(raw: unknown) {
    if (this.stopping) throw new HubError("hub_stopping", 503);
    return this.auth.prepareDesktopController(raw);
  }
  enrollLocalDesktopController(raw: unknown): Promise<void> {
    const { controller, proof } = desktopControllerEnrollmentSchema.parse(raw);
    return this.enrollController(controller, proof);
  }
  private enrollController(raw: unknown, nativeProof?: unknown): Promise<void> {
    const device = pairingSchema.parse(raw);
    parsePublicKey(device.publicKey);
    const work = this.controllerEnrollment.then(async () => {
      if (this.stopping) throw new HubError("hub_stopping", 503);
      await this.store.db.transaction(async () => {
        if (nativeProof) this.auth.consumeDesktopController(nativeProof, device);
        const markController = async () => {
          await this.store.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [desktopControllerMarkerKey(device.deviceId), JSON.stringify({ id: device.deviceId, publicKey: device.publicKey, ...(nativeProof ? { nameSource: "host" } : {}) })]);
          if (nativeProof) await this.profile.syncDesktopNameInTransaction(device.deviceId);
        };
        const row = await this.store.db.get<{ public_key: string; revoked: number; role: string }>("SELECT d.public_key,d.revoked,u.role FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=?", [device.deviceId]);
        if (row) {
          // Never promote an ordinary paired owner or a network-derived key.
          if ((await this.auth.localDesktopControllersInTransaction()).get(device.deviceId) === device.publicKey) {
            if (nativeProof) await markController();
            return;
          }
          if (!nativeProof || row.revoked || row.role !== "owner" || row.public_key !== device.publicKey) throw new HubError("desktop_controller_identity_invalid", 403);
          // Upgrade only a legacy, unclassified native key. In particular a
          // signed phone identity may not change its established network scope.
          if ((await this.auth.originalDeviceScopesInTransaction()).get(device.deviceId) === "network") throw new HubError("desktop_controller_scope_conflict", 409);
          const network = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='private-network:v1'");
          if (network) {
            const bindings = JSON.parse(network.value)?.membership?.manifest?.devices;
            if (Array.isArray(bindings) && bindings.some((binding: { host?: string; id?: string; scope?: string; revoked?: boolean }) => binding.host === this.auth.publicKey && binding.id === device.deviceId && binding.scope === "network" && !binding.revoked)) throw new HubError("desktop_controller_scope_conflict", 409);
          }
          await markController();
          await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,'controller.migrated','{}')", [Date.now(), device.deviceId]);
          return;
        }
        const pending = await this.store.db.get<{ public_key: string }>("SELECT public_key FROM pairing_requests WHERE device_id=? AND status='pending' AND expires_at>?", [device.deviceId, Date.now()]);
        if (pending && pending.public_key !== device.publicKey) throw new HubError("desktop_controller_identity_invalid", 403);
        await this.store.db.run("DELETE FROM pairing_requests WHERE device_id=? AND public_key=?", [device.deviceId, device.publicKey]);
        await this.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES(?,'owner',?,?,?,?,?)", [device.deviceId, device.name, device.platform, device.publicKey, Date.now(), Date.now()]);
        await markController();
        await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,'controller.enrolled','{}')", [Date.now(), device.deviceId]);
      });
    });
    this.controllerEnrollment = work.catch(() => undefined);
    return work;
  }
  hostDrainStatus() { return { ...(this.botManager?.drainStatus() ?? { draining: false, drained: false }), ...(this.hostDrainLease ? { drainLeaseExpiresAt: this.hostDrainLease.expiresAt } : {}) }; }
  private armHostDrainLease(id: string): void {
    if (this.stopping) return;
    if (this.hostDrainLease) clearTimeout(this.hostDrainLease.timer);
    const duration = this.options.drainLeaseMs ?? 30_000, expiresAt = Date.now() + duration;
    const expire = () => {
      if (this.stopping || this.hostDrainLease?.id !== id || this.hostDrainLease.expiresAt !== expiresAt) return;
      void this.cancelHostDrain(id).catch(() => {
        if (!this.stopping && this.hostDrainLease?.id === id && this.hostDrainLease.expiresAt === expiresAt) {
          this.options.onWarning?.("host_drain_lease_resume_failed");
          this.hostDrainLease.timer = setTimeout(expire, 3000); this.hostDrainLease.timer.unref();
        }
      });
    };
    const timer = setTimeout(expire, duration); timer.unref(); this.hostDrainLease = { id, expiresAt, timer };
  }
  private transitionHostDrain(work: () => Promise<void>): Promise<void> {
    const operation = this.hostDrainControl.then(async () => { if (this.stopping) throw new Error("hub_stopping"); await work(); });
    this.hostDrainControl = operation.catch(() => undefined);
    return operation;
  }
  drainHost(drainId?: string): Promise<void> {
    return this.transitionHostDrain(async () => {
      if (!this.botManager) throw new Error("host_drain_unsupported");
      const unmanaged = await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM bots b WHERE b.deleted_at IS NULL AND b.online=1 AND NOT EXISTS(SELECT 1 FROM managed_bots m WHERE m.bot_id=b.id) LIMIT 1"));
      if (unmanaged) throw new Error("host_drain_unmanaged_bot_online");
      const alreadyDraining = this.botManager.drainStatus().draining;
      try { await this.botManager.drain(drainId); }
      finally {
        const status = this.botManager.drainStatus();
        // Repeated drain requests do not renew another caller's lease. Only the
        // explicit renewal operation can extend an existing lease by its ID.
        if (!alreadyDraining && status.draining && status.drainId) this.armHostDrainLease(status.drainId);
      }
    });
  }
  renewHostDrain(drainId?: string): Promise<void> {
    return this.transitionHostDrain(async () => {
      const status = this.botManager?.drainStatus();
      if (!drainId || !status?.draining || status.drainId !== drainId || this.hostDrainLease?.id !== drainId) throw new Error("host_drain_owned");
      if (Date.now() >= this.hostDrainLease.expiresAt) throw new Error("host_drain_lease_expired");
      this.armHostDrainLease(drainId);
    });
  }
  stopDrainedHost(drainId?: string): Promise<void> {
    return this.transitionHostDrain(async () => {
      const status = this.botManager?.drainStatus();
      if (!drainId || !status?.draining || status.drainId !== drainId || this.hostDrainLease?.id !== drainId) throw new Error("host_drain_owned");
      if (Date.now() >= this.hostDrainLease.expiresAt) throw new Error("host_drain_lease_expired");
      if (!status.drained) throw new Error("host_drain_not_finished");
      this.beginShutdown();
    });
  }
  cancelHostDrain(drainId?: string): Promise<void> { return this.transitionHostDrain(async () => {
    await this.botManager?.cancelDrain(drainId);
    if (this.hostDrainLease) clearTimeout(this.hostDrainLease.timer); this.hostDrainLease = undefined;
    await this.dispatchPending();
  }); }
  private pushWorker: PushWorker;
  private disposers: (() => void)[] = [];
  private syncLineage?: string;
  private readonly conversationFolders: ConversationFolders;
  private readonly avatars: HubAvatars;
  private constructor(readonly store: HubStore, readonly auth: HubAuth, readonly attachments: HubAttachments, readonly options: HubServerOptions) {
    this.remoteScreen = new HubRemoteScreen(store, auth);
    this.screenSockets = new RemoteScreenSockets(this.remoteScreen);
    this.disposers.push(() => { this.remoteScreen.dispose(); this.screenSockets.dispose(); });
    const screenTick = setInterval(() => this.remoteScreen.tick(), 250); screenTick.unref(); this.disposers.push(() => clearInterval(screenTick));
    this.workbench = new WorkbenchBroker(store);
    this.designSharing = new DesignShareBroker({repository:metaDesignShareRepository(store.db),requireMember:(userId,conversationId)=>store.db.serial(()=>store.requireMember(userId,conversationId)),userName:async userId=>(await store.user(userId))?.name});
    this.runChanges = new HubRunChanges(store);
    this.relaySources = options.relaySources ?? new RelaySources();
    this.widgetSettings = new HubWidgetSettings(options.stateDir);
    this.sideSessions = new HubSideSessions(store, auth, (botId, method, params, timeout) => this.callBot(botId, method, params, timeout));
    this.disposers.push(() => this.sideSessions.dispose());
    this.voiceSettings = options.voiceSettings ?? new HubVoiceSettings(options.stateDir);
    this.asrSetup = options.asrSetup ?? new QwenAsrSetup();
    this.profile = new HostProfile(store.db);
    this.network = new PrivateNetwork(store, auth, this.profile, {
      exchange: options.networkExchange ?? ((host, request) => exchangeNetworkPeer(host, request, { signal: this.networkAbort.signal })),
    });
    this.hostRoutes = new HostRoutes({ store, network: this.network, publicKey: auth.publicKey, stateDir: options.stateDir, listeners: () => this.managedListeners() });
    const conversationsCreated = (userId: string, conversations: Conversation[]) => {
      for (const conversation of conversations) for (const c of this.clients) if (c.session?.userId === userId && (!conversation.hidden || c.capabilities.includes(DISPATCH_CAPABILITY))) { c.conversationIds.add(conversation.id); this.publishClient(c, { v: 1, type: "conversation.updated", conversation }); }
    };
    this.botMessages = new BotMessages(store, auth, this.network, attachments, undefined,
      botId => { const connection = this.bots.get(botId); return connection?.ready ? connection.botMessages : undefined; },
      (userId, conversation) => conversationsCreated(userId, [conversation]));
    this.dispatch = new HubDispatch(store, {
      source: () => this.botMessages.ownSource(),
      conversationCreated: (userId, conversation) => conversationsCreated(userId, [conversation]),
      stop: (botId, conversationId, userId, messageId) => this.callBot(botId, "stop", { conversationId, userId, messageId }),
    });
    this.agentBuses = new HubAgentBuses(store, {
      workerCapable: (botId) => { const connection = this.bots.get(botId); return connection?.ready ? connection.agentBus : undefined; },
      stop: (botId, params) => this.callBot(botId, "agentBus.stop", params),
      conversationsCreated,
    });
    this.groupDiscussions = new HubGroupDiscussions(store, {
      workerCapable: (botId) => { const connection = this.bots.get(botId); return connection?.ready ? connection.groupDiscussion : undefined; },
      // Exactly this input's live run; never another turn of the conversation.
      stop: (botId, conversationId, messageId) => this.callBot(botId, "stop", { conversationId, messageId }),
    });
    this.conversationFolders = new ConversationFolders(store.db);
    this.avatars = new HubAvatars(store);
    this.linkPreviews = new HubLinkPreviews(store, attachments);
    this.workspaceDiff = new HubWorkspaceDiff(async (botId, remainingMs) => {
      const deadline = Date.now() + remainingMs;
      if (this.botManager && await this.botManager.owns(botId)) return path.join(options.stateDir, "bots", botId);
      return z.object({ stateDir: z.string().refine(path.isAbsolute) }).parse(await this.callBot(botId, "files.root", {}, Math.max(1, deadline - Date.now()))).stateDir;
    });
    this.fileCenter = new HubFileCenter(options.stateDir, async () => {
      const result: FileCenterRoots = { instances: [], warnings: [] };
      for (const bot of await store.bots("owner")) {
        try {
          const stateDir = this.botManager && await this.botManager.owns(bot.id)
            ? path.join(options.stateDir, "bots", bot.id)
            : z.object({ stateDir: z.string().refine(path.isAbsolute) }).parse(await this.callBot(bot.id, "files.root", {})).stateDir;
          result.instances.push({ name: bot.id, stateDir });
        } catch { result.warnings.push(`${bot.name}: Bot 不在线或尚不支持文件盘点，本次未计入。`); }
      }
      return result;
    });
    const pushSender = createPushSender(options.push ?? {}), pushHostId = `hub_${createHash("sha256").update(Buffer.from(this.auth.publicKey, "base64")).digest("hex")}`;
    this.pushWorker = new PushWorker(store, (subscription, payload) => pushSender(subscription, { ...payload, hostId: pushHostId }), (deviceId) => [...this.clients].some((c) => c.session?.deviceId === deviceId && c.foreground && c.ws.readyState === WebSocket.OPEN));
    this.http = options.tls ? createTlsServer(options.tls) : createServer();
    this.attachListener(this.http, options.host ?? "127.0.0.1", options.port ?? 0, !!options.tls, !options.tls, options.exposure);
    if (options.tls) this.attachListener(createServer(), "127.0.0.1", options.instancePort ?? 0, false, true);
    for (const listener of options.tlsListeners ?? []) this.attachListener(createTlsServer(listener.tls), listener.host, listener.port, true, false, listener.exposure, listener.managed, listener.managed ? certificateAuthorityFromChain(listener.tls.cert) : undefined);
    this.disposers.push(store.subscribe((event) => {
      this.trackTask(this.broadcast(event).catch(() => options.onWarning?.("broadcast_failed")));
      // The input is already committed. App projection/read latency or failure
      // must not strand its durable delivery on an otherwise healthy worker.
      if (event.kind === "message.created" && typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) && event.payload.authorType === "user") {
        this.trackTask(this.dispatchPending().catch(() => options.onWarning?.("queue_dispatch_failed")));
      }
    }));
    this.disposers.push(auth.onRevoke((deviceId) => { for (const c of this.clients) if (c.session?.deviceId === deviceId) this.endClientSession(c, "device_revoked"); }));
    this.disposers.push(auth.onRevoke((deviceId) => {
      this.sideSessions.revoke(deviceId);
      for (const [controller, session] of this.downloads) if (session.deviceId === deviceId) controller.abort(new HubError("device_revoked", 401));
    }));
    // A separate CLI process can revoke a device or enqueue maintenance work.
    // Recheck connected device identities without relying on client heartbeats.
    const previews = setInterval(() => { if (!this.stopping) void this.linkPreviews.tick().catch(() => options.onWarning?.("link_preview_failed")); }, 500);
    previews.unref(); this.disposers.push(() => clearInterval(previews));
    const audit = setInterval(() => { if (!this.stopping) void store.flushAudit().catch(() => options.onWarning?.("audit_flush_failed")); }, 5000);
    audit.unref(); this.disposers.push(() => clearInterval(audit));
    let checking = false;
    const sweep = setInterval(() => {
      if (checking || this.stopping) return; checking = true;
      void this.sweep().catch(() => options.onWarning?.("hub_sweep_failed")).finally(() => { checking = false; });
    }, 500); sweep.unref(); this.disposers.push(() => clearInterval(sweep));
  }
  private attachListener(server: Server, host: string, port: number, tls: boolean, instance: boolean, exposure?: ListenerExposure, managed = false, authority?: string): void {
    assertSafeBind(host, tls, exposure);
    this.listeners.push({ server, host, port, tls, instance, managed, ...(authority ? { authority } : {}) });
    server.on("connection", (socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
    });
    server.on("request", (req, res) => {
      if (this.stopping) { res.setHeader("Connection", "close"); this.respondError(res, new HubError("hub_stopping", 503)); return; }
      const task = this.request(req, res, instance).catch(async (e: unknown) => {
        if (req.url?.startsWith("/api/bot-messages/") || req.url?.startsWith("/api/instance/bot-messages") || req.headers["x-tarobot-message-passport"]) {
          await this.store.audit("bot-message.rejected", null, { stage: "http", reason: e instanceof HubError ? e.code.slice(0, 256) : "invalid_request" });
        }
        this.respondError(res, e);
      });
      this.httpTasks.add(task);
      void task.finally(() => this.httpTasks.delete(task)).catch(() => this.options.onWarning?.("request_failed"));
    });
    server.on("upgrade", (req, socket, head) => {
      if (!this.stopping && this.originAllowed(req) && this.screenSockets.handles(req.url ?? "")) {
        this.screenSockets.upgrade(req, socket, head, instance && !tls && isLoopback(req.socket.remoteAddress ?? "")); return;
      }
      // A relay arrives from loopback, so the socket address alone cannot
      // distinguish an instance connection from an untrusted remote client.
      if (this.stopping || !this.originAllowed(req) || !["/ws", "/instance"].includes(req.url ?? "") || (req.url === "/instance" && (!instance || !isLoopback(req.socket.remoteAddress ?? "")))) { socket.destroy(); return; }
      this.sockets.handleUpgrade(req, socket, head, (ws) => req.url === "/instance" ? this.instanceSocket(ws) : this.clientSocket(ws, this.relaySources.source(req.socket)));
    });
  }
  private trackTask(work: Promise<unknown>): void {
    this.httpTasks.add(work);
    void work.finally(() => this.httpTasks.delete(work)).catch(() => undefined);
  }
  private bindListener(listener: (typeof this.listeners)[number]): Promise<void> {
    if (this.stopping || listener.retired || listener.server.listening) return Promise.resolve();
    const pending = this.listenerStarts.get(listener.server); if (pending) return pending;
    const { server, host, port } = listener;
    const work = new Promise<void>((resolve, reject) => {
      const cleanup = () => { server.off("error", failed); server.off("listening", ready); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const ready = () => { cleanup(); if (this.stopping || listener.retired) server.close(() => {}); resolve(); };
      server.once("error", failed); server.once("listening", ready);
      try { server.listen(port, host); } catch (error) { failed(error as Error); }
    }).catch(error => {
      // A missing Wi-Fi/VPN address must not take down the local controller,
      // workers or relay. Only additional TLS endpoints may recover later.
      if (server !== this.http && !listener.instance && ["EADDRNOTAVAIL", "EADDRINUSE", "ENODEV", "ENETUNREACH", "EAFNOSUPPORT"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        this.options.onWarning?.("optional_listener_unavailable"); return;
      }
      throw error;
    });
    this.listenerStarts.set(server, work);
    void work.finally(() => this.listenerStarts.delete(server)).catch(() => undefined);
    return work;
  }
  /** Called only by local, opted-in desktop network maintenance. Existing TLS
   * connections drain normally; replacing a leaf never changes the host CA. */
  async refreshTlsListeners(current: HubTlsListener[]): Promise<void> {
    if (this.stopping) return;
    for (const spec of current) assertSafeBind(spec.host, true, spec.exposure);
    const key = (value: { host: string; port: number }) => `${value.host}:${value.port}`;
    const wanted = new Set(current.map(key));
    if (this.listeners.some(listener => !listener.retired && !listener.managed && wanted.has(key(listener)))) throw new Error("managed_listener_conflict");
    for (const listener of this.listeners) if (listener.managed && !wanted.has(key(listener))) {
      listener.retired = true;
      if (listener.server.listening) listener.server.close(() => {});
    }
    for (const spec of current) {
      if (this.stopping) return;
      let listener = this.listeners.find(value => value.managed && !value.retired && key(value) === key(spec));
      if (!listener) {
        const server = createTlsServer(spec.tls); this.attachListener(server, spec.host, spec.port, true, false, spec.exposure, true, certificateAuthorityFromChain(spec.tls.cert));
        listener = this.listeners.at(-1)!;
      } else { (listener.server as import("node:https").Server).setSecureContext(spec.tls); listener.authority = certificateAuthorityFromChain(spec.tls.cert); }
      await this.bindListener(listener);
    }
  }
  /** Configured desktop-managed endpoints and whether each is actually bound;
   * `bindListener` tolerates an unavailable address, so configured ≠ reachable. */
  managedListeners(): ManagedListener[] {
    return this.listeners.filter(listener => listener.managed && !listener.retired)
      .map(listener => ({ host: listener.host, port: listener.port, listening: listener.server.listening, interfaceKey: lanInterfaceKey(listener.host), ...(listener.authority ? { authority: listener.authority } : {}) }));
  }
  /** Local maintenance only, after listener refresh releases the desktop mutex.
   * Database work only; shutdown drains it with other accepted tasks. */
  refreshHostRoutes(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const work = this.hostRoutes.refresh();
    this.trackTask(work);
    return work;
  }
  private releaseIdentityAdmission?: () => Promise<void>;
  static async start(options: HubServerOptions): Promise<HubServer> {
    const host = options.host ?? "127.0.0.1"; assertSafeBind(host, !!options.tls, options.exposure);
    for (const listener of options.tlsListeners ?? []) assertSafeBind(listener.host, true, listener.exposure);
    const existingIdentity = await acquireExistingHostIdentityAdmission(options.stateDir);
    let store: HubStore | undefined;
    let hub: HubServer | undefined;
    let releaseIdentity = existingIdentity?.release;
    try {
      store = await HubStore.open(options.stateDir);
      const activeStore = store;
      await store.db.serial(() => activeStore.db.run("UPDATE bots SET online=0"));
      await store.recoverSteering();
      const auth = await HubAuth.open(store, options.stateDir);
      if (existingIdentity && auth.publicKey !== existingIdentity.publicKey) throw new HostDirectoryError("conflict");
      releaseIdentity ??= await acquireHostIdentityAdmission(auth.publicKey);
      await auth.retireLegacyPendingPairings();
      const attachments = new HubAttachments(store, options.stateDir, options.maxFileBytes); await attachments.initialize();
      hub = new HubServer(store, auth, attachments, options);
      hub.releaseIdentityAdmission = releaseIdentity;
      hub.syncLineage = (await store.db.get<{ value: string }>("SELECT value FROM meta WHERE key='sync_lineage'"))?.value;
      // Runs whose input settled while this Hub was stopped never stay active.
      await hub.agentBuses.reconcile();
      // Discussion turns settled while stopped advance once; uncertain ones pause.
      await hub.groupDiscussions.reconcile();
      for (const listener of hub.listeners) await hub.bindListener(listener);
      const runningHub = hub;
      const retryListeners = setInterval(() => {
        if (runningHub.stopping) return;
        for (const listener of runningHub.listeners) void runningHub.bindListener(listener).catch(() => options.onWarning?.("listener_retry_failed"));
      }, 30_000); retryListeners.unref(); hub.disposers.push(() => clearInterval(retryListeners));
      if (options.managedBots) {
        const running = hub;
        hub.botManager = new BotManager(store, options.stateDir, options.managedBots, () => running.instanceUrl, (id) => running.broadcastBotStatus(id));
        hub.dispatch.workers = hub.botManager;
        await hub.botManager.restore();
      }
      hub.pushWorker.start();
      hub.dispatch.start();
      hub.startNetworkSync();
      store.activityIndex.start();
      return hub;
    } catch (error) { if (hub) await hub.close(); else { try { await store?.db.close(); } finally { await releaseIdentity?.(); } } throw error; }
  }
  private listenerUrl(server: Server, tls: boolean): string { const address = server.address(); if (!address || typeof address === "string") throw new Error("not_listening"); return `${tls ? "https" : "http"}://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`; }
  get url(): string { return this.listenerUrl(this.http, !!this.options.tls); }
  get urls(): string[] { return this.listeners.filter(({ server }) => server.listening).map(({ server, tls }) => this.listenerUrl(server, tls)); }
  get instanceUrl(): string { const listener = this.listeners.find((l) => l.instance)!; return this.listenerUrl(listener.server, false); }
  /** Terminal intent is synchronous, before any maintenance or route I/O.
   * Once accepted, an expired/cancelled CLI drain must never resume work. */
  beginShutdown(): void {
    this.stopping = true;
    this.workbench.close(); this.designSharing.close();
    if (this.hostDrainLease) clearTimeout(this.hostDrainLease.timer);
    this.hostDrainLease = undefined;
    this.botManager?.beginShutdown();
  }
  get shutdownComplete(): boolean { return this.closed; }
  close(): Promise<void> { this.beginShutdown(); return this.closing ??= this.finishClose(); }
  private startNetworkSync(): void {
    const tick = () => {
      if (this.stopping || this.networkTick) return;
      this.networkTick = this.network.tick().catch(() => { if (!this.stopping) this.options.onWarning?.("network_sync_failed"); })
        .finally(() => { this.networkTick = undefined; });
    };
    tick();
    const timer = setInterval(tick, 5_000); timer.unref();
    this.disposers.push(() => clearInterval(timer));
  }
  private async finishClose(): Promise<void> {
    const errors = new ShutdownErrors();
    await errors.run("network.cancel", () => { this.network.close(); this.networkAbort.abort(); });
    await errors.run("network.finish", () => this.networkTick);
    await errors.run("file-center.cancel", () => this.fileCenter.cancel());
    await errors.run("asr-setup.close", () => this.asrSetup.close());
    await errors.run("workspace-diff.cancel", () => this.workspaceDiff.close());
    await errors.run("previews.stop", () => this.linkPreviews.stop());
    await errors.run("workers.close", () => this.botManager?.close());
    await errors.run("dispatch.stop", () => this.dispatch.stop());
    await errors.run("push.stop", () => this.pushWorker.stop());
    for (const dispose of this.disposers.splice(0)) await errors.run("subscription.close", dispose);
    await errors.run("listeners.finish", () => Promise.allSettled([...this.listenerStarts.values()]));
    for (const ws of this.sockets.clients) await errors.run("websocket.close", () => ws.terminate());
    for (const rpc of this.pendingRpc.values()) await errors.run("rpc.cancel", () => { clearTimeout(rpc.timer); rpc.reject(new Error("hub_stopping")); });
    this.pendingRpc.clear();
    for (const controller of this.downloads.keys()) await errors.run("download.cancel", () => controller.abort(new HubError("hub_stopping", 503)));
    await errors.run("file-center.close", () => this.fileCenter.close());
    const closedListeners = this.listeners.map(({ server }) => errors.run("listener.close", () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    })));
    // Track TCP peers too: HTTP closeAllConnections misses unfinished TLS
    // handshakes. Downloads were cancelled above; disconnect remaining peers
    // so incomplete request bodies cannot hold shutdown open indefinitely.
    for (const socket of this.connections) await errors.run("connection.close", () => socket.destroy());
    await Promise.all(closedListeners);
    // Keep SQLite available for work accepted before shutdown (including
    // cancellation/finalization), even after its HTTP connection has closed.
    // Accepted socket work can enqueue its final publication while settling.
    // Admission is frozen; drain the complete set before closing SQLite.
    while (this.httpTasks.size) await Promise.allSettled([...this.httpTasks]);
    await errors.run("controller.finish", () => this.controllerEnrollment);
    await errors.run("drain.finish", () => this.hostDrainControl);
    await errors.run("audit.flush", () => this.store.flushAudit());
    // A still-live worker is an active state owner. Keep the DB and lock owned
    // until exit is confirmed instead of turning a cleanup error into a split Hub.
    if ((!this.botManager || this.botManager.shutdownComplete) && this.listeners.every(({ server }) => !server.listening)) {
      this.closed = await errors.run("database.close", () => this.store.db.close());
      if (this.closed) await errors.run("identity.release", async () => { await this.releaseIdentityAdmission?.(); this.releaseIdentityAdmission = undefined; });
    } else errors.errors.push(new Error("hub_writers_still_running"));
    errors.finish("hub_close_failed");
  }
  private async sweep(): Promise<void> {
    await this.remoteScreen.sweep();
    for (const client of this.clients) if (client.session) {
      try { await this.auth.validateSession(client.session); }
      catch (error) { this.endClientSession(client, error instanceof HubError && error.code === "device_revoked" ? "device_revoked" : "session_expired"); }
    }
    for (const [controller, session] of this.downloads) {
      try { await this.auth.validateSession(session); }
      catch (error) { controller.abort(error); }
    }
    for (const botId of this.bots.keys()) void this.dispatchActions(botId).catch(() => this.options.onWarning?.("action_dispatch_failed"));
  }
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    return [...this.urls, ...NATIVE_ORIGINS, ...(this.options.origins ?? [])].includes(origin);
  }
  private send(ws: WebSocket, value: unknown): Promise<void> {
    const work = writeFrame(ws, value, this.fragmentSockets.has(ws));
    void work.catch((error: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (error instanceof Error && error.message === "client_update_required") ws.send(JSON.stringify({ v: 1, type: "error", code: "client_update_required", message: "请更新客户端以读取完整长回答。", retryable: false }), () => ws.close(4008, "client_update_required"));
      else ws.terminate();
    });
    return work;
  }
  private errorFrame(ws: WebSocket, error: unknown, requestId?: string, conversationId?: string, title?: string): Promise<void> { return this.send(ws, { v: 1, type: "error", requestId, conversationId, code: error instanceof HubError ? error.code : error instanceof z.ZodError ? "invalid_request" : "internal_error", message: error instanceof HubError ? error.code === "client_update_required_after_restore" ? "主机已从备份恢复，请更新客户端以重新同步完整聊天记录。" : error.code === "history_metadata_unavailable" ? `${title ? `对话「${title.slice(0,80)}」` : "该对话"}的同步索引不完整，请联系主机管理员检查或从可信备份恢复；聊天原文仍保留，修复后重新连接。` : error.code : "Request failed", retryable: error instanceof HubError ? (error.status >= 500 || error.code === "session_expired") : !(error instanceof z.ZodError) }); }
  private endClientSession(client: Client, code: "device_revoked" | "session_expired"): void {
    if (client.rejected) return;
    client.rejected = code;
    if (client.session) { this.workbench.unregister(this.workbenchPeer(client));this.designSharing.disconnect(this.designSharePeer(client)); }
    void this.store.audit("socket.rejected", client.session?.deviceId ?? null, { code }).catch(() => undefined);
    void this.send(client.ws, { v: 1, type: "notice", code }).finally(() => client.ws.close(4001, code)).catch(() => undefined);
  }
  private async sendClient(client: Client, value: unknown): Promise<void> {
    if (client.rejected) throw new HubError(client.rejected, 401);
    if (!client.session || client.ws.readyState !== WebSocket.OPEN) throw new HubError("sync_disconnected", 503);
    try { await this.auth.validateSession(client.session); }
    catch (error) {
      if (error instanceof HubError && error.status === 401) this.endClientSession(client, error.code === "device_revoked" ? "device_revoked" : "session_expired");
      throw error;
    }
    // Revocation can finish while this send waits for the authentication queue.
    if (client.rejected) throw new HubError(client.rejected, 401);
    if (client.ws.readyState !== WebSocket.OPEN) throw new HubError("sync_disconnected", 503);
    await this.send(client.ws, value);
  }
  private publishClient(client: Client, value: unknown): void {
    if (!client.readySent) {
      if (client.rejected || client.ws.readyState !== WebSocket.OPEN) return;
      // Clients ignore application frames before ready. Preserve changes made
      // after its snapshots were read; reconnect for fresh snapshots if a stalled
      // handshake accumulates too much metadata. Message bodies use pendingSync.
      if (client.pendingPublications.length >= 256) { client.pendingPublications.length = 0; client.ws.terminate(); return; }
      client.pendingPublications.push(value);
      return;
    }
    // Broadcast failure belongs to this connection, never to the committed
    // event or to another recipient. Reconnect replays the durable journal.
    void this.sendClient(client, value).catch(() => { if (!client.rejected) client.ws.terminate(); });
  }
  private broadcastTail: Promise<void> = Promise.resolve();
  private broadcast(event: HubEvent): Promise<void> {
    // Reserve the committed event's projection read immediately. Deferring it
    // until the preceding broadcast completes repeatedly puts each event behind
    // newer writes from every Bot, growing display latency under live load.
    // Reads still use the database's serial queue; publication remains ordered.
    const recipients = [...this.clients];
    const prepared = this.store.eventProjections(event, [...new Set(recipients.flatMap(client => client.session ? [client.session.userId] : []))]);
    // A later read can fail before its publication turn. Handle it now and let
    // the ordered task report the same failure without poisoning following work.
    void prepared.catch(() => undefined);
    const task = this.broadcastTail.then(() => this.broadcastOrdered(event, recipients, prepared)).catch(error => {
      // A failed final projection may have no later event to expose a gap.
      // Retire only affected, still-behind connections so their normal reconnect
      // replays the journal (or takes a snapshot after retention). Never advance
      // a cursor past a failed projection or bypass per-user visibility checks.
      for (const client of recipients) {
        // While a replacement snapshot is unacknowledged, the hello cursor may
        // still exceed this Host's head. It is not evidence of delivered state.
        const syncing = client.syncing && (!client.capabilities.includes(CONVERSATION_SYNC_CAPABILITY) || client.syncingConversations.has(event.conversationId));
        if (client.session && client.conversationIds.has(event.conversationId)
          && !client.syncFailures.has(event.conversationId)
          && (syncing || (client.cursors[event.conversationId] ?? 0) < event.seq)) client.ws.terminate();
      }
      throw error;
    });
    this.broadcastTail = task.catch(() => undefined); return task;
  }
  private async broadcastOrdered(event: HubEvent, recipients: Client[], prepared: Promise<Map<string, HubEvent>>): Promise<void> {
    const projections = await prepared;
    for (const client of recipients) {
      if (!client.session || !client.conversationIds.has(event.conversationId) || client.syncFailures.has(event.conversationId)) continue;
      if (client.syncing && (!client.capabilities.includes(CONVERSATION_SYNC_CAPABILITY) || client.syncingConversations.has(event.conversationId))) client.pendingSync.add(event.conversationId);
      else {
        // Clients authenticated after preparation recover this event through
        // their own snapshot/replay, never through another user's projection.
        const projected = projections.get(client.session.userId);
        if (projected) this.sendEvent(client, projected);
      }
    }
  }
  private sendEvent(client: Client, event: HubEvent): void {
    if (event.seq <= (client.cursors[event.conversationId] ?? 0)) return;
    this.publishClient(client, this.eventFrame(client, event));
    client.cursors[event.conversationId] = event.seq;
  }
  private eventFrame(client: Client, event: HubEvent): unknown {
    if (event.kind === "message.created" || event.kind === "message.updated") {
      const parsed = messageSchema.safeParse(event.payload);
      if (parsed.success) {
        // Durable events retain full snapshots. Each connection starts with a
        // full base, including when replay begins in the middle of a stream.
        // This also keeps clients without streaming.v1 fully compatible.
        const message: Message = client.capabilities.includes("cards.v1") ? parsed.data : { ...parsed.data, blocks: [{ type: "text", text: blocksText(parsed.data.blocks) }] };
        const previous = client.streams.get(message.id);
        const delta = previous && client.capabilities.includes("streaming.v1") ? messageDelta(previous, message, { cardExtra: client.capabilities.includes(CARD_EXTRA_STREAM_CAPABILITY) }) : undefined;
        if (!previous || message.version > previous.version) {
          if (message.status === "streaming" && client.capabilities.includes("streaming.v1")) client.streams.set(message.id, message);
          else client.streams.delete(message.id);
        }
        return delta ? { ...event, kind: "message.stream", payload: delta } : { ...event, payload: message };
      }
    }
    return event;
  }
  private async sendSync(client: Client, frame: unknown): Promise<void> {
    if (client.ws.readyState !== WebSocket.OPEN) throw new HubError("sync_disconnected", 503);
    await this.sendClient(client, frame);
  }
  private async syncConversation(client: Client, conversationId: string, snapshots: boolean): Promise<void> {
    const userId = client.session!.userId;
    let cursor = client.cursors[conversationId] ?? 0;
    const head = await this.store.syncHead(userId, conversationId);
    const lineageMismatch = !!this.syncLineage && client.syncLineages[conversationId] !== this.syncLineage;
    // A legacy delta-only client cannot reset its persisted cursor or replace
    // missing history. Silently declaring synchronization complete leaves it
    // permanently blind after a restore; surface the required upgrade.
    if (!client.capabilities.includes("snapshot.v1") && lineageMismatch)
      throw new HubError("client_update_required_after_restore", 426);
    if (!client.capabilities.includes("snapshot.v1") && (cursor > head.seq || cursor + 1 < head.firstSeq))
      throw new HubError("client_update_required", 426);
    const incremental = !lineageMismatch && client.capabilities.includes(SNAPSHOT_DELTA_CAPABILITY);
    if (snapshots && client.capabilities.includes("snapshot.v1") && (lineageMismatch || head.seq - cursor > (incremental ? SNAPSHOT_DELTA_THRESHOLD : SNAPSHOT_EVENT_THRESHOLD) || cursor > head.seq || cursor + 1 < head.firstSeq)) {
      let snapshotSeq = cursor;
      try {
        for await (const frame of this.store.snapshotFrames(userId, conversationId, cursor, { incremental })) {
          if (frame.type === "snapshot.begin") {
            // A replacement can follow replay pages on this same socket. Its
            // canonical versions supersede every previous delta base.
            for (const [id, message] of client.streams) if (message.conversationId === conversationId) client.streams.delete(id);
            if (this.syncLineage && client.capabilities.includes(SYNC_LINEAGE_CAPABILITY)) frame.lineage = this.syncLineage;
            snapshotSeq = frame.seq; client.snapshot = { id: frame.id, sent: 0, received: 0, bytes: 0, pending: [] }; }
          if (frame.type === "snapshot.message") {
            // snapshot.v1 is strict in older clients; only send the additional
            // activity timestamp after the client explicitly opts in.
            if (!client.capabilities.includes(SNAPSHOT_ACTIVITY_CAPABILITY)) delete frame.contentAt;
            if (!client.capabilities.includes("cards.v1")) frame.message = { ...frame.message, blocks: [{ type: "text", text: blocksText(frame.message.blocks) }] };
            if (frame.message.status === "streaming" && client.capabilities.includes("streaming.v1")) client.streams.set(frame.message.id, frame.message);
            const bytes = Buffer.byteLength(JSON.stringify(frame));
            await this.waitSnapshotReceipts(client, bytes);
            client.snapshot!.sent = frame.index + 1;
            client.snapshot!.bytes += bytes;
            client.snapshot!.pending.push({ count: frame.index + 1, bytes });
          }
          if (frame.type === "snapshot.end") await this.waitSnapshotReceipts(client);
          await this.sendSync(client, frame);
        }
      } finally { client.snapshot = undefined; }
      client.cursors[conversationId] = snapshotSeq;
      if (this.syncLineage) client.syncLineages[conversationId] = this.syncLineage;
      return;
    }
    // Stop at this captured head; writes arriving meanwhile set pendingSync.
    while (cursor < head.seq) {
      const page = await this.store.sync(userId, conversationId, cursor).catch(async error => {
        if (error instanceof HubError && error.code === "sync_snapshot_required") {
          if (!client.capabilities.includes("snapshot.v1")) throw new HubError("client_update_required", 426);
          await this.syncConversation(client, conversationId, true);
          return undefined;
        }
        throw error;
      });
      if (!page) return;
      for (const event of page.events) {
        if (event.seq > head.seq) break;
        await this.sendSync(client, this.eventFrame(client, event));
        cursor = event.seq; client.cursors[conversationId] = cursor;
      }
      if (!page.events.length || !page.more) break;
    }
  }
  private async waitSnapshotReceipts(client: Client, nextBytes?: number): Promise<void> {
    const transfer = client.snapshot!;
    // A cumulative ACK releases just enough space, without draining the entire
    // window. One large (fragmented) message may travel alone above the byte cap.
    const available = () => transfer.received === transfer.sent || nextBytes !== undefined && transfer.sent - transfer.received < SNAPSHOT_WINDOW_MESSAGES && transfer.bytes + nextBytes <= SNAPSHOT_WINDOW_BYTES;
    if (available()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); client.ws.off("close", closed); transfer.changed = undefined; error ? reject(error) : resolve(); };
      const closed = () => finish(new HubError("sync_disconnected", 503));
      const deadline = () => { const timer = setTimeout(() => finish(new HubError("snapshot_receipt_timeout", 503)), 10_000); timer.unref(); return timer; };
      let timer = deadline(), received = transfer.received;
      client.ws.once("close", closed);
      transfer.changed = () => {
        if (available()) finish();
        else if (transfer.received > received) { received = transfer.received; clearTimeout(timer); timer = deadline(); }
      };
      if (client.ws.readyState !== WebSocket.OPEN) closed();
    });
  }
  private async syncClient(client: Client, conversationIds: string[]): Promise<void> {
    const independent = client.capabilities.includes(CONVERSATION_SYNC_CAPABILITY);
    const synchronize = async (conversationId: string, snapshots: boolean): Promise<boolean> => {
      if (client.syncFailures.has(conversationId)) return false;
      try { await this.syncConversation(client, conversationId, snapshots); return true; }
      catch (error) {
        // Missing authoritative metadata after retention cannot be guessed from
        // a truncated journal. Isolate this conversation, not the whole socket.
        if (!(error instanceof HubError) || error.code !== "history_metadata_unavailable") throw error;
        client.syncFailures.add(conversationId); client.pendingSync.delete(conversationId);
        await this.store.audit("sync.history_metadata_unavailable", client.session!.deviceId, { conversationId }).catch(() => undefined);
        const conversation = (await this.store.conversations(client.session!.userId)).find(item => item.id === conversationId);
        await this.errorFrame(client.ws, error, undefined, conversationId, conversation?.title);
        return false;
      }
    };
    for (const conversationId of conversationIds) {
      client.pendingSync.delete(conversationId);
      if (!await synchronize(conversationId, true)) continue;
      if (independent) {
        while (client.pendingSync.delete(conversationId)) if (!await synchronize(conversationId, true)) break;
        if (client.syncFailures.has(conversationId)) continue;
        // No await between the final pending check and allowing live events.
        // Broadcasts at/below the captured cursor are discarded by sendEvent.
        client.syncingConversations.delete(conversationId);
        await this.sendSync(client, { v: 1, type: "sync.conversation", conversationId });
      }
    }
    while (client.pendingSync.size) {
      const ids = [...client.pendingSync]; client.pendingSync.clear();
      for (const conversationId of ids) await synchronize(conversationId, false);
    }
    // Existing clients clear ALL pending conversations on sync.complete. Keep
    // that fence until repair/reconnect; independent clients can still send and
    // receive in each healthy conversation that got its own completion marker.
    if (client.syncFailures.size) return;
    client.syncing = false;
    await this.sendClient(client, { v: 1, type: "sync.complete" });
  }
  private clientSocket(ws: WebSocket, source: string): void {
    const id = newId("connection");
    const client: Client = { foreground: false, ws, capabilities: [], cursors: {}, syncLineages: {}, conversationIds: new Set(), readySent: false, pendingPublications: [], syncing: true, pendingSync: new Set(), syncingConversations: new Set(), syncFailures: new Set(), streams: new Map() };
    this.clients.add(client);
    const timeout = setTimeout(() => { if (!client.session) ws.close(4001, "auth_timeout"); }, 30_000); timeout.unref();
    let hello: Extract<ClientFrame, { type: "hello" }> | undefined;
    let handshakeRejected = false;
    let tail = Promise.resolve();
    let completing = false, latestCompletion: Extract<ClientFrame, { type: "command.complete" }> | undefined;
    const reject = async (error: unknown, requestId?: string, fatalDuringSync = true) => {
      if (!client.session) handshakeRejected = true;
      await this.store.audit("request.rejected", client.session?.deviceId ?? null, { code: error instanceof HubError ? error.code : "invalid_request" }).catch(() => undefined);
      if (!client.session && hello?.capabilities.includes(AUTH_STATUS_CAPABILITY) && error instanceof HubError && ["untrusted_device", "signature_invalid", "challenge_expired"].includes(error.code)) {
        // Failure to produce a recovery receipt must still reject and close the
        // unauthenticated socket through the ordinary error path below.
        const denied = await this.auth.revocationDenial(hello.deviceId, hello.nonce).catch(() => undefined);
        if (denied) { client.rejected = "device_revoked"; await this.send(ws, denied).catch(() => undefined); ws.close(4001, "authentication_failed"); return; }
      }
      await this.errorFrame(ws, error, requestId).catch(() => undefined);
      if (client.session && error instanceof HubError && error.code === "history_metadata_unavailable") return;
      if (client.session && error instanceof HubError && error.status === 401) this.endClientSession(client, error.code === "device_revoked" ? "device_revoked" : "session_expired");
      else if (!client.session || client.syncing && fatalDuringSync) ws.close(4001, "authentication_failed");
    };
    const complete = (frame: Extract<ClientFrame, { type: "command.complete" }>) => {
      latestCompletion = frame;
      if (completing) return;
      completing = true;
      this.trackTask((async () => {
        while (latestCompletion && ws.readyState === WebSocket.OPEN && !client.rejected) {
          const next = latestCompletion; latestCompletion = undefined;
          try { await this.auth.validateSession(client.session!); await this.clientFrame(client, next); }
          catch (error) { await reject(error, undefined, false); }
        }
      })().finally(() => { completing = false; if (latestCompletion && ws.readyState === WebSocket.OPEN && !client.rejected) complete(latestCompletion); }).catch(() => undefined));
    };
    ws.on("message", (data, binary) => {
      if (this.stopping) return;
      // Authentication catch-up can span many frames. Keep liveness probes out
      // of its request queue, or healthy large syncs look like broken routes.
      if (client.session && !binary && data.toString().length < 512) {
        try {
          const probe = parseClientFrame(data.toString());
          if ("frame" in probe && probe.frame.type === "ping") {
            this.publishClient(client, { v: 1, type: "pong" });
            return;
          }
          if ("frame" in probe && probe.frame.type === "snapshot.ack") {
            const transfer = client.snapshot;
            if (!transfer || probe.frame.id !== transfer.id || probe.frame.count > transfer.sent) { ws.close(4008, "invalid_snapshot_receipt"); return; }
            transfer.received = Math.max(transfer.received, probe.frame.count);
            while (transfer.pending[0] && transfer.pending[0].count <= transfer.received) transfer.bytes -= transfer.pending.shift()!.bytes;
            transfer.changed?.(); return;
          }
          if (client.readySent && "frame" in probe && probe.frame.type === "turn.stop") {
            // Cancellation must not wait behind an unrelated Bot RPC (e.g. a
            // stalled completion menu). Recheck the same session/membership
            // boundary; only this ephemeral control bypasses ordered requests.
            const frame = probe.frame;
            this.trackTask(this.auth.validateSession(client.session).then(() => this.clientFrame(client, frame)).catch((error: unknown) => reject(error, undefined, false)));
            return;
          }
          if (client.readySent && "frame" in probe && probe.frame.type === "command.complete") { complete(probe.frame); return; }
        } catch { /* The ordered handler reports malformed frames below. */ }
      }
      if(client.session && client.readySent && !client.rejected && !binary && data.toString().length <= MAX_FRAME_BYTES) {
        try {
          const parsed=parseClientFrame(data.toString());
          if("frame" in parsed && parsed.frame.type==="design.share.request") {
            const frame=parsed.frame;
            this.trackTask((async()=>{
              if(!client.capabilities.includes(DESIGN_SHARE_CLIENT_CAPABILITY))throw new HubError("design_share_capability_required",409);
              await this.sendClient(client,await this.designSharing.handle(this.designSharePeer(client),frame));
            })().catch(error=>reject(error,frame.requestId,false)));return;
          }
        }catch { /* report invalid input through the ordered parser */ }
      }
      let requestId: string | undefined;
      tail = tail.then(async () => {
        if (client.rejected || handshakeRejected) return;
        if (binary) throw new HubError("text_frames_only");
        const result = parseClientFrame(data.toString());
        if ("ignored" in result) { this.options.onWarning?.("unknown_client_frame"); return; }
        const frame = result.frame;
        requestId = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
        if (frame.type === "hello") {
          if (hello || client.session) throw new HubError("unexpected_hello");
          if (!frame.protocolVersions.includes(1)) throw new HubError("protocol_incompatible");
          hello = frame; client.capabilities = frame.capabilities; if (frame.capabilities.includes(FRAGMENT_CAPABILITY)) this.fragmentSockets.add(ws); client.cursors = frame.cursors;
          if (frame.capabilities.includes(SYNC_LINEAGE_CAPABILITY)) client.syncLineages = frame.syncLineages ?? {};
          this.send(ws, { v: 1, type: "challenge", ...await this.auth.challenge(id, frame.deviceId, frame.nonce, source) }); return;
        }
        if (frame.type === "auth") {
          if (!hello || client.session) throw new HubError("unexpected_auth");
          const session = await this.auth.authenticate(id, frame.signature); client.session = session; clearTimeout(timeout);
          // A short-lived host management client needs the owner APIs, not a
          // copy of every conversation/avatar/history merely to list Bots.
          // Authentication and all subsequent HTTP authorization are unchanged.
          if (client.capabilities.includes("management.v1")) {
            await this.sendClient(client, { v: 1, type: "ready", sessionToken: session.token, expiresAt: session.expiresAt, serverTime: Date.now(), serverCapabilities: CAPABILITIES,
              uploadLimits: { maxFileBytes: this.attachments.maxFileBytes, chunkBytes: CHUNK_BYTES }, user: await this.store.user(session.userId), bots: listedBots(await this.store.bots(session.userId, client.capabilities.includes("bots.delete.v1")), client.capabilities), conversations: [], avatars: [] });
            client.readySent = true; client.syncing = false;
            client.pendingPublications.length = 0; client.pendingSync.clear();
            await this.sendClient(client, { v: 1, type: "sync.complete" }); return;
          }
          const conversations = await this.store.conversations(session.userId, { hidden: client.capabilities.includes(DISPATCH_CAPABILITY) });
          for (const conversation of conversations) { client.conversationIds.add(conversation.id); client.syncingConversations.add(conversation.id); }
          const conversationFolders = await this.conversationFolders.read(session.userId).catch(() => {
            // Optional metadata must not make a trusted device unable to chat.
            // Omission disables folder edits; never replace corrupt data with empty state.
            this.options.onWarning?.("conversation_folders_unavailable");
            return undefined;
          });
          await this.sendClient(client, { v: 1, type: "ready", sessionToken: session.token, expiresAt: session.expiresAt, serverTime: Date.now(), serverCapabilities: CAPABILITIES, uploadLimits: { maxFileBytes: this.attachments.maxFileBytes, chunkBytes: CHUNK_BYTES }, user: await this.store.user(session.userId), bots: listedBots(await this.store.bots(session.userId, client.capabilities.includes("bots.delete.v1")), client.capabilities), conversations, ...(conversationFolders ? { conversationFolders } : {}), avatars: await this.avatars.list(session.userId, session) });
          while (client.pendingPublications.length) await this.sendClient(client, client.pendingPublications.shift());
          client.readySent = true;
          if (client.capabilities.includes(CONVERSATION_SYNC_CAPABILITY)) {
            const preferred = hello.preferredConversationId;
            const ordered = [...conversations].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || b.createdAt - a.createdAt);
            // Authenticated requests have their own ordered queue. A slow
            // history receiver cannot stall sends/stops in a completed chat.
            this.trackTask(this.syncClient(client, ordered.map(c => c.id)).catch(error => reject(error)));
          } else {
            await this.syncClient(client, conversations.map(c => c.id));
          }
          return;
        }
        if (!client.session) throw new HubError("authentication_required", 401);
        await this.auth.validateSession(client.session);
        await this.clientFrame(client, frame);
      }).catch((error: unknown) => reject(error, requestId,
        // Independent catch-up runs beside this queue: an ordinary rejected
        // request is not a failed sync and must not close the socket.
        !(client.readySent && client.capabilities.includes(CONVERSATION_SYNC_CAPABILITY))));
      this.trackTask(tail);
    });
    ws.on("error", () => { this.options.onWarning?.("client_socket_error"); });
    ws.on("close", () => { if (client.session) { this.workbench.unregister(this.workbenchPeer(client));this.designSharing.disconnect(this.designSharePeer(client)); } clearTimeout(timeout); client.pendingPublications.length = 0; this.auth.forgetConnection(id); this.clients.delete(client); });
  }
  private async createConversation(userId: string, frame: Extract<ClientFrame, { type: "conversation.create" | "topic.create" }>, validate: () => Promise<unknown>) {
    const conversation = frame.type === "topic.create"
      ? await this.store.createConversation(userId, [], frame.title, frame.clientActionId, { parentId: frame.groupId }, validate)
      : await this.store.createConversation(userId, frame.botIds, frame.title, frame.clientActionId, { type: frame.conversationType }, validate);
    for (const c of this.clients) if (c.session && (c.session.userId === userId || conversation.parentId && c.conversationIds.has(conversation.parentId))) { c.conversationIds.add(conversation.id); this.publishClient(c, { v: 1, type: "conversation.updated", conversation, ...(c.session.userId === userId ? { clientActionId: frame.clientActionId } : {}) }); }
    return conversation;
  }
  private designSharePeer(client:Client):DesignSharePeer {
    const session=client.session!;
    return {key:client,userId:session.userId,deviceId:session.deviceId,
      active:()=>!this.stopping && !client.rejected && client.session===session && client.readySent && client.ws.readyState===WebSocket.OPEN,
      validate:()=>this.auth.validateSession(session),send:frame=>this.sendClient(client,frame),terminate:()=>client.ws.terminate()};
  }
  private workbenchPeer(client: Client): WorkbenchPeer {
    const session = client.session!;
    return { key: client, userId: session.userId, deviceId: session.deviceId,
      active: () => !this.stopping && !client.rejected && client.session === session && client.readySent && client.ws.readyState === WebSocket.OPEN,
      validate: () => this.auth.validateSession(session), send: frame => this.sendClient(client, frame) };
  }
  private async workbenchBotActor(botId: string, conversationId: string, messageId: string): Promise<WorkbenchActor & { validateInQueue(): Promise<void> }> {
    const connection = this.bots.get(botId);
    const source = await this.store.messageForBot(botId, messageId);
    if (source.authorType !== "user" || source.botSource || source.groupDiscussion || source.forwardedFrom || source.conversationId !== conversationId) throw new HubError("workbench_context_forbidden", 403);
    const validateInQueue = async () => {
      if (!connection || this.stopping || this.bots.get(botId) !== connection || !connection.ready || connection.ws.readyState !== WebSocket.OPEN) throw new HubError("workbench_bot_disconnected", 409);
      await this.store.requireBot(botId, conversationId); await this.store.requireMember(source.authorId, conversationId);
      let delivery = await this.store.db.get<{workbench_receipt_json: string | null}>("SELECT m.workbench_receipt_json FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.message_id=? AND d.bot_id=? AND d.status='pending' AND d.dispatched=1 AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions x WHERE x.message_id=m.id AND x.user_id=?)", [messageId, botId, source.authorId]);
      // A native review turn has no delivery: only its live lease on this socket.
      const lease = this.nativeTurns.get(messageId);
      if (!delivery && lease?.botId === botId && lease.connection === connection && lease.conversationId === conversationId) {
        const row = await this.store.db.get<{workbench_receipt_json: string | null; blocks_json: string}>("SELECT m.workbench_receipt_json,m.blocks_json FROM messages m WHERE m.id=? AND m.status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions x WHERE x.message_id=m.id AND x.user_id=?)", [messageId, source.authorId]);
        const control = row ? (JSON.parse(row.blocks_json) as Block[]).find(block => block.type === "steering") : undefined;
        if (control?.botId === botId && control.mode === "message" && control.outcome !== "rejected") delivery = row;
      }
      if (!delivery) throw new HubError("workbench_turn_ended", 409);
      // A resumed model may remember another turn's explicit target. Missing
      // context at capacity cannot authorize that target or automatic choice.
      if (delivery.workbench_receipt_json && (JSON.parse(delivery.workbench_receipt_json) as WorkbenchContextReceipt).omitted) throw new HubError("workbench_context_unavailable", 409);
    };
    const validate = () => this.store.db.serial(validateInQueue);
    await validate();
    const bot = await this.store.db.serial(() => this.store.db.get<{name:string}>("SELECT name FROM bots WHERE id=?",[botId]));
    return { actor:{kind:"bot",id:botId,name:bot?.name?.slice(0,128) ?? botId}, sourceMessageId: messageId, userId: source.authorId, conversationId, validate, validateInQueue, context: await this.workbench.contextForMessage(source.authorId, messageId, conversationId) };
  }
  private async clientFrame(client: Client, frame: ClientFrame): Promise<void> {
    if (this.stopping) throw new HubError("hub_stopping", 503);
    const userId = client.session!.userId;
    const validate = () => this.auth.validateSessionInTransaction(client.session!);
    if ("conversationId" in frame) await this.store.db.serial(() => this.store.requireMember(userId, frame.conversationId));
    if (["message.send", "message.forward", "read.mark"].includes(frame.type) && "conversationId" in frame && client.syncFailures.has(frame.conversationId))
      throw new HubError("history_metadata_unavailable", 409);
    switch (frame.type) {
      case "design.share.request": throw new HubError("design_share_app_unavailable",409);
      case "workbench.register": case "workbench.unregister": case "workbench.receipt": {
        if (!client.capabilities.includes(WORKBENCH_CAPABILITY)) throw new HubError("workbench_capability_required", 409);
        const peer = this.workbenchPeer(client);
        if (frame.type === "workbench.register") await this.workbench.register(peer, frame.registration);
        else if (frame.type === "workbench.unregister") this.workbench.unregister(peer, frame.windowId);
        else await this.workbench.receive(peer, frame.dispatchId, frame.receipt);
        break;
      }
      case "presence": client.foreground = frame.foreground; break;
      case "ping": await this.sendClient(client, { v: 1, type: "pong" }); break;
      case "message.send": case "message.forward": {
        const priorWorkbenchMessage = frame.type === "message.send" && frame.workbench ? await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM messages WHERE author_id=? AND client_msg_id=?", [userId, frame.clientMsgId])) : undefined;
        if (frame.type === "message.send" && frame.workbench && !priorWorkbenchMessage) {
          if (!client.capabilities.includes(WORKBENCH_CAPABILITY)) throw new HubError("workbench_capability_required", 409);
          await this.workbench.validateContext(userId, frame.conversationId, frame.workbench, client.session!.deviceId);
        }
        const guarded = async () => { await validate(); if (frame.type === "message.send" && frame.workbench && !priorWorkbenchMessage) this.workbench.assertContextActive(userId, frame.conversationId, frame.workbench); };
        const result = frame.type === "message.forward" ? await this.attachments.forward(userId, frame, validate) : await this.store.sendMessage(userId, { ...frame, parallelCapable: client.capabilities.includes(GROUP_PARALLEL_CAPABILITY) }, guarded);
        const workbenchContextOmitted = "workbenchContextOmitted" in result ? result.workbenchContextOmitted : undefined;
        await this.sendClient(client, { v: 1, type: "message.ack", clientMsgId: frame.clientMsgId, messageId: result.message.id, ...(workbenchContextOmitted ? { workbenchContextOmitted } : {}) });
        break;
      }
      case "read.mark": await this.store.markRead(userId, frame.conversationId, frame.seq, validate); break;
      case "typing": break;
      case "conversation.create": case "topic.create": {
        await this.createConversation(userId, frame, validate);
        break;
      }
      case "conversation.rename": case "conversation.archive": case "conversation.bind": {
        if (frame.type === "conversation.bind") {
          await this.store.db.serial(() => this.store.requireOwner(userId));
          const current = (await this.store.conversations(userId)).find((c) => c.id === frame.conversationId)!;
          if (frame.sessionId !== null && current.botIds.length !== 1) throw new HubError("bind_requires_direct_conversation");
          if (frame.sessionId !== null) {
            const sessions = z.array(z.object({ id: z.string() })).parse(await this.callBot(current.botIds[0]!, "sessions", {}));
            if (!sessions.some((s) => s.id === frame.sessionId)) throw new HubError("session_not_found_on_instance", 404);
          }
          await this.auth.validateSession(client.session!);
        }
        const conversation = await this.store.updateConversation(userId, frame.conversationId, frame, validate);
        if (frame.type === "conversation.bind" && frame.sessionId === null) await this.store.audit("conversation.binding_cleared", userId, { conversationId: frame.conversationId });
        for (const c of this.clients) if (c.conversationIds.has(conversation.id)) this.publishClient(c, { v: 1, type: "conversation.updated", conversation });
        break;
      }
      case "turn.stop": {
        const conversation = (await this.store.conversations(userId)).find((c) => c.id === frame.conversationId)!;
        const ids = frame.botId ? [frame.botId] : conversation.botIds;
        if (ids.some((botId) => !conversation.botIds.includes(botId))) throw new HubError("bot_forbidden", 403);
        await this.store.db.serial(async () => { await validate(); await this.store.requireMember(userId, frame.conversationId); });
        // One offline/unresponsive member must not delay stopping the others.
        // Stops are ephemeral controls: never queue them for reconnect replay.
        const results = await Promise.allSettled(ids.map(async (botId) => z.object({ stopped: z.boolean() }).parse(await this.callBot(botId, "stop", { conversationId: frame.conversationId, userId }))));
        if (results.some((result) => result.status === "rejected")) throw new HubError("stop_incomplete", 503);
        break;
      }
      case "command.complete": {
        if (!(await this.store.bots(userId)).some((b) => b.id === frame.botId)) throw new HubError("bot_forbidden", 403);
        await this.auth.validateSession(client.session!);
        // Completion is optional UI assistance, not a user operation. A stale
        // or unavailable menu must not stall sends or show a Bot error banner.
        const result = await this.callBot(frame.botId, "commands", { query: frame.query }, 1000).catch(() => []);
        await this.sendClient(client, { v: 1, type: "command.completions", botId: frame.botId, query: frame.query, result }); break;
      }
      case "interaction.submit": {
        if (await this.store.actionExists(userId, frame.clientActionId, frame)) { await this.sendClient(client, { v: 1, type: "interaction.ack", clientActionId: frame.clientActionId }); break; }
        const message = await this.store.messageForUser(userId, frame.messageId);
        if (message.conversationId !== frame.conversationId || message.authorType !== "bot" || message.status === "deleted") throw new HubError("interaction_forbidden", 403);
        const find = (elements: CardElement[]): CardElement | undefined => { for (const e of elements) { if (e.actionId === frame.actionId) return e; const nested = find(e.children ?? []); if (nested) return nested; } };
        let action: CardElement | undefined;
        for (const block of message.blocks) if (block.type === "card") action ??= find(block.elements);
        if (!action || action.disabled) throw new HubError("action_unavailable", 409);
        await this.store.enqueueAction(userId, frame.clientActionId, frame, message.authorId, frame.conversationId, { conversationId: frame.conversationId, messageId: message.id, userId, actionId: frame.actionId, tag: action.type === "select" ? action.multiple ? "multi_select_static" : "select_static" : action.type, name: action.name ?? action.actionId ?? "", value: action.value ?? {}, values: frame.values }, validate);
        await this.store.audit("interaction.queued", client.session!.deviceId, { messageId: message.id });
        void this.dispatchActions(message.authorId).catch(() => this.options.onWarning?.("action_dispatch_failed"));
        await this.sendClient(client, { v: 1, type: "interaction.ack", clientActionId: frame.clientActionId }); break;
      }
    }
  }
  async notifyRouteAlert(botId: string, alert: RouteAlert): Promise<void> {
    const result = z.object({ ok: z.boolean() }).parse(await this.callBot(botId, "route.alert", alert));
    if (!result.ok) throw new HubError("route_alert_unconfirmed");
  }
  private dispatchPending(botId?: string): Promise<void> {
    const ids = botId ? [botId] : [...this.bots.keys()];
    return Promise.all(ids.map(id => this.dispatchBot(id))).then(() => undefined);
  }
  private dispatchBot(id: string): Promise<void> {
    // One slow socket must not block other Bots. Each Bot still claims/sends in
    // order, and every accepted dispatch remains part of shutdown's task set.
    const work = (this.dispatchTails.get(id) ?? Promise.resolve()).then(async () => {
      if (this.stopping || this.hostDrainStatus().draining) return;
      const connection = this.bots.get(id); if (!connection) return;
      const queue = new HubPromptQueue(this.store);
      const active = () => !this.stopping && !this.hostDrainStatus().draining && this.bots.get(id) === connection && connection.ready && connection.ws.readyState === WebSocket.OPEN;
      let messages: Message[];
      const pull = connection.queuePull && connection.queueCapable ? { ready: new Set<string>() } : undefined;
      // An older worker fails each Agent Bus input in the claim transaction
      // instead of holding its conversation or receiving the prompt as chat.
      try { messages = await queue.claim(id, connection.queueCapable, connection.replayQueue, active, connection.botMessages, connection.agentBus || (ids => this.agentBuses.rejectForWorkerInTransaction(id, ids)),
        connection.groupDiscussion || (ids => this.groupDiscussions.rejectForWorkerInTransaction(id, ids)), pull); }
      catch {
        // The transaction may have rolled back, or its commit may be uncertain.
        // Reattachment retries from durable state and does not need a new prompt.
        connection.replayQueue = true;
        if (this.bots.get(id) === connection) connection.ws.terminate();
        this.options.onWarning?.("queue_dispatch_failed"); return;
      }
      if (!active()) { if (messages.length) connection.replayQueue = true; return; }
      connection.replayQueue = false;
      try {
        for (const conversationId of pull?.ready ?? []) {
          if (!active()) break;
          await this.send(connection.ws, { v: 1, type: "instance.queue", conversationId });
        }
        for (const message of messages) {
          let conversation;
          try { conversation = await this.store.conversationForBot(id, message.conversationId); }
          catch (error) {
            if (error instanceof HubError && ["bot_forbidden", "bot_deleted"].includes(error.code) && await queue.settleInaccessible(id, message.id)) continue;
            throw error;
          }
          if (!active()) { connection.replayQueue = true; break; }
          const agentBus = connection.agentBus ? await this.agentBuses.dispatch(id, message.id) : undefined;
          // Trusted turn metadata comes only from the Hub's own turn record.
          const groupDiscussion = connection.groupDiscussion ? await this.groupDiscussions.dispatch(id, message.id) : undefined;
          if (!active()) { connection.replayQueue = true; break; }
          const workbenchMetadata = gatewayWorkbenchMetadata(await this.store.db.serial(() => readWorkbenchTurnMetadata(this.store.db, message.id)), connection.designOpen);
          await this.send(connection.ws, { v: 1, type: "instance.message", message, conversation, ...workbenchMetadata, ...(agentBus ? { agentBus } : {}), ...(groupDiscussion ? { groupDiscussion } : {}) });
          // Readers see "speaking" instead of "waiting" without polling.
          if (groupDiscussion) this.trackTask(this.groupDiscussions.markDispatched(id, message.id).catch(() => this.options.onWarning?.("group_discussion_settle_failed")));
        }
      } catch {
        // SQLite metadata reads can fail after the durable claim too. Force a
        // fresh attachment to replay fenced inputs through GatewayReceipts;
        // otherwise an open socket could strand them forever after this error.
        connection.replayQueue = true;
        if (this.bots.get(id) === connection) connection.ws.terminate();
        this.options.onWarning?.("queue_dispatch_failed");
      }
    });
    const tail = work.catch(() => undefined); this.dispatchTails.set(id, tail);
    void tail.then(() => { if (this.dispatchTails.get(id) === tail) this.dispatchTails.delete(id); });
    this.trackTask(work); return work;
  }
  private scheduleDispatch(botId: string): void {
    // Delivery settlement is an RPC response boundary, not a wait for the next
    // socket write. In particular, never hold instance.result behind dispatch.
    this.trackTask(this.dispatchPending(botId).catch(() => this.options.onWarning?.("queue_dispatch_failed")));
  }
  private async dispatchActions(botId: string): Promise<void> {
    if (this.actionDispatch.has(botId) || this.stopping || !this.bots.has(botId)) return;
    this.actionDispatch.add(botId);
    try {
      for (const action of await this.store.pendingActions(botId)) {
        if (this.stopping) return;
        const params = z.record(z.string(), z.json()).parse(JSON.parse(action.params_json));
        const result = await this.callBot(botId, "interaction", { ...params, receiptId: action.id });
        await this.store.finishAction(action.id, result);
        const outcome = z.object({ ok: z.boolean() }).safeParse(result);
        await this.store.audit("interaction.completed", botId, { actionId: action.id, ok: outcome.success && outcome.data.ok });
        await this.store.appendBotEvent(botId, action.conversation_id, "turn.state", { actionId: action.id, result });
      }
    } finally { this.actionDispatch.delete(botId); }
  }
  private callBot(botId: string, method: string, params: unknown, timeoutMs = 10_000): Promise<Json> {
    const connection = this.bots.get(botId);
    if (!connection?.ready) return Promise.reject(new HubError("bot_offline", 503));
    const id = newId("rpc");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingRpc.delete(id); reject(new HubError("bot_timeout", 504)); }, timeoutMs); timer.unref();
      this.pendingRpc.set(id, { resolve, reject, timer, ws: connection.ws }); this.send(connection.ws, { v: 1, type: "instance.call", id, method, params });
    });
  }
  private async replayAbandonedBusStops(connection: BotConnection): Promise<void> {
    const active = () => !this.stopping && this.bots.get(connection.botId) === connection && connection.ready && connection.ws.readyState === WebSocket.OPEN;
    for (const stop of await this.agentBuses.abandonedStops(connection.botId)) {
      if (!active()) return;
      // The worker checks both input/run identity and actual live processing.
      // A new worker or a settled run must not remember this as an early stop.
      await this.callBot(connection.botId, "agentBus.stop", { ...stop, onlyIfProcessing: true }).catch(() => undefined);
    }
  }
  private instanceSocket(ws: WebSocket): void {
    let botId: string | undefined; let tail = Promise.resolve(); const reader = nodeFrameReader();
    let rejected = false;
    const active = () => !rejected && !this.stopping && ws.readyState === WebSocket.OPEN;
    const timeout = setTimeout(() => { if (!botId) ws.close(4001, "auth_timeout"); }, 10_000); timeout.unref();
    ws.on("message", (data) => {
      tail = tail.then(async () => {
        if (!active() || botId && this.bots.get(botId)?.ws !== ws) return;
        const decoded = botId ? reader.read(data.toString()) : JSON.parse(data.toString()); if (decoded === undefined) return;
        const frame = instanceFrameSchema.parse(decoded);
        if (frame.type === "instance.hello") {
          if (botId) throw new HubError("already_authenticated");
          const record = await this.store.db.serial(() => this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [frame.botId]));
          // A socket may close while authentication waits in the DB queue. Its
          // close handler has already run without a Bot ID, so registering it
          // now would leave a permanently-online entry for a dead connection.
          if (!active()) return;
          if (!record || !timingSafeEqual(Buffer.from(record.secret_hash, "hex"), Buffer.from(hashSecret(frame.secret), "hex"))) throw new HubError("instance_unauthorized", 401);
          botId = frame.botId; if (frame.capabilities?.includes(FRAGMENT_CAPABILITY)) this.fragmentSockets.add(ws); clearTimeout(timeout); this.bots.get(botId)?.ws.close(4000, "replaced");
          const queueAdvertised = frame.capabilities?.includes(PROMPT_QUEUE_CAPABILITY) ?? false;
          const queueCapable = queueAdvertised && supportsPromptQueueEngine(frame.engine);
          const connection: BotConnection = { designOpen: frame.capabilities?.includes(WORKBENCH_DESIGN_OPEN_CAPABILITY) ?? false, nativeInput: frame.capabilities?.includes(NATIVE_INPUT_CAPABILITY) ?? false, nativeReviewInput: (frame.capabilities?.includes(NATIVE_INPUT_CAPABILITY) && frame.capabilities.includes(NATIVE_REVIEW_INPUT_CAPABILITY)) ?? false, engineTasks: frame.capabilities?.includes(ENGINE_TASKS_CAPABILITY) ?? false, ws, botId, widgetPolicy: frame.capabilities?.includes(WIDGET_POLICY_CAPABILITY) ?? false, voicePolicy: frame.capabilities?.includes(VOICE_POLICY_CAPABILITY) ?? false, queueAdvertised, queueCapable, queuePull: frame.capabilities?.includes(PROMPT_QUEUE_PULL_CAPABILITY) ?? false, botMessages: frame.capabilities?.includes("bot-messages.v1") ?? false, agentBus: frame.capabilities?.includes(AGENT_BUS_WORKER_CAPABILITY) ?? false, groupDiscussion: frame.capabilities?.includes(GROUP_DISCUSSION_WORKER_CAPABILITY) ?? false, replayQueue: true, ready: false };
          // Reserve socket ownership before awaiting SQLite. Concurrent hellos
          // must replace this exact socket, not both replace its predecessor.
          this.bots.set(botId, connection);
          const ownsConnection = () => active() && this.bots.get(botId!) === connection;
          if (!await new HubPromptQueue(this.store).registerWorker(botId, queueCapable, ownsConnection, frame) || !ownsConnection()) return;
          connection.ready = true;
          this.send(ws, { v: 1, type: "instance.ready", capabilities: [WORKBENCH_CAPABILITY, WORKBENCH_MARKDOWN_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY, NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY, STEERING_OUTCOME_CAPABILITY, FRAGMENT_CAPABILITY, RUN_CAPABILITY, RUN_RECOVERY_CAPABILITY, RUN_SCOPES_CAPABILITY, BACKGROUND_TASK_GROUP_CAPABILITY, PROMPT_QUEUE_CAPABILITY, PROMPT_QUEUE_PULL_CAPABILITY] });
          // Never await RPC results in this socket's frame chain: its result
          // frames are handled by that same chain after hello completes.
          if (connection.agentBus) this.trackTask(this.replayAbandonedBusStops(connection).catch(() => this.options.onWarning?.("agent_bus_stop_replay_failed")));
          this.trackTask(this.groupDiscussions.settleBot(botId, true).catch(() => this.options.onWarning?.("group_discussion_settle_failed")));
          this.scheduleDispatch(botId); await this.broadcastBotStatus(botId); return;
        }
        if (!botId) throw new HubError("instance_unauthorized", 401);
        if (frame.type === "ping") {
          if (frame.status && this.bots.get(botId)?.ws === ws) {
            const status = frame.status;
            const changed = await this.store.db.serial(async () => {
              const current = await this.store.db.get<{ engine: string; model: string; effort: string }>("SELECT engine,model,effort FROM bots WHERE id=?", [botId!]);
              if (this.bots.get(botId!)?.ws !== ws || !current || (current.engine === status.engine && current.model === status.model && current.effort === status.effort)) return false;
              await this.store.db.run("UPDATE bots SET engine=?,model=?,effort=? WHERE id=?", [status.engine, status.model, status.effort, botId!]);
              return true;
            });
            if (changed) {
              const connection = this.bots.get(botId);
              if (connection?.ws === ws) {
                connection.queueCapable = connection.queueAdvertised && supportsPromptQueueEngine(status.engine);
                await new HubPromptQueue(this.store).registerWorker(botId, connection.queueCapable, () => active() && this.bots.get(botId!) === connection);
              }
              await this.broadcastBotStatus(botId); this.scheduleDispatch(botId);
            }
          }
          this.send(ws, { v: 1, type: "pong" }); return;
        }
        if (frame.type === "instance.result") {
          const pending = this.pendingRpc.get(frame.id); if (!pending || pending.ws !== ws) return;
          clearTimeout(pending.timer); this.pendingRpc.delete(frame.id);
          if (frame.error) pending.reject(new HubError("bot_request_failed", 502)); else pending.resolve(frame.result ?? null); return;
        }
        if (frame.type === "instance.request") {
          if (frame.method.startsWith("workbench.")) {
            // Waiting for an App receipt must not block this Bot's other turns,
            // heartbeat/status or a user's stop acknowledgement.
            const owner = botId;
            this.trackTask(this.instanceRequest(owner, frame.method, frame.params).then(
              result => this.send(ws, {v: 1, type: "instance.result", id: frame.id, result}),
              error => this.send(ws, {v: 1, type: "instance.result", id: frame.id, error: error instanceof HubError ? error.code : "invalid_request"})
            ).catch(() => undefined)); return;
          }
          try { this.send(ws, { v: 1, type: "instance.result", id: frame.id, result: await this.instanceRequest(botId, frame.method, frame.params) }); }
          catch (error) { this.send(ws, { v: 1, type: "instance.result", id: frame.id, error: error instanceof HubError ? error.code : "invalid_request" }); }
        }
      }).catch(async () => { rejected = true; await this.errorFrame(ws, new HubError("instance_request_rejected", 401)).catch(() => undefined); ws.close(4001); });
      this.trackTask(tail);
    });
    ws.on("error", () => this.options.onWarning?.("instance_socket_error"));
    ws.on("close", () => {
      clearTimeout(timeout); reader.clear();
      for (const [id, lease] of this.nativeTurns) if (lease.connection.ws === ws) this.nativeTurns.delete(id);
      if (botId && this.bots.get(botId)?.ws === ws) { this.bots.delete(botId); this.trackTask(this.store.botStatus(botId, { online: 0 }).then(() => this.broadcastBotStatus(botId!)).catch(() => undefined)); }
      for (const [id, rpc] of this.pendingRpc) if (rpc.ws === ws) { clearTimeout(rpc.timer); this.pendingRpc.delete(id); rpc.reject(new HubError("bot_offline", 503)); }
    });
  }
  private async broadcastBotStatus(botId: string): Promise<void> {
    const deleted = await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM bots WHERE id=? AND deleted_at IS NOT NULL", [botId]));
    if (deleted) this.bots.get(botId)?.ws.close(4003, "bot_deleted");
    for (const c of this.clients) if (c.session) {
      const bot = (await this.store.bots(c.session.userId, true)).find((b) => b.id === botId);
      // Dispatcher engine workers reach only clients that keep them out of lists.
      if (bot?.role === "worker" && !c.capabilities.includes(DISPATCH_CAPABILITY)) continue;
      if (bot && (!bot.deletedAt || c.capabilities.includes("bots.delete.v1"))) this.publishClient(c, { v: 1, type: "bot.status", bot });
      // Older clients cannot remove a Bot from their directory. A normal
      // reconnect replaces it with a fresh, filtered ready snapshot.
      if (bot?.deletedAt && !c.capabilities.includes("bots.delete.v1")) c.ws.close(1000, "bot_directory_changed");
      if (deleted) for (const conversation of await this.store.conversations(c.session.userId)) if (c.conversationIds.has(conversation.id)) this.publishClient(c, { v: 1, type: "conversation.updated", conversation });
    }
  }
  /** A run source is live while this Bot's delivery is dispatched and pending,
   * or while its native review lease is held by this same socket. */
  private async liveRunSource(botId: string, conversationId: string, messageId: string, connection: BotConnection): Promise<boolean> {
    const lease = this.nativeTurns.get(messageId);
    if (lease?.botId === botId && lease.connection === connection && lease.conversationId === conversationId) return true;
    return !!await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.message_id=? AND d.bot_id=? AND m.conversation_id=? AND d.status='pending' AND d.dispatched=1", [messageId, botId, conversationId]));
  }
  private async liveRunSources(botId: string, conversationId: string): Promise<string[]> {
    const rows = await this.store.db.serial(() => this.store.db.all<{ message_id: string }>("SELECT d.message_id FROM deliveries d JOIN messages m ON m.id=d.message_id WHERE d.bot_id=? AND m.conversation_id=? AND d.status='pending' AND d.dispatched=1 LIMIT 8", [botId, conversationId]));
    return [...rows.map(row => row.message_id), ...[...this.nativeTurns].filter(([, lease]) => lease.botId === botId && lease.conversationId === conversationId).map(([id]) => id)];
  }
  /** design.open follows the latest input the model provably adopted into this
   * live run (native receipt, or an applied/absorbed steer). Pending evidence
   * never falls back to the run's original device. */
  private async adoptedOpenContext(botId: string, actor: WorkbenchActor): Promise<WorkbenchContext | undefined> {
    for (const [id, flight] of this.steersInFlight) if (flight.botId === botId && flight.conversationId === actor.conversationId && id !== actor.sourceMessageId) throw new HubError("workbench_input_pending", 409);
    const { inputs, truncated } = await this.store.runInputs(actor.sourceMessageId!);
    for (const input of inputs.reverse()) {
      const control = input.blocks.find(block => block.type === "steering");
      const state = control?.nativeInput?.state, application = control?.application?.status;
      if (!control || control.botId !== botId || control.outcome === "rejected" || application === "dropped" || state === "cancelled" || state === "dropped") continue;
      if (state !== "received" && application !== "applied" && application !== "absorbed") throw new HubError("workbench_input_pending", 409);
      // An adopted input the user can no longer see never falls back to the old device.
      if (input.authorId !== actor.userId || input.status === "deleted" || input.conversationId !== actor.conversationId
        || await this.store.db.serial(() => this.store.db.get("SELECT 1 FROM message_deletions WHERE message_id=? AND user_id=?", [input.id, actor.userId]))) throw new HubError("workbench_open_target_unavailable", 409);
      const metadata = await this.store.db.serial(() => readWorkbenchTurnMetadata(this.store.db, input.id));
      if (metadata.workbenchContextOmitted) throw new HubError("workbench_context_unavailable", 409);
      return metadata.workbench;
    }
    if (truncated) throw new HubError("workbench_input_pending", 409);
    return actor.context;
  }
  private async instanceRequest(botId: string, method: string, params: unknown): Promise<unknown> {
    if (method === "workbench.turn.begin" || method === "workbench.turn.end") {
      const input = z.object({ conversationId: idSchema, messageId: idSchema }).strict().parse(params), connection = this.bots.get(botId);
      if (!connection?.designOpen) throw new HubError("unsupported", 409);
      if (method === "workbench.turn.end") {
        const lease = this.nativeTurns.get(input.messageId), flight = this.steersInFlight.get(input.messageId);
        if (lease?.botId === botId && lease.connection === connection) this.nativeTurns.delete(input.messageId);
        if (flight?.botId === botId && flight.connection === connection) flight.ended = true;
        return null;
      }
      // Once, for exactly the input whose /steer call to this socket is in
      // flight. Reserved before any read; rechecked after, so an end or close
      // during the reads is never undone.
      const flight = this.steersInFlight.get(input.messageId);
      if (!flight || flight.begun || flight.botId !== botId || flight.connection !== connection || flight.conversationId !== input.conversationId) throw new HubError("workbench_turn_unavailable", 409);
      flight.begun = true;
      if ([...this.nativeTurns.values()].filter(lease => lease.botId === botId).length >= 8) throw new HubError("workbench_busy", 429);
      const record = await this.store.messageForBot(botId, input.messageId), control = record.blocks.find(block => block.type === "steering");
      if (record.conversationId !== input.conversationId || record.authorType !== "user" || record.botSource || control?.botId !== botId || control.mode !== "message" || control.outcome === "rejected") throw new HubError("workbench_turn_unavailable", 409);
      const metadata = await this.store.db.serial(() => readWorkbenchTurnMetadata(this.store.db, input.messageId));
      if (flight.ended || flight.calls <= 0 || this.steersInFlight.get(input.messageId) !== flight || this.bots.get(botId) !== connection || connection.ws.readyState !== WebSocket.OPEN || this.stopping) throw new HubError("workbench_turn_unavailable", 409);
      this.nativeTurns.set(input.messageId, { botId, conversationId: input.conversationId, connection });
      return metadata;
    }
    if (["workbench.command", "workbench.cancel", "workbench.context", "workbench.targets"].includes(method)) {
      const input = z.object({ conversationId: idSchema, contextMessageId: idSchema, requestId: idSchema.optional(), request: workbenchRequestSchema.optional() }).strict().parse(params);
      const actor = await this.workbenchBotActor(botId, input.conversationId, input.contextMessageId);
      if (method === "workbench.cancel") { if (!input.requestId) throw new HubError("invalid_request"); await this.workbench.cancelRequest(actor, input.requestId); return null; }
      if (method === "workbench.context") return actor.context ?? null;
      if (method === "workbench.targets") return this.workbench.list(actor);
      if (!input.request) throw new HubError("invalid_request");
      if (input.request.operation === "design.open") actor.context = await this.adoptedOpenContext(botId, actor);
      return this.workbench.request(actor, input.request);
    }
    if (method === "queue.take") {
      const { conversationId } = z.object({ conversationId: idSchema }).strict().parse(params);
      const connection = this.bots.get(botId);
      if (!connection?.queuePull || !connection.queueCapable) throw new HubError("queue_unsupported", 409);
      const active = () => !this.stopping && !this.hostDrainStatus().draining && this.bots.get(botId) === connection && connection.ready && connection.ws.readyState === WebSocket.OPEN;
      const message = await new HubPromptQueue(this.store).take(botId, conversationId, active, connection.botMessages);
      if (!message) return null;
      const workbenchMetadata = gatewayWorkbenchMetadata(await this.store.db.serial(() => readWorkbenchTurnMetadata(this.store.db, message.id)), connection.designOpen);
      return { message, conversation: await this.store.conversationForBot(botId, conversationId), ...workbenchMetadata };
    }
    if (method === "run.recover") { const input = z.object({ before: z.number().int().nonnegative().max(Date.now()) }).strict().parse(params); await this.store.recoverOrphanRuns(botId, input.before); await this.store.retireNativeInputs(botId, input.before); await this.settleDiscussion(() => this.groupDiscussions.settleBot(botId)); return null; }
    if (method === "input.progress") { if (!this.bots.get(botId)?.nativeInput) throw new HubError("unsupported", 409); await this.store.applyNativeInputProgress(botId, params); return null; }
    if (method === "steer.outcome") { await this.store.applySteeringOutcome(botId, params); return null; }
    if (method === "run.write") { await new RunJournal(this.store).write(botId, params); return null; }
    if (method === "run.scope.write") { await new RunJournal(this.store).writeScoped(botId, params); return null; }
    if (method === "publish") {
      const message = await this.store.publishBotMessage(botId, botPublishSchema.parse(params), (blocks, previous) => { if (blocks.some(block => block.type === "card" && block.extra?.widget !== undefined && !previous.some(old => JSON.stringify(old) === JSON.stringify(block)))) this.widgetSettings.assertEnabled(); });
      // A receipt may precede the final run-card publication; settle again here.
      await this.settleDiscussion(() => this.groupDiscussions.published(botId, message));
      return message;
    }
    if (method === "fetch") return this.store.messageForBot(botId, z.object({ messageId: idSchema }).parse(params).messageId);
    if (method === "conversation") return this.store.conversationForBot(botId, z.object({ conversationId: idSchema }).parse(params).conversationId);
    if (method === "ack") {
      const { messageId } = z.object({ messageId: idSchema }).parse(params);
      await this.store.acknowledgeDelivery(botId, messageId); await new HubPromptQueue(this.store).settled(botId, messageId);
      await this.agentBuses.settleDelivery(botId, messageId);
      await this.settleDiscussion(() => this.groupDiscussions.settleInput(botId, messageId));
      this.scheduleDispatch(botId); return null;
    }
    if (method === "delivery.fail") { const p = z.object({ messageId: idSchema, reason: z.enum(["interrupted", "failed"]) }).parse(params); await this.store.failDelivery(botId, p.messageId, p.reason); await new HubPromptQueue(this.store).settled(botId, p.messageId); await this.agentBuses.settleDelivery(botId, p.messageId); await this.settleDiscussion(() => this.groupDiscussions.settleInput(botId, p.messageId, p.reason)); this.scheduleDispatch(botId); return null; }
    if (method === "agentBus.event") { await this.agentBuses.event(botId, params); return null; }
    if (method === "groupDiscussion.report") { await this.groupDiscussions.report(botId, params); return null; }
    if (method === "reaction" || method === "turn.state") { const p = z.object({ conversationId: idSchema, payload: z.json() }).parse(params); await this.store.appendBotEvent(botId, p.conversationId, method, p.payload); return null; }
    throw new HubError("unknown_method");
  }
  /** The committed receipt/publication is already durable. A settlement error
   * must not fail that RPC (and cause a resend); startup reconciliation and
   * the next receipt retry it from durable state. */
  private async settleDiscussion(work: () => Promise<void>): Promise<void> {
    try { await work(); } catch { this.options.onWarning?.("group_discussion_settle_failed"); }
  }
  private json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); res.end(JSON.stringify(value)); }
  private respondError(res: ServerResponse, error: unknown): void { if (error instanceof TargetResolutionError) error = new HubError(error.message, 409); if (res.headersSent) { res.destroy(); return; } this.json(res, error instanceof HubError ? error.status : error instanceof z.ZodError ? 400 : 500, { error: error instanceof HubError ? error.code : error instanceof z.ZodError ? "invalid_request" : "internal_error" }); }
  private async body(req: IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > limit) throw new HubError("body_too_large", 413); chunks.push(data); }
    // Headers may have been authorized minutes before the final body byte.
    await this.requestGuards.get(req)?.();
    return Buffer.concat(chunks);
  }
  private async jsonBody(req: IncomingMessage, limit = MAX_FRAME_BYTES): Promise<unknown> { try { return JSON.parse((await this.body(req, limit)).toString("utf8")); } catch (e) { if (e instanceof HubError) throw e; throw new HubError("invalid_json"); } }
  private networkRate(source: string, operation: "peer" | "enroll" | "bot-message"): void {
    const now = Date.now(), key = `${operation}:${source}`;
    for (const [id, entry] of this.networkSources) if (entry.until <= now) this.networkSources.delete(id);
    if (!this.networkSources.has(key) && this.networkSources.size >= 4096) throw new HubError("rate_limited", 429);
    // All 32 hosts may share one NAT or relay source and poll together every
    // five seconds. Two rounds of burst capacity plus eight requests/second
    // leave room for joins without allowing 600 large parses at once.
    const bucket = this.networkSources.get(key) ?? { remaining: operation === "enroll" ? 60 : 64, updatedAt: now, until: now + 60_000 };
    if (operation !== "enroll") {
      bucket.remaining = Math.min(64, bucket.remaining + Math.max(0, now - bucket.updatedAt) / 125);
      bucket.until = now + 60_000;
    }
    bucket.updatedAt = now; this.networkSources.set(key, bucket);
    if (bucket.remaining < 1) throw new HubError("rate_limited", 429);
    bucket.remaining--;
  }
  private async request(req: IncomingMessage, res: ServerResponse, instanceAllowed: boolean): Promise<void> {
    const source = this.relaySources.source(req.socket);
    if (!this.originAllowed(req)) throw new HubError("origin_forbidden", 403);
    if (req.headers.origin) { res.setHeader("Access-Control-Allow-Origin", req.headers.origin); res.setHeader("Vary", "Origin"); }
    res.setHeader("Access-Control-Expose-Headers", "ETag, Content-Range, Accept-Ranges, Date");
    if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, If-Range", "Access-Control-Max-Age": "600" }); res.end(); return; }
    const url = new URL(req.url ?? "/", this.url); const route = url.pathname;
    // Worker-only, one-use browser downloads must never fall back to HTML when
    // a worker has expired or a browser retries the navigation on the network.
    if (route.startsWith("/__tarocub_download/")) { res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); return; }
    if (route === "/health" && req.method === "GET") { this.json(res, 200, { ok: true, protocol: 1, pairingInvites: 1, publicKey: this.auth.publicKey }); return; }
    if (route === "/api/tls-identity" && req.method === "GET") {
      // The proof is bound to this listener's actual local leaf certificate,
      // including SNI selection. No forwarded header or client-supplied hash is
      // allowed to choose what the Hub signs. It conveys no device authority.
      if (!(req.socket instanceof TLSSocket)) throw new HubError("tls_required", 426);
      const localCertificate = req.socket.getCertificate();
      const certificate = localCertificate && "raw" in localCertificate ? localCertificate.raw : undefined;
      if (!Buffer.isBuffer(certificate) || !certificate.length) throw new HubError("tls_identity_unavailable", 503);
      this.json(res, 200, this.auth.tlsIdentity(url.searchParams.get("nonce") ?? "", certificate, source)); return;
    }
    if (route === "/api/pair" && req.method === "POST") { this.json(res, 201, await this.auth.pairInvited(await this.jsonBody(req, 8192), source)); return; }
    if (route === "/api/bot-messages/challenge" && req.method === "GET") {
      this.networkRate(source, "bot-message");
      const nonce = idSchema.parse(url.searchParams.get("nonce"));
      this.json(res, 200, { publicKey: this.auth.publicKey, signature: this.auth.signBotChallenge(nonce) }); return;
    }
    if (req.headers["x-tarobot-message-passport"]) {
      this.networkRate(source, "bot-message");
      const header = req.headers["x-tarobot-message-passport"];
      if (typeof header !== "string" || header.length > 8192) throw new HubError("bot_message_signature_invalid", 403);
      let raw: unknown;
      try { raw = JSON.parse(Buffer.from(header, "base64url").toString("utf8")); }
      catch { throw new HubError("bot_message_signature_invalid", 403); }
      const { signed } = await this.botMessages.authorizePassport(raw, req.method ?? "", route);
      // 200 KiB of valid text may expand sixfold under JSON escaping. Keep
      // control requests bounded without lowering the existing text contract.
      const limit = req.method === "PUT" && /^\/api\/uploads\/[\w-]+\/\d+$/.test(route) ? CHUNK_BYTES : 2 * MAX_FRAME_BYTES;
      const result = await this.botMessages.receive(signed, req.method ?? "", route, await this.body(req, limit));
      this.json(res, 200, { result, signature: this.auth.signBotReply(signed.passport.nonce, result) }); return;
    }
    if (route === "/api/network/peer" && req.method === "POST") {
      this.networkRate(source, "peer");
      this.json(res, 200, await this.network.peer(await this.jsonBody(req, MAX_NETWORK_BYTES), source)); return;
    }
    if (route === "/api/network/enroll" && req.method === "POST") {
      this.networkRate(source, "enroll");
      this.json(res, 200, await this.network.enroll(await this.jsonBody(req, MAX_NETWORK_BYTES))); return;
    }
    if (route.startsWith("/api/instance/")) { if (!instanceAllowed) throw new HubError("instance_unauthorized", 401); await this.instanceHttp(req, res, route); return; }
    if (!route.startsWith("/api/")) { await this.staticFile(route, res); return; }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const session = await this.auth.authorize(token, source);
    const userId = session.userId;
    let ownerRequired = false;
    let messageControllerRequired = false;
    const validateInQueue = async () => {
      await this.auth.validateSessionInTransaction(session);
      if (ownerRequired) await this.store.requireOwner(userId);
      if (messageControllerRequired && !(await this.auth.localDesktopControllersInTransaction()).has(session.deviceId)) throw new HubError("local_controller_required", 403);
    };
    const validate = () => this.store.db.serial(validateInQueue);
    const serial = <T>(operation: () => Promise<T>) => this.store.db.serial(async () => { await validateInQueue(); return operation(); });
    const transaction = <T>(operation: () => Promise<T>) => this.store.db.transaction(async () => { await validateInQueue(); return operation(); });
    const requireOwner = async () => { ownerRequired = true; await validate(); };
    const reply = async (status: number, value: unknown) => { await validate(); this.json(res, status, value); };
    this.requestGuards.set(req, validate);
    try {
      if (route === "/api/workbench/admit" && req.method === "POST") {
        const input = z.object({ dispatchId: idSchema }).strict().parse(await this.jsonBody(req, 2048));
        await reply(200, await this.workbench.admit(session, input.dispatchId)); return;
      }
      const workbenchRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/workbench\/(targets|commands|context)$/);
      if (workbenchRoute) {
        const conversationId = workbenchRoute[1]!, actor: WorkbenchActor = { userId, conversationId, validate, actor: {kind:"user",id:userId,name:(await this.store.user(userId))?.name ?? userId} };
        if (workbenchRoute[2] === "targets" && req.method === "GET") { await reply(200, await this.workbench.list(actor)); return; }
        if (workbenchRoute[2] === "context" && req.method === "POST") {
          const input = z.object({ contextMessageId: idSchema }).strict().parse(await this.jsonBody(req, 2048));
          await reply(200, await this.workbench.contextForMessage(userId, input.contextMessageId, conversationId) ?? null); return;
        }
        if (workbenchRoute[2] === "commands" && req.method === "POST") {
          const request = workbenchRequestSchema.parse(await this.jsonBody(req));
          if (request.contextMessageId) actor.context = await this.workbench.contextForMessage(userId, request.contextMessageId, conversationId);
          await reply(200, await this.workbench.request(actor, request)); return;
        }
        throw new HubError("method_not_allowed", 405);
      }
      if (route === "/api/settings/backups" && ["GET", "PUT"].includes(req.method ?? "")) {
        await requireOwner();
        const view = req.method === "PUT"
          ? await updateBackupSettings(this.store, this.options.stateDir, backupSettingsUpdateSchema.parse(await this.jsonBody(req, 4096)), session.deviceId, validateInQueue)
          : await serial(() => readBackupSettings(this.store.db, idSchema.optional().parse(url.searchParams.get("requestId") ?? undefined)));
        await reply(200, { ...view, snapshots: await automaticBackupSummary(this.options.stateDir) }); return;
      }
      if (route === "/api/settings/widgets" && ["GET", "PUT"].includes(req.method ?? "")) {
        await requireOwner();
        let view;
        if (req.method === "PUT") {
          const command = widgetSettingsUpdateSchema.parse(await this.jsonBody(req, 4096));
          view = await this.widgetSettings.update(command, operation => serial(async () => {
            await operation();
            await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), session.deviceId, "widgets.settings-updated", JSON.stringify(command)]);
          }));
        } else {
          const requestId = idSchema.optional().parse(url.searchParams.get("requestId") ?? undefined);
          view = this.widgetSettings.status(requestId);
        }
        view.workersNeedingUpdate = (await this.store.bots(userId)).filter(bot => { const worker = this.bots.get(bot.id); return worker && !worker.widgetPolicy; }).map(({ id, name }) => ({ id, name }));
        await reply(200, view); return;
      }
      if (route === "/api/integrations/voice" && ["GET", "PUT"].includes(req.method ?? "")) {
        await requireOwner();
        try {
          let view: VoiceSettingsState;
          if (req.method === "PUT") {
            const command = voiceSettingsUpdateSchema.parse(await this.jsonBody(req, 4096));
            view = await this.voiceSettings.update(command, session.deviceId, validate, operation => serial(async () => {
              await operation();
              await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), session.deviceId, "voice.settings-updated", JSON.stringify({ requestId: command.requestId, mode: command.mode, thresholdSeconds: command.thresholdSeconds, adapterId: command.adapterId })]);
            }));
          } else {
            const requestId = url.searchParams.get("requestId");
            if (requestId && !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new HubError("invalid_request", 400);
            view = await this.voiceSettings.status(requestId ?? undefined);
          }
          const bots = await this.store.bots(userId);
          view.workersNeedingUpdate = bots.filter(bot => { const worker = this.bots.get(bot.id); return worker && !worker.voicePolicy; }).map(({ id, name }) => ({ id, name }));
          await reply(200, view); return;
        } catch (error) { if (error instanceof VoiceSettingsError) throw new HubError(error.code, error.status); throw error; }
      }
      if (route === "/api/screens/status" && req.method === "GET") { await reply(200, await this.remoteScreen.status(session)); return; }
      if (route === "/api/screens/configure" && req.method === "POST") {
        const { command, proof } = signedScreenConfigureSchema.parse(await this.jsonBody(req, SCREEN_MAX_CONTROL_BYTES));
        await reply(200, await this.remoteScreen.configure(session, command, proof)); return;
      }
      if (route === "/api/screens/sessions" && req.method === "POST") { await reply(201, await this.remoteScreen.open(session, await this.jsonBody(req, SCREEN_MAX_CONTROL_BYTES))); return; }
      if (route === "/api/screens/stop" && req.method === "POST") { const input = screenStopSchema.parse(await this.jsonBody(req, 4096)); await this.remoteScreen.stop(session, input.sessionId); await reply(200, { ok: true }); return; }
      if (route === "/api/integrations/asr" && req.method === "GET") {
        await requireOwner(); await reply(200, await this.asrSetup.status()); return;
      }
      if (route === "/api/integrations/asr/install" && req.method === "POST") {
        await requireOwner(); const command = asrInstallSchema.parse(await this.jsonBody(req, 4096));
        const job = await this.asrSetup.start(command, () => serial(async () => {
          await this.store.db.run("INSERT INTO audit_log(at,actor,kind,detail_json) VALUES(?,?,?,?)", [Date.now(), session.deviceId, "asr.install-requested", JSON.stringify(command)]);
        }), validate).catch(error => { if (error instanceof AsrSetupError) throw new HubError(error.code, error.status); throw error; });
        await reply(202, job); return;
      }
      const recordedChangesRoute = route.match(/^\/api\/messages\/([A-Za-z0-9_-]+)\/changes(\/file)?$/);
      if (recordedChangesRoute && req.method === "GET") {
        await requireOwner();
        if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new HubError("invalid_request", 400);
        const query = (recordedChangesRoute[2] ? runChangeFileQuerySchema : runChangesQuerySchema).parse(Object.fromEntries(url.searchParams));
        const controller = new AbortController(); this.downloads.set(controller, session);
        const cancel = () => controller.abort(); res.once("close", cancel); if (res.destroyed) cancel();
        try {
          const result = await this.runChanges.read(userId, recordedChangesRoute[1]!, query, controller.signal, validate);
          // Scope/deletion/session checks and publication share one DB queue
          // slot: a revoke/delete queued during rendering wins before response.
          await serial(async () => {
            await this.store.requireMember(userId, query.conversationId);
            const visible = await this.store.db.get("SELECT 1 FROM messages WHERE id=? AND author_id=? AND author_type='bot' AND conversation_id=? AND status!='deleted' AND NOT EXISTS(SELECT 1 FROM message_deletions d WHERE d.message_id=messages.id AND d.user_id=?)", [recordedChangesRoute[1]!, query.botId, query.conversationId, userId]);
            if (!visible) throw new HubError("message_not_found", 404);
            if (controller.signal.aborted) throw new HubError("request_aborted", 499);
            this.json(res, 200, result);
          });
        }
        finally { res.off("close", cancel); this.downloads.delete(controller); }
        return;
      }
      const changesRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/changes(\/file)?$/);
      if (changesRoute && req.method === "GET") {
        await requireOwner();
        if ([...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new HubError("invalid_request", 400);
        const fileQuery = changesRoute[2] ? workspaceFileDiffQuerySchema.parse(Object.fromEntries(url.searchParams)) : undefined;
        const query = fileQuery ?? workspaceChangesQuerySchema.parse(Object.fromEntries(url.searchParams));
        const scope = { conversationId: changesRoute[1]!, botId: query.botId };
        const authorize = () => serial(async () => { await this.store.requireMember(userId, scope.conversationId); await this.store.requireBot(scope.botId, scope.conversationId); });
        await authorize();
        const controller = new AbortController(); this.downloads.set(controller, session);
        const cancel = () => controller.abort(new HubError("request_aborted", 499));
        res.once("close", cancel); if (res.destroyed) cancel();
        try {
          const result = fileQuery
            ? await this.workspaceDiff.file(scope, fileQuery.path, fileQuery.preview === "1", controller.signal, authorize)
            : await this.workspaceDiff.list(scope, controller.signal, authorize);
          await authorize(); await reply(200, result);
        } finally { res.off("close", cancel); this.downloads.delete(controller); }
        return;
      }
      if (route === "/api/bot-messages/grants" && (req.method === "GET" || req.method === "POST")) {
        await requireOwner();
        if (req.method === "GET") await reply(200, await this.botMessages.readGrants(userId, validateInQueue));
        else {
          const input = z.object({ command: z.record(z.string(), z.unknown()), proof: deviceActionProofSchema }).strict().parse(await this.jsonBody(req));
          await reply(200, await this.botMessages.updateGrants(userId, session.deviceId, input.command, validateInQueue,
            () => this.auth.consumeBotMessageGrant(session, hashSecret(networkCanonical(input.command)), input.proof)));
        }
        return;
      }
      // App owner devices: one-way grants from another Host's Bot to this Host's
      // Bots. Same signed domain/storage as the local tab; the legacy loopback
      // CLI route below keeps its own local-controller requirement.
      if (route === "/api/bot-messages/cross-host-grants" && (req.method === "GET" || req.method === "POST")) {
        await requireOwner();
        if (req.method === "GET") await reply(200, await this.botMessages.readCrossHostGrants(userId, validateInQueue));
        else {
          const input = z.object({ command: z.record(z.string(), z.unknown()), proof: deviceActionProofSchema }).strict().parse(await this.jsonBody(req));
          await reply(200, await this.botMessages.updateCrossHostGrants(userId, session.deviceId, input.command, validateInQueue,
            () => this.auth.consumeBotMessageGrant(session, hashSecret(networkCanonical(input.command)), input.proof)));
        }
        return;
      }
      if (route === "/api/bot-messages/grant" && req.method === "POST") {
        if (!instanceAllowed || !isLoopback(req.socket.remoteAddress ?? "")) throw new HubError("local_controller_required", 403);
        messageControllerRequired = true; await requireOwner();
        const input = z.object({ command: z.record(z.string(), z.unknown()), proof: deviceActionProofSchema }).strict().parse(await this.jsonBody(req));
        await reply(200, await this.botMessages.grant(input.command, validateInQueue, () => this.auth.consumeBotMessageGrant(session, hashSecret(networkCanonical(input.command)), input.proof), session.deviceId)); return;
      }
      if (route === "/api/bot-messages/local" && req.method === "POST") {
        if (!instanceAllowed || !isLoopback(req.socket.remoteAddress ?? "")) throw new HubError("local_controller_required", 403);
        messageControllerRequired = true; await requireOwner(); const input = botLocalRequestSchema.parse(await this.jsonBody(req, BOT_TRANSFER_BYTES));
        if (!input.sourceBot) throw new HubError("bot_message_source_required", 400);
        await reply(200, await this.botMessages.local(input, input.sourceBot, validateInQueue, true)); return;
      }
      const runRoute = /^\/api\/messages\/([\w-]{1,128})\/run$/.exec(route);
      if (runRoute && req.method === "GET") {
        const after = z.coerce.number().int().min(0).max(2000).parse(url.searchParams.get("after") ?? 0);
        const tail = z.literal("1").optional().parse(url.searchParams.get("tail") ?? undefined) === "1";
        const before = z.coerce.number().int().min(1).max(2001).optional().parse(url.searchParams.get("before") ?? undefined);
        if ((tail && before !== undefined) || ((tail || before !== undefined) && after !== 0)) throw new HubError("invalid_request", 400);
        const query = z.string().max(200).parse(url.searchParams.get("q") ?? "");
        const includeScopes = url.searchParams.get("scopes") === "1";
        await reply(200, await new RunJournal(this.store).read(userId, runRoute[1]!, after, query, includeScopes, { tail, before })); return;
      }
      if (route === "/api/host-profile" && (req.method === "GET" || req.method === "PATCH")) {
        if (req.method === "GET") await reply(200, await this.profile.read(validateInQueue));
        else { await requireOwner(); await reply(200, await this.profile.update(await this.jsonBody(req), validateInQueue)); }
        return;
      }
      if (route === "/api/network" && req.method === "GET") {
        await requireOwner(); await reply(200, await this.network.view(validateInQueue)); return;
      }
      if (route === HOST_ROUTES_PATH && req.method === "GET") {
        await requireOwner(); await reply(200, await this.hostRoutes.view(validateInQueue)); return;
      }
      if (route === "/api/network/manage" && req.method === "POST") {
        await requireOwner();
        // Keep the signed command's original representation for the network
        // layer's canonical-input check; do not normalize nested names/routes.
        const input = z.object({ command: z.unknown(), proof: deviceActionProofSchema.optional() }).strict().parse(await this.jsonBody(req, MAX_NETWORK_BYTES));
        const result = await this.network.command(input.command, session, input.proof);
        const completed = networkCommandSchema.parse(input.command);
        // An active departure intentionally revokes the requesting phone too.
        // Only return its already-authorized, root-verified departure receipt;
        // all other operations still recheck the session before their reply.
        if (completed.operation === "leave" && completed.expectedState === "active" && result.view.sync === "standalone"
          && result.membership?.manifest.id === completed.networkId
          && result.membership.manifest.hosts.some(host => host.publicKey === this.auth.publicKey && host.revoked)) this.json(res, 200, result);
        else await reply(200, result);
        return;
      }
      if (route === "/api/conversations/batch" && req.method === "POST") {
        const result = await new ConversationBatchOperations(this.store).apply(userId, await this.jsonBody(req), validateInQueue);
        for (const conversation of result.conversations) for (const client of this.clients) {
          if (client.conversationIds.has(conversation.id)) this.publishClient(client, { v: 1, type: "conversation.updated", conversation });
        }
        if (result.folders) for (const client of this.clients) if (client.session?.userId === userId) this.publishClient(client, { v: 1, type: "conversation-folders.updated", folders: result.folders });
        await reply(200, result);
        return;
      }
      if (route === "/api/conversation-folders" && (req.method === "GET" || req.method === "PATCH")) {
        if (req.method === "GET") await reply(200, await this.conversationFolders.read(userId, validateInQueue));
        else {
          const folders = await this.conversationFolders.change(userId, await this.jsonBody(req), validateInQueue);
          for (const client of this.clients) if (client.session?.userId === userId) this.publishClient(client, { v: 1, type: "conversation-folders.updated", folders });
          await reply(200, folders);
        }
        return;
      }
      const queueRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/queue$/);
      if (queueRoute && (req.method === "GET" || req.method === "POST")) {
        const conversationId = queueRoute[1]!, queue = new HubPromptQueue(this.store);
        if (req.method === "GET") await reply(200, await queue.read(userId, idSchema.parse(url.searchParams.get("botId")), conversationId, validateInQueue));
        else {
          const input = promptQueueMutationSchema.parse(await this.jsonBody(req));
          const result = await queue.mutate(userId, conversationId, input, validateInQueue);
          await reply(200, result);
          this.trackTask(this.dispatchPending(input.botId).catch(() => this.options.onWarning?.("queue_dispatch_failed")));
        }
        return;
      }
      const sideRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/side(?:\/([A-Za-z0-9_-]+)(\/stop)?)?$/);
      if (sideRoute && ["GET", "POST", "DELETE"].includes(req.method ?? "")) {
        const conversationId = sideRoute[1]!, sideId = sideRoute[2];
        let botId: string, method: string, input: { sideId?: string; requestId?: string; text?: string; revision?: number; attachments?: string[]; withAttachments?: boolean; withAudio?: boolean; withTools?: boolean; withDelivery?: boolean; delivery?: true; tools?: "inherited" } = {};
        if (!sideId && req.method === "POST") { const parsed = sideOpenSchema.parse(await this.jsonBody(req, 4096)); botId = parsed.botId; input = { requestId: parsed.requestId, ...(parsed.tools ? { tools: parsed.tools } : {}), ...(parsed.delivery ? { delivery: true } : {}) }; method = "side.open"; }
        else if (sideId && !sideRoute[3] && req.method === "POST") { const parsed = sideAskSchema.parse(await this.jsonBody(req, 80_000)); botId = parsed.botId; input = { sideId, requestId: parsed.requestId, text: parsed.text, ...(parsed.attachments ? { attachments: parsed.attachments } : {}) }; method = "side.ask"; }
        else if (sideId && sideRoute[3] && req.method === "POST") { botId = z.object({ botId: idSchema }).strict().parse(await this.jsonBody(req, 4096)).botId; input = { sideId }; method = "side.stop"; }
        else if (!sideRoute[3] && (req.method === "GET" || sideId && req.method === "DELETE")) {
          botId = idSchema.parse(url.searchParams.get("botId")); method = req.method === "DELETE" ? "side.close" : sideId ? "side.read" : "side.status";
          if (sideId) input = { sideId, ...(url.searchParams.has("revision") && req.method === "GET" ? { revision: z.coerce.number().int().nonnegative().parse(url.searchParams.get("revision")) } : {}) };
          // Attachment capability is opt-in so older strict clients keep their reply shape;
          // audio (Gateway ASR) is a further opt-in within it.
          else input = { ...(url.searchParams.get("attachments") === "1" ? { withAttachments: true, ...(url.searchParams.get("audio") === "1" ? { withAudio: true } : {}) } : {}), ...(url.searchParams.get("tools") === "1" ? { withTools: true } : {}), ...(url.searchParams.get("delivery") === "1" ? { withDelivery: true } : {}) };
        } else throw new HubError("not_found", 404);
        await reply(200, await this.sideSessions.request(session, conversationId, botId, method, input)); return;
      }
      const inputRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/inputs\/([A-Za-z0-9_-]+)$/);
      if (inputRoute && req.method === "POST") {
        const input = nativeInputControlRequestSchema.parse(await this.jsonBody(req, 4096));
        const [ , conversationId, messageId ] = inputRoute;
        const authorize = async () => {
          await this.auth.validateSession(session);
          return serial(() => this.store.nativeInputForControl(userId, conversationId!, messageId!));
        };
        const { botId, inputId, targetId } = await authorize();
        // Without the worker's receipt we cannot tell whether this is the
        // first attempt or a check of an already performed control.
        if (!this.bots.get(botId)?.nativeInput) { await reply(200, { outcome: "unknown", reason: "uncertain" }); return; }
        let result;
        try { result = nativeInputControlResultSchema.parse(await this.callBot(botId, "input.control", { conversationId, userId, inputId, ...input })); }
        catch { result = { outcome: "unknown", reason: "uncertain" } as const; }
        await authorize();
        if (result.outcome === "accepted" && result.result === "cancelled") await this.store.applyNativeInputProgress(botId, { conversationId, userId, requestId: inputId, targetId, progress: { state: "cancelled" } });
        await reply(200, result); return;
      }
      const steerRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/steer$/);
      const tasksRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/tasks(\/recover)?$/);
      if (tasksRoute && (req.method === "GET" || req.method === "POST")) {
        const conversationId = tasksRoute[1]!;
        if (tasksRoute[2] && req.method !== "POST") throw new HubError("not_found", 404);
        const input = req.method === "POST" ? (tasksRoute[2] ? engineSessionRecoverySchema : engineTaskStopSchema).parse(await this.jsonBody(req, 4096)) : undefined;
        const botId = input?.botId ?? idSchema.parse(url.searchParams.get("botId"));
        const authorize = async () => {
          await this.auth.validateSession(session);
          await serial(async () => { await this.store.requireMember(userId, conversationId); await this.store.requireBot(botId, conversationId); });
        };
        await authorize();
        const worker = this.bots.get(botId);
        if (!worker) throw new HubError("bot_offline", 409);
        if (!worker.engineTasks) { await reply(200, input ? { outcome: "rejected", reason: "unsupported" } : { supported: false, tasks: [] }); return; }
        const result = input
          ? engineTaskControlResultSchema.parse(await this.callBot(botId, "token" in input ? "tasks.recover" : "tasks.stop", { conversationId, userId, requestId: input.requestId, ...("token" in input ? { token: input.token } : { taskId: input.taskId }) }))
          : engineTaskSnapshotSchema.parse(await this.callBot(botId, "tasks.list", { conversationId }));
        await authorize();
        await reply(200, result); return;
      }
      if (steerRoute && (req.method === "GET" || req.method === "POST")) {
        const conversationId = steerRoute[1]!;
        const input = req.method === "POST" ? steerRequestSchema.parse(await this.jsonBody(req)) : undefined;
        const botId = input?.botId ?? idSchema.parse(url.searchParams.get("botId"));
        await serial(async () => { await this.store.requireMember(userId, conversationId); await this.store.requireBot(botId, conversationId); });
        await this.auth.validateSession(session);
        if (!input) {
          // A background-review target is opt-in per caller and per worker: an
          // older Gateway's strict status call would reject the extra field.
          const backgroundReview = url.searchParams.get("review") === "1" && this.bots.get(botId)?.nativeReviewInput === true;
          const status = steerStatusSchema.parse(await this.callBot(botId, "steer.status", { conversationId, ...(backgroundReview ? { backgroundReview: true } : {}) }));
          const { nativeInput, targetKind: _targetKind, ...legacy } = status;
          await reply(200, this.bots.get(botId)?.nativeInput ? status : legacy); return;
        }
        // Only a new native input freezes the sender's own visible opener; a
        // retry of a saved input keeps its original context unvalidated.
        const context = input.workbench;
        if (context && !await serial(() => this.store.db.get("SELECT 1 FROM messages WHERE author_id=? AND client_msg_id=?", [userId, input.requestId]))) {
          if (!workbenchOpenerOnly(context) || Object.keys(context).length !== 2) throw new HubError("invalid_workbench_context", 400);
          await this.workbench.validateContext(userId, conversationId, context, session.deviceId);
        }
        const { message, created } = await this.store.beginSteeringRecord(userId, { ...input, conversationId }, async created => { await validateInQueue(); if (created && context) this.workbench.assertContextActive(userId, conversationId, context); });
        const prior = message.blocks.find((block) => block.type === "steering")!;
        if (prior.outcome === "accepted" || prior.outcome === "rejected") { await reply(200, message); return; }
        // This may be a check of a previously written input after a worker
        // downgrade/disconnect. Lack of today's capability cannot prove that
        // the original input was never admitted, so never authorize a resend.
        if (prior.mode && !this.bots.get(botId)?.nativeInput) { await reply(200, await this.store.finishSteering(message.id, created ? { outcome: "rejected", reason: "unsupported" } : { outcome: "unknown", reason: "uncertain" })); return; }
        // HTTP controls aren't replayed on reconnect. The Gateway fsyncs an
        // at-most-once receipt; explicit checks reuse the same request/target ID.
        let result;
        // A review-capable worker gets this exact record's ID: an input to a
        // background-review target becomes a new turn replying to it.
        const exact = prior.mode && this.bots.get(botId)?.nativeReviewInput ? { messageId: message.id } : {};
        // In flight until its run binding is durable: design.open waits meanwhile.
        const connection = this.bots.get(botId), current = this.steersInFlight.get(message.id);
        const flight = current && current.connection === connection ? current : { botId, conversationId, connection: connection!, calls: 0, begun: false, ended: false };
        if (connection) { flight.calls++; this.steersInFlight.set(message.id, flight); }
        try {
          try { result = steerResultSchema.parse(await this.callBot(botId, "steer", { conversationId, userId, requestId: input.requestId, targetId: input.targetId, text: input.text, ...(prior.mode ? { mode: prior.mode } : {}), ...exact })); }
          catch { result = { outcome: "unknown", reason: "uncertain" } as const; }
          const { sourceMessageId: runSource, ...outcome } = result;
          // design.open must not reach the run's old device once this input may
          // be part of it. A reported run, or without one every live run of
          // this Bot here, remembers it; adoption is proven separately.
          if (connection?.designOpen && outcome.outcome !== "rejected") {
            for (const parent of runSource ? [runSource] : await this.liveRunSources(botId, conversationId)) if (parent !== message.id && await this.liveRunSource(botId, conversationId, parent, connection)) await this.store.bindRunInput(parent, message.id);
          }
          await reply(200, await this.store.finishSteering(message.id, outcome)); return;
        } finally { if (connection && --flight.calls <= 0 && this.steersInFlight.get(message.id) === flight) this.steersInFlight.delete(message.id); }
      }
      if (route === "/api/avatars" && req.method === "GET") { await reply(200, await this.avatars.list(userId, session)); return; }
      const avatarRoute = route.match(/^\/api\/avatars\/(user|bot|group)\/([A-Za-z0-9_-]+)(?:\/(\d+))?$/);
      if (avatarRoute) {
        const target = avatarTargetSchema.parse({ kind: avatarRoute[1], id: avatarRoute[2] });
        if (req.method === "PUT" && !avatarRoute[3]) {
          const avatar = await this.avatars.set(userId, target, await this.jsonBody(req), session);
          for (const client of this.clients) if (client.session && await this.avatars.canRead(client.session.userId, target)) this.publishClient(client, { v: 1, type: "avatar.updated", avatar });
          await reply(200, avatar); return;
        }
        if (req.method === "GET" && avatarRoute[3]) {
          const bytes = await this.avatars.image(userId, target, Number(avatarRoute[3]), session);
          await validate();
          res.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" }); res.end(bytes); return;
        }
        throw new HubError("not_found", 404);
      }
      if (route.startsWith("/api/attachment-admin/")) {
        await requireOwner();
        if (route === ATTACHMENT_ADMIN_SUMMARY_PATH && req.method === "GET") { await reply(200, await attachmentAdminSummary(this.store, userId)); return; }
        if (route === ATTACHMENT_ADMIN_LIST_PATH && req.method === "GET") {
          await reply(200, await attachmentAdminList(this.store, userId, attachmentAdminListQuerySchema.parse(Object.fromEntries(url.searchParams)))); return;
        }
        if (route === ATTACHMENT_ADMIN_DELETE_PATH && req.method === "POST") {
          const input = attachmentAdminDeleteSchema.parse(await this.jsonBody(req)); await validate();
          const result = await retireAttachments(this.store, userId, input);
          // Retirement is committed; a failed unlink is retried by daily GC.
          try { await this.attachments.purge(result.ids); }
          catch (error) { await this.store.audit("attachment.purge_retry", session.deviceId, { count: result.ids.length, code: (error as NodeJS.ErrnoException).code ?? "purge_failed" }); }
          await reply(200, result); return;
        }
        throw new HubError("not_found", 404);
      }
      if (route === "/api/files" || route.startsWith("/api/files/")) {
        await requireOwner();
        if (route === "/api/files" && req.method === "GET") { await reply(200, await this.fileCenter.poll(url.searchParams.get("revision") ?? undefined)); return; }
        if (route === "/api/files/scan" && req.method === "POST") { await this.fileCenter.start(validate); await reply(202, await this.fileCenter.status()); return; }
        if (route === "/api/files/cancel" && req.method === "POST") { this.fileCenter.cancel(); await reply(200, { ok: true }); return; }
        if (route === "/api/files/labels" && req.method === "PATCH") {
          const input = fileLabelPatchSchema.parse(await this.jsonBody(req)); await this.fileCenter.label(input, validate);
          await this.store.audit("file_center.label_updated", session.deviceId, { unitId: input.unitId });
          await reply(200, await this.fileCenter.status()); return;
        }
        if (route === "/api/files/reveal" && req.method === "POST") {
          const { unitId } = z.object({ unitId: fileUnitIdSchema }).strict().parse(await this.jsonBody(req)); await this.fileCenter.reveal(unitId, validate);
          await this.store.audit("file_center.revealed", session.deviceId, { unitId }); await reply(200, { ok: true }); return;
        }
        throw new HubError("not_found", 404);
      }
      if (route === "/api/bots/catalog" && req.method === "GET" || route === "/api/bots" && req.method === "POST") {
        await requireOwner();
        if (!this.botManager) throw new HubError("bot_creation_unavailable", 503);
        if (req.method === "GET") await reply(200, await this.botManager.catalog());
        else await reply(201, await this.botManager.create(userId, createBotSchema.parse(await this.jsonBody(req)), validateInQueue));
        return;
      }
      const deleteBotRoute = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)$/);
      if (deleteBotRoute && req.method === "DELETE") {
        await requireOwner();
        if (!this.botManager) throw new HubError("bot_delete_unavailable", 503);
        const botId = deleteBotRoute[1]!, input = deleteBotSchema.parse(await this.jsonBody(req));
        const conversations = await this.botManager.delete(userId, botId, input.expectedName, validateInQueue);
        const workers = await this.store.db.serial(() => this.store.db.all<{ id: string; name: string }>("SELECT b.id,b.name FROM dispatch_workers w JOIN bots b ON b.id=w.bot_id WHERE w.dispatcher_bot_id=? AND b.deleted_at IS NULL", [botId]));
        // A deleted dispatcher's engine workers stop with it; their history stays.
        for (const worker of workers) await this.botManager.delete(userId, worker.id, worker.name).catch(() => this.options.onWarning?.("dispatch_worker_delete_failed"));
        this.bots.get(botId)?.ws.close(4003, "bot_deleted");
        await this.settleDiscussion(() => this.groupDiscussions.settleBot(botId));
        // The deletion is committed; later Bus reads and startup reconcile retry.
        await this.agentBuses.settleCoordinator(botId).catch(() => this.options.onWarning?.("agent_bus_settle_failed"));
        for (const conversation of conversations) for (const client of this.clients) if (client.conversationIds.has(conversation.id)) this.publishClient(client, { v: 1, type: "conversation.updated", conversation });
        await reply(200, { bot: (await this.store.bots(userId, true)).find(bot => bot.id === botId), conversations });
        return;
      }
      const botNameRoute = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/name$/);
      if (botNameRoute && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = botNameRoute[1]!;
        if (req.method === "GET") await reply(200, await this.store.botName(userId, botId));
        else {
          const result = await this.store.renameBot(userId, botId, renameBotSchema.parse(await this.jsonBody(req)), validateInQueue);
          await this.broadcastBotStatus(botId);
          await this.store.audit("bot.renamed", session.deviceId, { botId });
          await reply(200, result);
        }
        return;
      }
      const groupSettingsRoute = route.match(/^\/api\/groups\/([A-Za-z0-9_-]+)\/settings$/);
      if (groupSettingsRoute && req.method === "GET") { await reply(200, await this.store.groupSettings(userId, groupSettingsRoute[1]!, validateInQueue)); return; }
      if (groupSettingsRoute && req.method === "PUT") {
        const { groupSettingsSchema } = await import("../client-protocol/groups.js");
        const changed = await this.store.updateGroup(userId, groupSettingsRoute[1]!, groupSettingsSchema.parse(await this.jsonBody(req)), validateInQueue);
        for (const conversation of changed) for (const client of this.clients) if (client.conversationIds.has(conversation.id)) this.publishClient(client, { v: 1, type: "conversation.updated", conversation });
        await reply(200, changed); return;
      }
      const discussionRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/discussion(?:\/([A-Za-z0-9_-]+)\/(control|notes|steps\/([A-Za-z0-9_-]+)))?$/);
      if (discussionRoute && (req.method === "POST" ? !discussionRoute[3] || discussionRoute[3] === "control" || discussionRoute[3] === "notes" : req.method === "GET" && (!discussionRoute[2] || !!discussionRoute[4]))) {
        const conversationId = discussionRoute[1]!, runId = discussionRoute[2];
        // Reads never settle or advance a run; only receipts and controls do.
        if (req.method === "GET" && discussionRoute[4]) await reply(200, await this.groupDiscussions.step(userId, conversationId, runId!, discussionRoute[4], validateInQueue));
        else if (req.method === "GET") {
          const query = z.object({ brief: z.literal("1").optional(), known: z.string().max(260).optional() }).strict().parse(Object.fromEntries(url.searchParams));
          await reply(200, await this.groupDiscussions.read(userId, conversationId, validateInQueue, { brief: query.brief === "1", ...(query.known !== undefined ? { known: query.known } : {}) }));
        }
        else if (!runId) await reply(200, await this.groupDiscussions.start(userId, conversationId, await this.jsonBody(req), validateInQueue));
        else if (discussionRoute[3] === "notes") await reply(200, await this.groupDiscussions.note(userId, conversationId, runId, await this.jsonBody(req), validateInQueue));
        else {
          await reply(200, await this.groupDiscussions.control(userId, conversationId, runId, await this.jsonBody(req), validateInQueue));
          // A resumed run may release a held input; let every Bot claim now.
          this.trackTask(this.dispatchPending().catch(() => this.options.onWarning?.("queue_dispatch_failed")));
        }
        return;
      }
      if (route === "/api/conversations" && req.method === "POST") {
        const parsed = parseClientFrame(JSON.stringify(await this.jsonBody(req)));
        if (!("frame" in parsed)) throw new HubError("invalid_request");
        const frame = parsed.frame;
        if (frame.type !== "conversation.create" && frame.type !== "topic.create") throw new HubError("invalid_request");
        await reply(201, await this.createConversation(userId, frame, validateInQueue)); return;
      }
      const widgetRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/widgets$/);
      if (widgetRoute && req.method === "POST") {
        const { requestId, ...raw } = z.object({ requestId: idSchema }).passthrough().parse(await this.jsonBody(req));
        await reply(200, await this.store.publishUserWidget(userId, widgetRoute[1]!, requestId, widgetBlock(validateWidget(raw)), validateInQueue, () => this.widgetSettings.assertEnabled()));
        return;
      }
      const clearRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/messages\/clear$/);
      if (clearRoute && (req.method === "GET" || req.method === "POST")) {
        if (req.method === "GET") await reply(200, await this.store.planClearMessages(userId, clearRoute[1]!));
        else {
          const { clearMessagesInputSchema } = await import("../client-protocol/message-clear.js");
          await reply(200, await this.store.clearMessages(userId, clearRoute[1]!, clearMessagesInputSchema.parse(await this.jsonBody(req)), validateInQueue));
        }
        return;
      }
      const messagesRoute = route.match(/^\/api\/conversations\/([A-Za-z0-9_-]+)\/messages$/);
      if (messagesRoute && (req.method === "DELETE" || req.method === "GET")) {
        if (req.method === "DELETE") {
          const { deleteMessagesSchema } = await import("../client-protocol/message-deletion.js");
          await reply(200, await this.store.deleteMessages(userId, messagesRoute[1]!, deleteMessagesSchema.parse(await this.jsonBody(req)), validateInQueue));
        } else await reply(200, await this.store.listMessages(userId, messagesRoute[1]!, idSchema.optional().parse(url.searchParams.get("before") ?? undefined)));
        return;
      }
      if (route === "/api/gdocs/status" && req.method === "GET") {
        await requireOwner();
        const status = this.options.googleDocs ? await googleDocsStatus(this.options.googleDocs) : { configured: false, authorized: false, error: "google_docs_not_configured" };
        await requireOwner();
        await reply(200, status); return;
      }
      if (route === "/api/gdocs/export" && req.method === "POST") {
        await requireOwner();
        const { messageId } = z.object({ messageId: idSchema }).strict().parse(await this.jsonBody(req));
        const message = await this.store.messageForUser(userId, messageId);
        if (!this.options.googleDocs) throw new HubError("google_docs_not_configured", 503);
        let document;
        try {
          const docs = await this.options.googleDocs();
          document = await exportGoogleDocument(this.store, this.options.stateDir, userId, message, docs, validateInQueue);
        } catch (error) {
          if (error instanceof HubError) throw error;
          throw new HubError(googleDocsErrorCode(error), 503);
        }
        await serial(() => this.store.requireMember(userId, message.conversationId));
        await reply(200, document); return;
      }
      if (route === "/api/ops" && req.method === "GET") {
        await requireOwner();
        const bots = await this.store.bots(userId);
        const instances = await Promise.all(bots.map(async (bot) => ({ ...bot, ...(bot.online ? { status: await this.callBot(bot.id, "status", {}).catch(() => null) } : {}) })));
        await reply(200, { hub: { uptimeSeconds: Math.floor(process.uptime()), memoryBytes: process.memoryUsage().rss, routes: this.urls, clients: this.clients.size }, instances }); return;
      }
      if (route === "/api/ops/audit" && req.method === "GET") {
        await requireOwner();
        const query = diagnosticQuerySchema.parse(Object.fromEntries(url.searchParams));
        if (query.source !== "audit") throw new HubError("hub_audit_only");
        const controller = new AbortController();
        const cancel = () => controller.abort(new HubError("request_aborted", 499));
        res.once("close", cancel); if (res.destroyed) cancel();
        try { await reply(200, diagnosticPageSchema.parse(await readHubDiagnostics(this.store, query, controller.signal))); }
        finally { res.off("close", cancel); }
        return;
      }
      const schedules = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/schedules$/);
      if (schedules && (req.method === "GET" || req.method === "POST")) {
        await requireOwner();
        const botId = schedules[1]!;
        if (!(await this.store.bots(userId)).some(bot => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        if (req.method === "GET") {
          const raw = await this.callBot(botId, "schedules.list", {});
          const result = scheduledTasksSchema.safeParse(raw);
          if (!result.success) throw new HubError("scheduler_unavailable", 503);
          const allowed = new Set((await this.store.conversations(userId)).filter(c => c.botIds.includes(botId)).map(c => c.id));
          await reply(200, { ...result.data, jobs: result.data.jobs.filter(job => allowed.has(job.conversationId)) });
        } else {
          const input = z.object({ mutation: scheduleMutationSchema, locale: z.enum(["zh", "en"]) }).strict().parse(await this.jsonBody(req));
          const conversations = await this.store.conversations(userId);
          const conversation = conversations.find(c => c.id === input.mutation.conversationId && c.botIds.includes(botId));
          if (!conversation) throw new HubError("conversation_forbidden", 403);
          const disabling = input.mutation.action === "remove" || input.mutation.action === "enabled" && !input.mutation.enabled;
          if (!disabling && (conversation.archived || conversations.some(c => c.id === conversation.parentId && c.archived))) throw new HubError("conversation_archived", 409);
          await validate();
          const result = scheduleResultSchema.parse(await this.callBot(botId, "schedules.mutate", { ...input, userId }));
          if (!result.ok) throw new HubError(result.error, 409);
          await this.store.audit("bot.schedule_updated", session.deviceId, { botId, action: input.mutation.action });
          await reply(200, result);
        }
        return;
      }
      const dispatcher = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/(dispatcher|tickets|tickets\/dispatch|tickets\/update|dispatch-targets|dispatch-capabilities)$/);
      if (dispatcher) {
        await requireOwner();
        const [, botId, kind] = dispatcher as unknown as [string, string, string], owner = { kind: "owner" as const, userId, validate: validateInQueue };
        if (kind === "dispatcher" && req.method === "GET") { await reply(200, await this.dispatch.settings(userId, botId)); return; }
        if (kind === "dispatcher" && req.method === "PUT") { const result = await this.dispatch.updateSettings(userId, botId, await this.jsonBody(req), validateInQueue); await this.store.audit("dispatch.settings_updated", session.deviceId, { botId }); await reply(200, result); return; }
        if (kind === "tickets" && req.method === "GET") {
          const query = new URL(req.url ?? "/", "http://hub").searchParams, options = { open: query.get("open") === "1", capabilities: query.get("capabilities") === "1" };
          await reply(200, query.get("summary") === "1" ? await this.dispatch.overview(owner, botId, options) : await this.dispatch.list(owner, botId, options)); return;
        }
        if (kind === "tickets" && req.method === "POST") { await reply(201, await this.dispatch.create(owner, botId, await this.jsonBody(req))); return; }
        if (kind === "tickets/dispatch" && req.method === "POST") { await reply(200, await this.dispatch.dispatch(owner, botId, await this.jsonBody(req))); return; }
        if (kind === "tickets/update" && req.method === "POST") { await reply(200, await this.dispatch.update(owner, botId, await this.jsonBody(req))); return; }
        if (kind === "dispatch-targets" && req.method === "GET") { await reply(200, await this.dispatch.targets(owner, botId)); return; }
        if (kind === "dispatch-capabilities" && req.method === "GET") {
          const query = new URL(req.url ?? "/", "http://hub").searchParams;
          await reply(200, await this.dispatch.capabilities(owner, botId, { ...Object.fromEntries(query), ...(query.has("offset") ? { offset: Number(query.get("offset")) } : {}) })); return;
        }
      }
      const ticket = route.match(/^\/api\/tickets\/([A-Za-z0-9_-]+)(\/action|\/assists)?$/);
      if (ticket) {
        await requireOwner();
        if (!ticket[2] && req.method === "GET") { await reply(200, await this.dispatch.show({ kind: "owner", userId }, ticket[1]!)); return; }
        if (ticket[2] === "/assists" && req.method === "GET") { await reply(200, await this.dispatch.assists({ kind: "owner", userId }, ticket[1]!)); return; }
        if (ticket[2] === "/action" && req.method === "POST") { await reply(200, await this.dispatch.action(userId, ticket[1]!, await this.jsonBody(req), validateInQueue)); return; }
      }
      const engineReset = route.match(/^\/api\/dispatch\/engines\/([a-z]+)\/reset$/);
      if (engineReset && req.method === "POST") { await requireOwner(); await reply(200, await this.dispatch.resetEngine(userId, engineReset[1], validateInQueue)); return; }
      const persona = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/persona$/);
      if (persona && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = persona[1]!;
        if (!(await this.store.bots(userId)).some(bot => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        const input = req.method === "PUT" ? personaPatchSchema.parse(await this.jsonBody(req)) : {};
        const result = personaResultSchema.parse(await this.callBot(botId, req.method === "PUT" ? "persona.set" : "persona.get", input));
        if (!result.ok) throw new HubError(result.error, 409);
        if (req.method === "PUT") await this.store.audit("bot.persona_updated", session.deviceId, { botId });
        await reply(200, result.settings);
        return;
      }
      const permissions = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/permissions$/);
      if (permissions && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = permissions[1]!;
        if (!(await this.store.bots(userId)).some((bot) => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        const input = req.method === "PUT" ? permissionPatchSchema.parse(await this.jsonBody(req)) : {};
        const operation = (this.permissionOperations.get(botId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          await this.auth.validateSession(session);
          await requireOwner();
          const result = permissionResultSchema.parse(await this.callBot(botId, req.method === "PUT" ? "permissions.set" : "permissions.get", input));
          if (!result.ok) throw new HubError(result.error, 409);
          if (req.method === "PUT") await this.store.audit("bot.permissions_updated", session.deviceId, { botId, choice: result.settings.choice });
          await reply(200, result.settings);
        });
        this.permissionOperations.set(botId, operation);
        try { await operation; } finally { if (this.permissionOperations.get(botId) === operation) this.permissionOperations.delete(botId); }
        return;
      }
      const chrome = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/chrome$/);
      if (chrome && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = chrome[1]!;
        if (!(await this.store.bots(userId)).some(bot => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        const input = req.method === "PUT" ? chromePatchSchema.parse(await this.jsonBody(req)) : {};
        // Browser access is a Bot permission. Revalidate the owner after waiting
        // for earlier permission operations; the config mutex protects disk state.
        const operation = (this.permissionOperations.get(botId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          await this.auth.validateSession(session); await requireOwner();
          const result = chromeResultSchema.parse(await this.callBot(botId, req.method === "PUT" ? "chrome.set" : "chrome.get", input));
          if (!result.ok) throw new HubError(result.error, 409);
          if (req.method === "PUT") await this.store.audit("bot.chrome_updated", session.deviceId, { botId, enabled: result.settings.enabled });
          await reply(200, result.settings);
        });
        this.permissionOperations.set(botId, operation);
        try { await operation; } finally { if (this.permissionOperations.get(botId) === operation) this.permissionOperations.delete(botId); }
        return;
      }
      const model = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/model$/);
      if (model && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = model[1]!;
        if (!(await this.store.bots(userId)).some(bot => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        const input = req.method === "PUT" ? modelPatchSchema.parse(await this.jsonBody(req)) : {};
        // Share the queue with effort: model changes may also change effort.
        const operation = (this.effortOperations.get(botId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          await this.auth.validateSession(session); await requireOwner();
          const result = modelResultSchema.parse(await this.callBot(botId, req.method === "PUT" ? "model.set" : "model.get", input));
          if (!result.ok) throw new HubError(result.error, 409);
          const { engine, model: value, effort } = result.settings;
          await this.store.botStatus(botId, { engine, model: value, effort }); await this.broadcastBotStatus(botId);
          if (req.method === "PUT") await this.store.audit("bot.model_updated", session.deviceId, { botId, model: value, effort });
          await reply(200, result.settings);
        });
        this.effortOperations.set(botId, operation);
        try { await operation; } finally { if (this.effortOperations.get(botId) === operation) this.effortOperations.delete(botId); }
        return;
      }
      const effort = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/effort$/);
      if (effort && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        const botId = effort[1]!;
        if (!(await this.store.bots(userId)).some((bot) => bot.id === botId)) throw new HubError("bot_forbidden", 403);
        const input = req.method === "PUT" ? effortPatchSchema.parse(await this.jsonBody(req)) : {};
        const operation = (this.effortOperations.get(botId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
          await this.auth.validateSession(session);
          await requireOwner();
          const result = effortResultSchema.parse(await this.callBot(botId, req.method === "PUT" ? "effort.set" : "effort.get", input));
          if (!result.ok) throw new HubError(result.error, 409);
          const { engine, model, effort: value } = result.settings;
          await this.store.botStatus(botId, { engine, model, effort: value });
          await this.broadcastBotStatus(botId);
          if (req.method === "PUT") await this.store.audit("bot.effort_updated", session.deviceId, { botId, effort: value });
          await reply(200, result.settings);
        });
        this.effortOperations.set(botId, operation);
        try { await operation; } finally { if (this.effortOperations.get(botId) === operation) this.effortOperations.delete(botId); }
        return;
      }
      if (route === "/api/agent-buses" && (req.method === "GET" || req.method === "POST")) {
        await requireOwner();
        if (req.method === "GET") { await reply(200, { items: await this.agentBuses.list(userId, validateInQueue) }); return; }
        const workspace = await this.agentBuses.create(userId, await this.jsonBody(req), validateInQueue);
        await this.store.audit("agent_bus.saved", session.deviceId, { workspaceId: workspace.id });
        await reply(200, workspace); return;
      }
      const agentBus = route.match(/^\/api\/agent-buses\/([A-Za-z0-9_-]+)(\/runs(?:\/([A-Za-z0-9_-]+)\/stop)?)?$/);
      if (agentBus && (agentBus[2] ? req.method === "POST" : ["GET", "PUT", "DELETE"].includes(req.method ?? ""))) {
        await requireOwner();
        const workspaceId = agentBus[1]!, runId = agentBus[3];
        if (runId) {
          const run = await this.agentBuses.stop(userId, workspaceId, runId, await this.jsonBody(req), validateInQueue);
          await this.store.audit("agent_bus.run_stop", session.deviceId, { workspaceId, runId, status: run.status });
          await reply(200, run); return;
        }
        if (agentBus[2]) {
          const run = await this.agentBuses.start(userId, workspaceId, await this.jsonBody(req), validateInQueue);
          await this.store.audit("agent_bus.run_started", session.deviceId, { workspaceId, runId: run.id, messageId: run.messageId });
          await reply(200, run); return;
        }
        if (req.method === "GET") { await reply(200, await this.agentBuses.detail(userId, workspaceId, validateInQueue)); return; }
        if (req.method === "PUT") {
          const workspace = await this.agentBuses.update(userId, workspaceId, await this.jsonBody(req), validateInQueue);
          await this.store.audit("agent_bus.saved", session.deviceId, { workspaceId });
          await reply(200, workspace); return;
        }
        const removed = await this.agentBuses.remove(userId, workspaceId, await this.jsonBody(req), validateInQueue);
        await this.store.audit("agent_bus.deleted", session.deviceId, { workspaceId });
        await reply(200, removed); return;
      }
      const collaboration = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/collaboration$/);
      if (collaboration && (req.method === "GET" || req.method === "PUT")) {
        await requireOwner();
        if (!this.botManager) throw new HubError("collaboration_managed_only", 403);
        const botId = collaboration[1]!;
        if (req.method === "PUT") {
          await saveCollaboration(this.botManager, userId, botId, await this.jsonBody(req), () => this.auth.validateSession(session));
          await this.store.audit("bot.collaboration_updated", session.deviceId, { botId });
        }
        await reply(200, await readCollaboration(this.botManager, userId, botId)); return;
      }
      const capabilities = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/capabilities$/);
      if (capabilities && req.method === "GET") {
        await requireOwner();
        const botId = capabilities[1]!;
        if (!(await this.store.bots(userId)).some((b) => b.id === botId)) throw new HubError("bot_forbidden", 403);
        z.object({}).strict().parse(Object.fromEntries(url.searchParams));
        const managed = this.botManager && await this.botManager.owns(botId);
        const result = await this.callBot(botId, "capabilities", {}).catch((error: unknown) => {
          if (!managed) throw error;
          return readBotCapabilities(path.join(this.options.stateDir, "bots", botId), { offline: true });
        });
        await reply(200, botCapabilitiesSchema.parse(result)); return;
      }
      const dashboard = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/dashboard$/);
      if (dashboard && req.method === "GET") {
        await requireOwner();
        const botId = dashboard[1]!;
        const bot = (await this.store.bots(userId)).find((b) => b.id === botId);
        if (!bot) throw new HubError("bot_forbidden", 403);
        z.object({}).strict().parse(Object.fromEntries(url.searchParams));
        const managed = this.botManager && await this.botManager.owns(botId);
        const result = bot.online
          ? await this.callBot(botId, "dashboard", {}).catch((error: unknown) => { if (!managed) throw error; return readBotDashboard(path.join(this.options.stateDir, "bots", botId)); })
          : managed ? await readBotDashboard(path.join(this.options.stateDir, "bots", botId)) : (() => { throw new HubError("bot_offline", 503); })();
        await reply(200, botDashboardSchema.parse(result)); return;
      }
      const diagnostics = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/diagnostics$/);
      if (diagnostics && req.method === "GET") {
        await requireOwner();
        const botId = diagnostics[1]!;
        if (!(await this.store.bots(userId)).some((b) => b.id === botId)) throw new HubError("bot_forbidden", 403);
        const query = diagnosticQuerySchema.parse(Object.fromEntries(url.searchParams));
        const page = this.botManager && await this.botManager.owns(botId)
          ? await readBotDiagnostics(path.join(this.options.stateDir, "bots", botId), query)
          : await this.callBot(botId, "diagnostics", query);
        await reply(200, diagnosticPageSchema.parse(page)); return;
      }
      if (route === "/api/ops/logs" && req.method === "GET") { await requireOwner(); await reply(200, { text: redactSecrets(String(await hubServiceCommand("logs", this.options.stateDir, ""))) }); return; }
      const operation = route.match(/^\/api\/bots\/([A-Za-z0-9_-]+)\/(sessions|restart|service-status)$/);
      if (operation) {
        await requireOwner(); const botId = operation[1]!;
        if (!(await this.store.bots(userId)).some((b) => b.id === botId)) throw new HubError("bot_forbidden", 403);
        if (operation[2] === "sessions" && req.method === "GET") { await reply(200, await this.callBot(botId, "sessions", {})); return; }
        if (operation[2] === "service-status" && req.method === "GET") { await reply(200, this.botManager && await this.botManager.owns(botId) ? this.botManager.serviceStatus(botId) : await this.callBot(botId, "service.status", {})); return; }
        if (operation[2] === "restart" && req.method === "POST") {
          const input = z.object({ receiptId: idSchema }).strict().parse(await this.jsonBody(req));
          await this.store.audit("instance.restart_requested", session.deviceId, { botId, deferred: true });
          if (this.botManager && await this.botManager.owns(botId)) await reply(200, await this.botManager.restart(botId, input.receiptId, validate));
          else { await validate(); await reply(200, await this.callBot(botId, "restart", input)); }
          return;
        }
      }
      if (route === "/api/devices/rename" && req.method === "PATCH") {
        const input = z.object({ deviceId: idSchema, name: hostNameSchema }).strict().parse(await this.jsonBody(req));
        const result = await transaction(async () => {
          const device = await this.store.db.get<{ id: string; public_key: string }>("SELECT id,public_key FROM devices WHERE id=? AND user_id=?", [input.deviceId, userId]);
          if (!device) throw new HubError("device_not_found", 404);
          if ((await this.auth.localDesktopControllersInTransaction(true)).has(input.deviceId)) throw new HubError("host_device_name_managed", 409);
          const result = await this.store.db.run("UPDATE devices SET name=? WHERE id=? AND user_id=?", [input.name, input.deviceId, userId]);
          await markDeviceNameAlias(this.store.db, device);
          return result;
        });
        if (!result.changes) throw new HubError("device_not_found", 404);
        await this.store.audit("device.renamed", session.deviceId, { deviceId: input.deviceId }); await reply(200, { ok: true }); return;
      }
      if (route === "/api/notifications" && req.method === "GET") {
        const preferences = await serial(() => this.store.db.get<{ preferences_json: string | null; options_json: string | null }>("SELECT p.preferences_json,o.options_json FROM devices d LEFT JOIN device_preferences p ON p.device_id=d.id LEFT JOIN device_notification_options o ON o.device_id=d.id WHERE d.id=?", [session.deviceId]));
        // `customization` tells clients this Hub stores per-topic and preview options.
        await reply(200, { customization: true, preferences: effectivePreferences(preferences?.preferences_json, preferences?.options_json), mutedConversations: (await serial(() => this.store.db.all<{ conversation_id: string }>("SELECT conversation_id FROM conversation_members WHERE member_type='user' AND member_id=? AND muted=1", [userId]))).map((m) => m.conversation_id), providers: { apns: !!this.options.push?.apns, fcm: !!this.options.push?.fcm, webpush: !!this.options.push?.webpush, unifiedpush: !!this.options.push?.unifiedpush }, vapidPublicKey: this.options.push?.webpush?.publicKey,
          // Capability: clients declare their own APNs topic only to Hubs listing it.
          ...(this.options.push?.apns ? { apnsTopics: allowedApnsTopics(this.options.push) } : {}) }); return;
      }
      if (route === "/api/notifications" && req.method === "PUT") {
        const preferences = notificationPreferencesSchema.parse(await this.jsonBody(req));
        const { enabled, quietStart, quietEnd, timeZone } = preferences;
        const options = Object.fromEntries(NOTIFICATION_OPTION_KEYS.flatMap(key => preferences[key] === undefined ? [] : [[key, preferences[key]]]));
        await transaction(async () => {
          // device_preferences keeps only fields a same-schema older Hub can parse.
          await this.store.db.run("INSERT INTO device_preferences VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET preferences_json=excluded.preferences_json", [session.deviceId, JSON.stringify({ enabled, quietStart, quietEnd, timeZone })]);
          // A writer that omits an option (including older clients) keeps its saved value.
          if (Object.keys(options).length) {
            const saved = await this.store.db.get<{ options_json: string }>("SELECT options_json FROM device_notification_options WHERE device_id=?", [session.deviceId]);
            await this.store.db.run("INSERT INTO device_notification_options VALUES(?,?) ON CONFLICT(device_id) DO UPDATE SET options_json=excluded.options_json", [session.deviceId, JSON.stringify({ ...parseNotificationOptions(saved?.options_json), ...options })]);
          }
          // Even disable/re-enable must fence a refresh that started before the
          // user's change. A random receipt prevents an ABA match after DELETE.
          await this.store.db.run("UPDATE push_bindings SET revision=? WHERE device_id=?", [randomUUID(), session.deviceId]);
        });
        for (const client of this.clients) if (client.session?.deviceId === session.deviceId) this.publishClient(client, { v: 1, type: "notifications.changed" });
        await reply(200, { ok: true }); return;
      }
      if (route === "/api/push" && req.method === "GET") {
        const binding = await serial(async () => {
          const row = await this.store.db.get<{ provider: string; revision: string; push_json: string | null }>("SELECT b.provider,b.revision,d.push_json FROM push_bindings b JOIN devices d ON d.id=b.device_id WHERE b.device_id=?", [session.deviceId]);
          const prefs = await this.store.db.get<{ preferences_json: string }>("SELECT preferences_json FROM device_preferences WHERE device_id=?", [session.deviceId]);
          let subscribed = false;
          try { const subscription = pushSubscriptionSchema.safeParse(JSON.parse(row?.push_json ?? "null")); subscribed = subscription.success && subscription.data.provider === row?.provider; } catch { /* Invalid legacy subscriptions need explicit recovery. */ }
          return { provider: row?.provider ?? null, revision: row?.revision ?? null, enabled: parsePreferences(prefs?.preferences_json).enabled, subscribed };
        });
        await reply(200, binding); return;
      }
      if (route === "/api/push" && req.method === "PATCH") {
        const { expectedRevision, ...subscription } = pushRotationSchema.parse(await this.jsonBody(req));
        try { assertApnsTopicAllowed(subscription, this.options.push ?? {}); } catch { throw new HubError("push_subscription_not_allowed"); }
        await transaction(async () => {
          const row = await this.store.db.get<{ provider: string; revision: string; push_json: string | null; preferences_json: string | null }>("SELECT b.*,d.push_json,p.preferences_json FROM push_bindings b JOIN devices d ON d.id=b.device_id LEFT JOIN device_preferences p ON p.device_id=d.id WHERE b.device_id=?", [session.deviceId]);
          if (!row || row.revision !== expectedRevision || row.provider !== subscription.provider || !parsePreferences(row.preferences_json).enabled) throw new HubError("push_binding_changed", 409);
          const value = JSON.stringify(subscription);
          if (row.push_json !== value) {
            await this.store.db.run("UPDATE devices SET push_json=? WHERE id=?", [value, session.deviceId]);
            await this.store.db.run("UPDATE push_bindings SET revision=? WHERE device_id=?", [randomUUID(), session.deviceId]);
          }
        });
        await reply(200, { ok: true }); return;
      }
      if (route === "/api/push" && req.method === "PUT") {
        const input = await this.jsonBody(req);
        let subscription; try { subscription = validatePushDestination(input, this.options.push ?? {}); } catch { throw new HubError("push_subscription_not_allowed"); }
        await transaction(async () => {
          await this.store.db.run("UPDATE devices SET push_json=? WHERE id=? AND revoked=0", [JSON.stringify(subscription), session.deviceId]);
          await this.store.db.run("INSERT INTO push_bindings VALUES(?,?,?) ON CONFLICT(device_id) DO UPDATE SET provider=excluded.provider,revision=excluded.revision", [session.deviceId, subscription.provider, randomUUID()]);
        });
        for (const client of this.clients) if (client.session?.deviceId === session.deviceId) this.publishClient(client, { v: 1, type: "notifications.changed" });
        await this.store.audit("push.registered", session.deviceId, { provider: subscription.provider }); await reply(200, { ok: true }); return;
      }
      if (route === "/api/push" && req.method === "DELETE") {
        await transaction(async () => {
          await this.store.db.run("UPDATE devices SET push_json=NULL WHERE id=?", [session.deviceId]);
          await this.store.db.run("DELETE FROM push_bindings WHERE device_id=?", [session.deviceId]);
          await this.store.db.run("UPDATE push_outbox SET status='cancelled' WHERE device_id=? AND status='pending'", [session.deviceId]);
        });
        for (const client of this.clients) if (client.session?.deviceId === session.deviceId) this.publishClient(client, { v: 1, type: "notifications.changed" });
        await reply(200, { ok: true }); return;
      }
      if (route === "/api/conversations/mute" && req.method === "PUT") {
        const input = z.object({ conversationId: idSchema, muted: z.boolean() }).strict().parse(await this.jsonBody(req));
        await transaction(async () => { await this.store.requireMember(userId, input.conversationId); await this.store.db.run("UPDATE conversation_members SET muted=? WHERE conversation_id=? AND member_type='user' AND member_id=?", [Number(input.muted), input.conversationId, userId]); });
        // Conversation mute belongs to the user; device notification options do
        // not. Invalidate only this user's devices, then reload their own options.
        for (const client of this.clients) if (client.session?.userId === userId) this.publishClient(client, { v: 1, type: "notifications.changed" });
        await reply(200, { ok: true }); return;
      }
      if (route === PAIRING_INVITES_PATH && (req.method === "POST" || req.method === "GET")) {
        await requireOwner();
        const result = req.method === "POST" ? await this.auth.issuePairingInvite(session, await this.jsonBody(req, 4096)) : await this.auth.listPairingInvites(session);
        await reply(req.method === "POST" ? 201 : 200, result); return;
      }
      if (route === PAIRING_INVITE_REVOKE_PATH && req.method === "POST") {
        await requireOwner(); await reply(200, await this.auth.revokePairingInvite(session, await this.jsonBody(req, 4096))); return;
      }
      if (route === "/api/devices" && req.method === "GET") { await requireOwner(); await reply(200, await this.store.devices(userId)); return; }
      if (route === "/api/devices/pending" && req.method === "GET") {
        await requireOwner();
        // Pairing codes are known only to the requesting device. Owners can
        // review the exact pending identity before entering its displayed code.
        const pending = await serial(() => this.store.db.all<{ deviceId: string; name: string; platform: string; publicKey: string; expiresAt: number }>(
          "SELECT device_id AS deviceId,name,platform,public_key AS publicKey,expires_at AS expiresAt FROM pairing_requests WHERE status='pending' AND expires_at>? ORDER BY expires_at LIMIT 256", [Date.now()]));
        await reply(200, pending); return;
      }
      if (route === "/api/devices/challenge" && req.method === "POST") {
        await requireOwner();
        await reply(200, await this.auth.prepareDeviceAction(await this.jsonBody(req), token!, session)); return;
      }
      if (route === "/api/devices/approve" && req.method === "POST") {
        const input = z.object({ code: z.string().regex(/^\d{8}$/), proof: deviceActionProofSchema.optional() }).strict().parse(await this.jsonBody(req));
        await reply(200, { deviceId: await this.auth.approve(input.code, userId, undefined, session, input.proof) }); return;
      }
      if (route === "/api/devices/revoke" && req.method === "POST") {
        const input = z.object({ deviceId: idSchema, proof: deviceActionProofSchema.optional() }).strict().parse(await this.jsonBody(req));
        await this.auth.revoke(input.deviceId, userId, session, input.proof);
        // Self-revocation intentionally invalidates its own session. Return only
        // the committed acknowledgment, not an authorization error after success.
        if (input.deviceId === session.deviceId) this.json(res, 200, { ok: true });
        else await reply(200, { ok: true });
        return;
      }
      if (route === "/api/conversations" && req.method === "GET") { await reply(200, await this.store.conversations(userId, { hidden: new URL(req.url ?? "/", "http://hub").searchParams.get("hidden") === "1" })); return; }
      if (route === "/api/conversation-files" && req.method === "GET") {
        const query = conversationFilesQuerySchema.parse(Object.fromEntries(url.searchParams));
        await reply(200, await conversationFiles(this.store, userId, query)); return;
      }
      if (route === "/api/search/page" && req.method === "GET") {
        const { q, cursor, ...filters } = searchPageQuerySchema.parse(Object.fromEntries(url.searchParams));
        const results = await this.store.searchPage(userId, q, filters, cursor);
        await this.auth.validateSession(session); await reply(200, results); return;
      }
      if (route === "/api/search" && req.method === "GET") {
        const { q, ...filters } = searchQuerySchema.parse(Object.fromEntries(url.searchParams));
        const results = await this.store.search(userId, q, filters);
        // A device can be revoked while the independent read queue is busy.
        await this.auth.validateSession(session); await reply(200, results); return;
      }
      if (route === "/api/link-preview" && req.method === "POST") {
        const input = z.object({ conversationId: idSchema, url: linkUrlSchema }).strict().parse(await this.jsonBody(req));
        await reply(200, await this.linkPreviews.prepare(userId, input.conversationId, input.url)); return;
      }
      if (route === "/api/uploads" && req.method === "POST") { await reply(201, await this.attachments.create(userId, await this.jsonBody(req), validateInQueue)); return; }
      const upload = route.match(/^\/api\/uploads\/([A-Za-z0-9_-]+)(?:\/(complete|\d+))?$/);
      if (upload) {
        const id = upload[1]!;
        if (!upload[2] && req.method === "GET") { await reply(200, await this.attachments.status(userId, id)); return; }
        if (upload[2] === "complete" && req.method === "POST") { const row = await this.attachments.complete(userId, id, validate); await reply(200, { id: row.id, sha256: row.sha256, size: row.size }); return; }
        if (upload[2] && req.method === "PUT") { await this.attachments.putChunk(userId, id, Number(upload[2]), await this.body(req, CHUNK_BYTES), validate); await reply(200, { ok: true }); return; }
      }
      const attachment = route.match(/^\/api\/attachments\/([A-Za-z0-9_-]+)$/);
      if (attachment && req.method === "GET") {
        const file = await this.attachments.download({ userId }, attachment[1]!);
        const controller = new AbortController(); this.downloads.set(controller, session);
        try {
          await validate(); controller.signal.throwIfAborted();
          const selected = attachmentResponse(file.row.size, file.row.sha256, req.headers.range, req.headers["if-range"]);
          res.writeHead(selected.status, { ...selected.headers, "Content-Type": file.row.mime, "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.row.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" });
          if (selected.status === 416) res.end();
          else await pipeline(createReadStream(file.path, { start: selected.start, end: selected.end }), res, { signal: controller.signal });
        } catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
        finally { this.downloads.delete(controller); }
        return;
      }
      throw new HubError("not_found", 404);
    } catch (error) { await this.store.audit("http.rejected", session.deviceId, { code: error instanceof HubError ? error.code : "invalid_request" }); throw error; }
    finally { this.requestGuards.delete(req); }
  }
  private async staticFile(route: string, res: ServerResponse): Promise<void> {
    if (!this.options.clientDir) throw new HubError("not_found", 404);
    const relative = route === "/" ? "index.html" : decodeURIComponent(route.slice(1));
    const root = path.resolve(this.options.clientDir); const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new HubError("not_found", 404);
    const metadata = await stat(file).catch(() => undefined); if (!metadata?.isFile()) throw new HubError("not_found", 404);
    const mime = ({ ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" } as Record<string, string>)[path.extname(file)] ?? "application/octet-stream";
    if (relative === "design-loader.html") {
      // Fixed trusted redirect only; project code runs in the subsequent opaque
      // data document. Its restrictive meta CSP is intentionally independent.
      res.writeHead(200, { "Content-Type": "text/html", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "frame-ancestors 'self'" });
      res.end(await readFile(file)); return;
    }
    if (relative === "widget-sandbox.html") {
      res.writeHead(200, { "Content-Type": "text/html", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts" });
      res.end(await readFile(file)); return;
    }
    const localConnect = this.options.tls ? "" : " http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*";
    res.writeHead(200, { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'self'; connect-src 'self' https: wss:${localConnect}; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob: data:; font-src 'self' data:; frame-ancestors 'none'` }); res.end(await readFile(file));
  }
  private async instanceHttp(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
    if (!isLoopback(req.socket.remoteAddress ?? "")) throw new HubError("instance_unauthorized", 401);
    const credentials = req.headers.authorization?.match(/^Instance ([A-Za-z0-9_-]+):([A-Za-z0-9_-]{32,256})$/);
    const botId = credentials?.[1];
    const record = botId ? await this.store.db.serial(() => this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [botId])) : undefined;
    if (!record || !credentials || !botId || !timingSafeEqual(Buffer.from(record.secret_hash, "hex"), Buffer.from(hashSecret(credentials[2]!), "hex"))) throw new HubError("instance_unauthorized", 401);
    if (route === "/api/instance/workbench/publish" && req.method === "POST") {
      const input = z.object({ conversationId: idSchema, contextMessageId: idSchema, requestId: idSchema, widget: z.unknown() }).strict().parse(await this.jsonBody(req));
      const actor = await this.workbenchBotActor(botId, input.conversationId, input.contextMessageId);
      const block = widgetBlock(validateWidget(input.widget));
      // The narrow compatibility publisher may create one widget message only;
      // caller-chosen author/recipient/blocks/version are never accepted.
      const id = `msg_wb_${hashSecret(JSON.stringify([botId, input.conversationId, input.contextMessageId, input.requestId]))}`;
      const committed = await this.store.db.transaction(async () => {
        const current = await this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [botId]);
        if (current?.secret_hash !== record.secret_hash) throw new HubError("instance_unauthorized", 401);
        await actor.validateInQueue();
        const present = await this.store.db.get("SELECT 1 FROM messages WHERE id=?", [id]);
        if (present) {
          const old = await this.store.queuedMessageInTransaction(id);
          if (old.authorId !== botId || old.authorType !== "bot" || old.conversationId !== input.conversationId || old.replyTo !== input.contextMessageId || old.status !== "complete" || old.version !== 1 || JSON.stringify(old.blocks) !== JSON.stringify([block])) throw new HubError("idempotency_conflict", 409);
          return { message: old };
        }
        return this.store.publishBotMessageInTransaction(botId, { id, conversationId: input.conversationId, replyTo: input.contextMessageId, blocks: [block], version: 1, status: "complete" }, () => this.widgetSettings.assertEnabled());
      });
      if (committed.event) this.store.emitCommitted([committed.event]);
      const message = committed.message;
      this.json(res, 200, { delivered: true, messageId: message.id, conversationId: message.conversationId, authorType: message.authorType, source: workbenchPublishedSource(message) }); return;
    }
    if (route === "/api/instance/workbench/uploads" && req.method === "POST") {
      const input = z.object({ contextMessageId: idSchema, conversationId: idSchema }).passthrough().parse(await this.jsonBody(req, 4096));
      const actor = await this.workbenchBotActor(botId, input.conversationId, input.contextMessageId);
      const { contextMessageId: _source, ...upload } = input;
      const result = await this.attachments.create(actor.userId, upload); await actor.validate(); this.json(res, 201, result); return;
    }
    if (route === "/api/instance/workbench" && req.method === "POST") {
      const input = z.object({ method: z.enum(["workbench.command", "workbench.targets", "workbench.context"]), params: z.unknown() }).strict().parse(await this.jsonBody(req));
      this.json(res, 200, await this.instanceRequest(botId, input.method, input.params)); return;
    }
    if (route === "/api/instance/workbench/screenshot" && req.method === "POST") {
      const input = z.object({ conversationId: idSchema, contextMessageId: idSchema, requestId: idSchema, attachmentId: idSchema }).strict().parse(await this.jsonBody(req, 2048));
      const actor = await this.workbenchBotActor(botId, input.conversationId, input.contextMessageId);
      await this.workbench.screenshot(actor, input.requestId, input.attachmentId);
      const download = await this.attachments.download({ userId: actor.userId }, input.attachmentId);
      await actor.validate(); res.writeHead(200, { "Content-Type": download.row.mime, "Content-Length": download.row.size }); await pipeline(createReadStream(download.path), res); return;
    }
    if (route === "/api/instance/tickets" && req.method === "POST") {
      // The dispatcher's own engine session drives its ledger through the CLI. A
      // hidden worker reads targets for, and requests help within, its own
      // active ticket turn only; the Hub resolves that ticket from the turn.
      const input = z.object({ operation: z.enum(["list", "show", "targets", "capabilities", "create", "dispatch", "update", "assist", "assist-status", "assists"]), contextMessage: idSchema.optional(), data: z.record(z.string(), z.unknown()).default({}) }).strict().parse(await this.jsonBody(req, 64 * 1024));
      const guard = async () => {
        const current = await this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [botId]);
        if (!current || current.secret_hash !== record.secret_hash) throw new HubError("instance_unauthorized", 401);
      };
      const actor = { kind: "bot" as const, botId, validate: guard, ...(input.contextMessage ? { contextMessage: input.contextMessage } : {}) };
      const worker = (await this.store.db.serial(() => this.store.db.get<{ role: string }>("SELECT role FROM bots WHERE id=? AND deleted_at IS NULL", [botId])))?.role === "worker";
      if (worker && !["targets", "capabilities", "assist", "assist-status"].includes(input.operation)) throw new HubError("dispatch_worker_forbidden", 403);
      const result = worker ? input.operation === "targets" ? await this.dispatch.workerTargets(actor)
        : input.operation === "capabilities" ? await this.dispatch.workerCapabilities(actor, input.data)
        : input.operation === "assist" ? await this.dispatch.requestAssist(actor, input.data) : await this.dispatch.assistStatus(actor)
        : input.operation === "assist" ? await this.dispatch.requestAssist(actor, input.data)
        : input.operation === "assist-status" ? await this.dispatch.assistStatus(actor)
        : input.operation === "assists" ? await this.dispatch.assists(actor, idSchema.parse(input.data.ticketId))
        : input.operation === "list" ? await this.dispatch.list(actor, botId, { open: input.data.open === true })
        : input.operation === "show" ? await this.dispatch.show(actor, idSchema.parse(input.data.ticketId))
        : input.operation === "targets" ? await this.dispatch.targets(actor, botId)
        : input.operation === "capabilities" ? await this.dispatch.capabilities(actor, botId, input.data)
        : input.operation === "create" ? await this.dispatch.create(actor, botId, input.data)
        : input.operation === "dispatch" ? await this.dispatch.dispatch(actor, botId, input.data)
        : await this.dispatch.update(actor, botId, input.data);
      const current = await this.store.db.serial(() => this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [botId]));
      if (!current || current.secret_hash !== record.secret_hash) throw new HubError("instance_unauthorized", 401);
      this.json(res, 200, result); return;
    }
    if (route === "/api/instance/bot-messages" && req.method === "POST") {
      const guard = async () => {
        const current = await this.store.db.get<{ secret_hash: string }>("SELECT secret_hash FROM bots WHERE id=? AND deleted_at IS NULL", [botId]);
        if (!current || current.secret_hash !== record.secret_hash) throw new HubError("instance_unauthorized", 401);
      };
      const result = await this.botMessages.local(await this.jsonBody(req, BOT_TRANSFER_BYTES), botId, guard);
      await this.store.db.serial(guard); this.json(res, 200, result); return;
    }
    if (route === "/api/instance/uploads" && req.method === "POST") {
      const input = z.object({ conversationId: idSchema }).passthrough().parse(await this.jsonBody(req));
      const conv = await this.store.conversationForBot(botId, input.conversationId);
      this.json(res, 201, await this.attachments.create(conv.ownerId, input)); return;
    }
    const match = route.match(/^\/api\/instance\/(uploads|attachments)\/([A-Za-z0-9_-]+)(?:\/(complete|\d+))?$/);
    if (!match) throw new HubError("not_found", 404);
    const id = match[2]!;
    const file = await this.store.db.serial(() => this.store.db.get<{ owner_id: string; conversation_id: string }>("SELECT owner_id,conversation_id FROM attachments WHERE id=?", [id]));
    if (!file) throw new HubError("attachment_not_found", 404);
    await this.store.conversationForBot(botId, file.conversation_id);
    if (match[1] === "attachments" && req.method === "GET") await this.store.requireAttachmentUnsealed(botId, id);
    if (match[1] === "attachments" && req.method === "GET") { const download = await this.attachments.download({ botId }, id); res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": download.row.size }); await pipeline(createReadStream(download.path), res); return; }
    if (!match[3] && req.method === "GET") { this.json(res, 200, await this.attachments.status(file.owner_id, id)); return; }
    if (match[3] === "complete" && req.method === "POST") { const complete = await this.attachments.complete(file.owner_id, id); this.json(res, 200, { id: complete.id }); return; }
    if (match[3] && req.method === "PUT") { await this.attachments.putChunk(file.owner_id, id, Number(match[3]), await this.body(req, CHUNK_BYTES)); this.json(res, 200, { ok: true }); return; }
    throw new HubError("not_found", 404);
  }
}
