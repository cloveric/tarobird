import { WORKBENCH_DESIGN_SHARE_CAPABILITY, designShareRequestFrameSchema, designShareResultFrameSchema, designShareEventFrameSchema, designShareDispatchFrameSchema, designShareCancelFrameSchema, type DesignShareRequest, type DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";
import { DesignShareClient, type DesignShareTransport } from "./workbench-design-collaboration.js";
import type { WorkbenchDraft } from "./workbench-draft.js";
import type { DesignCommentAcceptance } from "./design-comment-delivery.js";
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY } from "../../src/client-protocol/workbench-design.js";
import { DISPATCH_CAPABILITY } from "../../src/client-protocol/dispatch.js";
import { ticketConversationsVisible } from "./dispatcher.js";
import { screenStatusSchema, screenJoinSchema, screenConfigureSchema, screenConfigureText, screenPolicySchema, REMOTE_SCREEN_QUALITY_CAPABILITY, type ScreenConfigure } from "../../src/client-protocol/remote-screen.js";
import type { ScreenQuality } from "../../src/client-protocol/screen-quality.js";
import { routeTrust } from "./route-trust.js";
import { PAIRING_INVITES_CAPABILITY } from "../../src/client-protocol/pairing-invites.js";
import { WORKBENCH_MARKDOWN_CAPABILITY, WORKBENCH_CAPABILITY, workbenchCommandFrameSchema, workbenchCancelFrameSchema, type WorkbenchCommandFrame, type WorkbenchCancelFrame } from "../../src/client-protocol/workbench.js";
import { CONVERSATION_BATCH_CAPABILITY, conversationBatchResultSchema, type ConversationBatch } from '../../src/client-protocol/conversation-batch.js';
import { groupReplyWireFrame, changedGroupReply } from "./group-reply-guard.js";
import { rememberGroupReplyCapabilities } from "./group-reply-mode-cache.js";
import { UNAVAILABLE_CARD_ACTION, outboxFailureBlocks } from "./outbox-failure.js";
import { clearMessagesPlanSchema, clearMessagesResultSchema, MESSAGE_CLEAR_CAPABILITY } from "../../src/client-protocol/message-clear.js";
import { deleteMessagesSchema, deleteMessagesResultSchema, MESSAGE_DELETE_CAPABILITY } from "../../src/client-protocol/message-deletion.js";
import { timeoutSignal, anySignal } from "./abort-signals.js";
import { conversationFoldersSchema, emptyConversationFolders, type ConversationFoldersState, type FolderEdit } from "../../src/client-protocol/conversation-folders.js";
import { connectionTiming } from "./connection-timing.js";
import { RoutePerformance, ROUTE_OBSERVATION_MS, ROUTE_DWELL_MS, ROUTE_STABLE_PROBE_MS, ROUTE_CANDIDATE_PROBE_MS } from "./route-performance.js";
import { rememberRouteTrust } from "./route-trust.js";
import { connectionErrorMessage, connectionVerificationFailure, connectionVerificationMessage, preferredVerificationFailure } from "./connection-verification.js";
import { runtimeHostId } from "./host-registry.js";
import { orderedRoutes, localRoutesSchema, deploymentSchema, deploymentMatchesRoutes, type Deployment, type RouteHealth } from "../../src/client-protocol/routes.js";
import { avatarSchema, avatarKey, profileUserSchema, type ProfileAvatar, type ProfileCache, type AvatarTarget } from "../../src/client-protocol/avatars.js";
import type { CreateBotInput } from "../../src/client-protocol/bots.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FrameReader } from "../../src/client-protocol/fragments.js";
import { messageStreamSchema } from "../../src/client-protocol/stream.js";
import { syncShareUploadLimit } from "./share-inbox.js";
import { t } from "./i18n.js";
import type { DiffReviewScope } from "./diff-review-draft.js";
import { assertMessageTextSize } from "./message-validation.js";
import { quietNow } from "../../src/client-protocol/push.js";
import { BACKGROUND_TASK_GROUP_CAPABILITY } from "../../src/client-protocol/background-task-group.js";
import { RUN_SCOPES_CAPABILITY, RUN_TAIL_CAPABILITY } from "../../src/client-protocol/run.js";
import { desktopNotice } from "./message-notification.js";
import { desktopNotification, type NotificationState } from "./notifications.js";
import { nativePlatform } from "./native.js";
import { PRIVATE_NETWORK_CAPABILITY, networkCanonical, networkCommandSchema, networkCommandResultSchema, networkViewSchema, type NetworkCommandInput, type NetworkView, type SignedNetworkManifest, type SignedNetworkProposal } from "../../src/client-protocol/private-network.js";
import { hostProfileSchema, type HostProfileState } from "../../src/client-protocol/host-profile.js";
import { verifyNetworkMembership } from "./network-identity.js";
import { z } from "zod";
import { CAPABILITIES, MAX_FRAME_BYTES, MAX_FILE_BYTES, uploadLimitsSchema, clientFrameSchema, conversationSchema, eventSchema, type ClientFrame, type Conversation, type Json } from "../../src/client-protocol/index.js";
import { CONVERSATION_SYNC_CAPABILITY, SNAPSHOT_ACTIVITY_CAPABILITY, SYNC_LINEAGE_CAPABILITY, snapshotFrameSchema } from "../../src/client-protocol/snapshot.js";
import { cache as legacyCache, type ClientCache, type OutboxEntry, type Identity, type Route } from "./storage.js";
import { randomNonce, signChallenge, signDeviceAction, verifyHub, verifyRevocation } from "./identity.js";
import { boundDeviceActionStatement, deviceActionSchema } from "../../src/client-protocol/device-actions.js";
import { botMessageGrantsCommandSchema, botMessageGrantsSnapshotSchema, type BotMessageGrantsCommand, crossHostMessageGrantsCommandSchema, crossHostMessageGrantsSnapshotSchema, type CrossHostMessageGrantsCommand } from "../../src/client-protocol/bot-message-grants.js";
import { HubHttpError } from "./http-error.js";
/** Bound for `screenStatus` / `screenOpen` / `screenStop` only. */
export const SCREEN_REQUEST_TIMEOUT_MS = 15_000;
import { hubFetch, hubSocket, usesPinnedTransport, type HubSocket } from "./transport.js";
import type { DownloadOptions } from "./downloads.js";
import { PassiveAttachments, type AttachmentLease } from "./passive-attachments.js";
import type { StopReceipt } from "./run-stop.js";

import { memoryAttachment, sweepTemporaryDownloads, type AttachmentSource } from "./download-buffer.js";
import { DISK_CACHE_MIN_BYTES, diskCacheKey, forgetCachedAttachments, readCachedAttachment, storeCachedAttachment } from "./attachment-disk-cache.js";

export type Bot = { id: string; name: string; engine: string; model: string; effort: string; online: number; managed?: number; deletedAt?: number; defaultAvatar?: string; role?: string };
// `role` is open-ended so a newer Host role cannot reject the whole directory; only "dispatcher" has meaning here.
const botSchema = z.object({ id: z.string(), name: z.string(), engine: z.string(), model: z.string(), effort: z.string(), online: z.number(), managed: z.number().optional(), deletedAt: z.number().optional(), defaultAvatar: z.string().max(64).optional(), role: z.string().max(32).optional() });
const readySchema = z.object({ serverCapabilities: z.array(z.string()).default([]), conversationFolders: conversationFoldersSchema.optional(), uploadLimits: uploadLimitsSchema.optional(), user: profileUserSchema, avatars: z.array(avatarSchema).default([]), sessionToken: z.string(), expiresAt: z.number(), serverTime: z.number().optional(), bots: z.array(botSchema), conversations: z.array(conversationSchema) });
/** Queued frames refresh only their own conversation; creation has no existing scope. */
const frameConversation = (frame: ClientFrame): string | undefined => "conversationId" in frame ? frame.conversationId : "groupId" in frame ? frame.groupId : undefined;
export type RouteSyncSource = "host" | "network";
export type RouteSyncResult = { limited: boolean };
export type ConnectionState = ProfileCache & { dispatchAvailable?: boolean; screenAvailable?: boolean; /** Host accepts `screenOpen({ quality })`; the target may still refuse (`screen_quality_unsupported`). */ screenQualityAvailable?: boolean; workbenchAvailable?: boolean; workbenchMarkdownAvailable?: boolean; workbenchDesignAvailable?: boolean; workbenchDesignOpenAvailable?: boolean; workbenchSlidesAvailable?: boolean; workbenchDesignCommentsAvailable?: boolean; workbenchDesignHistoryAvailable?: boolean; workbenchDesignShareAvailable?:boolean; pairingInvitesAvailable?: boolean; conversationBatchAvailable?: boolean; routeSync?: Partial<Record<RouteSyncSource, RouteSyncResult>>; engineTasksAvailable?: boolean; sideAvailable?: boolean; syncProgress?: { completed: number; total: number; indeterminate?: boolean }; groupDiscussionAvailable?: boolean; groupDiscussionComposerAvailable?: boolean; groupDiscussionRecoveryAvailable?: boolean; groupReplyGuardAvailable?: boolean; groupParallelAvailable?: boolean; voiceSettingsAvailable?: boolean; widgetSettingsAvailable?: boolean; backupSettingsAvailable?: boolean; routeSelection?: { reason: "initial" | "reconnected" | "failover" | "quality"; changedAt: number }; hostRoutesAvailable?: boolean; /** Host serves owner File Center › 附件管理 (`attachments.admin.v1`). */ attachmentAdminAvailable?: boolean; /** Bumped when this device deleted host attachments. */ attachmentDeletions?: number; workspaceDiffAvailable?: boolean; runChangesAvailable?: boolean; asrSetupAvailable?: boolean; navigationGraceUntil?: number; serverTimeOffset?: number; network?: NetworkView; networkChange?: NetworkView; networkAvailable?: boolean; hostProfile?: HostProfileState; conversationFolders?: ConversationFoldersState; foldersAvailable?: boolean; runScopesAvailable?: boolean; runGroupsAvailable?: boolean; runTailAvailable?: boolean; folderReorderAvailable?: boolean; folderPinAvailable?: boolean; conversationAvatarsAvailable?: boolean; cacheRevision: number; notifications?: NotificationState; routeHealth?: RouteHealth[]; maxFileBytes?: number; status: "offline" | "connecting" | "online"; route?: Route; latency?: number; error?: string; awaitingApproval?: boolean; bots: Bot[]; deletedBots?: Bot[]; /** A dispatcher's hidden engine workers: named in their ticket chats, never listed. */ dispatchWorkers?: Bot[]; botDeletionAvailable?: boolean; promptQueueAvailable?: boolean; messageDeletionAvailable?: boolean; messageClearAvailable?: boolean; outbox: number };
export type OutboxSettlement = { entry: OutboxEntry; revision: number; messageAccepted: boolean };
export class HubConnection {
  state: ConnectionState = { cacheRevision: 0, status: "offline", bots: [], outbox: 0, avatars: [] };
  private navigationGraceTimer?: ReturnType<typeof setTimeout>;
  private outboxVersion = 0;
  /** Invalidates discussion views without treating every streamed text token as a change. */
  groupDiscussionRevision = 0;
  get outboxRevision(): number { return this.outboxVersion; }
  /** Request fresh local views without reconnecting or sending application data. */
  refreshCache(): void { this.update({}, true); }
  async pinConversation(id: string, pinned: boolean, scope: "group" | "global" = "group"): Promise<void> {
    await this.cache.setPinned(id, pinned, scope);
    this.refreshCache();
  }
  /** Request fresh local views of one conversation (pending rows, history fences). */
  refreshConversation(id: string): void { this.changedConversations.add(id); this.update({}, true, true); }
  /** Outbox writes change only the durable queue. The owning conversation still
   * advances because pending rows and ACK receipts fence on cacheRevision; other
   * conversations keep their history. Unknown ownership keeps the global refresh. */
  private outboxChanged(...conversations: (string | undefined)[]): void {
    this.outboxVersion++;
    const owners = conversations.filter((id): id is string => !!id);
    if (!owners.length) { this.refreshCache(); return; }
    for (const id of owners) this.changedConversations.add(id);
    this.update({}, true, true);
  }
  private outboxSettlements = new Set<(receipt: OutboxSettlement) => void>();
  private outboxQueued = new Set<(frame: ClientFrame) => void>();
  private avatarLoads = new Map<string, Promise<Blob>>();
  private readonly passiveAttachments = new PassiveAttachments(
    id => this.cache.attachment(id).catch(() => undefined),
    (id, signal) => {
      if (this.closed || this.state.status !== "online" || !this.token || !this.state.route) return Promise.reject(new Error(t("当前离线，附件尚未缓存")));
      return this.downloadBlob(id, { signal });
    },
  );
  private listeners = new Set<() => void>(); private ws?: HubSocket; private closed = false; private generation = 0; private stopFailures = 0;
  private signing?: Promise<string>;
  private closingReceive?: { generation: number; resume: boolean };
  private userId?: string; private notificationRequest = 0;
  private token?: string; private renewal?: ReturnType<typeof setTimeout>; private reconnect?: ReturnType<typeof setTimeout>; private heartbeat?: ReturnType<typeof setInterval>; private lastPong = 0;
  private syncing = true; private inflight?: string; private inflightEntry?: OutboxEntry; private retry = 0;
  private independentSync = false;
  private pendingSync = new Set<string>();
  private syncProgressPublishedAt = -Infinity;
  private cacheFull = false;
  private replayEvents = 0;
  private eventRefresh?: ReturnType<typeof setTimeout>;
  private globalConversationRevision = 0;
  private readonly conversationRevisions = new Map<string, number>();
  private readonly changedConversations = new Set<string>();
  /** A board pane only rereads history touched by an event. Global invalidations
   * (snapshot, reconnect, local outbox reconciliation) still refresh every pane. */
  conversationRevision(id: string): number { return Math.max(this.globalConversationRevision, this.conversationRevisions.get(id) ?? 0); }
  private outboxRetry?: ReturnType<typeof setTimeout>;
  private probeTimer?: ReturnType<typeof setInterval>; private handshake?: ReturnType<typeof setTimeout>; private probing = false;
  private preferredProbeAt = 0; private preferredProbeMisses = 0; private preferredProbeStarted = -Infinity;
  private activeMessages = new Set<string>(); private failedRoutes = new Map<string, { until: number; attempts: number }>(); private preferred?: { url: string; count: number; since: number }; private lastTraffic = 0;
  private routeHandoff?: { route: Route; latency: number; generation: number; routes: Route[]; expiresAt: number };
  private httpEpoch = new AbortController(); private fileTransfers = 0;
  private routeWrites: Promise<void> = Promise.resolve();
  private httpMutations = 0;
  private readonly routePerformance = new RoutePerformance();
  private probeBatch = 0;
  private probeAbort?: AbortController;
  private probeCompletion?: Promise<void>;
  private lastConnectedUrl?: string;
  private lastRouteChange = 0;
  private started = false;
  private starting?: Promise<void>;
  private lifecycle = 0;
  private folderUpdates: Promise<void> = Promise.resolve();
  private folderVersion = 0;
  networkKnown?: SignedNetworkManifest;
  networkRemote?: SignedNetworkManifest;
  networkDeparture?: SignedNetworkManifest;
  private departureRequest?: AbortController;
  private networkPin?: {id:string;authorityKey:string};
  private networkBlocked = false;
  private deviceRevoked = false;
  private pairingRequired = false;
  private networkRevision = 0;
  pinNetwork(id:string, authorityKey:string): void { this.networkPin = {id, authorityKey}; }
  suspendNetwork(): void { this.networkBlocked = true; this.close(true); this.update({error:t("网络授权已失效")}); }
  get isNetworkBlocked(): boolean { return this.networkBlocked; }
  get isReadOnly(): boolean { return this.networkBlocked || this.deviceRevoked || this.pairingRequired; }
  get isClosed(): boolean { return this.closed; }
  beginFileTransfer(): () => void { this.fileTransfers++; let released = false; return () => { if (!released) { released = true; this.fileTransfers--; this.lastTraffic = Date.now(); } }; }
  private readonly presence = (event?: Event) => {
    void this.send({ v: 1, type: "presence", foreground: document.visibilityState === "visible" && document.hasFocus() }).catch(() => undefined);
    if (document.hidden) {
      this.preferred = undefined;
      // A new foreground after a real background transition gets a fresh probe;
      // an earlier wake's timer must not consume that opportunity to answer.
      if (nativePlatform() === "ios") { this.clearForegroundProbe(); this.awaitingForegroundProbe = false; }
    }
    else if (event?.type === "visibilitychange" || event?.type === "focus") this.resume();
  };
  onCommands?: (values: Json, botId?: string, query?: string) => void;
  private readonly commandListeners = new Set<(values: Json, botId?: string, query?: string) => void>();
  subscribeCommands(listener: (values: Json, botId?: string, query?: string) => void): () => void {
    this.commandListeners.add(listener); return () => { this.commandListeners.delete(listener); };
  }
  // Design sharing (Opus-owned section): one raw transport, one correlator.
  private readonly designShareFrameListeners = new Set<(frame: DesignShareServerFrame) => void>();
  private readonly designShareStatusListeners = new Set<(online: boolean) => void>();
  private designShareOnline = false;
  /** Raw, live socket transport for one DesignShareClient per connection.
   * Sharing requests must never enter the durable chat outbox. */
  readonly designShareTransport: DesignShareTransport = {
    send: input => {
      if (!this.state.workbenchDesignShareAvailable || this.state.status !== "online" || this.closed || this.isReadOnly || !this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("design_share_app_unavailable");
      const frame = designShareRequestFrameSchema.parse(input);
      this.ws.send(JSON.stringify(frame));
    },
    onFrame: listener => { this.designShareFrameListeners.add(listener); return () => { this.designShareFrameListeners.delete(listener); }; },
    /** Sharing sessions retire at once when the socket leaves `online`; recovery is an explicit attach/join. */
    onStatus: listener => { this.designShareStatusListeners.add(listener); return () => { this.designShareStatusListeners.delete(listener); }; },
  };
  private designShareClient?: DesignShareClient;
  /** The App's only design-share correlator for this connection. */
  get designShares(): DesignShareClient { return this.designShareClient ??= new DesignShareClient(this.designShareTransport); }
  private designShareStatus(online: boolean): void {
    if (online === this.designShareOnline) return;
    this.designShareOnline = online;
    // Requests already written to the old socket may have reached the Host: unknown, never "not executed".
    if (!online) this.designShareClient?.abortPending("design_share_outcome_unknown");
    for (const listener of [...this.designShareStatusListeners]) { try { listener(online); } catch { /* A retired window cannot block the connection. */ } }
  }
  private emitDesignShareFrame(frame: DesignShareServerFrame): void {
    for (const listener of this.designShareFrameListeners) { try { listener(frame); } catch { /* A retired window cannot block the socket reader. */ } }
  }
  /** Compatibility: non-result frames, through the same single correlator. */
  subscribeDesignShares(listener: (frame: Exclude<DesignShareServerFrame, { type: "design.share.result" }>) => void) { return this.designShares.on(frame => { if (frame.type !== "design.share.result") listener(frame); }); }
  /** Compatibility promise API; the request is correlated by `designShares`, not a second map. */
  designShare(request: DesignShareRequest, requestId = crypto.randomUUID().replaceAll("-", "")): Promise<unknown> { return this.designShares.request(request, requestId); }
  private readonly workbenchListeners = new Set<(frame: WorkbenchCommandFrame | WorkbenchCancelFrame) => void>();
  subscribeWorkbench(listener: (frame: WorkbenchCommandFrame | WorkbenchCancelFrame) => void): () => void {
    this.workbenchListeners.add(listener); return () => { this.workbenchListeners.delete(listener); };
  }
  constructor(readonly identity: Identity, readonly cache: ClientCache = legacyCache, private readonly hostName?: () => string | undefined) { rememberRouteTrust(identity.routes, identity.hubPublicKey); }
  private authenticatedSessionEpoch = 0;
  /** Monotonic local identity for each successfully authenticated WS session.
   * Session-scoped registrations must renew even when their content is unchanged. */
  get sessionEpoch(): number { return this.authenticatedSessionEpoch; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  subscribeOutboxSettlement(listener: (receipt: OutboxSettlement) => void): () => void { this.outboxSettlements.add(listener); return () => this.outboxSettlements.delete(listener); }
  subscribeOutboxQueued(listener: (frame: ClientFrame) => void): () => void { this.outboxQueued.add(listener); return () => this.outboxQueued.delete(listener); }
  private settleOutbox(entry: OutboxEntry | undefined, messageAccepted: boolean): void {
    if (!entry || this.closed) return;
    const receipt = { entry, revision: this.state.cacheRevision, messageAccepted };
    this.outboxSettlements.forEach(listener => listener(receipt));
  }
  private update(changes: Partial<ConnectionState> = {}, cacheChanged = false, scoped = false): void {
    if (changes.status) this.designShareStatus(changes.status === "online");
    clearTimeout(this.eventRefresh); this.eventRefresh = undefined;
    // A display-only grace period for an established host that loses its link.
    // Retry/handshake transitions never renew it; transport authority stays offline.
    let navigationGraceUntil = this.state.navigationGraceUntil;
    if ((changes.status ?? this.state.status) === "online" || this.closed || this.isReadOnly) navigationGraceUntil = undefined;
    else if (this.state.status === "online" && changes.status) navigationGraceUntil = Date.now() + 5 * 60_000;
    else if (navigationGraceUntil !== undefined && Date.now() >= navigationGraceUntil) navigationGraceUntil = undefined;
    if (navigationGraceUntil !== this.state.navigationGraceUntil) {
      clearTimeout(this.navigationGraceTimer); this.navigationGraceTimer = undefined;
      if (navigationGraceUntil !== undefined) this.navigationGraceTimer = setTimeout(() => this.update(), Math.max(0, navigationGraceUntil - Date.now()));
    }
    changes = { ...changes, navigationGraceUntil };
    // Any state transition also publishes a committed replay prefix, including
    // disconnect/error before a batch fills. Cache writes and cursors still
    // commit per event; only redundant UI/history reads are coalesced.
    const changed = cacheChanged || this.replayEvents > 0; this.replayEvents = 0;
    if (changed) {
      const revision = this.state.cacheRevision + 1;
      if (cacheChanged && !scoped) { this.globalConversationRevision = revision; this.conversationRevisions.clear(); }
      else for (const id of this.changedConversations) this.conversationRevisions.set(id, revision);
      this.changedConversations.clear();
    }
    this.state = { ...this.state, ...changes, cacheRevision: this.state.cacheRevision + Number(changed) }; this.listeners.forEach((f) => f());
  }
  private eventApplied(conversationId: string, coalesce = false, receiving: () => boolean = () => false): void {
    this.changedConversations.add(conversationId);
    const replaying = this.syncing && this.state.status === "online" && (!this.independentSync || this.pendingSync.has(conversationId));
    // History clears and plain-text streams can contain many small updates.
    // Keep every cache write/cursor durable, but avoid rereading the entire
    // conversation after each one. Flush a short tail even with no next event;
    // ordinary events, receipts and connection transitions flush immediately.
    if ((replaying || coalesce && !this.closed && this.state.status === "online") && ++this.replayEvents < 32) {
      if (!replaying && !this.eventRefresh) {
        // Do not insert a full history read between every slow cache write in
        // an already-received burst. The 32-event cap still publishes progress;
        // once the receive queue drains, this timer publishes its final tail.
        const flush = () => {
          if (receiving()) this.eventRefresh = setTimeout(flush, 60);
          else this.update({}, true, true);
        };
        this.eventRefresh = setTimeout(flush, 60);
      }
      return;
    }
    this.update({}, true, true);
  }
  start(): Promise<void> {
    if (this.pairingRequired) return Promise.resolve();
    if (this.cache.isClosed) {
      this.cacheUnavailable();
      return Promise.reject(new Error(connectionErrorMessage("local_cache_unavailable")));
    }
    if (this.started) return this.starting ?? Promise.resolve();
    this.started = true; this.closed = false; const lifecycle = ++this.lifecycle;
    if (this.httpEpoch.signal.aborted) this.httpEpoch = new AbortController();
    window.addEventListener("online", this.networkOnline); document.addEventListener("visibilitychange", this.presence); window.addEventListener("focus", this.presence); window.addEventListener("blur", this.presence);
    const work = (async () => {
      const [active, profiles, revoked, stored, outbox, conversationFolders, membership] = await Promise.all([this.cache.activeMessages(), this.cache.profiles(), this.cache.identityRevoked(this.identity), this.cache.identity(), this.cache.outbox(), this.cache.conversationFolders(), this.cache.networkMembership()]);
      if (this.closed || lifecycle !== this.lifecycle) return;
      if (!stored || stored.deviceId !== this.identity.deviceId || stored.hubPublicKey !== this.identity.hubPublicKey) throw new Error("host_cache_identity_mismatch");
      if (await this.cache.pendingReset()) throw new Error("local_reset_in_progress");
      if (this.closed || lifecycle !== this.lifecycle) return;
      let cachedNetwork: NetworkView | undefined;
      if (membership) {
        this.networkKnown = verifyNetworkMembership(membership, this.identity.hubPublicKey); this.networkPin = membership.manifest;
        const host = membership.manifest.hosts.find(value => value.publicKey === this.identity.hubPublicKey)!;
        cachedNetwork = { host, membership, sync: host.revoked ? "removed" : "waiting", lastSyncedAt: 0 };
      }
      this.activeMessages = new Set(active); this.update({ ...profiles, conversationFolders, outbox: outbox.length, ...(cachedNetwork ? { network: cachedNetwork } : {}) }, true);
      if (this.networkBlocked) { this.suspendNetwork(); return; }
      if (revoked) { this.deviceRevoked = true; if (this.networkPin) this.networkBlocked = true; this.close(); this.update({ error: t("此设备已被吊销，请重新配对") }); return; }
      void this.downloadCheckpoints.sweep().catch(() => undefined);
      void sweepTemporaryDownloads().catch(() => undefined);
      await this.connect();
    })();
    this.starting = work.catch((error: unknown) => {
      if (lifecycle === this.lifecycle) {
        if (this.cache.isClosed) { this.cacheUnavailable(); throw new Error(connectionErrorMessage("local_cache_unavailable")); }
        else { this.close(); this.update({ error: error instanceof Error ? error.message : t("连接失败") }); }
      }
      throw error;
    }).finally(() => { if (lifecycle === this.lifecycle) this.starting = undefined; });
    return this.starting;
  }
  private readonly networkOnline = () => this.resume();
  private awaitingForegroundProbe = false;
  private foregroundProbe?: ReturnType<typeof setTimeout>;
  private clearForegroundProbe(): void { clearTimeout(this.foregroundProbe); this.foregroundProbe = undefined; }
  resume(force = false): void {
    // Background timers may be suspended. Expire the display grace on wake-up
    // even when an existing handshake is still in progress.
    if (this.state.navigationGraceUntil !== undefined && Date.now() >= this.state.navigationGraceUntil) this.update();
    if (this.closed || this.starting) return;
    if (this.cache.isClosed) { this.cacheUnavailable(); return; }
    this.cacheFull = false; // A foreground/manual retry may follow storage cleanup.
    // Native close and foreground events can arrive together after suspension.
    // Preserve frames already received (including receipts and signed denials)
    // before changing the socket generation, even for an explicit retry.
    if (this.closingReceive?.generation === this.generation) {
      this.closingReceive.resume = true; return;
    }
    // Route probing and authentication already have bounded timeouts. Repeated
    // wake-up signals must not tear down a slow handshake before it can finish.
    if (!force && this.state.status === "connecting") return;
    if (!force && this.state.status === "online" && this.ws?.readyState === WebSocket.OPEN) {
      // Foregrounding a healthy app must not cancel its requests. The heartbeat
      // retires a stale socket if this fresh liveness probe goes unanswered.
      // Grant one wake-up grace period, not a new lease for every duplicate
      // foreground/online signal. Only incoming traffic proves this link alive.
      if (!this.awaitingForegroundProbe) {
        this.lastPong = performance.now(); this.awaitingForegroundProbe = true;
        if (nativePlatform() === "ios") {
          const ws = this.ws, generation = this.generation, started = performance.now();
          const probe = setTimeout(() => {
            if (this.foregroundProbe !== probe) return;
            this.foregroundProbe = undefined;
            if (this.closed || generation !== this.generation || this.ws !== ws || !this.awaitingForegroundProbe) return;
            if (document.hidden || document.visibilityState !== "visible") { this.awaitingForegroundProbe = false; return; }
            // A suspended/busy WebView can deliver a late timer before queued
            // native frames. Leave that case to the existing steady heartbeat.
            if (performance.now() - started > 8000) return;
            // Refresh this socket without marking its route unhealthy solely
            // because iOS suspended the client. Authentication still runs anew.
            this.abandon(ws, generation, false);
          }, 5000);
          this.foregroundProbe = probe;
        }
      }
      this.ws.send('{"v":1,"type":"ping"}');
      void this.pollPreferredRoute(this.generation, true); return;
    }
    this.retry = 0;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.ws) this.abandon(this.ws, this.generation, false); else void this.connect();
  }
  private failRoute(): void {
    const url = this.state.route?.url; if (!url) return;
    this.routePerformance.failed(url, Date.now());
    const attempts = (this.failedRoutes.get(url)?.attempts ?? 0) + 1;
    this.failedRoutes.set(url, { attempts, until: Date.now() + Math.min(60_000, 5000 * 2 ** Math.min(attempts - 1, 4)) }); this.preferred = undefined; this.routeHandoff = undefined;
  }
  /** A retired IndexedDB handle cannot recover by probing a healthy Hub again.
   * Keep identity/outbox/drafts untouched. This connection never reuses a retired handle. */
  private cacheUnavailable(): void {
    if (this.closed) return;
    this.close(true);
    this.update({ error: connectionErrorMessage("local_cache_unavailable") });
  }
  private async selectRoute(allowCooldown = false, generation = this.generation): Promise<{ route: Route; latency: number }> {
    rememberRouteTrust(this.identity.routes, this.identity.hubPublicKey);
    const configuredRoutes = this.identity.routes, routes = orderedRoutes(configuredRoutes);
    // Probe the last working path first. At most four requests per host enter
    // the shared transport queue, so a large route list cannot monopolize it.
    const last = routes.findIndex(route => route.url === this.lastConnectedUrl);
    if (last > 0) routes.unshift(...routes.splice(last, 1));
    const batch = ++this.probeBatch;
    const current = () => !this.closed && generation === this.generation && configuredRoutes === this.identity.routes && batch === this.probeBatch;
    // Drain canceled work before another batch enters the queue. Cold-start
    // early selection must not allow background/reconnect batches to overlap.
    if (this.probeCompletion) { this.probeAbort?.abort(); await this.probeCompletion; }
    if (!current()) throw new Error("route_probe_superseded");
    const controller = new AbortController(); this.probeAbort = controller;
    const settled: (RouteHealth | undefined)[] = [];
    let localFailure: string | undefined, cursor = 0;
    let release: (() => void) | undefined, grace: ReturnType<typeof setTimeout> | undefined;
    const early = allowCooldown ? new Promise<void>(resolve => { release = resolve; }) : undefined;
    const probe = async (route: Route): Promise<RouteHealth> => {
      const started = performance.now();
      try {
        const response = await hubFetch(route.url, "/health", this.identity.hubPublicKey, { signal: anySignal([controller.signal, timeoutSignal(connectionTiming(route, usesPinnedTransport()).probeMs)]), cache: "no-store" });
        const result = z.object({ publicKey: z.string(), ok: z.literal(true) }).parse(await response.json());
        if (!response.ok) throw new Error("route_unavailable");
        if (result.publicKey !== this.identity.hubPublicKey) return { url: route.url, status: "wrong-hub", failure: "identity-mismatch" };
        return { url: route.url, status: (this.failedRoutes.get(route.url)?.until ?? 0) > Date.now() ? "cooldown" : "reachable", latency: Math.round(performance.now() - started) };
      } catch (error) {
        const code = error instanceof Error ? error.message : typeof error === "string" ? error : "";
        if (["native_document_retired", "native_document_unavailable", "native_view_unavailable"].includes(code)) localFailure = connectionErrorMessage(code);
        const failure = connectionVerificationFailure(error);
        return { url: route.url, status: failure === "identity-mismatch" ? "wrong-hub" : "unreachable", ...(failure ? { failure } : {}) };
      }
    };
    const worker = async () => {
      while (cursor < routes.length && current()) {
        const index = cursor++, result = await probe(routes[index]!);
        settled[index] = result;
        if (!current()) return;
        this.routePerformance.observe(result, Date.now());
        this.update({ routeHealth: settled.filter((value): value is RouteHealth => !!value) });
        // A blackholed route must not delay a reachable alternative. Late
        // health results are informational; only the authenticated WS is live.
        if (release && !grace && (result.status === "reachable" || result.status === "cooldown")) grace = setTimeout(release, 200);
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(4, routes.length) }, worker));
    const completion = all.then(() => undefined); this.probeCompletion = completion;
    void completion.finally(() => { if (this.probeCompletion === completion) this.probeCompletion = undefined; controller.abort(); }).catch(() => undefined);
    await (early ? Promise.race([all, early]) : all); clearTimeout(grace); release = undefined;
    const probes = this.routePerformance.rank(settled.filter((value): value is RouteHealth => !!value), Date.now());
    const candidate = (allowCooldown ? probes.find(probe => probe.status === "reachable" && !this.failedRoutes.has(probe.url)) : undefined)
      ?? probes.find(probe => probe.status === "reachable")
      ?? (allowCooldown ? probes.filter(probe => probe.status === "cooldown")
        .sort((a, b) => (this.failedRoutes.get(a.url)?.until ?? 0) - (this.failedRoutes.get(b.url)?.until ?? 0))[0] : undefined);
    if (!candidate) {
      const name = this.hostName?.()?.trim() || this.state.hostProfile?.name || this.state.network?.host.name || t("此主机");
      throw new Error(localFailure ?? connectionVerificationMessage(preferredVerificationFailure(probes.map(probe => probe.failure)), "paired") ?? t("暂时无法连接「{0}」，正在自动重试。", name));
    }
    return { route: routes.find(route => route.url === candidate.url)!, latency: candidate.latency! };
  }
  private async connect(): Promise<void> {
    if (this.closed) return;
    if (this.cache.isClosed) { this.cacheUnavailable(); return; }
    this.clearForegroundProbe();
    const handoff = this.routeHandoff?.generation === this.generation ? this.routeHandoff : undefined; this.routeHandoff = undefined;
    const generation = ++this.generation; this.update({ status: "connecting", syncProgress: undefined }); this.syncing = true; this.inflight = undefined;
    this.independentSync = false; this.pendingSync.clear();
    this.preferredProbeAt = 0; this.preferredProbeMisses = 0; this.preferredProbeStarted = -Infinity;
    if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    // Supersede the socket before probing. Its late callbacks carry the old
    // generation and cannot tear down a newer authenticated transport.
    this.ws?.close(); this.ws = undefined;
    try {
      // A system credential prompt can outlive its socket. Wait for that one
      // operation instead of issuing another native read on every reconnect.
      if (this.signing) {
        this.update({ error: connectionErrorMessage("device_signature_pending") });
        await this.signing.catch(() => undefined);
        if (generation !== this.generation || this.closed) return;
      }
      // An idle switchback already verified this route three times. Repeating
      // the cold-start race can select the faster relay forever. Consume the
      // verified target once; edits, expiry and failures restore normal probing.
      // The new socket still performs the full TLS/Hub identity handshake.
      const chosen = handoff && handoff.routes === this.identity.routes && handoff.expiresAt > Date.now()
        && (this.failedRoutes.get(handoff.route.url)?.until ?? 0) <= Date.now()
        ? { route: handoff.route, latency: handoff.latency } : await this.selectRoute(true, generation);
      if (generation !== this.generation || this.closed) return;
      const handshakeStarted = performance.now();
      this.update(chosen); const ws = hubSocket(chosen.route.url, this.identity.hubPublicKey); this.ws = ws;
      let preparation: "socket" | "cache" | "host" | "signature" = "socket";
      this.handshake = setTimeout(() => {
        if (generation !== this.generation || this.closed) return;
        if (this.cache.isClosed) { this.cacheUnavailable(); return; }
        this.update({ error: connectionErrorMessage(preparation === "signature" ? "device_signature_pending" : preparation === "cache" ? "local_cache_preparation_timeout" : "connection_handshake_timeout") });
        this.abandon(ws, generation, preparation !== "signature" && preparation !== "cache");
      }, connectionTiming(chosen.route, usesPinnedTransport()).handshakeMs);
      const nonce = randomNonce(); let chain = Promise.resolve(), renewing = false, receiveFailed = false, localFailure = false, signingWait = 0, pendingFrames = 0;
      let handshakeState: "hello" | "auth-sent" | "ready" = "hello";
      // Socket-local tokens fence an old connection's queued cache writes after
      // another window has committed a restored timeline. Reconnects own new maps.
      const receivedLineages: Record<string, string> = {};
      let lineageCapable = false, snapshotLineage: { conversationId: string; lineage?: string } | undefined;
      const reader = new FrameReader(() => { const hash = sha256.create(); return { update: (bytes) => hash.update(bytes), hex: () => bytesToHex(hash.digest()) }; });
      ws.onopen = () => { preparation = "cache"; void this.cache.discardSnapshot().then(() => Promise.all([this.cache.syncResume(), this.cache.selectedConversation()])).then(([{ cursors, syncLineages }, preferredConversationId]) => {
        Object.assign(receivedLineages, syncLineages);
        preparation = "host";
        if (generation === this.generation && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: "hello", deviceId: this.identity.deviceId, nonce, protocolVersions: [1], capabilities: [...CAPABILITIES, SNAPSHOT_ACTIVITY_CAPABILITY], cursors, syncLineages, ...(preferredConversationId ? { preferredConversationId } : {}) }));
      }).catch((error: unknown) => {
        if (generation !== this.generation || this.closed) return;
        if (this.cache.isClosed) { this.cacheUnavailable(); return; }
        // Cache preparation can fail before hello is sent. Surface that failure
        // instead of presenting an endless, unexplained network reconnect.
        this.cacheFull = error instanceof Error && error.name === "QuotaExceededError";
        this.update({ error: connectionErrorMessage(error) });
        this.abandon(ws, generation, preparation !== "cache");
      }); };
      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        // Incoming traffic is observed before IndexedDB/render work; a busy
        // catch-up queue must not be mistaken for a blackholed transport.
        this.lastPong = performance.now();
        this.awaitingForegroundProbe = false;
        this.clearForegroundProbe();
        pendingFrames++;
        chain = chain.then(async () => {
        if (generation !== this.generation) return;
        const raw = String(event.data);
        if (new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) throw new Error("frame_too_large");
        const decoded = reader.read(raw); if (decoded === undefined) return;
        const frame = z.object({ v: z.literal(1), type: z.string() }).passthrough().parse(decoded);
        if (frame.type === "auth.denied") {
          if (handshakeState === "ready") throw new Error(t("Hub 身份验证顺序异常，已断开连接。"));
          verifyRevocation(this.identity, nonce, frame);
          await this.acceptRevocation(); return;
        }
        if (frame.type === "challenge") {
          if (handshakeState !== "hello") throw new Error(t("Hub 身份验证顺序异常，已断开连接。"));
          if (ws.readyState !== WebSocket.OPEN) return;
          this.update({ awaitingApproval: false });
          const c = z.object({ nonce: z.string(), signature: z.string(), publicKey: z.string() }).parse(frame);
          await verifyHub(this.identity, c.nonce, nonce, c.signature, c.publicKey);
          preparation = "signature";
          const signingStarted = performance.now(), signing = signChallenge(this.identity, c.nonce, nonce); this.signing = signing;
          let signature: string;
          try { signature = await signing; } finally { signingWait += performance.now() - signingStarted; if (this.signing === signing) this.signing = undefined; }
          preparation = "host";
          if (generation !== this.generation || this.closed || ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify({ v: 1, type: "auth", signature })); handshakeState = "auth-sent"; return;
        }
        if (frame.type === "ready") {
          if (handshakeState !== "auth-sent") throw new Error(t("Hub 身份验证顺序异常，已断开连接。"));
          if (ws.readyState !== WebSocket.OPEN) return;
          if (this.handshake) clearTimeout(this.handshake);
          const ready = readySchema.parse(frame);
          this.independentSync = ready.serverCapabilities.includes(CONVERSATION_SYNC_CAPABILITY);
          lineageCapable = ready.serverCapabilities.includes(SYNC_LINEAGE_CAPABILITY);
          this.update({ workbenchDesignShareAvailable:ready.serverCapabilities.includes(WORKBENCH_DESIGN_SHARE_CAPABILITY), workbenchDesignCommentsAvailable: ready.serverCapabilities.includes(WORKBENCH_DESIGN_COMMENTS_CAPABILITY), workbenchDesignHistoryAvailable: ready.serverCapabilities.includes(WORKBENCH_DESIGN_HISTORY_CAPABILITY), workbenchSlidesAvailable: ready.serverCapabilities.includes(WORKBENCH_SLIDES_CAPABILITY), screenQualityAvailable: ready.serverCapabilities.includes(REMOTE_SCREEN_QUALITY_CAPABILITY), workbenchDesignOpenAvailable: ready.serverCapabilities.includes(WORKBENCH_DESIGN_OPEN_CAPABILITY), workbenchDesignAvailable: ready.serverCapabilities.includes(WORKBENCH_DESIGN_CAPABILITY), workbenchAvailable: ready.serverCapabilities.includes(WORKBENCH_CAPABILITY), workbenchMarkdownAvailable: ready.serverCapabilities.includes(WORKBENCH_MARKDOWN_CAPABILITY), sideAvailable: ready.serverCapabilities.includes("conversations.side.v1"), engineTasksAvailable: ready.serverCapabilities.includes("conversations.tasks.v1") });
          this.pendingSync = new Set(ready.conversations.map(c => c.id));
          this.update({ syncProgress: { completed: 0, total: ready.conversations.length, indeterminate: !this.independentSync } }); handshakeState = "ready";
          // Identity metadata is also needed while draining received read events
          // after a close; only transport activation waits for the cache writes.
          this.userId = ready.user.id; await this.cache.saveConversations(ready.conversations);
          if (ready.conversationFolders) await this.acceptConversationFolders(ready.conversationFolders, generation, true);
          await this.cache.saveProfiles({ user: ready.user, avatars: ready.avatars }, this.identity);
          // Close can race either cache write. Draining accepted frames must not
          // restore a dead socket's token, timers, route health or online state.
          if (generation !== this.generation || this.closed || ws.readyState !== WebSocket.OPEN) return;
          this.token = ready.sessionToken; this.authenticatedSessionEpoch++; this.retry = 0; this.failedRoutes.delete(chosen.route.url);
          this.routePerformance.connected(chosen.route.url, performance.now() - handshakeStarted - signingWait);
          const reason = !this.lastConnectedUrl ? "initial" : this.lastConnectedUrl === chosen.route.url ? "reconnected" : handoff?.route.url === chosen.route.url ? "quality" : "failover";
          if (this.lastConnectedUrl !== chosen.route.url) this.lastRouteChange = Date.now();
          this.lastConnectedUrl = chosen.route.url;
          this.update({ routeSelection: { reason, changedAt: Date.now() } });
          this.update({ dispatchAvailable: ready.serverCapabilities.includes(DISPATCH_CAPABILITY), screenAvailable: ready.serverCapabilities.includes("desktop.screen.v1"), pairingInvitesAvailable: ready.serverCapabilities.includes(PAIRING_INVITES_CAPABILITY), conversationBatchAvailable: ready.serverCapabilities.includes(CONVERSATION_BATCH_CAPABILITY), groupReplyGuardAvailable: ready.serverCapabilities.includes("groups.reply-guard.v1"), groupDiscussionAvailable: ready.serverCapabilities.includes("groups.discussion.v1"), groupDiscussionComposerAvailable: ready.serverCapabilities.includes("groups.discussion.composer.v1"), groupDiscussionRecoveryAvailable: ready.serverCapabilities.includes("groups.discussion.recovery.v1"), groupParallelAvailable: ready.serverCapabilities.includes("groups.parallel.v1"), voiceSettingsAvailable: ready.serverCapabilities.includes("integrations.voice.v2"), widgetSettingsAvailable: ready.serverCapabilities.includes("widgets.settings.v1"), backupSettingsAvailable: ready.serverCapabilities.includes("backups.settings.v1"), hostRoutesAvailable: ready.serverCapabilities.includes("host-routes.v1"), attachmentAdminAvailable: ready.serverCapabilities.includes("attachments.admin.v1"), asrSetupAvailable: ready.serverCapabilities.includes("integrations.asr.v1"), workspaceDiffAvailable: ready.serverCapabilities.includes("workspace.diff.v1"), runChangesAvailable: ready.serverCapabilities.includes("runs.changes.v1"), runScopesAvailable: ready.serverCapabilities.includes(RUN_SCOPES_CAPABILITY), runGroupsAvailable: ready.serverCapabilities.includes(BACKGROUND_TASK_GROUP_CAPABILITY), runTailAvailable: ready.serverCapabilities.includes(RUN_TAIL_CAPABILITY), serverTimeOffset: (ready.serverTime ?? Date.now()) - Date.now(), networkAvailable: ready.serverCapabilities.includes(PRIVATE_NETWORK_CAPABILITY), folderReorderAvailable: ready.serverCapabilities.includes("conversation-folders.reorder.v1"), folderPinAvailable: ready.serverCapabilities.includes("conversation-folders.pin.v1"), conversationAvatarsAvailable: ready.serverCapabilities.includes("conversation-avatars.v1"), foldersAvailable: !!ready.conversationFolders, user: ready.user, avatars: ready.avatars, status: "online", bots: ready.bots.filter(bot => !bot.deletedAt && bot.role !== "worker"), deletedBots: ready.bots.filter(bot => !!bot.deletedAt && bot.role !== "worker"), dispatchWorkers: ready.bots.filter(bot => !bot.deletedAt && bot.role === "worker"), botDeletionAvailable: ready.serverCapabilities.includes("bots.delete.v1"), promptQueueAvailable: ready.serverCapabilities.includes("prompt-queue.v1"), messageDeletionAvailable: ready.serverCapabilities.includes(MESSAGE_DELETE_CAPABILITY), messageClearAvailable: ready.serverCapabilities.includes(MESSAGE_CLEAR_CAPABILITY), maxFileBytes: ready.uploadLimits?.maxFileBytes ?? MAX_FILE_BYTES, error: undefined }, true); void rememberGroupReplyCapabilities(this).catch(() => undefined); void syncShareUploadLimit(this.state.maxFileBytes ?? MAX_FILE_BYTES).catch(() => console.warn("share_limit_cache_failed")); this.lastPong = performance.now(); this.presence(); void this.refreshNotificationPreferences().catch(() => undefined);
          const timing = connectionTiming(chosen.route, usesPinnedTransport());
          let heartbeatAt = performance.now();
          this.heartbeat = setInterval(() => {
            if (generation !== this.generation || this.closed || ws.readyState !== WebSocket.OPEN) return;
            const now = performance.now();
            // A paused UI cannot receive socket events either. After missing
            // two ticks, send a fresh probe before treating queued replies as
            // network loss. Only the loopback desktop path uses a short deadline.
            if (now - heartbeatAt > timing.heartbeatMs * 2 && !this.awaitingForegroundProbe) this.lastPong = now;
            heartbeatAt = now;
            if (now - this.lastPong > timing.staleMs) this.abandon(ws, generation);
            else if (ws.readyState === WebSocket.OPEN) ws.send('{"v":1,"type":"ping"}');
          }, timing.heartbeatMs);
          this.probeTimer = setInterval(() => { void this.pollPreferredRoute(generation); }, 1500);
          this.renewal = setTimeout(() => { renewing = true; ws.close(1000, "session_renewal"); }, Math.max(1000, ready.expiresAt - (ready.serverTime ?? Date.now()) - 30_000)); return;
        }
        // The health key is public. Until its signed challenge and the ready
        // exchange finish, no application frame may alter cache/outbox or
        // publish presence. Only the separately signed, nonce-bound denial
        // above can persist a pre-ready revocation. Unknown frames stay ignorable.
        if (handshakeState !== "ready") {
          if (frame.type === "error" && frame.code === "untrusted_device" && this.identity.pendingPairing) { this.update({ awaitingApproval: true }); ws.close(); return; }
          if (frame.type === "error") throw new Error(frame.code === "rate_limited" ? t("连接尝试过于频繁，稍后会自动重连。配对信息仍保留。") : t("Hub 未能确认设备身份，请检查配对授权。"));
          return;
        }
        if (frame.type === "design.share.result") { this.emitDesignShareFrame(designShareResultFrameSchema.parse(frame)); return; }
        if (frame.type === "design.share.event" || frame.type === "design.share.dispatch" || frame.type === "design.share.cancel") {
          this.emitDesignShareFrame(frame.type === "design.share.event" ? designShareEventFrameSchema.parse(frame) : frame.type === "design.share.dispatch" ? designShareDispatchFrameSchema.parse(frame) : designShareCancelFrameSchema.parse(frame));
          return;
        }
        if (frame.type === "workbench.command" || frame.type === "workbench.cancel") {
          const incoming = frame.type === "workbench.command" ? workbenchCommandFrameSchema.parse(frame) : workbenchCancelFrameSchema.parse(frame);
          for (const listener of this.workbenchListeners) listener(incoming);
          return;
        }
        if (frame.type === "event") {
          const event = eventSchema.parse(frame); const message = await this.cache.apply(event, this.userId, { lineage: receivedLineages[event.conversationId] }); this.lastTraffic = Date.now();
          if (message) { if (message.status === "streaming" || message.status === "pending") this.activeMessages.add(message.id); else this.activeMessages.delete(message.id);
            const preferences = this.state.notifications?.preferences;
            // Topic and preview choices are the same device preferences the Hub applies to phone pushes.
            const notice = preferences?.enabled ? desktopNotice(message, preferences) : undefined;
            if ((!this.syncing || this.independentSync && !this.pendingSync.has(message.conversationId)) && preferences && notice && !quietNow(preferences, Date.now()) && !this.state.notifications?.mutedConversations?.includes(message.conversationId) && (document.visibilityState !== "visible" || !document.hasFocus()) && ["macos", "windows"].includes(nativePlatform()) && (ticketConversationsVisible() || !(await this.cache.conversation(message.conversationId).catch(() => undefined))?.hidden) && await this.cache.claimNotification(message.id)) {
              const title = notice.preview ? (await this.cache.conversation(message.conversationId).catch(() => undefined))?.title : undefined;
              const resolve = () => {
                const current = this.state.notifications;
                if (this.closed || generation !== this.generation || !current?.preferences.enabled || quietNow(current.preferences, Date.now()) || current.mutedConversations?.includes(message.conversationId) || document.visibilityState === "visible" && document.hasFocus()) return;
                // Re-check after cache reads and again after native queue waits.
                // A notice admitted without detail stays private if previews are
                // enabled while it waits, matching already-redacted phone pushes.
                const latest = desktopNotice(message, { ...current.preferences, showPreview: notice.preview && current.preferences.showPreview !== false });
                if (!latest) return;
                const body = latest.body({ title, botName: this.state.bots.find(bot => bot.id === message.authorId)?.name, locale: document.documentElement?.lang?.startsWith("en") ? "en" : "zh" });
                return { hostId: runtimeHostId(this.identity.hubPublicKey!), id: message.id, title: "TaroCub" as const, body, conversationId: message.conversationId, messageId: message.id, kind: latest.kind, at: Date.now() };
              };
              const payload = resolve();
              if (payload) void desktopNotification(payload, resolve).catch(() => undefined);
            }
          }
          if (event.kind === "turn.state" && typeof event.payload === "object" && event.payload && !Array.isArray(event.payload) && "result" in event.payload) { const result = z.object({ ok: z.boolean() }).safeParse(event.payload.result); if (result.success && !result.data.ok) this.update({ error: t("卡片操作未完成，请检查结果后重试") }); }
          // Another window may already have committed this tombstone, so apply
          // can return undefined. This is only an invalidation hint; consumers
          // read the committed cache, never unvalidated event payload content.
          const payload = event.payload;
          const deleted = (event.kind === "message.created" || event.kind === "message.updated") && !!payload && typeof payload === "object" && !Array.isArray(payload) && payload.status === "deleted";
          const delta = event.kind === "message.stream" ? messageStreamSchema.safeParse(payload) : undefined;
          // Only plain text may wait for a short batch. First messages, terminal
          // status updates and every card/interactive operation stay immediate.
          const textStream = delta?.success && delta.data.ops.every(op =>
            op.op === "appendText" && !op.path || op.op === "replaceBlock" && op.value.type === "text");
          if (deleted) this.groupDiscussionRevision++;
          if (event.kind === "turn.state" && typeof event.payload === "object" && event.payload && !Array.isArray(event.payload) && ("groupDiscussion" in event.payload || "groupSettings" in event.payload)) this.groupDiscussionRevision++;
          this.eventApplied(event.conversationId, deleted || textStream, () => pendingFrames > 0); return;
        }
        if (["snapshot.begin", "snapshot.message", "snapshot.end"].includes(frame.type)) {
          if (!this.syncing) throw new Error("unexpected_snapshot");
          const snapshot = snapshotFrameSchema.parse(frame);
          const expected = snapshot.type === "snapshot.begin" ? { lineage: receivedLineages[snapshot.conversation.id] } : undefined;
          // Older Hosts cannot advertise restore lineage. Retain the socket's
          // committed token while reading their existing snapshot protocol.
          if (snapshot.type === "snapshot.begin" && !lineageCapable) snapshot.lineage = expected?.lineage;
          if (await this.cache.acceptSnapshot(snapshot, expected)) {
            if (snapshotLineage) {
              if (snapshotLineage.lineage) receivedLineages[snapshotLineage.conversationId] = snapshotLineage.lineage;
              else delete receivedLineages[snapshotLineage.conversationId];
              snapshotLineage = undefined;
            }
            // Snapshots replace replayed turn.state invalidations too.
            this.groupDiscussionRevision++;
            this.activeMessages = new Set(await this.cache.activeMessages()); this.update({}, true);
          }
          if (snapshot.type === "snapshot.begin") snapshotLineage = { conversationId: snapshot.conversation.id, lineage: snapshot.lineage };
          if (snapshot.type === "snapshot.message" && generation === this.generation && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 1, type: "snapshot.ack", id: snapshot.id, count: snapshot.index + 1 }));
          this.lastTraffic = Date.now(); return;
        }
        if (frame.type === "sync.conversation") {
          if (receiveFailed) return;
          if (!this.independentSync || !this.syncing || typeof frame.conversationId !== "string" || !this.pendingSync.delete(frame.conversationId)) throw new Error("unexpected_conversation_sync");
          const total = this.state.syncProgress?.total ?? 0;
          const completed = total - this.pendingSync.size, now = performance.now();
          // A completion marker changes queue eligibility, not cached history.
          // Publish committed replay immediately, but don't render every empty
          // conversation during reconnect. The final marker is always visible.
          if (completed === 1 || !this.pendingSync.size || now - this.syncProgressPublishedAt >= 100) {
            this.syncProgressPublishedAt = now;
            this.update({ syncProgress: { completed, total } }, false, true);
          } else if (this.replayEvents) this.update({}, false, true);
          await this.flush(); return;
        }
        if (frame.type === "sync.complete") { if (receiveFailed) return; this.syncing = false; this.pendingSync.clear(); this.update({ syncProgress: undefined }, false, true); await this.flush(); return; }
        if (frame.type === "conversation-folders.updated") { await this.acceptConversationFolders(conversationFoldersSchema.parse(frame.folders), generation); return; }
        if (frame.type === "conversation.updated") { this.groupDiscussionRevision++; await this.cache.saveConversations([conversationSchema.parse(frame.conversation)]); if (typeof frame.clientActionId === "string") await this.ack(frame.clientActionId); this.update({}, true); return; }
        if (frame.type === "message.ack" && typeof frame.clientMsgId === "string") {
          // An earlier event/parse/cache failure invalidates the local-history
          // watermark for this socket. Keep the durable item until reconnect
          // completes synchronization and safely resends the same idempotent ID.
          if (!receiveFailed) {
            await this.ack(frame.clientMsgId, true, {
              ...(typeof frame.messageId === "string" ? { messageId: frame.messageId } : {}),
              ...(typeof frame.workbenchContextOmitted === "string" ? { workbenchContextOmitted: frame.workbenchContextOmitted } : {}),
            });
            if (frame.workbenchContextOmitted === "history_limit") this.update({ error: t("消息已发送，但工作台历史容量已满；本轮无法操作工作台内容。") });
          }
          return;
        }
        if (frame.type === "interaction.ack" && typeof frame.clientActionId === "string") { await this.ack(frame.clientActionId); return; }
        if (frame.type === "notifications.changed") { void this.refreshNotificationPreferences().catch(() => undefined); return; }
        if (frame.type === "avatar.updated") { this.acceptAvatar(avatarSchema.parse(frame.avatar)); return; }
        if (frame.type === "bot.status") { this.acceptBot(botSchema.parse(frame.bot)); return; }
        if (frame.type === "command.completions") {
          const values = z.json().parse(frame.result), botId = typeof frame.botId === "string" ? frame.botId : undefined, query = typeof frame.query === "string" ? frame.query : undefined;
          this.onCommands?.(values, botId, query);
          this.commandListeners.forEach(listener => listener(values, botId, query)); return;
        }
        // Liveness was recorded when onmessage received the frame. Processing
        // an old pong after slow cache work must not make a dead link fresh.
        if (frame.type === "pong") return;
        if (frame.type === "notice" && frame.code === "device_revoked") {
          // A notice is a transport hint, not a durable revocation proof. Stop
          // sending now and obtain a signed, fresh-nonce denial on reconnect.
          this.retry = 0; this.abandon(ws, generation, false); return;
        }
        if (frame.type === "error") {
          if (frame.code === "session_expired") {
            // The durable outbox still owns unacknowledged messages. Renew
            // authentication without turning them into permanent user errors.
            this.retry = 0; this.abandon(ws, generation, false); return;
          }
          await this.rejectOperation(frame);
        }
      }).catch((error: unknown) => {
        receiveFailed = true;
        if (generation === this.generation && !this.closed) {
          if ((typeof error === "string" ? error : error instanceof Error ? error.message : "") === "device_pairing_required") {
            // This is a local installation boundary, not a signed Host revocation
            // or network outage. Keep cached drafts/history, stop automatic retry
            // and never drain this identity's outbox into a fresh pairing.
            this.pairingRequired = true; this.close(); this.update({ error: connectionErrorMessage(error) }); return;
          }
          if (this.cache.isClosed) { this.cacheUnavailable(); return; }
          this.cacheFull = error instanceof Error && error.name === "QuotaExceededError";
          localFailure = this.cacheFull || error instanceof Error && ["local_reset_in_progress", "sync_lineage_mismatch", "snapshot_lineage_mismatch"].includes(error.message)
            || preparation === "signature";
          this.update({ error: connectionErrorMessage(error) });
        }
        ws.close();
      }).finally(() => { pendingFrames--; }); };
      ws.onclose = (event) => {
        if (generation !== this.generation) { reader.clear(); return; }
        if (!this.closed && event.code !== 1000 && !localFailure) this.failRoute();
        // Stop sending immediately, but finish frames already received before
        // reconnecting. A queued, authenticated revocation must not be discarded
        // merely because its socket closed before IndexedDB finished a write.
        const preserveHttp = event.code === 1000 && (renewing || event.reason === "preferred_route_recovered" && this.routeHandoff?.generation === generation);
        const closing = { generation, resume: false }; this.closingReceive = closing;
        this.offline(false, preserveHttp);
        const drained = () => {
          reader.clear(); if (this.closingReceive === closing) this.closingReceive = undefined;
          if (generation !== this.generation || this.closed) return;
          // A wake that waited for the receive queue must not inherit an old
          // reconnect backoff once those frames have committed.
          if (closing.resume) this.retry = 0;
          this.offline(true, preserveHttp);
        };
        void chain.then(drained, drained);
      };
      ws.onerror = (event) => { if (generation === this.generation && !this.closed) this.update({ error: connectionErrorMessage(event instanceof ErrorEvent ? event.message : undefined) }); this.abandon(ws, generation); };
    } catch (error) { if (generation !== this.generation || this.closed) return; this.update({ error: connectionErrorMessage(error) }); this.offline(); }
  }
  private abandon(ws: HubSocket, generation: number, failed = true): void {
    if (generation !== this.generation) return;
    // A half-open TCP link may never finish a WebSocket close handshake.
    // Retire it immediately and ignore every late callback from that socket.
    if (failed) this.failRoute(); ++this.generation; this.probeAbort?.abort(); ws.close(); this.offline();
  }
  private offline(scheduleReconnect = true, preserveHttp = false): void {
    this.awaitingForegroundProbe = false;
    this.clearForegroundProbe();
    if (this.reconnect) clearTimeout(this.reconnect); this.reconnect = undefined;
    if (this.outboxRetry) clearTimeout(this.outboxRetry);
    if (!preserveHttp) { this.httpEpoch.abort(); this.httpEpoch = new AbortController(); }
    if (this.heartbeat) clearInterval(this.heartbeat); if (this.renewal) clearTimeout(this.renewal); if (this.probeTimer) clearInterval(this.probeTimer); if (this.handshake) clearTimeout(this.handshake); this.token = undefined; this.update({ status: "offline", syncProgress: undefined });
    if (!this.closed && scheduleReconnect && !this.cacheFull) this.reconnect = setTimeout(() => { void this.connect(); }, this.identity.pendingPairing ? 5500 : this.retry++ === 0 ? 0 : Math.min(10_000, 250 * 2 ** Math.min(this.retry - 2, 5)));
  }
  private async pollPreferredRoute(generation: number, wake = false): Promise<void> {
    if (document.hidden) { this.preferred = undefined; return; }
    if (this.probing || this.closed || generation !== this.generation || this.state.status !== "online") return;
    const now = Date.now();
    if (wake) {
      if (now - this.preferredProbeStarted < 1500) return;
    } else if (now < this.preferredProbeAt) return;
    // Timers may be suspended without visibility events. Resume starts a fresh
    // observation window; old samples cannot establish continuous stability.
    if (now - this.preferredProbeStarted > ROUTE_STABLE_PROBE_MS + 30_000) this.preferred = undefined;
    const routes = this.identity.routes, ws = this.ws;
    this.preferredProbeStarted = now;
    await this.probePreferred(generation);
    if (document.hidden || this.closed || generation !== this.generation || this.state.status !== "online" || routes !== this.identity.routes || ws !== this.ws) return;
    this.preferredProbeAt = Date.now() + (this.preferred ? ROUTE_CANDIDATE_PROBE_MS : ROUTE_STABLE_PROBE_MS);
  }
  private async probePreferred(generation: number): Promise<void> {
    if (this.probing || this.closed || generation !== this.generation || this.state.status !== "online" || document.hidden) return; this.probing = true;
    const routes = this.identity.routes, ws = this.ws;
    const currentProbe = () => !document.hidden && generation === this.generation && !this.closed && this.state.status === "online" && routes === this.identity.routes && ws === this.ws;
    const idle = () => !this.syncing && !this.inflight && this.fileTransfers === 0 && this.httpMutations === 0 && this.activeMessages.size === 0 && Date.now() - this.lastTraffic > 1500;
    try {
      const chosen = await this.selectRoute(); if (!currentProbe()) return;
      const active = this.state.routeHealth?.find(probe => probe.url === this.state.route?.url);
      if (active?.latency !== undefined) this.update({ latency: active.latency });
      const candidate = this.state.routeHealth?.find(probe => probe.url === chosen.route.url);
      if (chosen.route.url === this.state.route?.url || !candidate || !this.routePerformance.promising(candidate, active, Date.now())) { this.preferred = undefined; return; }
      const previous = this.preferred;
      this.preferred = { url: chosen.route.url, count: previous?.url === chosen.route.url ? previous.count + 1 : 1,
        since: previous?.url === chosen.route.url ? previous.since : Date.now() };
      if (this.preferred.count < 3 || Date.now() - this.preferred.since < ROUTE_OBSERVATION_MS
        || Date.now() - this.lastRouteChange < ROUTE_DWELL_MS || !this.routePerformance.worthwhile(candidate, active, Date.now()) || !ws || !idle()) return;
      const outboxRevision = this.outboxRevision, outbox = await this.cache.outbox();
      if (!currentProbe() || !idle() || outboxRevision !== this.outboxRevision || outbox.some(m => !m.error)) return;
      this.routeHandoff = { ...chosen, generation, routes, expiresAt: Date.now() + 10_000 };
      ws.close(1000, "preferred_route_recovered");
    } catch { if (currentProbe()) this.preferred = undefined; /* Heartbeat owns failure recovery. */ }
    finally { this.probing = false; }
  }
  private acceptConversationFolders(value: ConversationFoldersState, generation: number, authoritative = false, observedVersion?: number): Promise<void> {
    // Serialize cache/state publication as well as checking the socket epoch.
    // Old HTTP/cache work must finish before a new ready snapshot replaces it.
    const work = this.folderUpdates.then(async () => {
      if (this.closed || generation !== this.generation) return;
      // A conflict GET is authoritative only if no newer update arrived while
      // it was in flight. Otherwise retain the usual monotonic revision check.
      const replace = authoritative && (observedVersion === undefined || observedVersion === this.folderVersion);
      if (!replace && value.revision < (this.state.conversationFolders?.revision ?? 0)) return;
      await this.cache.saveConversationFolders(value, this.identity, replace);
      if (this.closed || generation !== this.generation) return;
      this.folderVersion++; this.update({ conversationFolders: value });
    });
    this.folderUpdates = work.catch(() => undefined);
    return work;
  }
  async batchConversations(input: ConversationBatch) {
    if (this.state.status !== 'online' || !this.state.conversationBatchAvailable) throw new Error(t('连接恢复并升级此主机后可批量整理对话。'));
    const generation = this.generation;
    const result = conversationBatchResultSchema.parse(await this.http('/api/conversations/batch', { method: 'POST', body: JSON.stringify(input), signal: timeoutSignal(20_000) }));
    if (result.receipt.requestId !== input.requestId || result.receipt.action !== input.action) throw new Error(t('未能确认操作结果，请核对最新状态后再试。'));
    // Conversation updates arrive through the ordered socket. Applying an HTTP
    // snapshot could undo a newer restore received while the response was delayed.
    if (result.folders) await this.acceptConversationFolders(result.folders, generation);
    return result;
  }
  async refreshConversationFolders() {
    const generation = this.generation, observedVersion = this.folderVersion;
    await this.acceptConversationFolders(conversationFoldersSchema.parse(await this.http('/api/conversation-folders')), generation, true, observedVersion);
  }
  async changeConversationFolders(edit: FolderEdit, expectedRevision?: number): Promise<void> {
    if (this.state.status !== "online" || !this.state.foldersAvailable) throw new Error(t("连接恢复或主机升级后可编辑分组"));
    if (edit.type === "pin" && !this.state.folderPinAvailable) throw new Error(t("此主机尚未支持置顶分组，请更新运行 Bot 的电脑上的 TaroBird。"));
    const generation = this.generation;
    try {
      const value = conversationFoldersSchema.parse(await this.http("/api/conversation-folders", { method: "PATCH", body: JSON.stringify({ ...edit, revision: expectedRevision ?? (this.state.conversationFolders ?? emptyConversationFolders()).revision }), signal: timeoutSignal(20_000) }));
      await this.acceptConversationFolders(value, generation);
    } catch (error) {
      // Refresh after a conflict or uncertain receipt; don't replay an edit and
      // silently overwrite another device's move/rename.
      if (!this.closed && generation === this.generation) {
        const observedVersion = this.folderVersion;
        try { await this.acceptConversationFolders(conversationFoldersSchema.parse(await this.http("/api/conversation-folders")), generation, true, observedVersion); } catch { /* keep the last confirmed view */ }
      }
      const code = error instanceof HubHttpError ? error.code : "";
      throw new Error(code === "folder_name_exists" ? t("已有同名分组，请换一个名称") : code === "folders_changed" ? t("分组已在其他设备更新，请重试") : code === "folder_not_found" ? t("此分组已删除，请重新选择") : code === "conversation_not_available" ? t("此对话已不可用") : code === "folder_limit" ? t("分组数量已达上限") : code === "folder_assignment_limit" ? t("已分组对话数量已达上限，包含已归档对话。可先恢复部分归档对话，再将其移回“未分组”以释放额度。") : t("未能确认操作结果，请核对最新状态后再试。"));
    }
  }
  private acceptBot(bot: Bot): void {
    if (bot.role === "worker") { const others = (this.state.dispatchWorkers ?? []).filter(b => b.id !== bot.id); this.update({ dispatchWorkers: bot.deletedAt ? others : [...others, bot] }); return; }
    if (bot.deletedAt) this.update({ bots: this.state.bots.filter(b => b.id !== bot.id), deletedBots: [...(this.state.deletedBots ?? []).filter(b => b.id !== bot.id), bot] });
    else if (!this.state.deletedBots?.some(b => b.id === bot.id)) this.update({ bots: this.state.bots.some(b => b.id === bot.id) ? this.state.bots.map(b => b.id === bot.id ? bot : b) : [...this.state.bots, bot] });
  }
  async deleteMessages(conversationId: string, messageIds: string[]): Promise<{ deletedIds: string[] }> {
    if (!this.state.messageDeletionAvailable) throw new Error("message_deletion_unavailable");
    const input = deleteMessagesSchema.parse({ messageIds });
    const result = deleteMessagesResultSchema.parse(await this.http(`/api/conversations/${conversationId}/messages`, { method: "DELETE", body: JSON.stringify(input), signal: timeoutSignal(20_000) }));
    if (new Set(result.deletedIds).size !== new Set(messageIds).size || result.deletedIds.some(id => !messageIds.includes(id))) throw new Error("message_deletion_unconfirmed");
    return result;
  }
  async planClearMessages(conversationId: string) {
    if (!this.state.messageClearAvailable || this.isReadOnly) throw new Error("message_clear_unavailable");
    return clearMessagesPlanSchema.parse(await this.http(`/api/conversations/${conversationId}/messages/clear`, { signal: timeoutSignal(20_000) }));
  }
  async clearMessagesBatch(conversationId: string, throughId: string) {
    if (!this.state.messageClearAvailable || this.isReadOnly) throw new Error("message_clear_unavailable");
    return clearMessagesResultSchema.parse(await this.http(`/api/conversations/${conversationId}/messages/clear`, { method: "POST", body: JSON.stringify({ throughId }), signal: timeoutSignal(20_000) }));
  }
  async confirmHistoryClear(conversationId: string, seq: number): Promise<void> {
    // An empty retry may follow a lost HTTP receipt. Confirm the committed
    // event cursor, not just this response's (possibly empty) list of IDs.
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      if (await this.cache.cursor(conversationId) >= seq) {
        if (this.replayEvents) this.update({}, true, true);
        return;
      }
      if (this.closed || this.cache.isClosed || this.isReadOnly) break;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error("message_clear_sync_unconfirmed");
  }
  async deleteBot(bot: Bot): Promise<void> {
    const result = z.object({ bot: botSchema, conversations: z.array(conversationSchema) }).parse(await this.http(`/api/bots/${bot.id}`, { method: "DELETE", body: JSON.stringify({ expectedName: bot.name, confirm: true }), signal: timeoutSignal(20_000) }));
    if (!result.bot.deletedAt || result.bot.id !== bot.id) throw new Error("bot_delete_unconfirmed");
    this.acceptBot(result.bot);
    // Conversations also arrive on the socket; refresh persisted views after the receipt.
    this.refreshCache();
  }
  async createBot(input: CreateBotInput): Promise<Bot> {
    const bot = botSchema.parse(await this.http("/api/bots", { method: "POST", body: JSON.stringify(input), signal: timeoutSignal(20_000) }));
    // A newer online status may arrive before this HTTP response.
    if (!this.state.deletedBots?.some(b => b.id === bot.id) && !this.state.bots.some((b) => b.id === bot.id)) this.update({ bots: [...this.state.bots, bot] });
    return this.state.bots.find((b) => b.id === bot.id) ?? bot;
  }
  async createConversation(frame: Extract<ClientFrame, { type: "conversation.create" | "topic.create" }>): Promise<Conversation> {
    const conversation = conversationSchema.parse(await this.http("/api/conversations", { method: "POST", body: JSON.stringify(frame), signal: timeoutSignal(20_000) }));
    const current = await this.cache.seedConversation(conversation); this.update({}, true); return current;
  }
  async send(frame: ClientFrame, designComments?: WorkbenchDraft): Promise<void> {
    if (this.pairingRequired) throw new Error(connectionErrorMessage("device_pairing_required"));
    if (this.deviceRevoked) throw new Error(t("此设备已被吊销，请重新配对"));
    if (this.networkBlocked) throw new Error(t("网络授权已失效"));
    if (frame.type === "message.send") assertMessageTextSize(frame.text);
    frame = clientFrameSchema.parse(frame);
    if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > MAX_FRAME_BYTES) throw new Error(t("消息过大，请作为文件发送"));
    if ("clientMsgId" in frame || "clientActionId" in frame) {
      if (this.cache.isClosed) { this.cacheUnavailable(); throw new Error(connectionErrorMessage("local_cache_unavailable")); }
      await this.cache.enqueue(frame, designComments ? { identity: this.identity, userId: this.state.user?.id ?? "", draft: designComments } : undefined); this.outboxQueued.forEach(listener => listener(frame)); this.outboxChanged(frameConversation(frame)); this.update({ outbox: (await this.cache.outbox()).length }); await this.flush();
    }
    else { if (this.ws?.readyState !== WebSocket.OPEN || this.state.status !== "online") throw new Error(t("连接恢复后即可操作")); this.ws.send(JSON.stringify(frame)); }
  }
  async queueDiffReview(scope: DiffReviewScope, expectedRevision?: string) {
    if (this.isReadOnly || this.state.user?.role !== "owner") throw new Error("diff_review_forbidden");
    const result = await this.cache.enqueueDiffReview(scope, this.identity, expectedRevision);
    if (!result.reused) this.outboxQueued.forEach(listener => listener(result.frame));
    this.outboxChanged(scope.conversationId); this.update({ outbox: (await this.cache.outbox()).length }); await this.flush();
    return result;
  }
  async retryDiffReview(scope: DiffReviewScope, clientMsgId: string) {
    if (this.isReadOnly || this.state.user?.role !== "owner") throw new Error("diff_review_forbidden");
    const result = await this.cache.retryDiffReview(scope, this.identity, clientMsgId);
    this.outboxChanged(scope.conversationId); await this.flush(); return result;
  }
  async abandonDiffReview(scope: DiffReviewScope, clientMsgId: string) {
    const draft = await this.cache.abandonDiffReview(scope, this.identity, clientMsgId);
    if (this.inflightEntry?.id === clientMsgId) this.inflightEntry = undefined;
    if (this.inflight === clientMsgId) this.inflight = undefined;
    this.outboxChanged(scope.conversationId); await this.flush(); return draft;
  }
  /** Take before sending turn.stop: it is never queued or replayed, and the Hub
   * reports only stop_incomplete (without a request ID) to the sending socket. */
  stopReceipt(): StopReceipt { return { socket: this.generation, failures: this.stopFailures }; }
  private async rejectOperation(frame: Record<string, unknown>): Promise<void> {
    // Keep terminal card rejections next to the retained request, not in the
    // host-wide connection banner. Unknown/other requests retain normal errors.
    let expired = false;
    if (frame.code === UNAVAILABLE_CARD_ACTION && frame.retryable === false && typeof frame.requestId === "string") {
      const entry = this.inflightEntry?.id === frame.requestId ? this.inflightEntry
        : (await this.cache.outbox()).find(item => item.id === frame.requestId);
      expired = !entry || entry.frame.type === "interaction.submit";
    }
    if (frame.code === "stop_incomplete") this.stopFailures++;
    const error = expired ? UNAVAILABLE_CARD_ACTION : frame.code === "stop_incomplete" ? t("未能确认所有 Bot 已停止，请检查运行状态。")
      : frame.code === "group_discussion_active" ? t("群内已有进行中的讨论。请结束讨论后重试，或仅转发保存。")
      : frame.code === "group_discussion_start_required" ? t("此群按顺序讨论。请在输入框发起讨论，转发时只能选择一位 Bot 回复。")
      : frame.code === "group_reply_mode_changed" ? changedGroupReply()
      : frame.code === "group_parallel_client_update_required" ? t("此群已开启并行回复，请更新 App 后发送，或先指定回复的 Bot。")
      : frame.code === "attachment_unavailable" ? t("原附件已丢失或损坏，请重新上传后发送。")
      : frame.code === "binding_conflict" ? t("另一台设备已更改会话选择，请确认最新状态后重试。")
      : frame.retryable !== false && typeof frame.requestId === "string" ? t("暂时未能确认操作，正在稍后重试。")
      : frame.code === UNAVAILABLE_CARD_ACTION ? t("此卡片操作已失效，请查看最新卡片。")
      : typeof frame.message === "string" ? frame.message : t("请求失败");
    const groupMessageError = typeof frame.requestId === "string" && ["group_discussion_active", "group_discussion_start_required", "group_reply_mode_changed"].includes(String(frame.code));
    if (!expired && !groupMessageError) this.update({ error });
    if (typeof frame.requestId === "string") {
      const owner = this.inflightEntry?.id === frame.requestId ? this.inflightEntry : (await this.cache.outbox()).find(item => item.id === frame.requestId);
      if (frame.retryable === false) await this.cache.fail(frame.requestId, error);
      else await this.cache.retryableFailure(frame.requestId, t("多次发送未确认，请检查消息记录后重试或移除待发送项。"));
      this.outboxChanged(owner && frameConversation(owner.frame));
      if (frame.retryable === false && this.inflightEntry?.id === frame.requestId) this.inflightEntry = undefined;
      if (this.inflight === frame.requestId) this.inflight = undefined;
      await this.flush();
    }
  }
  clearError(): void { this.update({ error: undefined }); }
  async retryFailed(id: string): Promise<void> {
    if (await this.cache.retryFailed(id)) {
      const entry = (await this.cache.outbox()).find(item => item.id === id);
      this.outboxChanged(entry && frameConversation(entry.frame)); await this.flush();
    } else this.refreshCache();
  }
  async discardFailed(id: string): Promise<void> {
    const removed = await this.cache.discardFailed(id);
    if (removed && this.inflightEntry?.id === removed.id && this.inflightEntry.order === removed.order) this.inflightEntry = undefined;
    this.settleOutbox(removed, false); if (removed) this.outboxChanged(frameConversation(removed.frame)); await this.flush();
  }
  private async ack(id: string, messageAccepted = false, acceptance?: DesignCommentAcceptance): Promise<void> {
    const removed = await this.cache.acknowledge(id, messageAccepted, acceptance);
    // Another window sharing this cache may have committed the deletion first.
    // Our own sent entry still proves what this authenticated ACK confirms.
    this.settleOutbox(removed ?? (messageAccepted && this.inflightEntry?.id === id ? this.inflightEntry : undefined), messageAccepted);
    const owner = removed ?? (this.inflightEntry?.id === id ? this.inflightEntry : undefined);
    this.outboxChanged(owner && frameConversation(owner.frame));
    if (this.inflightEntry?.id === id) this.inflightEntry = undefined;
    if (this.inflight === id) this.inflight = undefined;
    await this.flush();
  }
  private async flush(): Promise<void> {
    const entries = await this.cache.outbox();
    // Older clients left this request error in the host banner even after
    // discard/ACK. Clearing exactly this legacy code preserves all other errors.
    // Reading/sending the queue changes no cached history; mutations already
    // refreshed their owning conversation. Publish only the queue count.
    if (this.state.outbox !== entries.length || this.state.error === UNAVAILABLE_CARD_ACTION)
      this.update({ outbox: entries.length, ...(this.state.error === UNAVAILABLE_CARD_ACTION ? { error: undefined } : {}) });
    if (this.outboxRetry) clearTimeout(this.outboxRetry);
    if (this.syncing && !this.independentSync || this.inflight || this.state.status !== "online" || this.ws?.readyState !== WebSocket.OPEN) return;
    const blocked = new Set<string>(); let wakeAt = Infinity;
    for (const entry of entries) {
      // Local guard failures await durable storage below. Another flush or a
      // route change may have taken ownership while that write was pending.
      if (this.inflight || this.state.status !== "online" || this.ws?.readyState !== WebSocket.OPEN) return;
      const conversation = "conversationId" in entry.frame ? entry.frame.conversationId : "groupId" in entry.frame ? entry.frame.groupId : entry.id;
      if (this.syncing && this.pendingSync.has(conversation)) continue;
      if (blocked.has(conversation)) continue;
      if (entry.error) { if (outboxFailureBlocks(entry)) blocked.add(conversation); continue; }
      if (entry.retryAt && entry.retryAt > Date.now()) { blocked.add(conversation); wakeAt = Math.min(wakeAt, entry.retryAt); continue; }
      let wire: ClientFrame;
      try { wire = groupReplyWireFrame(entry.frame, this.state); }
      catch (cause) {
        const error = cause instanceof Error ? cause.message : changedGroupReply();
        await this.cache.fail(entry.id, error); this.outboxChanged(conversation); blocked.add(conversation); continue;
      }
      this.inflight = entry.id; this.inflightEntry = entry; this.ws.send(JSON.stringify(wire)); return;
    }
    if (Number.isFinite(wakeAt)) this.outboxRetry = setTimeout(() => { void this.flush().catch(() => undefined); }, Math.max(1, wakeAt - Date.now()));
  }
  updateRoutes(input: Route[], options?: { deployment?: Deployment; expected?: Route[]; reason?: "user" | "host-sync" }): Promise<void> {
    const routes = localRoutesSchema.parse(input), expected = options?.expected ?? this.identity.routes;
    const work = this.routeWrites.then(async () => {
      if (this.identity.routes !== expected) throw new Error("routes_changed");
      const deployment = deploymentSchema.optional().parse(options && "deployment" in options ? options.deployment : this.identity.deployment);
      if (!deploymentMatchesRoutes(deployment, routes)) throw new Error("deployment_routes_mismatch");
      if (networkCanonical(routes) === networkCanonical(this.identity.routes) && deployment === this.identity.deployment) return;
      await this.cache.saveIdentityRoutes({ ...this.identity }, routes, deployment);
      this.identity.routes = routes; this.identity.deployment = deployment;
      this.routeHandoff = undefined;
      this.routePerformance.retain(routes.map(route => route.url));
      if (this.preferred && !routes.some(route => route.url === this.preferred!.url)) this.preferred = undefined;
      for (const url of this.failedRoutes.keys()) if (!routes.some(route => route.url === url)) this.failedRoutes.delete(url);
      this.preferredProbeAt = 0;
      const current = routes.find(route => route.url === this.state.route?.url);
      this.update({ routeSync: undefined, route: current ?? this.state.route, routeHealth: this.state.routeHealth?.filter(health => routes.some(route => route.url === health.url)) });
      if (this.state.status !== "online" || !current) this.resume(true);
      else void this.pollPreferredRoute(this.generation, true);
    });
    this.routeWrites = work.catch(() => undefined);
    return work;
  }
  /** In-memory diagnosis from an actual provenance-aware merge, never an
   * estimate from the listener list. A late result cannot describe another
   * identity or a route configuration that has since been edited. */
  recordRouteSyncResult(source: RouteSyncSource, expected: Pick<Identity, "hubPublicKey" | "deviceId" | "publicKey" | "routes">, limited: boolean): void {
    if (this.closed || this.isReadOnly || expected.hubPublicKey !== this.identity.hubPublicKey || expected.deviceId !== this.identity.deviceId
      || expected.publicKey !== this.identity.publicKey || networkCanonical(expected.routes) !== networkCanonical(this.identity.routes)) return;
    if (this.state.routeSync?.[source]?.limited === limited) return;
    this.update({ routeSync: { ...this.state.routeSync, [source]: { limited } } });
  }
  /** Call only after a successful preferences write. Desktop notification policy
   * reads this same store, so it must not wait for a fallible follow-up GET. */
  acceptNotificationPreferences(preferences: NotificationState["preferences"]): void {
    if (this.closed || !this.state.notifications) return;
    ++this.notificationRequest;
    this.update({ notifications: { ...this.state.notifications, preferences } });
  }
  /** Acknowledged mute writes supersede earlier HTTP reads and WS refresh hints. */
  acceptConversationMute(conversationId: string, muted: boolean): void {
    ++this.notificationRequest;
    if (this.closed || !this.state.notifications) return;
    const ids = new Set(this.state.notifications.mutedConversations);
    if (muted) ids.add(conversationId); else ids.delete(conversationId);
    this.update({ notifications: { ...this.state.notifications, mutedConversations: [...ids] } });
  }
  async refreshNotificationPreferences(signal?: AbortSignal): Promise<NotificationState> {
    const request = ++this.notificationRequest, generation = this.generation;
    const state = await this.http<NotificationState>("/api/notifications", { signal });
    if (!this.closed && generation === this.generation && request === this.notificationRequest) this.update({ notifications: state });
    return state;
  }
  private async duringMutation<T>(work: () => Promise<T>): Promise<T> {
    this.httpMutations++;
    try { return await work(); } finally { this.httpMutations--; this.lastTraffic = Date.now(); }
  }
  async http<T = unknown>(route: string, init: RequestInit = {}): Promise<T> {
    if (init.method?.toUpperCase() === "POST" && ["/api/devices/approve", "/api/devices/revoke"].includes(route)) return this.duringMutation(() => this.deviceAction<T>(route, init));
    const epoch = this.httpEpoch, generation = this.generation;
    const value = await this.httpRequest<T>(route, init);
    if (route === "/api/host-profile" && ["GET", "PATCH"].includes(init.method?.toUpperCase() ?? "GET")) {
      const profile = hostProfileSchema.parse(value);
      // An older in-flight refresh must not undo a confirmed rename. Publish
      // the receipt even when the independent network-directory read fails.
      if (!this.closed && epoch === this.httpEpoch && generation === this.generation
        && (!this.state.hostProfile || profile.revision > this.state.hostProfile.revision)) this.update({ hostProfile: profile });
    }
    return value;
  }
  /** Network metadata is optional: an old Hub or a failed directory must not
   * block chat. Every completion stays bound to the original authenticated epoch. */
  async refreshNetwork(): Promise<NetworkView | undefined> {
    if (!this.state.networkAvailable || this.state.status !== "online" || this.state.user?.role !== "owner") return;
    const epoch = this.httpEpoch, generation = this.generation, networkRevision = this.networkRevision;
    const [view] = await Promise.all([
      this.httpRequest<NetworkView>("/api/network").then(value => { if (value.membership) verifyNetworkMembership(value.membership, this.identity.hubPublicKey); return networkViewSchema.parse(value); }),
      this.http("/api/host-profile"),
    ]);
    if (this.closed || epoch !== this.httpEpoch || generation !== this.generation || networkRevision !== this.networkRevision) return;
    if (view.host.publicKey !== this.identity.hubPublicKey) throw new Error("network_host_mismatch");
    this.networkRemote = view.membership;
    if (this.networkPin && (!view.membership || view.membership.manifest.id !== this.networkPin.id || view.membership.manifest.authorityKey !== this.networkPin.authorityKey)) {
      this.update({networkChange:view}); throw new Error("network_membership_changed");
    }
    await this.acceptNetworkView(view, false, () => !this.closed && epoch === this.httpEpoch && generation === this.generation && networkRevision === this.networkRevision);
    if (this.closed || epoch !== this.httpEpoch || generation !== this.generation || networkRevision !== this.networkRevision) return;
    // Periodic discovery usually returns the same verified view. Publishing an
    // identical copy re-rendered every subscriber every few seconds.
    if (JSON.stringify(view) !== JSON.stringify(this.state.network)) this.update({ network: view });
    return view;
  }
  async confirmNetworkChange(review: NetworkView): Promise<void> {
    const epoch = this.httpEpoch, revision = ++this.networkRevision;
    const value = await this.httpRequest<NetworkView>("/api/network");
    if (value.membership) verifyNetworkMembership(value.membership, this.identity.hubPublicKey);
    const fresh = networkViewSchema.parse(value);
    if (fresh.host.publicKey !== this.identity.hubPublicKey || networkCanonical(fresh.membership ?? null) !== networkCanonical(review.membership ?? null)) throw new Error("network_review_changed");
    const current = () => !this.closed && epoch === this.httpEpoch && revision === this.networkRevision;
    if (!current()) throw new Error("device_action_cancelled");
    await this.acceptNetworkView(fresh, true, current);
    if (!current()) return;
    this.networkRemote = fresh.membership; this.update({network:fresh,networkChange:undefined});
  }
  private async acceptNetworkView(view: NetworkView, explicit = false, current = () => true): Promise<void> {
    if (view.membership) verifyNetworkMembership(view.membership, this.identity.hubPublicKey, explicit ? undefined : this.networkPin);
    await this.cache.saveNetworkMembership(this.identity, view.membership, explicit);
    if (current()) {
      const previous = this.networkPin, next = view.membership?.manifest;
      this.networkKnown = view.membership; this.networkPin = next;
      if (this.state.routeSync?.network && (previous?.id !== next?.id || previous?.authorityKey !== next?.authorityKey)) {
        this.update({ routeSync: this.state.routeSync.host ? { host: this.state.routeSync.host } : undefined });
      }
    }
  }
  async networkCommand(raw: NetworkCommandInput): Promise<{ view: NetworkView; membership?: SignedNetworkManifest; proposal?: SignedNetworkProposal }> {
    return this.duringMutation(() => this.performNetworkCommand(raw));
  }
  private async performNetworkCommand(raw: NetworkCommandInput): Promise<{ view: NetworkView; membership?: SignedNetworkManifest; proposal?: SignedNetworkProposal }> {
    const command = networkCommandSchema.parse(["routes", "attest", "remove", "leave"].includes(raw.operation) ? {networkId: this.networkPin?.id ?? "", ...(["remove", "leave"].includes(raw.operation) ? {expectedState: this.state.network?.membership?.manifest.hosts.find(h => h.publicKey === (raw.operation === "remove" ? raw.publicKey : this.identity.hubPublicKey))?.state ?? "standalone"} : {}), ...raw} : raw), token = this.token, epoch = this.httpEpoch;
    let revision = this.networkRevision;
    const current = () => { if (!token || this.closed || this.token !== token || epoch !== this.httpEpoch || epoch.signal.aborted || revision !== this.networkRevision) throw new HubHttpError(409, "device_action_cancelled"); };
    current();
    if (["create", "join", "leave"].includes(command.operation)) revision = ++this.networkRevision;
    const action = deviceActionSchema.parse({ operation: "network", target: bytesToHex(sha256(new TextEncoder().encode(networkCanonical(command)))) });
    const statement = boundDeviceActionStatement(await this.httpRequest("/api/devices/challenge", { method: "POST", body: JSON.stringify(action) }), {
      action, hubPublicKey: this.identity.hubPublicKey ?? "", deviceId: this.identity.deviceId, sessionHash: bytesToHex(sha256(new TextEncoder().encode(token!))),
    });
    current(); const signature = await signDeviceAction(this.identity, statement); current();
    const expected = command.operation === "join" ? command.membership.manifest : this.networkPin;
    const departure = command.operation === "leave" && command.expectedState === "active" && expected?.authorityKey !== this.identity.hubPublicKey ? new AbortController() : undefined;
    if (departure) { this.departureRequest?.abort(); this.departureRequest = departure; }
    const timer = departure ? setTimeout(() => departure.abort(), 30_000) : undefined;
    const stillCurrent = () => {
      if (!departure) { current(); return; }
      if (departure.signal.aborted || this.departureRequest !== departure || revision !== this.networkRevision) throw new HubHttpError(409, "device_action_cancelled");
    };
    try {
      const body = JSON.stringify({ command, proof: { nonce: statement.nonce, signature } });
      // Active leave can revoke this very session. Its one signed departure
      // receipt may finish across transport revocation; ordinary close/reset
      // still cancels it. No other action bypasses the authenticated epoch.
      const result = departure ? await (async () => {
        const response = await hubFetch(this.state.route!.url, "/api/network/manage", this.identity.hubPublicKey, {method:"POST",body,headers:{Authorization:`Bearer ${token}`},signal:departure.signal});
        if (!response.ok) { const failure = await response.json().catch(() => ({})) as {error?:string}; throw new HubHttpError(response.status, failure.error ?? t("请求失败")); }
        return await response.json() as {view:NetworkView;membership?:SignedNetworkManifest;proposal?:SignedNetworkProposal};
      })() : await this.httpRequest<{view:NetworkView;membership?:SignedNetworkManifest;proposal?:SignedNetworkProposal}>("/api/network/manage", {method:"POST",body});
      stillCurrent();
      if (result.view.membership) {
        verifyNetworkMembership(result.view.membership, this.identity.hubPublicKey, command.operation === "create" ? undefined : expected);
        if (command.operation === "create" && result.view.membership.manifest.authorityKey !== this.identity.hubPublicKey) throw new Error("network_authority_mismatch");
      }
      if (result.membership) verifyNetworkMembership(result.membership, undefined, command.operation === "create" ? result.view.membership?.manifest : expected);
      networkCommandResultSchema.parse(result);
      const view = networkViewSchema.parse(result.view);
      if (view.host.publicKey !== this.identity.hubPublicKey) throw new Error("network_host_mismatch");
      if (departure) {
        if (!expected || !result.membership?.manifest.hosts.some(host => host.publicKey === this.identity.hubPublicKey && host.revoked)
          || view.membership || view.sync !== "standalone") throw new Error("network_departure_unconfirmed");
      }
      await this.acceptNetworkView(view, ["create", "join", "leave"].includes(command.operation), () => {
        try { stillCurrent(); return true; } catch { return false; }
      });
      stillCurrent(); if (departure) this.networkDeparture = result.membership;
      this.networkRemote = view.membership;
      this.update({ network: view, networkChange: undefined });
      return { ...result, view };
    } finally { if (timer) clearTimeout(timer); if (this.departureRequest === departure) this.departureRequest = undefined; }
  }

  /** Remote-screen calls are interactive and serialise the viewer's open/stop
   * chain, so they get a short bound instead of the general 5-minute one. A
   * timed-out call is reported as `screen_request_timeout` and never retried
   * here: an open whose answer was lost may still have created a session the
   * client cannot name, which the Host retires when nobody attaches to it. */
  private screenRequest<T>(route: string, init: RequestInit = {}): Promise<T> {
    return this.httpRequest<T>(route, init, { ms: SCREEN_REQUEST_TIMEOUT_MS, code: "screen_request_timeout" });
  }
  async screenStatus() { return screenStatusSchema.parse(await this.screenRequest("/api/screens/status")); }
  async screenConfigure(raw: ScreenConfigure) {
    return this.duringMutation(async () => {
      const command = screenConfigureSchema.parse(raw), token = this.token, epoch = this.httpEpoch;
      const current = () => { if (!token || this.closed || this.token !== token || this.httpEpoch !== epoch || epoch.signal.aborted) throw new HubHttpError(409, "device_action_cancelled"); };
      current();
      const action = deviceActionSchema.parse({ operation: "screen-grant", target: bytesToHex(sha256(new TextEncoder().encode(screenConfigureText(command)))) });
      const statement = boundDeviceActionStatement(await this.httpRequest("/api/devices/challenge", { method: "POST", body: JSON.stringify(action) }),
        { action, hubPublicKey: this.identity.hubPublicKey ?? "", deviceId: this.identity.deviceId, sessionHash: bytesToHex(sha256(new TextEncoder().encode(token!))) });
      current(); const signature = await signDeviceAction(this.identity, statement); current();
      const result = await this.httpRequest("/api/screens/configure", { method: "POST", body: JSON.stringify({ command, proof: { nonce: statement.nonce, signature } }) });
      current(); return screenPolicySchema.parse(result);
    });
  }
  /** Send `quality` only when `screenQualityAvailable`; an older Host rejects the field. */
  async screenOpen(input: { desktopId: string; displayId: string; displayRevision: number; requestId: string; codecs: ("h264" | "vp8")[]; quality?: ScreenQuality }) {
    const route = this.state.route, epoch = this.httpEpoch;
    if (!route || !this.identity.hubPublicKey) throw new Error("screen_host_offline");
    const join = screenJoinSchema.parse(await this.screenRequest("/api/screens/sessions", { method: "POST", body: JSON.stringify(input) }));
    if (this.closed || epoch !== this.httpEpoch || this.state.route?.url !== route.url) { void this.screenStop(join.session.id).catch(() => undefined); throw new Error("screen_route_changed"); }
    return { join, network: { url: route.url, publicKey: this.identity.hubPublicKey, ...routeTrust(route.url, this.identity.hubPublicKey) } };
  }
  async screenStop(sessionId?: string) { return this.screenRequest("/api/screens/stop", { method: "POST", body: JSON.stringify({ sessionId }) }); }

  async saveBotMessageGrants(raw: BotMessageGrantsCommand, signal?: AbortSignal, submitting?: () => void) {
    return this.duringMutation(async () => botMessageGrantsSnapshotSchema.parse(await this.performMessageGrantRequest("/api/bot-messages/grants", botMessageGrantsCommandSchema.parse(raw), signal, submitting)));
  }
  async saveCrossHostMessageGrants(raw: CrossHostMessageGrantsCommand, signal?: AbortSignal, submitting?: () => void) {
    return this.duringMutation(async () => crossHostMessageGrantsSnapshotSchema.parse(await this.performMessageGrantRequest("/api/bot-messages/cross-host-grants", crossHostMessageGrantsCommandSchema.parse(raw), signal, submitting)));
  }
  private async performMessageGrantRequest(route: string, command: BotMessageGrantsCommand | CrossHostMessageGrantsCommand, signal?: AbortSignal, submitting?: () => void) {
    const token = this.token, epoch = this.httpEpoch;
    const current = () => { if (!token || this.closed || this.token !== token || this.httpEpoch !== epoch || epoch.signal.aborted || signal?.aborted) throw new HubHttpError(409, "device_action_cancelled"); };
    current();
    const action = deviceActionSchema.parse({ operation: "bot-message-grant", target: bytesToHex(sha256(new TextEncoder().encode(networkCanonical(command)))) });
    const statement = boundDeviceActionStatement(await this.httpRequest("/api/devices/challenge", { method: "POST", body: JSON.stringify(action), signal }),
      { action, hubPublicKey: this.identity.hubPublicKey ?? "", deviceId: this.identity.deviceId, sessionHash: bytesToHex(sha256(new TextEncoder().encode(token!))) });
    current(); const signature = await signDeviceAction(this.identity, statement); current();
    submitting?.();
    const result = await this.httpRequest(route, { method: "POST", signal, body: JSON.stringify({ command, proof: { nonce: statement.nonce, signature } }) });
    current(); return result;
  }

  private async deviceAction<T>(route: string, init: RequestInit): Promise<T> {
    const token = this.token, epoch = this.httpEpoch;
    const current = () => {
      if (!token || this.closed || this.token !== token || this.httpEpoch !== epoch || epoch.signal.aborted || init.signal?.aborted) throw new HubHttpError(409, "device_action_cancelled");
    };
    current();
    const approving = route === "/api/devices/approve";
    const input = (approving ? z.object({ code: z.string() }).strict() : z.object({ deviceId: z.string() }).strict()).parse(JSON.parse(String(init.body)));
    const action = deviceActionSchema.parse({ operation: approving ? "approve" : "revoke", target: "code" in input ? input.code : input.deviceId });
    let raw: unknown;
    try { raw = await this.httpRequest("/api/devices/challenge", { method: "POST", body: JSON.stringify(action), signal: init.signal }); }
    catch (error) { if (error instanceof HubHttpError && error.status === 404) throw new HubHttpError(409, "device_action_unavailable"); throw error; }
    current();
    let statement;
    try { statement = boundDeviceActionStatement(raw, { action, hubPublicKey: this.identity.hubPublicKey ?? "", deviceId: this.identity.deviceId, sessionHash: bytesToHex(sha256(new TextEncoder().encode(token!))) }); }
    catch { throw new HubHttpError(403, "device_action_invalid"); }
    let signature: string;
    try { signature = await signDeviceAction(this.identity, statement); }
    catch { throw new HubHttpError(403, "device_action_signing_failed"); }
    current();
    // Never replay after token renewal, route replacement, cancellation or reset.
    return this.httpRequest<T>(route, { ...init, body: JSON.stringify({ ...input, proof: { nonce: statement.nonce, signature } }) });
  }
  /** `bound` (screen calls only): a shorter timeout whose expiry, like any
   * abort, also ends the transport and body awaits here, so this request's own
   * cleanup runs at once even if a transport ignores abort. Without it the
   * request keeps the general 5-minute bound and unchanged semantics. */
  private async httpRequest<T = unknown>(route: string, init: RequestInit = {}, bound?: { ms: number; code: string }): Promise<T> {
    if (!this.token || !this.state.route || this.closed) throw new HubHttpError(0, t("连接恢复后即可操作"));
    const controller = new AbortController(), signals = [this.httpEpoch.signal, init.signal].filter((s): s is AbortSignal => !!s);
    const abort = () => controller.abort(); for (const signal of signals) { signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }
    let expired = false;
    const timer = setTimeout(() => { expired = true; abort(); }, bound?.ms ?? 300_000);
    let ended: Promise<never> | undefined;
    if (bound) {
      ended = new Promise<never>((_resolve, reject) => {
        const end = () => reject(expired ? new HubHttpError(408, bound.code) : new DOMException("The request was aborted.", "AbortError"));
        if (controller.signal.aborted) end(); else controller.signal.addEventListener("abort", end, { once: true });
      });
      ended.catch(() => undefined);
    }
    // A late answer after the end is dropped: nothing below runs for it.
    const settle = <V>(value: Promise<V>): Promise<V> => ended ? Promise.race([value, ended]) : value;
    const mutation = !["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
    if (mutation) this.httpMutations++;
    try {
      const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${this.token}`);
      const response = await settle(hubFetch(this.state.route.url, route, this.identity.hubPublicKey, { ...init, signal: controller.signal, headers }));
      if (!response.ok) { const body = await settle(response.json().catch(() => ({}))) as { error?: string }; throw new HubHttpError(response.status, body.error ?? t("请求失败")); }
      return await settle(response.json()) as T;
    } catch (error) { if (bound && expired) throw new HubHttpError(408, bound.code); throw error; }
    finally { if (mutation) { this.httpMutations--; this.lastTraffic = Date.now(); } clearTimeout(timer); for (const signal of signals) signal.removeEventListener("abort", abort); }
  }
  private acceptAvatar(avatar: ProfileAvatar): void {
    if (this.closed) return;
    const old = this.state.avatars.find((v) => avatarKey(v) === avatarKey(avatar));
    if (old && old.revision >= avatar.revision) return;
    this.update({ avatars: [...this.state.avatars.filter((v) => avatarKey(v) !== avatarKey(avatar)), avatar] });
    void this.cache.saveProfiles({ user: this.state.user, avatars: this.state.avatars }, this.identity).catch(() => undefined);
  }
  async setAvatar(target: AvatarTarget, expectedRevision: number, dataUrl: string | null): Promise<void> {
    try { this.acceptAvatar(avatarSchema.parse(await this.http(`/api/avatars/${target.kind}/${target.id}`, { method: "PUT", body: JSON.stringify({ expectedRevision, dataUrl }) }))); }
    catch (error) { if (error instanceof HubHttpError && error.status === 409) { const list = z.array(avatarSchema).parse(await this.http("/api/avatars")); list.forEach((v) => this.acceptAvatar(v)); } throw error; }
  }
  avatarBlob(avatar: ProfileAvatar): Promise<Blob> {
    const key = `avatar:${this.identity.hubPublicKey}:${this.identity.deviceId}:${avatarKey(avatar)}:${avatar.revision}`;
    const existing = this.avatarLoads.get(key); if (existing) return existing;
    const load = (async () => {
      const cached = await this.cache.attachment(key).catch(() => undefined); if (cached) return cached;
      if (!this.token || !this.state.route || this.closed) throw new Error("avatar_offline");
      const response = await hubFetch(this.state.route.url, `/api/avatars/${avatar.kind}/${avatar.id}/${avatar.revision}`, this.identity.hubPublicKey, { headers: { Authorization: `Bearer ${this.token}` }, signal: this.httpEpoch.signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error("avatar_unavailable"); } const blob = await response.blob();
      if (!this.closed) await this.cache.saveAttachment(key, blob).catch(() => undefined); return blob;
    })();
    this.avatarLoads.set(key, load); void load.finally(() => this.avatarLoads.delete(key)).catch(() => undefined); return load;
  }
  async readAttachment<T>(id: string, headers: Record<string, string>, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!this.token || !this.state.route || this.closed) throw new HubHttpError(0, t("当前离线，附件尚未缓存"));
    const controller = new AbortController(), signals = [this.httpEpoch.signal, signal].filter((s): s is AbortSignal => !!s);
    const abort = () => controller.abort(); for (const item of signals) { item.addEventListener("abort", abort, { once: true }); if (item.aborted) abort(); }
    const timer = setTimeout(abort, 300_000);
    const route = this.state.route, started = performance.now();
    try {
      const response = await hubFetch(route.url, `/api/attachments/${encodeURIComponent(id)}`, this.identity.hubPublicKey, { headers: { ...headers, Authorization: `Bearer ${this.token}` }, signal: controller.signal, cache: "no-store" });
      try {
        const result = await consume(response);
        const bytes = Number(response.headers.get("Content-Length"));
        if (response.ok && Number.isFinite(bytes)) this.routePerformance.transferred(route.url, bytes, performance.now() - started);
        return result;
      } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => undefined); }
    } finally { clearTimeout(timer); for (const item of signals) item.removeEventListener("abort", abort); }
  }
  blob(id: string, options?: DownloadOptions): Promise<Blob> {
    if (!options) {
      // Legacy consumers retain their lease until completion. Explicit actions
      // keep independent cancellation and never share the passive queue budget.
      const lease = this.acquireAttachment(id);
      void lease.promise.finally(lease.release).catch(() => undefined);
      return lease.promise;
    }
    return (async () => {
      const cached = await this.cache.attachment(id).catch(() => undefined); if (options?.signal?.aborted) throw new Error(t("下载已取消。"));
      if (cached) { options?.progress?.(1); return cached; }
      return this.downloadBlob(id, options);
    })();
  }
  acquireAttachment(id: string, interactive = false): AttachmentLease { return this.passiveAttachments.acquire(id, interactive); }
  private readonly deletedAttachments = new Set<string>();
  /** This device deleted these host attachments (File Center › 附件管理): drop its
   * own cached copies and let mounted messages show 附件已删除 at once. Other
   * devices keep any copy they already downloaded. */
  async forgetDeletedAttachments(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    for (const id of ids) this.deletedAttachments.add(id);
    this.update({ attachmentDeletions: (this.state.attachmentDeletions ?? 0) + 1 });
    await this.cache.forgetAttachments(ids).catch(() => undefined);
    // Videos above 16 MiB are cached on disk, outside IndexedDB.
    await forgetCachedAttachments(ids.map(id => diskCacheKey(this.identity, id))).catch(() => undefined);
  }
  attachmentDeleted(id: string): boolean { return this.deletedAttachments.has(id); }
  private async downloadBlob(id: string, options: DownloadOptions): Promise<Blob> {
    if (this.closed) throw new Error(t("当前离线，附件尚未缓存"));
    const { downloadAttachment } = await import("./downloads.js");
    const blob = await downloadAttachment(this, id, options);
    if (!this.closed && !options.signal?.aborted) await this.cache.saveAttachment(id, blob).catch(() => undefined);
    return blob;
  }
  async file(id: string, options: DownloadOptions = {}): Promise<AttachmentSource> {
    const cached = await this.cache.attachment(id).catch(() => undefined);
    if (options.signal?.aborted) throw new Error(t("下载已取消。"));
    if (cached) { options.progress?.(1); return memoryAttachment(cached); }
    // Larger files (videos, mostly) are kept on disk instead: opening or saving
    // one again must not download it again.
    // An attachment this device deleted is never served from its own copy.
    const diskKey = diskCacheKey(this.identity, id), onDisk = this.deletedAttachments.has(id) ? undefined : await readCachedAttachment(diskKey);
    if (onDisk && options.signal?.aborted) { await onDisk.dispose(); throw new Error(t("下载已取消。")); }
    if (onDisk) { options.progress?.(1); return onDisk; }
    const { downloadAttachmentSource } = await import("./downloads.js");
    const preferDisk = nativePlatform() !== "web" || await (await import("./browser-download.js")).supportsBrowserDownload();
    const source = await downloadAttachmentSource(this, id, options, preferDisk);
    if (!this.closed) await this.cache.saveAttachment(id, source.blob).catch(() => undefined);
    // Copied in the background; the copy holds its own lease on the download.
    if (!this.closed && source.blob.size > DISK_CACHE_MIN_BYTES) void storeCachedAttachment(diskKey, source.retain(), undefined, () => !this.closed && !this.deletedAttachments.has(id));
    return source;
  }
  get downloadCheckpoints() { return this.cache.downloadCheckpoints(this.identity); }
  private async acceptRevocation(): Promise<void> {
    this.deviceRevoked = true;
    if (this.networkPin) this.networkBlocked = true;
    this.close(true); this.update({ error: t("此设备已被吊销，请重新配对") });
    await this.cache.markIdentityRevoked(this.identity).catch(() => console.warn("device_revocation_cache_failed"));
  }
  close(preserveDeparture = false): void { this.clearForegroundProbe(); this.probeAbort?.abort(); if (!preserveDeparture) this.departureRequest?.abort(); this.inflightEntry = undefined; window.removeEventListener("online", this.networkOnline); document.removeEventListener("visibilitychange", this.presence); window.removeEventListener("focus", this.presence); window.removeEventListener("blur", this.presence); this.started = false; this.starting = undefined; ++this.lifecycle; this.closed = true; this.passiveAttachments.cancelAll(new Error(t("连接已关闭，下载已停止。"))); if (this.outboxRetry) clearTimeout(this.outboxRetry); this.httpEpoch.abort(); this.update({ status: "offline", syncProgress: undefined, routeSync: undefined }); ++this.generation; if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat); if (this.renewal) clearTimeout(this.renewal); if (this.probeTimer) clearInterval(this.probeTimer); if (this.handshake) clearTimeout(this.handshake); this.ws?.close(); }
}
