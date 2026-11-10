import { createDesignBackup, type DesignBackupContent } from "./workbench-design-backup.js";
import { clearAttachmentDiskCache } from "./attachment-disk-cache.js";
import type { DesignPersistSidecar } from "./workbench-design-session.js";
import { designDocumentSchema, encodeDesignFile, decodeDesignFile, type DesignFile, type DesignDocument } from "./workbench-design.js";
import { clearNoteRecoveries } from "./workbench-note-recovery.js";
import { isWorkbenchItemKind, ownedWorkbenchConversation, type StoredWorkbenchDeletion, type StoredWorkbenchItem, type WorkbenchItemKind, type WorkbenchOwner } from "./workbench-library.js";
import { markdownDocumentSchema, type MarkdownDocument } from "./workbench-markdown.js";
import { groupComposerIntentSchema, type GroupComposerIntent } from "./group-composer-intent.js";
import { boardDocumentSchema, changeWorkbench, workbenchLayoutSchema, type BoardDocument, type WorkbenchLayout } from "./workbench-model.js";
import { workbenchDraftSchema, type WorkbenchDraft } from "./workbench-draft.js";
import { applyDesignCommentDelivery, designCommentFingerprint, designCommentReceiptKey, designCommentReceiptSchema, type DesignCommentAcceptance } from "./design-comment-delivery.js";
import { isUnavailableCardAction } from "./outbox-failure.js";
import { conversationBlocksPreview } from "./conversation-preview.js";
import { reviewReferenceKey, reviewReferencesSchema, validateReviewReferences, type RunReviewReferences } from "./diff-review-reference.js";
import { networkCanonical, type SignedNetworkManifest } from "../../src/client-protocol/private-network.js";
import { conversationFoldersSchema, emptyConversationFolders, type ConversationFoldersState } from "../../src/client-protocol/conversation-folders.js";
import { DEFAULT_MONO_ACCENT, DEFAULT_PALETTE, DEFAULT_THEME, isColorPalette, isMonoAccent, type ColorPalette, type MonoAccent } from "./palettes.js";
import { normalizeLayoutDensity, type LayoutDensity } from "./layout-density.js";
import type { NamedBot } from "./bot-references.js";
import { profileCacheSchema, type ProfileCache } from "../../src/client-protocol/avatars.js";
import { openDB, type DBSchema, type StoreNames, type IDBPTransaction, type IDBPDatabase } from "idb";
import { activeQuestionDrafts, questionDraftPrefix, questionDraftSchema, type QuestionDraft } from "./question-draft.js";
import { messageAttention, type MessageAttention } from "./attention.js";
import { projectReply, projectWorkingReply, type BotReply } from "./agent-state.js";
import { shareDraftSchema, type ShareDraft, type SavedShareDraft } from "../../src/client-protocol/share-drafts.js";
import { eventSchema, messageSchema, type ClientFrame, type Conversation, type HubEvent, type Message } from "../../src/client-protocol/index.js";
import { applyMessageDelta, messageStreamSchema } from "../../src/client-protocol/stream.js";
import { snapshotFrameSchema, type SnapshotFrame, type SnapshotBegin } from "../../src/client-protocol/snapshot.js";
import { PersistentDownloadCheckpoints, type DownloadChunk, type StoredDownloadCheckpoint } from "./download-checkpoints.js";
import { diffReviewDraftKey, diffReviewReceiptKey, diffReviewReceiptSchema, diffReviewScopeSchema, diffReviewPendingSchema, storedDiffReviewDraftSchema, reviseDiffReviewDraft, settleDiffReviewDraft, makeDiffReviewFrame, type DiffReviewScope, type DiffReviewNote, type DiffReviewDraft, type DiffReviewFrame, type StoredDiffReviewDraft } from "./diff-review-draft.js";

import type { Route, Deployment } from "../../src/client-protocol/routes.js";
import type { LinkPreviewStyle } from "../../src/client-protocol/links.js";
export type { Route } from "../../src/client-protocol/routes.js";
// An empty code is a durably saved request awaiting its HTTP receipt. Retain the
// same device key and request ID across retries/reload; never generate a new key
// after a possibly accepted request. The short-lived invite is cleared on auth.
export type PendingPairing = { code: string; expiresAt: number; serverTimeOffset?: number; request?: { invite?: string; requestId: string } };
export type Identity = { deviceId: string; name: string; privateKey?: CryptoKey; keyRef?: string; platform?: "web" | "macos" | "windows" | "ios" | "android"; publicKey: string; hubPublicKey?: string; deployment?: Deployment; routes: Route[]; pendingPairing?: PendingPairing };
export type LocalReset = { keyRef?: string };
export type ConversationActivity = { preview: string; at: number; unread: Record<string, number>; lastContentSeq: number; attention?: Record<string, MessageAttention>; replies?: Record<string, BotReply>; workingReplies?: Record<string, number> };
export type SidebarLayout = "bots" | "conversations";
export type Preferences = { sidebarLayout: SidebarLayout; sidebarGroupByHost: boolean; showDisconnectedBots: boolean; showTicketConversations: boolean; layoutDensity: LayoutDensity; theme: "system" | "light" | "dark"; palette: ColorPalette; monoAccent?: MonoAccent; locale: "zh" | "en"; fontSize: number; quietStart: string; quietEnd: string; showModelIcons: boolean; animatedAvatars: boolean; animations: boolean; linkPreviewStyle: LinkPreviewStyle };
export const defaultPreferences: Preferences = { sidebarLayout: "bots", sidebarGroupByHost: false, showDisconnectedBots: false, showTicketConversations: false, layoutDensity: normalizeLayoutDensity(undefined), theme: DEFAULT_THEME, palette: DEFAULT_PALETTE, monoAccent: DEFAULT_MONO_ACCENT, locale: "zh", fontSize: 14, quietStart: "", quietEnd: "", showModelIcons: true, animatedAvatars: true, animations: true, linkPreviewStyle: "card" };
export type ConversationDraft = { files: File[]; workbench?: WorkbenchDraft; reply?: Message; previewChoice?: string | null; previewStyle: import("../../src/client-protocol/links.js").LinkPreviewStyle; recipients?: string[] };
export type DraftPreview = { text: string; files: number; reply: boolean };
type StoredConversationDraft = Omit<ConversationDraft, "files"> & { files: { bytes: ArrayBuffer; name: string; type: string; lastModified: number }[]; revision: string; owner: string; size: number; active: number };
export const DRAFT_CONVERSATION_BYTES = 64 * 1024 * 1024;
export const DRAFT_TOTAL_BYTES = 128 * 1024 * 1024;
export const SHARE_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000;
const draftOwner = (identity: Identity) => JSON.stringify([identity.deviceId, identity.hubPublicKey, identity.publicKey]);
export interface Cache extends DBSchema {
  workbenchLayouts: { key: string; value: WorkbenchLayout };
  workbenchBoards: { key: [string, string]; value: BoardDocument };
  workbenchDesignMeta: { key: [string,string,"comments"|"history"]; value: unknown };
  workbenchDesignObjects: { key: [string,string,string]; value: DesignFile };
  workbenchDesign: { key: [string, string]; value: DesignDocument };
  workbenchMarkdown: { key: [string, string]; value: MarkdownDocument };
  conversationDrafts: { key: string; value: StoredConversationDraft; indexes: { size: number; active: number; fileCount: number; reply: string } };
  settings: { key: string; value: Identity | Preferences | SignedNetworkManifest | string };
  conversations: { key: string; value: Conversation };
  messages: { key: string; value: Message & { activitySeq?: number; activityAt?: number }; indexes: { conversation: string; status: Message["status"] } };
  activity: { key: string; value: ConversationActivity };
  attachmentData: { key: string; value: Blob | { bytes: ArrayBuffer; type: string } };
  attachmentMeta: { key: string; value: { size: number; accessed: number } };
  downloadMeta: { key: string; value: StoredDownloadCheckpoint };
  downloadChunks: { key: [string, string, number]; value: DownloadChunk; indexes: { attachment: string } };
  cursors: { key: string; value: number };
  outbox: { key: string; value: { id: string; order: number; frame: ClientFrame; error?: string; retryErrors?: number; firstRetryAt?: number; retryAt?: number } };
  syncState: { key: string; value: SnapshotBegin & { count: number; updatedAt: number; previousLineage?: string } };
  syncMessages: { key: [string, string]; value: Extract<SnapshotFrame, { type: "snapshot.message" }> & { owner: string }; indexes: { owner: string } };
}
export type OutboxEntry = Cache["outbox"]["value"];
const workbenchItemStores = { whiteboard: "workbenchBoards", markdown: "workbenchMarkdown", design: "workbenchDesign" } as const;
const workbenchItemId = /^[A-Za-z0-9_-]{1,128}$/;
function workbenchChange(value: unknown): { scope: string; ids: string[] } | undefined {
  if (!value || typeof value !== "object") return;
  const { v, scope, ids } = value as Record<string, unknown>;
  if (v !== 1 || typeof scope !== "string" || scope.length > 4096 || !Array.isArray(ids) || !ids.length || ids.length > 256
    || !ids.every(id => typeof id === "string" && workbenchItemId.test(id))) return;
  return { scope, ids: ids as string[] };
}
export class ClientCache {
  private draftListeners = new Set<() => void>();
  subscribeDrafts(listener: () => void): () => void { this.draftListeners.add(listener); return () => { this.draftListeners.delete(listener); }; }
  private draftsChanged(): void { for (const listener of this.draftListeners) listener(); }
  private diffReviewListeners = new Map<string, Set<() => void>>();
  private diffReviewChannel?: BroadcastChannel;
  /** Only this host's matching conversation/Bot review or its receipt changed. */
  subscribeDiffReviews(scope: DiffReviewScope, listener: () => void): () => void {
    const key = diffReviewDraftKey(diffReviewScopeSchema.parse(scope));
    let listeners = this.diffReviewListeners.get(key);
    if (!listeners) this.diffReviewListeners.set(key, listeners = new Set());
    listeners.add(listener);
    if (!this.closed && !this.diffReviewChannel && typeof BroadcastChannel !== "undefined") {
      this.diffReviewChannel = new BroadcastChannel(`tarobot-diff-review:${this.databaseName}`);
      this.diffReviewChannel.onmessage = event => {
        if (event.data === null) this.notifyDiffReviews();
        else { const scope = diffReviewScopeSchema.safeParse(event.data); if (scope.success) this.notifyDiffReviews(scope.data); }
      };
    }
    return () => {
      listeners.delete(listener); if (!listeners.size) this.diffReviewListeners.delete(key);
      if (!this.diffReviewListeners.size) { this.diffReviewChannel?.close(); this.diffReviewChannel = undefined; }
    };
  }
  private notifyDiffReviews(scope?: DiffReviewScope): void {
    if (scope) this.diffReviewListeners.get(diffReviewDraftKey(scope))?.forEach(listener => listener());
    else for (const listeners of this.diffReviewListeners.values()) for (const listener of listeners) listener();
  }
  private diffReviewsChanged(scope?: DiffReviewScope): void {
    this.notifyDiffReviews(scope);
    // Other desktop windows may hold another ClientCache for the same host.
    // Broadcast only invalidation keys, never note text or receipt contents.
    if (typeof BroadcastChannel !== "undefined") {
      const channel = this.diffReviewChannel ?? new BroadcastChannel(`tarobot-diff-review:${this.databaseName}`);
      channel.postMessage(scope ?? null);
      if (channel !== this.diffReviewChannel) channel.close();
    }
  }
  private workbenchListeners = new Map<string, Set<(ids: string[]) => void>>();
  private workbenchChannel?: BroadcastChannel;
  private designCommentListeners = new Map<string, Set<(ids: string[]) => void>>();
  private designCommentChannel?: BroadcastChannel;
  subscribeDesignCommentChanges(scope: string, listener: (ids: string[]) => void): () => void {
    let listeners = this.designCommentListeners.get(scope);
    if (!listeners) this.designCommentListeners.set(scope, listeners = new Set());
    listeners.add(listener);
    if (!this.closed && !this.designCommentChannel && typeof BroadcastChannel !== "undefined") {
      this.designCommentChannel = new BroadcastChannel(`tarobot-design-comments:${this.databaseName}`);
      this.designCommentChannel.onmessage = event => { const change = workbenchChange(event.data); if (change) this.notifyDesignComments(change.scope, change.ids); };
    }
    return () => { listeners.delete(listener); if (!listeners.size) this.designCommentListeners.delete(scope); if (!this.designCommentListeners.size) { this.designCommentChannel?.close(); this.designCommentChannel = undefined; } };
  }
  private notifyDesignComments(scope: string, ids: string[]) { this.designCommentListeners.get(scope)?.forEach(listener => listener([...ids])); }
  private designCommentsChanged(scope: string, ids: string[]) {
    this.notifyDesignComments(scope, ids);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = this.designCommentChannel ?? new BroadcastChannel(`tarobot-design-comments:${this.databaseName}`);
      channel.postMessage({v:1,scope,ids}); if (channel !== this.designCommentChannel) channel.close();
    }
  }
  /** Library deletions in one scope, from this or another window. Only IDs
   * cross windows, never titles or content. */
  subscribeWorkbenchChanges(scope: string, listener: (ids: string[]) => void): () => void {
    let listeners = this.workbenchListeners.get(scope);
    if (!listeners) this.workbenchListeners.set(scope, listeners = new Set());
    listeners.add(listener);
    if (!this.closed && !this.workbenchChannel && typeof BroadcastChannel !== "undefined") {
      this.workbenchChannel = new BroadcastChannel(`tarobot-workbench:${this.databaseName}`);
      this.workbenchChannel.onmessage = event => { const change = workbenchChange(event.data); if (change) this.notifyWorkbench(change.scope, change.ids); };
    }
    return () => {
      listeners.delete(listener); if (!listeners.size && this.workbenchListeners.get(scope) === listeners) this.workbenchListeners.delete(scope);
      if (!this.workbenchListeners.size) { this.workbenchChannel?.close(); this.workbenchChannel = undefined; }
    };
  }
  private notifyWorkbench(scope: string, ids: string[]): void { this.workbenchListeners.get(scope)?.forEach(listener => listener([...ids])); }
  private workbenchItemsChanged(scope: string, ids: string[]): void {
    this.notifyWorkbench(scope, ids);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = this.workbenchChannel ?? new BroadcastChannel(`tarobot-workbench:${this.databaseName}`);
      channel.postMessage({ v: 1, scope, ids });
      if (channel !== this.workbenchChannel) channel.close();
    }
  }
  private draftFileBytes = new WeakMap<File, Promise<ArrayBuffer>>();
  private questionSaves = new Map<string, Promise<void>>();
  private readonly db: Promise<IDBPDatabase<Cache>>;
  private readonly generation: Promise<string | undefined>;
  private selectionGeneration?: { value: string | undefined };
  private closed = false;
  get isClosed(): boolean { return this.closed; }
  private readonly snapshotOwner = crypto.randomUUID();
  private snapshotLease?: Promise<void>;
  private releaseSnapshotLease?: () => void;
  // A cache's namespace never changes when the user selects another host.
  // Delayed requests retain the cache belonging to their original connection.
  constructor(readonly databaseName = "tarocub-v1") {
    this.db = openDB<Cache>(databaseName, 13, { upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 13) { db.createObjectStore("workbenchDesignMeta"); db.createObjectStore("workbenchDesignObjects"); }
      if (oldVersion < 12) db.createObjectStore("workbenchDesign");
      if (oldVersion < 11) db.createObjectStore("workbenchMarkdown");
      if (oldVersion < 10) { db.createObjectStore("workbenchLayouts"); db.createObjectStore("workbenchBoards"); }
      if (oldVersion < 7) { const drafts = db.createObjectStore("conversationDrafts"); drafts.createIndex("size", "size"); drafts.createIndex("active", "active"); }
      if (oldVersion < 9) {
        // Index backfill covers existing drafts without copying attachment bytes
        // into list previews. Key cursors read only counts and conversation IDs.
        const drafts = transaction.objectStore("conversationDrafts");
        drafts.createIndex("fileCount", "files.length");
        drafts.createIndex("reply", "reply.id");
      }
      if (oldVersion < 6) {
        db.createObjectStore("downloadMeta");
        db.createObjectStore("downloadChunks", { keyPath: ["attachmentId", "revision", "index"] }).createIndex("attachment", "attachmentId");
      }
      if (oldVersion < 5) {
        // Only uncommitted staging is replaced. Visible messages/cursors stay
        // intact and reconnect requests a fresh snapshot from their last commit.
        if (db.objectStoreNames.contains("syncState")) db.deleteObjectStore("syncState");
        if (db.objectStoreNames.contains("syncMessages")) db.deleteObjectStore("syncMessages");
        db.createObjectStore("syncState");
        db.createObjectStore("syncMessages", { keyPath: ["owner", "message.id"] }).createIndex("owner", "owner");
      }
      if (oldVersion < 3) { db.createObjectStore("attachmentData"); db.createObjectStore("attachmentMeta"); }
      if (oldVersion < 2) db.createObjectStore("activity");
      if (oldVersion < 1) {
        db.createObjectStore("settings"); db.createObjectStore("conversations", { keyPath: "id" });
        db.createObjectStore("messages", { keyPath: "id" }).createIndex("conversation", "conversationId");
        db.createObjectStore("cursors"); db.createObjectStore("outbox", { keyPath: "id" });
      }
      // IDB backfills existing records transactionally. Startup can recover
      // active IDs without cloning every historical message into each host.
      if (oldVersion < 8) transaction.objectStore("messages").createIndex("status", "status");
    }, blocking: () => this.close(), terminated: () => this.close() });
    // Capture this page's cache generation once. Reset advances it before any
    // destructive step, fencing delayed writes from this page and other open tabs.
    this.generation = this.db.then(async (db) => {
      const value = await db.get("settings", "cacheGeneration") as string | undefined;
      this.selectionGeneration = { value }; return value;
    });
    // Host connections open every registered cache at startup, even when that
    // host's workspace has never been visited. Expired share edits must not
    // depend on mounting its ShareInbox. A closed app cleans up on next open.
    void this.identity().then(identity => identity ? this.pruneExpiredShareDrafts(identity) : undefined).catch(() => undefined);
  }
  close(): void { this.closed = true; this.notifyDiffReviews(); this.diffReviewChannel?.close(); this.diffReviewChannel = undefined; this.workbenchChannel?.close(); this.workbenchChannel = undefined; this.designCommentChannel?.close(); this.designCommentChannel = undefined; this.releaseSnapshotLease?.(); void this.db.then((db) => db.close(), () => undefined); }
  private ownSnapshot(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("local_cache_closed"));
    if (!navigator.locks) return Promise.resolve();
    if (!this.snapshotLease) this.snapshotLease = new Promise<void>((resolve, reject) => {
      const held = new Promise<void>((release) => { this.releaseSnapshotLease = release; });
      // A lifetime lease identifies abandoned page staging after reload/crash.
      // Keep it until close: releasing between snapshots would race cleanup.
      void navigator.locks.request(`tarocub-snapshot:${this.databaseName}:${this.snapshotOwner}`, async () => {
        if (this.closed) { reject(new Error("local_cache_closed")); return; }
        resolve(); await held;
      }).catch(reject);
    });
    return this.snapshotLease;
  }
  private async write(names: StoreNames<Cache>[]) {
    const [db, generation] = await Promise.all([this.db, this.generation]);
    if (this.closed) throw new Error("local_cache_closed");
    const tx = db.transaction([...new Set<StoreNames<Cache>>([...names, "settings"])], "readwrite");
    void tx.done.catch(() => undefined);
    const settings = tx.objectStore("settings");
    if (await settings.get("cacheGeneration") !== generation || await settings.get("pendingReset")) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("local_reset_in_progress");
    }
    return tx;
  }
  async pendingReset(): Promise<LocalReset | undefined> {
    const raw = await (await this.db).get("settings", "pendingReset");
    if (raw === undefined) return;
    const value: unknown = JSON.parse(raw as string);
    if (!value || typeof value !== "object" || ("keyRef" in value && typeof value.keyRef !== "string")) throw new Error("invalid_local_reset");
    return value as LocalReset;
  }

  async readWorkbench(scope: string): Promise<WorkbenchLayout | undefined> {
    if (this.closed) throw new Error("local_cache_closed");
    const value = await (await this.db).get("workbenchLayouts", scope);
    return value === undefined ? undefined : workbenchLayoutSchema.parse(value);
  }
  /** Read-only: the exact workbench scopes this cache recorded for one Host,
   * from layout keys `[host,user,conversation]`. Native reset clears the web
   * data of exactly these scopes; malformed or other-Host keys are ignored. */
  async workbenchBrowserScopes(host: string): Promise<Array<{ host: string; user: string; conversation: string }>> {
    if (this.closed) throw new Error("local_cache_closed");
    const printable = /^[\x21-\x7e]{1,256}$/, scopes: Array<{ host: string; user: string; conversation: string }> = [];
    for (const key of await (await this.db).getAllKeys("workbenchLayouts")) {
      if (typeof key !== "string") continue;
      let value: unknown; try { value = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === "string" && printable.test(part)) || value[0] !== host) continue;
      scopes.push({ host: value[0], user: value[1], conversation: value[2] });
    }
    return scopes;
  }
  async workbenchSourceMessage(id: string): Promise<Message | undefined> {
    if (this.closed) throw new Error("local_cache_closed");
    const message = await (await this.db).get("messages", id);
    return message?.status === "deleted" ? undefined : message;
  }
  async saveWorkbench(scope: string, expectedRevision: number, value: WorkbenchLayout): Promise<void> {
    const next = workbenchLayoutSchema.parse(value);
    if (next.revision !== expectedRevision + 1) throw new Error("workbench_revision_conflict");
    const tx = await this.write(["workbenchLayouts"]), store = tx.objectStore("workbenchLayouts");
    if (((await store.get(scope))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("workbench_revision_conflict");
    }
    await store.put(next, scope); await tx.done;
  }
  async readWorkbenchBoard(scope: string, id: string): Promise<BoardDocument | undefined> {
    if (this.closed) throw new Error("local_cache_closed");
    const value = await (await this.db).get("workbenchBoards", [scope, id]);
    return value === undefined ? undefined : boardDocumentSchema.parse(value);
  }
  async saveWorkbenchBoard(scope: string, expectedRevision: number, value: BoardDocument): Promise<void> {
    const next = boardDocumentSchema.parse(value);
    if (next.revision !== expectedRevision + 1) throw new Error("whiteboard_revision_conflict");
    const tx = await this.write(["workbenchBoards"]), store = tx.objectStore("workbenchBoards");
    const key: [string, string] = [scope, next.id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("whiteboard_revision_conflict");
    }
    await store.put(next, key); await tx.done;
  }
  async deleteWorkbenchBoard(scope: string, id: string, expectedRevision: number): Promise<void> {
    const tx = await this.write(["workbenchBoards"]), store = tx.objectStore("workbenchBoards");
    const key: [string, string] = [scope, id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("whiteboard_revision_conflict");
    }
    await store.delete(key); await tx.done;
  }
  /** Content and its tab references retire together, including on quota/reset/CAS failure. */
  async deleteWorkbenchBoardAndLayout(scope: string, id: string, expectedBoardRevision: number, expectedLayoutRevision: number, value: WorkbenchLayout): Promise<void> {
    const next = workbenchLayoutSchema.parse(value);
    if (next.revision !== expectedLayoutRevision + 1) throw new Error("workbench_revision_conflict");
    if ([...next.tabs, ...next.closed].some(tab => tab.id === id)) throw new Error("whiteboard_still_referenced");
    const tx = await this.write(["workbenchBoards", "workbenchLayouts"]);
    const boards = tx.objectStore("workbenchBoards"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, id];
    const board = await boards.get(key), layout = await layouts.get(scope);
    const error = !board || board.revision !== expectedBoardRevision ? "whiteboard_revision_conflict"
      : (layout?.revision ?? -1) !== expectedLayoutRevision ? "workbench_revision_conflict" : undefined;
    if (error) { tx.abort(); await tx.done.catch(() => undefined); throw new Error(error); }
    await boards.delete(key); await layouts.put(next, scope); await tx.done;
    // Other windows drop their copies (same path as a library deletion).
    this.workbenchItemsChanged(scope, [id]);
  }
  async readWorkbenchMarkdown(scope: string, id: string): Promise<MarkdownDocument | undefined> {
    if (this.closed) throw new Error("local_cache_closed");
    const value = await (await this.db).get("workbenchMarkdown", [scope, id]);
    return value === undefined ? undefined : markdownDocumentSchema.parse(value);
  }
  async saveWorkbenchMarkdown(scope: string, expectedRevision: number, value: MarkdownDocument): Promise<void> {
    const next = markdownDocumentSchema.parse(value);
    if (next.revision !== expectedRevision + 1) throw new Error("markdown_revision_conflict");
    const tx = await this.write(["workbenchMarkdown"]), store = tx.objectStore("workbenchMarkdown");
    const key: [string, string] = [scope, next.id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("markdown_revision_conflict");
    }
    await store.put(next, key); await tx.done;
  }
  async deleteWorkbenchMarkdown(scope: string, id: string, expectedRevision: number): Promise<void> {
    const tx = await this.write(["workbenchMarkdown"]), store = tx.objectStore("workbenchMarkdown");
    const key: [string, string] = [scope, id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("markdown_revision_conflict");
    }
    await store.delete(key); await tx.done;
  }
  /** Content and its tab references retire together, including on quota/reset/CAS failure. */
  async deleteWorkbenchMarkdownAndLayout(scope: string, id: string, expectedBoardRevision: number, expectedLayoutRevision: number, value: WorkbenchLayout): Promise<void> {
    const next = workbenchLayoutSchema.parse(value);
    if (next.revision !== expectedLayoutRevision + 1) throw new Error("workbench_revision_conflict");
    if ([...next.tabs, ...next.closed].some(tab => tab.id === id)) throw new Error("markdown_still_referenced");
    const tx = await this.write(["workbenchMarkdown", "workbenchLayouts"]);
    const boards = tx.objectStore("workbenchMarkdown"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, id];
    const board = await boards.get(key), layout = await layouts.get(scope);
    const error = !board || board.revision !== expectedBoardRevision ? "markdown_revision_conflict"
      : (layout?.revision ?? -1) !== expectedLayoutRevision ? "workbench_revision_conflict" : undefined;
    if (error) { tx.abort(); await tx.done.catch(() => undefined); throw new Error(error); }
    await boards.delete(key); await layouts.put(next, scope); await tx.done;
    // Other windows drop their copies (same path as a library deletion).
    this.workbenchItemsChanged(scope, [id]);
  }
  /** A new board and its open Tab commit together: a refused or conflicting
   * layout never leaves board bytes without an open or closed reference. */
  async createWorkbenchBoardAndLayout(scope: string, document: BoardDocument, expectedLayoutRevision: number, value: WorkbenchLayout): Promise<void> {
    const board = boardDocumentSchema.parse(document), next = workbenchLayoutSchema.parse(value);
    if (board.revision !== 0 || next.revision !== expectedLayoutRevision + 1 || !next.tabs.some(tab => tab.id === board.id && tab.kind === "whiteboard")) throw new Error("workbench_revision_conflict");
    const tx = await this.write(["workbenchBoards", "workbenchLayouts"]), boards = tx.objectStore("workbenchBoards"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, board.id];
    if (await boards.get(key) || ((await layouts.get(scope))?.revision ?? -1) !== expectedLayoutRevision) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("workbench_revision_conflict"); }
    await boards.put(board, key); await layouts.put(next, scope); await tx.done;
  }
  async createWorkbenchMarkdownAndLayout(scope: string, document: MarkdownDocument, expectedLayoutRevision: number, value: WorkbenchLayout): Promise<void> {
    const note = markdownDocumentSchema.parse(document), next = workbenchLayoutSchema.parse(value);
    if (note.revision !== 0 || next.revision !== expectedLayoutRevision + 1 || !next.tabs.some(tab => tab.id === note.id && tab.kind === "markdown")) throw new Error("workbench_revision_conflict");
    const tx = await this.write(["workbenchMarkdown", "workbenchLayouts"]), notes = tx.objectStore("workbenchMarkdown"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, note.id];
    if (await notes.get(key) || ((await layouts.get(scope))?.revision ?? -1) !== expectedLayoutRevision) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("workbench_revision_conflict"); }
    await notes.put(note, key); await layouts.put(next, scope); await tx.done;
  }
  async readWorkbenchDesign(scope: string, id: string): Promise<DesignDocument | undefined> {
    if (this.closed) throw new Error("local_cache_closed");
    const value = await (await this.db).get("workbenchDesign", [scope, id]);
    return value === undefined ? undefined : designDocumentSchema.parse(value);
  }
  async saveWorkbenchDesign(scope: string, expectedRevision: number, value: DesignDocument, sidecar?: DesignPersistSidecar): Promise<void> {
    const next = designDocumentSchema.parse(value);
    if (next.revision !== expectedRevision + 1) throw new Error("design_revision_conflict");
    const tx = await this.write(["workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"]), store = tx.objectStore("workbenchDesign");
    const key: [string, string] = [scope, next.id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("design_revision_conflict");
    }
    try {
      if (sidecar?.history) {
        const history=sidecar.history, meta=tx.objectStore("workbenchDesignMeta"), metaKey:[string,string,"history"]=[scope,next.id,"history"];
        const current=await meta.get(metaKey) as {revision?:number}|undefined;
        if ((current?.revision ?? -1)!==history.expected || history.next.revision!==history.expected+1) throw new Error("design_history_conflict");
        for(const [sha,file] of Object.entries(history.put)) {
          const verified=encodeDesignFile(decodeDesignFile(file),file.contentType);
          if(verified.sha256!==sha || verified.size!==file.size || file.sha256!==sha) throw new Error("design_history_corrupt");
          await tx.objectStore("workbenchDesignObjects").put(verified,[scope,next.id,sha]);
        }
        for(const sha of history.drop) {if(!/^[a-f0-9]{64}$/.test(sha))throw new Error("design_history_corrupt");await tx.objectStore("workbenchDesignObjects").delete([scope,next.id,sha]);}
        await meta.put(history.next,metaKey);
      }
      await store.put(next, key); await tx.done;
    } catch(error) { try{tx.abort();}catch{}await tx.done.catch(()=>undefined);throw error; }
  }
  /** One read transaction: a backup cannot pair one revision with another's history. */
  async readWorkbenchDesignBackup(scope:string,id:string,title:string):Promise<DesignBackupContent> {
    if(this.closed)throw new Error("local_cache_closed");
    const tx=(await this.db).transaction(["workbenchDesign","workbenchDesignMeta","workbenchDesignObjects"]);
    const document=await tx.objectStore("workbenchDesign").get([scope,id]);
    if(!document)throw new Error("design_not_found");
    const comments=await tx.objectStore("workbenchDesignMeta").get([scope,id,"comments"]);
    const history=await tx.objectStore("workbenchDesignMeta").get([scope,id,"history"]);
    const objects:Record<string,DesignFile>={};
    let cursor=await tx.objectStore("workbenchDesignObjects").openCursor(IDBKeyRange.bound([scope,id],[scope,id,[]]));
    let size=0,count=0;
    while(cursor){ const file=cursor.value;size+=file.size;if(size>64*1024*1024 || ++count>102400)throw new Error("design_backup_history_limit");objects[cursor.key[2]]=file;cursor=await cursor.continue(); }
    await tx.done;
    return createDesignBackup({title,document,comments,history,objects} as DesignBackupContent);
  }
  async readWorkbenchDesignMeta<T = unknown>(scope:string,id:string,kind:"comments"|"history"):Promise<T|undefined> {
    if(this.closed)throw new Error("local_cache_closed");
    return (await this.db).get("workbenchDesignMeta",[scope,id,kind]) as Promise<T|undefined>;
  }
  async saveWorkbenchDesignMeta(scope:string,id:string,kind:"comments"|"history",expected:number,value:{revision:number}):Promise<void> {
    const tx=await this.write(["workbenchDesign","workbenchDesignMeta"]), store=tx.objectStore("workbenchDesignMeta"),key:[string,string,"comments"|"history"]=[scope,id,kind];
    const current=await store.get(key) as {revision?:number}|undefined;
    if(!await tx.objectStore("workbenchDesign").getKey([scope,id]) || (current?.revision??0)!==expected || value.revision!==expected+1) {tx.abort();await tx.done.catch(()=>undefined);throw new Error("design_metadata_conflict");}
    await store.put(value,key);await tx.done;
    if(kind==="comments")this.designCommentsChanged(scope,[id]);
  }
  async readWorkbenchDesignObject(scope:string,id:string,sha:string):Promise<DesignFile|undefined> {
    if(this.closed)throw new Error("local_cache_closed");if(!/^[a-f0-9]{64}$/.test(sha))throw new Error("design_history_corrupt");
    return (await this.db).get("workbenchDesignObjects",[scope,id,sha]);
  }
  private async deleteDesignSidecars(tx:IDBPTransaction<Cache,StoreNames<Cache>[],"readwrite">,scope:string,id:string) {
    for(const name of ["workbenchDesignMeta","workbenchDesignObjects"] as const) {
      let cursor=await tx.objectStore(name).openKeyCursor(IDBKeyRange.bound([scope,id],[scope,id,[]]));
      while(cursor){await tx.objectStore(name).delete(cursor.primaryKey);cursor=await cursor.continue();}
    }
  }
  async deleteWorkbenchDesign(scope: string, id: string, expectedRevision: number): Promise<void> {
    const tx = await this.write(["workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"]), store = tx.objectStore("workbenchDesign");
    const key: [string, string] = [scope, id];
    if (((await store.get(key))?.revision ?? -1) !== expectedRevision) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("design_revision_conflict");
    }
    await store.delete(key); await this.deleteDesignSidecars(tx,scope,id); await tx.done;
  }
  /** Content and its tab references retire together, including on quota/reset/CAS failure. */
  async deleteWorkbenchDesignAndLayout(scope: string, id: string, expectedBoardRevision: number, expectedLayoutRevision: number, value: WorkbenchLayout): Promise<void> {
    const next = workbenchLayoutSchema.parse(value);
    if (next.revision !== expectedLayoutRevision + 1) throw new Error("workbench_revision_conflict");
    if ([...next.tabs, ...next.closed].some(tab => tab.id === id)) throw new Error("design_still_referenced");
    const tx = await this.write(["workbenchDesign", "workbenchLayouts", "workbenchDesignMeta", "workbenchDesignObjects"]);
    const boards = tx.objectStore("workbenchDesign"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, id];
    const board = await boards.get(key), layout = await layouts.get(scope);
    const error = !board || board.revision !== expectedBoardRevision ? "design_revision_conflict"
      : (layout?.revision ?? -1) !== expectedLayoutRevision ? "workbench_revision_conflict" : undefined;
    if (error) { tx.abort(); await tx.done.catch(() => undefined); throw new Error(error); }
    await boards.delete(key); await this.deleteDesignSidecars(tx,scope,id); await layouts.put(next, scope); await tx.done;
    // Other windows drop their copies (same path as a library deletion).
    this.workbenchItemsChanged(scope, [id]);
  }
  async createWorkbenchDesignAndLayout(scope: string, document: DesignDocument, expectedLayoutRevision: number, value: WorkbenchLayout, imported?: DesignBackupContent): Promise<void> {
    const note = designDocumentSchema.parse(document), next = workbenchLayoutSchema.parse(value);
    if (note.revision !== 0 || next.revision !== expectedLayoutRevision + 1 || !next.tabs.some(tab => tab.id === note.id && tab.kind === "design")) throw new Error("workbench_revision_conflict");
    const backup=imported ? createDesignBackup({...imported,document:note}) : undefined;
    if(backup && ((backup.comments?.revision??0)!==0 || (backup.history?.revision??0)!==0))throw new Error("design_invalid_import");
    const tx = await this.write(["workbenchDesign", "workbenchLayouts", "workbenchDesignMeta", "workbenchDesignObjects"]), notes = tx.objectStore("workbenchDesign"), layouts = tx.objectStore("workbenchLayouts"), key: [string, string] = [scope, note.id];
    if (await notes.get(key) || ((await layouts.get(scope))?.revision ?? -1) !== expectedLayoutRevision) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("workbench_revision_conflict"); }
    try {
      if(backup?.comments)await tx.objectStore("workbenchDesignMeta").put(backup.comments,[scope,note.id,"comments"]);
      if(backup?.history)await tx.objectStore("workbenchDesignMeta").put(backup.history,[scope,note.id,"history"]);
      for(const [sha,file] of Object.entries(backup?.objects??{}))await tx.objectStore("workbenchDesignObjects").put(file,[scope,note.id,sha]);
      await notes.put(note,key);await layouts.put(next,scope);await tx.done;
    }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>undefined);throw error;}
  }
  /** Metadata of one owner's whiteboards, notes and designs, from a single
   * read-only snapshot: content keys plus owned layout values. Content bodies
   * (up to 32 MB each) are never cloned. Only conversations with content or
   * item references count toward the scope cap. Empty and browser/chart-only
   * layouts, which deletion retains, can exhaust only the bounded layout scan,
   * whose sole job is finding references without content: a conversation
   * holding content always reads its own layout by key. Anything past a
   * truncated scan is omitted rather than misreported as orphaned or missing. */
  async listWorkbenchItems(owner: WorkbenchOwner, limits: { scopes?: number; entries?: number; layouts?: number } = {}): Promise<{ items: StoredWorkbenchItem[]; truncated: boolean; skipped: number }> {
    if (this.closed) throw new Error("local_cache_closed");
    const maxScopes = Math.max(1, limits.scopes ?? 1000), maxEntries = Math.max(1, limits.entries ?? 5000), maxKeys = maxEntries * 2, maxLayouts = Math.max(1, limits.layouts ?? maxScopes * 20);
    const prefix = JSON.stringify([owner.host, owner.user]).slice(0, -1) + ",", upper = prefix + "\uffff";
    const tx = (await this.db).transaction(["workbenchLayouts", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"]);
    let bound: { scope: string; inclusive: boolean } | undefined, skipped = 0;
    const tighten = (scope: string, inclusive: boolean) => { if (!bound || scope < bound.scope || scope === bound.scope && !inclusive) bound = { scope, inclusive }; };
    const covered = (scope: string) => !bound || scope < bound.scope || bound.inclusive && scope === bound.scope;
    const present = new Map<string, Record<WorkbenchItemKind, string[]>>();
    for (const kind of ["whiteboard", "markdown", "design"] as const) {
      const keys = await tx.objectStore(workbenchItemStores[kind]).getAllKeys(IDBKeyRange.bound([prefix], [upper]), maxKeys + 1);
      if (keys.length > maxKeys) { keys.length = maxKeys; tighten(keys[maxKeys - 1][0], false); }
      for (const [scope, id] of keys) {
        if (!ownedWorkbenchConversation(scope, owner) || typeof id !== "string" || !workbenchItemId.test(id)) { skipped++; continue; }
        let ids = present.get(scope); if (!ids) present.set(scope, ids = { whiteboard: [], markdown: [], design: [] });
        ids[kind].push(id);
      }
    }
    const layoutStore = tx.objectStore("workbenchLayouts"), layouts = new Map<string, WorkbenchLayout | undefined>(), referenced = new Set<string>();
    let scanned = 0, last = "", scanCut = false, cursor = await layoutStore.openCursor(IDBKeyRange.bound(prefix, upper));
    while (cursor) {
      if (!ownedWorkbenchConversation(cursor.key, owner)) skipped++;
      else if (scanned >= maxLayouts) { scanCut = true; break; }
      else {
        scanned++; last = cursor.key;
        // A layout holding nothing to list is never kept or counted; an unreadable one matters only beside content.
        const parsed = workbenchLayoutSchema.safeParse(cursor.value);
        if (present.has(cursor.key)) layouts.set(cursor.key, parsed.success ? parsed.data : undefined);
        else if (parsed.success && [...parsed.data.tabs, ...parsed.data.closed].some(tab => isWorkbenchItemKind(tab.kind))) { layouts.set(cursor.key, parsed.data); referenced.add(cursor.key); }
      }
      cursor = await cursor.continue();
    }
    let scopes = [...new Set([...present.keys(), ...referenced])].filter(covered).sort();
    if (scopes.length > maxScopes) { tighten(scopes[maxScopes], false); scopes = scopes.slice(0, maxScopes); }
    // Content past an exhausted scan still reads its own layout, so its Tab state stays exact.
    for (const scope of scopes) if (scanCut && scope > last) {
      const raw = await layoutStore.get(scope);
      if (raw !== undefined) { const parsed = workbenchLayoutSchema.safeParse(raw); layouts.set(scope, parsed.success ? parsed.data : undefined); }
    }
    await tx.done;
    const items: StoredWorkbenchItem[] = [];
    for (const scope of scopes) {
      const layout = layouts.get(scope), ids = present.get(scope) ?? { whiteboard: [], markdown: [], design: [] };
      const base = { scope, conversationId: ownedWorkbenchConversation(scope, owner)!, ...(layout ? { layoutRevision: layout.revision } : layouts.has(scope) ? { layoutInvalid: true as const } : {}) };
      const listed = new Set<string>(), missing: StoredWorkbenchItem[] = [];
      for (const [tabs, state] of [[layout?.tabs ?? [], "open"], [layout?.closed ?? [], "closed"]] as const) for (const tab of tabs) {
        if (!isWorkbenchItemKind(tab.kind)) continue;
        const item = { ...base, id: tab.id, kind: tab.kind, title: tab.title, ...(tab.kind === "design" && tab.designFormat ? {designFormat:tab.designFormat} : {}) };
        listed.add(`${tab.kind}:${tab.id}`);
        if (ids[tab.kind].includes(tab.id)) items.push({ ...item, state }); else missing.push({ ...item, state: "missing" });
      }
      items.push(...missing);
      for (const kind of ["whiteboard", "markdown", "design"] as const) for (const id of ids[kind]) if (!listed.has(`${kind}:${id}`)) items.push({ ...base, id, kind, state: "orphan" });
    }
    const truncated = !!bound || scanCut || items.length > maxEntries;
    if (items.length > maxEntries) items.length = maxEntries;
    return { items, truncated, skipped };
  }
  async hasWorkbenchItem(scope: string, kind: WorkbenchItemKind, id: string): Promise<boolean> {
    if (this.closed) throw new Error("local_cache_closed");
    return await (await this.db).getKey(workbenchItemStores[kind], [scope, id]) !== undefined;
  }
  /** One conversation's library deletion: content and every Tab reference
   * retire in one fenced transaction; the layout record itself is retained
   * (browser-data cleanup enumerates its key). Callers hold the exclusive
   * editor lock of every item: whiteboard and Markdown editors hold theirs
   * exclusively and design frames shared, each before it can write. A Tab
   * reference alone is no editor; a later mount refreshes and finds nothing,
   * and a racing reopen or create conflicts on the layout revision. */
  async deleteWorkbenchItems(owner: WorkbenchOwner, scope: string, items: ReadonlyArray<{ kind: WorkbenchItemKind; id: string }>): Promise<StoredWorkbenchDeletion[]> {
    if (!ownedWorkbenchConversation(scope, owner)) throw new Error("workbench_scope_unavailable");
    if (items.length > 256 || items.some(item => !isWorkbenchItemKind(item.kind) || !workbenchItemId.test(item.id))) throw new Error("workbench_library_invalid_input");
    const tx = await this.write(["workbenchLayouts", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"]), layouts = tx.objectStore("workbenchLayouts");
    const results: StoredWorkbenchDeletion[] = [];
    try {
      const raw = await layouts.get(scope), parsed = raw === undefined ? undefined : workbenchLayoutSchema.safeParse(raw);
      // An unreadable layout is left exactly as it is; only content is removed.
      const layout = parsed?.success ? parsed.data : undefined;
      let next = layout;
      for (const { kind, id } of items) {
        const tab = layout && [...layout.tabs, ...layout.closed].find(value => value.id === id);
        if (tab && tab.kind !== kind) { results.push({ kind, id, status: "kind_mismatch" }); continue; }
        const store = tx.objectStore(workbenchItemStores[kind]), key: [string, string] = [scope, id];
        const exists = await store.getKey(key) !== undefined;
        if (exists) await store.delete(key);
        if (kind === "design") await this.deleteDesignSidecars(tx,scope,id);
        if (tab && next) next = changeWorkbench(next, { type: "delete", id });
        results.push({ kind, id, status: exists ? "deleted" : "already_deleted" });
      }
      if (layout && next && next !== layout) await layouts.put(workbenchLayoutSchema.parse({ ...next, revision: layout.revision + 1 }), scope);
      await tx.done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already aborted by the failed request. */ }
      await tx.done.catch(() => undefined); throw error;
    }
    const changed = results.filter(result => result.status === "deleted" || result.status === "already_deleted").map(result => result.id);
    if (changed.length) this.workbenchItemsChanged(scope, [...new Set(changed)]);
    return results;
  }
  async beginReset(): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const identity = await settings.get("identity") as Identity | undefined;
    await settings.put(JSON.stringify({ ...(identity?.keyRef ? { keyRef: identity.keyRef } : {}) }), "pendingReset");
    await settings.put(crypto.randomUUID(), "cacheGeneration");
    await tx.done;
    this.diffReviewsChanged();
    if (identity) clearNoteRecoveries(identity.deviceId);
    if (identity) this.clearSelectionHint(this.selectionHintKey(identity, await this.generation));
  }
  async finishReset(): Promise<void> {
    const [db, generation] = await Promise.all([this.db, this.generation]);
    const tx = db.transaction([...db.objectStoreNames], "readwrite");
    void tx.done.catch(() => undefined);
    const settings = tx.objectStore("settings");
    if (await settings.get("cacheGeneration") !== generation) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("local_reset_generation_changed"); }
    if (!await settings.get("pendingReset")) { await tx.done; return; }
    try {
      const preferences = await settings.get("preferences");
      for (const name of tx.objectStoreNames) await tx.objectStore(name).clear();
      if (preferences) await settings.put(preferences, "preferences");
      if (generation) await settings.put(generation, "cacheGeneration");
      await tx.done;
      this.diffReviewsChanged();
    } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await tx.done.catch(() => undefined); throw error; }
  }

  async networkMembership(): Promise<SignedNetworkManifest | undefined> { return await (await this.db).get("settings", "networkMembership") as SignedNetworkManifest | undefined; }
  async saveNetworkMembership(identity: Identity, value: SignedNetworkManifest | undefined, explicit = false): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    try {
      const current = await settings.get("identity") as Identity | undefined;
      if (!current || draftOwner(current) !== draftOwner(identity)) throw new Error("host_cache_identity_mismatch");
      const previous = await settings.get("networkMembership") as SignedNetworkManifest | undefined;
      if (!explicit && value && await settings.get("networkDetached") === "1") throw new Error("network_membership_changed");
      if (!explicit && previous) {
        const a = previous.manifest, b = value?.manifest;
        if (!b || a.id !== b.id || a.authorityKey !== b.authorityKey) throw new Error("network_membership_changed");
        if (b.revision < a.revision || b.revision === a.revision && networkCanonical(a) !== networkCanonical(b)) throw new Error("network_directory_stale");
      }
      if (previous && value && previous.manifest.id === value.manifest.id && previous.manifest.authorityKey === value.manifest.authorityKey) {
        const a = previous.manifest, b = value.manifest;
        // A restored coordinator may have a larger counter but an older
        // protocol or ownership scope. Explicit review cannot change an
        // existing member's identity; conflicting branches must revoke it.
        if (a.v === 2 && b.v !== 2 || a.devices.some(old => old.scope
          && !b.revokedMembers.includes(old.memberId)
          && b.devices.find(next => next.host === old.host && next.id === old.id)?.scope !== old.scope)) throw new Error("network_directory_stale");
      }
      if (!explicit && networkCanonical(previous ?? null) === networkCanonical(value ?? null)) { await tx.done; return; }
      if (explicit) { if (value) await settings.delete("networkDetached"); else await settings.put("1", "networkDetached"); }
      if (value) await settings.put(value, "networkMembership"); else await settings.delete("networkMembership");
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* already closed */ } await tx.done.catch(() => undefined); throw error; }
  }
  async identity(): Promise<Identity | undefined> { return (await (await this.db).get("settings", "identity")) as Identity | undefined; }
  async identityRevoked(identity: Identity): Promise<boolean> {
    return await (await this.db).get("settings", "revokedIdentity") === JSON.stringify([identity.deviceId, identity.hubPublicKey]);
  }
  async markIdentityRevoked(identity: Identity): Promise<void> {
    const tx = await this.write(["settings", "downloadMeta", "downloadChunks"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (current && draftOwner(current) === draftOwner(identity)) {
      await settings.put(JSON.stringify([identity.deviceId, identity.hubPublicKey]), "revokedIdentity");
      await tx.objectStore("downloadMeta").clear(); await tx.objectStore("downloadChunks").clear();
    }
    await tx.done;
    if (current && draftOwner(current) === draftOwner(identity)) { this.diffReviewsChanged(); await clearAttachmentDiskCache(); }
  }
  async saveIdentity(identity: Identity): Promise<void> {
    const previous = await this.identity();
    if (previous && (draftOwner(previous) !== draftOwner(identity))) await this.forgetIdentity();
    const tx = await this.write(["settings"]); await tx.objectStore("settings").put(identity, "identity"); await tx.done;
    if (!previous || draftOwner(previous) !== draftOwner(identity)) this.diffReviewsChanged();
  }
  /** Route-only CAS. Automatic discovery must not overwrite a newly paired
   * identity or resurrect enrollment progress from an older in-memory copy. */
  async saveIdentityRoutes(expected: Identity, routes: Route[], deployment?: Deployment): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    const revoked = await settings.get("revokedIdentity");
    const error = !current || draftOwner(current) !== draftOwner(expected) ? "host_cache_identity_mismatch"
      : revoked === JSON.stringify([expected.deviceId, expected.hubPublicKey]) ? "device_revoked"
      : networkCanonical(current.routes) !== networkCanonical(expected.routes) || current.deployment !== expected.deployment ? "routes_changed" : undefined;
    if (error) { tx.abort(); await tx.done.catch(() => undefined); throw new Error(error); }
    await settings.put({ ...current!, routes, deployment }, "identity"); await tx.done;
  }
  /** Atomically install a new pairing without replacing newer route edits or
   * clearing a cache now owned by another pairing. Used by migration recovery. */
  async initializeIdentity(identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (current && draftOwner(current) !== draftOwner(identity)) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("host_cache_identity_mismatch");
    }
    if (!current) await settings.put(identity, "identity");
    await tx.done;
    if (!current) this.diffReviewsChanged();
  }
  /** Persist only enrollment progress for the same device and Hub. */
  async savePendingPairing(identity: Identity, pending?: PendingPairing, expected?: { requestId?: string; code: string }): Promise<void> {
    // Update only enrollment progress, preserving route edits and cache ownership.
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("host_cache_identity_mismatch");
    }
    if (expected && (!current.pendingPairing || current.pendingPairing.code !== expected.code || current.pendingPairing.request?.requestId !== expected.requestId)) {
      tx.abort(); await tx.done.catch(() => undefined); throw new Error("pairing_request_changed");
    }
    if (pending) current.pendingPairing = pending; else delete current.pendingPairing;
    await settings.put(current, "identity"); await tx.done;
  }
  /** Explicit local reset: never carry another Hub's drafts or outbox into pairing. */
  async forgetIdentity(): Promise<void> {
    const tx = await this.write(["settings", "conversations", "messages", "activity", "cursors", "outbox", "attachmentData", "attachmentMeta", "downloadMeta", "downloadChunks", "syncState", "syncMessages", "conversationDrafts", "workbenchLayouts", "workbenchBoards", "workbenchMarkdown", "workbenchDesign", "workbenchDesignMeta", "workbenchDesignObjects"]);
    const preferences = await tx.objectStore("settings").get("preferences");
    const generation = await tx.objectStore("settings").get("cacheGeneration");
    const identity = await tx.objectStore("settings").get("identity") as Identity | undefined;
    for (const name of tx.objectStoreNames) await tx.objectStore(name).clear();
    if (preferences) await tx.objectStore("settings").put(preferences, "preferences");
    if (generation) await tx.objectStore("settings").put(generation, "cacheGeneration");
    await tx.done;
    // Large downloads live on disk, outside these stores; drop them with the rest.
    await clearAttachmentDiskCache();
    if (identity) { clearNoteRecoveries(identity.deviceId); this.clearSelectionHint(this.selectionHintKey(identity, generation as string | undefined)); }
    this.draftsChanged();
    this.diffReviewsChanged();
  }
  async attachment(id: string): Promise<Blob | undefined> {
    const tx = await this.write(["attachmentData", "attachmentMeta"]); const stored = await tx.objectStore("attachmentData").get(id);
    const blob = stored instanceof Blob ? stored : stored ? new Blob([stored.bytes], { type: stored.type }) : undefined;
    if (blob) await tx.objectStore("attachmentMeta").put({ size: blob.size, accessed: Date.now() }, id); await tx.done; return blob;
  }
  downloadCheckpoints(identity: Identity): PersistentDownloadCheckpoints {
    return new PersistentDownloadCheckpoints(() => this.write(["downloadMeta", "downloadChunks"]), identity);
  }
  async saveAttachment(id: string, blob: Blob): Promise<void> {
    if (blob.size > 16 * 1024 * 1024) return;
    // Some WebKit stores abort when cloning Blob objects. Persist portable bytes;
    // keep reading legacy Blob records, with the same bounded cache budget.
    const data = { bytes: await blob.arrayBuffer(), type: blob.type };
    const tx = await this.write(["attachmentData", "attachmentMeta"]); const meta = tx.objectStore("attachmentMeta"); const complete = tx.done; void complete.catch(() => undefined);
    const keys = await meta.getAllKeys(); const values = await meta.getAll(); const existing = await meta.get(id); let bytes = values.reduce((sum, value) => sum + value.size, 0) + blob.size - (existing?.size ?? 0);
    for (const entry of keys.map((key, i) => ({ key, ...values[i]! })).sort((a, b) => a.accessed - b.accessed)) {
      if (bytes <= 128 * 1024 * 1024) break; if (entry.key === id) continue;
      await meta.delete(entry.key); await tx.objectStore("attachmentData").delete(entry.key); bytes -= entry.size;
    }
    await tx.objectStore("attachmentData").put(data, id); await meta.put({ size: blob.size, accessed: Date.now() }, id); await complete;
  }
  async botNames(): Promise<NamedBot[]> {
    try { const raw = await (await this.db).get("settings", "botNames"); const values: unknown = JSON.parse(typeof raw === "string" ? raw : "[]");
      return Array.isArray(values) ? values.filter((v): v is NamedBot => !!v && typeof v.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v.id) && typeof v.name === "string" && v.name.length <= 100).map(({ id, name, engine, model, deletedAt, defaultAvatar, role }) => ({ id, name, ...(typeof deletedAt === "number" && deletedAt > 0 ? { deletedAt } : {}), ...(typeof engine === "string" && engine.length <= 64 ? { engine } : {}), ...(typeof model === "string" && model.length <= 128 ? { model } : {}), ...(typeof defaultAvatar === "string" && /^[a-z-]{1,64}$/.test(defaultAvatar) ? { defaultAvatar } : {}), ...(role === "dispatcher" ? { role } : {}) })) : [];
    } catch { return []; }
  }
  async saveBotNames(bots: readonly NamedBot[], identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]); const current = await tx.objectStore("settings").get("identity") as Identity | undefined;
    if (current?.deviceId === identity.deviceId && current.hubPublicKey === identity.hubPublicKey) await tx.objectStore("settings").put(JSON.stringify(bots.map(({ id, name, engine, model, deletedAt, defaultAvatar, role }) => ({ id, name, ...(typeof deletedAt === "number" && deletedAt > 0 ? { deletedAt } : {}), ...(typeof engine === "string" && engine.length <= 64 ? { engine } : {}), ...(typeof model === "string" && model.length <= 128 ? { model } : {}), ...(typeof defaultAvatar === "string" && /^[a-z-]{1,64}$/.test(defaultAvatar) ? { defaultAvatar } : {}), ...(role === "dispatcher" ? { role } : {}) }))), "botNames");
    await tx.done;
  }
  /** Authenticated routing metadata is not an unsent user draft. */
  async groupReplyMetadata(key: string): Promise<string> {
    const value = await (await this.db).get("settings", `groupReply:${key}`);
    return typeof value === "string" ? value : "";
  }
  async saveGroupReplyMetadata(key: string, value: string, identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (current && draftOwner(current) === draftOwner(identity)
      && await settings.get("revokedIdentity") !== JSON.stringify([identity.deviceId, identity.hubPublicKey])) {
      await settings.put(value, `groupReply:${key}`);
    }
    await tx.done;
  }
  async profiles(): Promise<ProfileCache> {
    try { return profileCacheSchema.parse(JSON.parse((await (await this.db).get("settings", "profiles")) as string)); } catch { return { avatars: [] }; }
  }
  async saveProfiles(profiles: ProfileCache, identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]); const current = await tx.objectStore("settings").get("identity") as Identity | undefined;
    if (current?.deviceId === identity.deviceId && current.hubPublicKey === identity.hubPublicKey) await tx.objectStore("settings").put(JSON.stringify(profiles), "profiles");
    await tx.done;
  }
  async conversationFolders(): Promise<ConversationFoldersState> {
    try { return conversationFoldersSchema.parse(JSON.parse((await (await this.db).get("settings", "conversationFolders")) as string)); }
    catch { return emptyConversationFolders(); }
  }
  async saveConversationFolders(value: ConversationFoldersState, identity: Identity, authoritative = false): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (current?.deviceId === identity.deviceId && current.hubPublicKey === identity.hubPublicKey) {
      const old = await settings.get("conversationFolders") as string | undefined;
      let parsed;
      try { parsed = old ? conversationFoldersSchema.safeParse(JSON.parse(old)) : undefined; } catch { /* Replace an unreadable cache with the confirmed Hub snapshot. */ }
      // A new authenticated snapshot can come from a restored Hub backup.
      // Revision ordering only applies within that snapshot's live session.
      if (authoritative || !parsed?.success || parsed.data.revision <= value.revision) await settings.put(JSON.stringify(value), "conversationFolders");
    }
    await tx.done;
  }
  async pins(scope: "group" | "global" = "group"): Promise<string[]> {
    try { const value: unknown = JSON.parse((await (await this.db).get("settings", scope === "global" ? "globalPins" : "pins")) as string ?? "[]"); return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : []; } catch { return []; }
  }
  async savePins(pins: string[]): Promise<void> { const tx = await this.write(["settings"]); await tx.objectStore("settings").put(JSON.stringify(pins), "pins"); await tx.done; }
  /** Update one local pin atomically, so concurrent rows cannot overwrite each other. */
  async setPinned(id: string, pinned: boolean, scope: "group" | "global" = "group"): Promise<void> {
    const key = scope === "global" ? "globalPins" : "pins";
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    let pins: string[] = [];
    try { const saved: unknown = JSON.parse((await settings.get(key)) as string ?? "[]"); if (Array.isArray(saved)) pins = saved.filter((value): value is string => typeof value === "string"); } catch { /* Keep the existing corrupt-cache fallback. */ }
    await settings.put(JSON.stringify(pinned ? [...new Set([...pins, id])] : pins.filter(value => value !== id)), key);
    await tx.done;
  }
  private selectionHintKey(identity: Identity, generation: string | undefined): string {
    return `tarocub-selection:${JSON.stringify([this.databaseName, generation ?? null, draftOwner(identity)])}`;
  }
  private clearSelectionHint(key: string, expected?: string): void {
    try { if (expected === undefined || localStorage.getItem(key) === expected) localStorage.removeItem(key); } catch { /* IDB remains available when localStorage is blocked. */ }
  }
  async selectedConversation(): Promise<string> {
    const [db, generation] = await Promise.all([this.db, this.generation]);
    const tx = db.transaction("settings"), settings = tx.objectStore("settings");
    const [value, identity, currentGeneration, pending] = await Promise.all([
      settings.get("selectedConversation"), settings.get("identity"), settings.get("cacheGeneration"), settings.get("pendingReset"),
    ]);
    await tx.done;
    if (currentGeneration !== generation || pending) return "";
    if (identity && typeof identity === "object" && "deviceId" in identity) {
      try {
        const raw = localStorage.getItem(this.selectionHintKey(identity, generation));
        const hint: unknown = raw ? JSON.parse(raw) : undefined;
        if (hint && typeof hint === "object" && "id" in hint && typeof hint.id === "string" && "token" in hint && typeof hint.token === "string") return hint.id;
      } catch { /* Fall back to the committed selection. */ }
    }
    return typeof value === "string" ? value : "";
  }
  async saveSelectedConversation(id: string, identity?: Identity): Promise<void> {
    // The UI commits before IDB's generation checks finish. Keep only this
    // pending selection synchronously so immediate reload/close can recover it.
    // A stale tab's hint has a different pairing/generation key after reset.
    const hintKey = identity && this.selectionGeneration && !this.closed ? this.selectionHintKey(identity, this.selectionGeneration.value) : undefined;
    // Distinguish A -> B -> A: the first A must not clear the pending last A.
    const hint = JSON.stringify({ id, token: crypto.randomUUID() });
    if (hintKey) { try { localStorage.setItem(hintKey, hint); } catch { /* Selection must work without localStorage. */ } }
    try {
      const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
      if (identity) {
        const current = await settings.get("identity") as Identity | undefined;
        if (!current || draftOwner(current) !== draftOwner(identity)) { await tx.done; throw new Error("host_cache_identity_mismatch"); }
      }
      await settings.put(id, "selectedConversation"); await tx.done;
    } finally { if (hintKey) this.clearSelectionHint(hintKey, hint); }
  }
  async preferences(): Promise<Preferences> {
    const saved = await (await this.db).get("settings", "preferences") as Partial<Preferences> | undefined;
    // Missing or retired palettes use Monochrome; preserve all other saved choices.
    // Retain the legacy animations field, but the retired App switch is always on.
    return { ...defaultPreferences, ...saved, animations: true, animatedAvatars: saved?.animatedAvatars !== false, linkPreviewStyle: saved?.linkPreviewStyle === "inline" ? "inline" : "card", layoutDensity: normalizeLayoutDensity(saved?.layoutDensity), sidebarGroupByHost: saved?.sidebarGroupByHost === true, showDisconnectedBots: saved?.showDisconnectedBots === true, showTicketConversations: saved?.showTicketConversations === true, sidebarLayout: saved?.sidebarLayout === "conversations" ? "conversations" : "bots", palette: isColorPalette(saved?.palette) ? saved.palette : DEFAULT_PALETTE, monoAccent: isMonoAccent(saved?.monoAccent) ? saved.monoAccent : DEFAULT_MONO_ACCENT };
  }
  async savePreferences(value: Preferences): Promise<void> { const tx = await this.write(["settings"]); await tx.objectStore("settings").put(value, "preferences"); await tx.done; }
  async draft(id: string): Promise<string> { return (await (await this.db).get("settings", `draft:${id}`)) as string ?? ""; }
  /** Derived list metadata only: never load files, quoted message bodies or
   * conversation history just to display an unsent-content indicator. */
  async draftPreviews(): Promise<Record<string, DraftPreview>> {
    const tx = (await this.db).transaction(["settings", "conversationDrafts"]);
    const previews: Record<string, DraftPreview> = Object.create(null);
    const entry = (id: string) => previews[id] ??= { text: "", files: 0, reply: false };
    const rich = tx.objectStore("conversationDrafts");
    await Promise.all([
      (async () => {
        for (let cursor = await tx.objectStore("settings").openCursor(IDBKeyRange.bound("draft:", "draft:\uffff")); cursor; cursor = await cursor.continue()) {
          if (typeof cursor.value !== "string" || cursor.key.startsWith("draft:discussion-composer:")) continue;
          const text = cursor.value.replace(/\s+/g, " ").trim();
          if (text) entry(cursor.key.slice(6)).text = Array.from(text).slice(0, 160).join("");
        }
      })(),
      (async () => { for (let cursor = await rich.index("fileCount").openKeyCursor(IDBKeyRange.lowerBound(1)); cursor; cursor = await cursor.continue()) entry(cursor.primaryKey).files = cursor.key; })(),
      (async () => { for (let cursor = await rich.index("reply").openKeyCursor(); cursor; cursor = await cursor.continue()) entry(cursor.primaryKey).reply = true; })(),
    ]);
    await tx.done; return previews;
  }
  async draftCount(): Promise<number> {
    const tx = (await this.db).transaction(["settings", "conversationDrafts"]), settings = tx.objectStore("settings");
    const [keys, values, rich] = await Promise.all([settings.getAllKeys(), settings.getAll(), tx.objectStore("conversationDrafts").index("active").getAllKeys(1)]);
    const conversations = new Set([...keys.filter((key, index) => key.startsWith("draft:") && !key.startsWith("draft:discussion-composer:") && typeof values[index] === "string" && (values[index] as string).trim()).map(key => key.slice(6)), ...rich]).size;
    // Removing a host also removes its edited system-share reviews. Include
    // those in the existing unsent-content warning, excluding small tombstones.
    const shares = keys.filter((key, index) => {
      if (!key.startsWith("share-draft:") || typeof values[index] !== "string") return false;
      try { const value = JSON.parse(values[index] as string) as SavedShareDraft & { expiresAt?: number }; return !value.retired && !!value.draft && (value.expiresAt === undefined || value.expiresAt > Date.now()); }
      catch { return false; }
    }).length;
    return conversations + shares;
  }
  /** Dedicated unsent storage: never evicted by downloaded-file caching. */
  async conversationDraft(id: string, identity: Identity): Promise<{ draft: ConversationDraft; revision?: string }> {
    const tx = await this.write(["conversationDrafts"]);
    const current = await tx.objectStore("settings").get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) { tx.abort(); throw new Error("draft_identity_changed"); }
    const stored = await tx.objectStore("conversationDrafts").get(id); await tx.done;
    if (!stored) return { draft: { files: [], previewStyle: "card" } };
    if (stored.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
    const { revision, owner: _owner, size: _size, active: _active, files, ...metadata } = stored;
    return { revision, draft: { ...metadata, files: files.map(file => new File([file.bytes], file.name, { type: file.type, lastModified: file.lastModified })) } };
  }
  async saveConversationDraft(id: string, draft: ConversationDraft, identity: Identity, expectedRevision?: string): Promise<string | undefined> {
    const { files, ...metadata } = draft;
    const metadataBytes = new TextEncoder().encode(JSON.stringify({ ...metadata, fileMetadata: files.map(({ name, type, lastModified }) => ({ name, type, lastModified })) })).byteLength;
    const size = files.reduce((sum, file) => sum + file.size, 0) + metadataBytes;
    if (metadataBytes > 1024 * 1024) throw new Error("draft_metadata_too_large");
    if (files.length > 32 || size > DRAFT_CONVERSATION_BYTES) throw new Error("draft_capacity_exceeded");
    // Encode before opening the transaction: Blob reads must not auto-commit IDB.
    const encoded = await Promise.all(files.map(async file => {
      let bytes = this.draftFileBytes.get(file);
      if (!bytes) {
        // Share only an in-flight read. Keeping its fulfilled promise would
        // retain a full byte copy for as long as a draft retains this File.
        bytes = file.arrayBuffer().finally(() => this.draftFileBytes.delete(file));
        this.draftFileBytes.set(file, bytes);
      }
      return { bytes: await bytes, name: file.name, type: file.type, lastModified: file.lastModified };
    }));
    const tx = await this.write(["conversationDrafts", ...(metadata.reply ? ["messages" as const] : [])]), settings = tx.objectStore("settings"), store = tx.objectStore("conversationDrafts");
    if (metadata.reply && (await tx.objectStore("messages").get(metadata.reply.id))?.status === "deleted") delete metadata.reply;
    const fail = (message: string): never => { tx.abort(); throw new Error(message); };
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) fail("draft_identity_changed");
    if (await settings.get("revokedIdentity") === JSON.stringify([identity.deviceId, identity.hubPublicKey])) fail("draft_identity_revoked");
    const old = await store.get(id);
    if (old?.revision !== expectedRevision) fail("draft_changed_elsewhere");
    // Keep a revision tombstone even when empty: an old tab must not recreate
    // already-sent content after another tab clears it (the ABA case).
    const revision = crypto.randomUUID();
    let total = size - (old?.size ?? 0);
    for (let cursor = await store.index("size").openKeyCursor(); cursor; cursor = await cursor.continue()) total += cursor.key;
    const active = files.length || metadata.reply || metadata.previewChoice !== undefined ? 1 : 0;
    if (total > DRAFT_TOTAL_BYTES) fail("draft_capacity_exceeded");
    if (active && !old?.active && await store.index("active").count(1) >= 1000) fail("draft_record_limit");
    await store.put({ ...metadata, files: encoded, revision, owner: draftOwner(identity), size, active }, id); await tx.done;
    this.draftsChanged();
    return revision;
  }
  /** Main group drafts bind text and send intent in one lightweight transaction.
   * Files remain in conversationDrafts; typing never recopies their bytes. */
  async groupComposerDraft(id: string): Promise<{ text: string; intent?: GroupComposerIntent; invalidIntent?: string }> {
    const tx = (await this.db).transaction("settings"), store = tx.objectStore("settings");
    const [text, raw] = await Promise.all([store.get(`draft:${id}`), store.get(`group-composer-intent:${id}`)]);
    await tx.done;
    const draft = { text: typeof text === "string" ? text : "" };
    if (!raw) return draft;
    try { return { ...draft, intent: groupComposerIntentSchema.parse(JSON.parse(raw as string)) }; }
    catch { return { ...draft, invalidIntent: JSON.stringify(raw) }; }
  }
  async saveGroupComposerDraft(id: string, text: string, intent: GroupComposerIntent, expectedId?: string, expectedInvalid?: string): Promise<void> {
    const tx = await this.write(["settings"]), store = tx.objectStore("settings");
    const raw = await store.get(`group-composer-intent:${id}`);
    let old: GroupComposerIntent | undefined;
    try { old = raw ? groupComposerIntentSchema.parse(JSON.parse(raw as string)) : undefined; }
    catch {
      // Only the explicit recovery action may replace the exact malformed row
      // the user reviewed. Normal editing/sending never retires uncertain state.
      if (expectedInvalid !== JSON.stringify(raw)) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("draft_intent_unreadable"); }
    }
    if (old?.id !== expectedId) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("draft_changed_elsewhere"); }
    await store.put(text, `draft:${id}`); await store.put(JSON.stringify(intent), `group-composer-intent:${id}`);
    await tx.done; this.draftsChanged();
  }
  async clearGroupComposerDraft(id: string, text: string, intentId: string): Promise<GroupComposerIntent | undefined> {
    const tx = await this.write(["settings"]), store = tx.objectStore("settings");
    const raw = await store.get(`group-composer-intent:${id}`);
    const old = raw ? groupComposerIntentSchema.parse(JSON.parse(raw as string)) : undefined;
    let cleared: GroupComposerIntent | undefined;
    if (old?.id === intentId && await store.get(`draft:${id}`) === text) {
      cleared = { id: crypto.randomUUID(), empty: true };
      await store.delete(`draft:${id}`); await store.put(JSON.stringify(cleared), `group-composer-intent:${id}`);
    }
    await tx.done; if (cleared) this.draftsChanged(); return cleared;
  }
  async saveDraft(id: string, text: string): Promise<void> { const tx = await this.write(["settings"]); await tx.objectStore("settings").put(text, `draft:${id}`); await tx.done; this.draftsChanged(); }
  /** Native share files stay in their native inbox. Only this pairing's
   * editable review state lives here, separate from immutable delivery pins. */
  async shareDraft(id: string, identity: Identity): Promise<SavedShareDraft> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) { tx.abort(); throw new Error("draft_identity_changed"); }
    const raw = await settings.get(`share-draft:${id}`); await tx.done;
    if (raw === undefined) return { retired: false };
    const stored = JSON.parse(raw as string) as SavedShareDraft & { owner: string; expiresAt?: number };
    if (stored.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now()) throw new Error("share_draft_expired");
    return { revision: stored.revision, retired: stored.retired, ...(stored.draft ? { draft: shareDraftSchema.parse(stored.draft) } : {}) };
  }
  async saveShareDraft(id: string, draft: ShareDraft, identity: Identity, expectedRevision?: string, expiresAt = Date.now() + SHARE_DRAFT_RETENTION_MS): Promise<string> {
    const value = shareDraftSchema.parse(draft), tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const fail = (message: string): never => { tx.abort(); throw new Error(message); };
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) fail("draft_identity_changed");
    if (await settings.get("revokedIdentity") === JSON.stringify([identity.deviceId, identity.hubPublicKey])) fail("draft_identity_revoked");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) fail("share_draft_expired");
    const key = `share-draft:${id}`, raw = await settings.get(key);
    const old = raw === undefined ? undefined : JSON.parse(raw as string) as SavedShareDraft & { owner: string; expiresAt?: number };
    if (old?.retired) fail("share_draft_retired");
    if (old?.expiresAt !== undefined && old.expiresAt <= Date.now()) fail("share_draft_expired");
    if (old && old.owner !== draftOwner(identity)) fail("draft_identity_changed");
    if (old?.revision !== expectedRevision) fail("draft_changed_elsewhere");
    const revision = crypto.randomUUID();
    await settings.put(JSON.stringify({ revision, owner: draftOwner(identity), retired: false, draft: value, expiresAt: Math.min(expiresAt, old?.expiresAt ?? Infinity, Date.now() + SHARE_DRAFT_RETENTION_MS) }), key); await tx.done;
    return revision;
  }
  async retireShareDraft(id: string, identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) { tx.abort(); throw new Error("draft_identity_changed"); }
    // Keep only a small tombstone: an already queued save in another view may
    // not recreate a sent/discarded review after the native item is removed.
    const key = `share-draft:${id}`, raw = await settings.get(key);
    const old = raw === undefined ? undefined : JSON.parse(raw as string) as { expiresAt?: number };
    await settings.put(JSON.stringify({ revision: crypto.randomUUID(), owner: draftOwner(identity), retired: true, expiresAt: old?.expiresAt ?? Date.now() + SHARE_DRAFT_RETENTION_MS }), key); await tx.done;
  }
  async pruneExpiredShareDrafts(identity: Identity): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) { tx.abort(); throw new Error("draft_identity_changed"); }
    for (let cursor = await settings.openCursor(IDBKeyRange.bound("share-draft:", "share-draft:\uffff")); cursor; cursor = await cursor.continue()) {
      const record = JSON.parse(cursor.value as string) as { owner: string; expiresAt?: number };
      if (record.owner === draftOwner(identity) && record.expiresAt !== undefined && record.expiresAt <= Date.now()) await cursor.delete();
    }
    await tx.done;
  }
  async operationRecord(id: string): Promise<string> { return (await (await this.db).get("settings", `operation:${id}`)) as string ?? ""; }
  async clearOperationIfMatches(id: string, expected: string): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    if (await settings.get(`operation:${id}`) === expected) await settings.delete(`operation:${id}`);
    await tx.done;
  }
  async updateOperationIfMatches(id: string, expected: string, text: string): Promise<boolean> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    const changed = (await settings.get(`operation:${id}`) ?? "") === expected;
    if (changed) await settings.put(text, `operation:${id}`);
    await tx.done;
    return changed;
  }
  async clearDraftIfMatches(id: string, sentText: string): Promise<void> {
    const tx = await this.write(["settings"]), settings = tx.objectStore("settings");
    // A late send receipt must not erase a newer draft, including another tab's.
    const cleared = await settings.get(`draft:${id}`) === sentText;
    if (cleared) await settings.delete(`draft:${id}`);
    await tx.done;
    if (cleared) this.draftsChanged();
  }
  private readDiffReviewRecord(raw: Cache["settings"]["value"] | undefined, scope: DiffReviewScope, identity: Identity): StoredDiffReviewDraft | undefined {
    if (raw === undefined) return;
    let record: StoredDiffReviewDraft;
    try { record = storedDiffReviewDraftSchema.parse(JSON.parse(raw as string)); }
    catch { throw new Error("diff_review_draft_invalid"); }
    if (record.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
    if (record.scope.conversationId !== scope.conversationId || record.scope.botId !== scope.botId) throw new Error("diff_review_scope_changed");
    return record;
  }
  private async diffReviewRecord(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readonly" | "readwrite">, scope: DiffReviewScope, identity: Identity, editing = false): Promise<StoredDiffReviewDraft | undefined> {
    const settings = tx.objectStore("settings"), current = await settings.get("identity") as Identity | undefined;
    if (!current || draftOwner(current) !== draftOwner(identity)) throw new Error("draft_identity_changed");
    if (editing && await settings.get("revokedIdentity") === JSON.stringify([identity.deviceId, identity.hubPublicKey])) throw new Error("draft_identity_revoked");
    return this.readDiffReviewRecord(await settings.get(diffReviewDraftKey(scope)), scope, identity);
  }
  private async diffReviewReferences(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readonly" | "readwrite">, scope: DiffReviewScope, identity: Identity, record?: StoredDiffReviewDraft): Promise<RunReviewReferences> {
    const raw = await tx.objectStore("settings").get(reviewReferenceKey(scope));
    if (raw === undefined) return validateReviewReferences(record?.notes ?? [], {});
    const sidecar = reviewReferencesSchema.parse(JSON.parse(raw as string));
    if (sidecar.owner !== draftOwner(identity) || sidecar.scope.conversationId !== scope.conversationId || sidecar.scope.botId !== scope.botId) throw new Error("diff_review_reference_identity_changed");
    return validateReviewReferences(record?.notes ?? [], sidecar.refs);
  }
  private diffReviewView(record: StoredDiffReviewDraft | undefined, entry?: OutboxEntry, references: RunReviewReferences = {}): DiffReviewDraft {
    if (!record) return { notes: [] };
    return { notes: record.notes, revision: record.revision, ...(Object.keys(references).length ? { references } : {}), ...(record.pending ? { pending: record.pending,
      pendingState: entry ? entry.error ? "failed" : "queued" : "uncertain", ...(entry?.error ? { pendingError: entry.error } : {}) } : {}) };
  }
  async diffReviewDraft(input: DiffReviewScope, identity: Identity): Promise<DiffReviewDraft> {
    const scope = diffReviewScopeSchema.parse(input), [db, generation] = await Promise.all([this.db, this.generation]);
    if (this.closed) throw new Error("local_cache_closed");
    const tx = db.transaction(["settings", "outbox"], "readonly"), settings = tx.objectStore("settings");
    void tx.done.catch(() => undefined);
    try {
      if (await settings.get("cacheGeneration") !== generation || await settings.get("pendingReset")) throw new Error("local_reset_in_progress");
      const record = await this.diffReviewRecord(tx, scope, identity);
      const entry = record?.pending ? await tx.objectStore("outbox").get(record.pending.clientMsgId) : undefined;
      const references = await this.diffReviewReferences(tx, scope, identity, record);
      await tx.done; return this.diffReviewView(record, entry, references);
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  async saveDiffReviewDraft(input: DiffReviewScope, identity: Identity, notes: DiffReviewNote[], expectedRevision?: string, suppliedReferences?: RunReviewReferences): Promise<DiffReviewDraft> {
    const scope = diffReviewScopeSchema.parse(input), tx = await this.write(["settings", "outbox"]);
    try {
      const old = await this.diffReviewRecord(tx, scope, identity, true);
      if (old?.revision !== expectedRevision) throw new Error("draft_changed_elsewhere");
      const previous = await this.diffReviewReferences(tx, scope, identity, old);
      for (const note of old?.notes ?? []) if (suppliedReferences?.[note.id] && JSON.stringify(suppliedReferences[note.id]) !== JSON.stringify(previous[note.id])) throw new Error("diff_review_reference_changed");
      const references = validateReviewReferences(notes, { ...previous, ...suppliedReferences });
      const record = reviseDiffReviewDraft(old, scope, draftOwner(identity), notes);
      const entry = record.pending ? await tx.objectStore("outbox").get(record.pending.clientMsgId) : undefined;
      await tx.objectStore("settings").put(JSON.stringify(record), diffReviewDraftKey(scope));
      if (Object.keys(references).length) await tx.objectStore("settings").put(JSON.stringify({ v: 1, owner: draftOwner(identity), scope, refs: references }), reviewReferenceKey(scope));
      else await tx.objectStore("settings").delete(reviewReferenceKey(scope));
      await tx.done; this.diffReviewsChanged(scope); return this.diffReviewView(record, entry, references);
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  /** Pin the message and receipt in the same transaction as the outbox entry. */
  async enqueueDiffReview(input: DiffReviewScope, identity: Identity, expectedRevision?: string): Promise<{ frame: DiffReviewFrame; draft: DiffReviewDraft; reused: boolean }> {
    const scope = diffReviewScopeSchema.parse(input), tx = await this.write(["settings", "outbox"]), settings = tx.objectStore("settings");
    try {
      const old = await this.diffReviewRecord(tx, scope, identity, true);
      const references = await this.diffReviewReferences(tx, scope, identity, old);
      if (old?.pending) {
        const entry = await tx.objectStore("outbox").get(old.pending.clientMsgId);
        await tx.done; return { frame: old.pending.frame, draft: this.diffReviewView(old, entry, references), reused: true };
      }
      if (old?.revision !== expectedRevision) throw new Error("draft_changed_elsewhere");
      // Formatting, comment and UTF-8 validation precede every queue mutation.
      const frame = makeDiffReviewFrame(scope, old?.notes ?? [], crypto.randomUUID(), references);
      if (!old) throw new Error("diff_review_empty");
      if (await tx.objectStore("outbox").get(frame.clientMsgId) || await settings.get(diffReviewReceiptKey(frame.clientMsgId))) throw new Error("diff_review_message_id_conflict");
      const pending = diffReviewPendingSchema.parse({ clientMsgId: frame.clientMsgId, frame, snapshot: old.notes, noteVersions: old.noteVersions });
      const record = { ...old, revision: crypto.randomUUID(), pending };
      await settings.put(JSON.stringify(record), diffReviewDraftKey(scope));
      await settings.put(JSON.stringify({ owner: draftOwner(identity), scope }), diffReviewReceiptKey(frame.clientMsgId));
      const entry = await this.putOutboxFrame(tx, frame);
      await tx.done; this.diffReviewsChanged(scope); return { frame, draft: this.diffReviewView(record, entry, references), reused: false };
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  /** Explicit recovery only: reuse the immutable ID and frame, including an uncertain receipt. */
  async retryDiffReview(input: DiffReviewScope, identity: Identity, clientMsgId: string): Promise<{ frame: DiffReviewFrame; draft: DiffReviewDraft; reused: boolean }> {
    const scope = diffReviewScopeSchema.parse(input), tx = await this.write(["settings", "outbox"]);
    try {
      const record = await this.diffReviewRecord(tx, scope, identity, true);
      if (!record?.pending || record.pending.clientMsgId !== clientMsgId) throw new Error("diff_review_pending_changed");
      const references = await this.diffReviewReferences(tx, scope, identity, record);
      let entry = await tx.objectStore("outbox").get(clientMsgId);
      const reused = !!entry && !entry.error;
      if (!reused) entry = await this.putOutboxFrame(tx, record.pending.frame);
      await tx.done; if (!reused) this.diffReviewsChanged(scope); return { frame: record.pending.frame, draft: this.diffReviewView(record, entry, references), reused };
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  /** Abandon only failed/uncertain delivery; editing notes never cancels queued work. */
  async abandonDiffReview(input: DiffReviewScope, identity: Identity, clientMsgId: string): Promise<DiffReviewDraft> {
    const scope = diffReviewScopeSchema.parse(input), tx = await this.write(["settings", "outbox"]), settings = tx.objectStore("settings");
    try {
      // Local abandonment remains available after revocation; it sends nothing
      // and preserves every note while retiring only this failed receipt.
      const old = await this.diffReviewRecord(tx, scope, identity);
      if (!old?.pending || old.pending.clientMsgId !== clientMsgId) throw new Error("diff_review_pending_changed");
      const entry = await tx.objectStore("outbox").get(clientMsgId);
      if (entry && !entry.error) throw new Error("diff_review_send_in_progress");
      const record = settleDiffReviewDraft(old, clientMsgId, false);
      const references = await this.diffReviewReferences(tx, scope, identity, record);
      if (entry) await tx.objectStore("outbox").delete(clientMsgId);
      await settings.put(JSON.stringify(record), diffReviewDraftKey(scope));
      await settings.delete(diffReviewReceiptKey(clientMsgId));
      await tx.done; this.diffReviewsChanged(scope); return this.diffReviewView(record, undefined, references);
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  async questionDraft(messageId: string, key: string, identity: Identity): Promise<QuestionDraft | undefined> {
    await this.questionSaves.get(key)?.catch(() => undefined);
    const tx = (await this.db).transaction(["settings", "messages"]);
    const current = await tx.objectStore("settings").get("identity") as Identity | undefined;
    if (current?.deviceId !== identity.deviceId || current.hubPublicKey !== identity.hubPublicKey) return;
    const message = await tx.objectStore("messages").get(messageId);
    if (!message || !activeQuestionDrafts(message).has(key)) return;
    try { return questionDraftSchema.parse(JSON.parse(await tx.objectStore("settings").get(key) as string)); } catch { return; }
  }
  saveQuestionDraft(messageId: string, key: string, draft: QuestionDraft, identity: Identity): Promise<void> {
    const pending = (this.questionSaves.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.persistQuestionDraft(messageId, key, draft, identity));
    this.questionSaves.set(key, pending);
    void pending.finally(() => { if (this.questionSaves.get(key) === pending) this.questionSaves.delete(key); }).catch(() => undefined);
    return pending;
  }
  private async persistQuestionDraft(messageId: string, key: string, draft: QuestionDraft, identity: Identity): Promise<void> {
    const value = questionDraftSchema.parse(draft), tx = await this.write(["settings", "messages"]);
    const current = await tx.objectStore("settings").get("identity") as Identity | undefined;
    const message = await tx.objectStore("messages").get(messageId);
    if (current?.deviceId === identity.deviceId && current.hubPublicKey === identity.hubPublicKey && message && activeQuestionDrafts(message).has(key)) await tx.objectStore("settings").put(JSON.stringify(value), key);
    await tx.done;
  }
  private async pruneQuestionDrafts(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, messageId: string, keep = new Set<string>()) {
    const prefix = questionDraftPrefix(messageId), settings = tx.objectStore("settings");
    for (const key of await settings.getAllKeys(IDBKeyRange.bound(prefix, prefix + "\uffff"))) if (!keep.has(key)) await settings.delete(key);
  }
  async conversations(): Promise<Conversation[]> { return (await this.db).getAll("conversations"); }
  async conversation(id: string): Promise<Conversation | undefined> { return (await this.db).get("conversations", id); }
  async saveConversations(values: Conversation[]): Promise<void> { const tx = await this.write(["conversations"]); for (const value of values) await tx.objectStore("conversations").put(value); await tx.done; }
  async seedConversation(value: Conversation): Promise<Conversation> {
    // HTTP creation receipts can arrive after newer WebSocket metadata. Make
    // this check-and-insert atomic, including writes from another browser tab.
    const tx = await this.write(["conversations"]), store = tx.objectStore("conversations");
    const current = await store.get(value.id);
    if (!current) await store.put(value);
    await tx.done; return current ?? value;
  }
  async messages(conversationId: string): Promise<Message[]> { return (await (await this.db).getAllFromIndex("messages", "conversation", conversationId)).sort((a, b) => a.createdAt - b.createdAt).map(({ activitySeq: _seq, activityAt: _at, ...message }) => message); }
  async deletedMessageIds(): Promise<Set<string>> { return new Set(await (await this.db).getAllKeysFromIndex("messages", "status", "deleted")); }
  async activeMessages(): Promise<string[]> {
    const tx = (await this.db).transaction("messages"), status = tx.store.index("status");
    // Observe transaction failure even if one of the key requests rejects.
    const [pending, streaming] = await Promise.all([status.getAllKeys("pending"), status.getAllKeys("streaming"), tx.done]);
    return [...pending, ...streaming].sort();
  }
  /** Read cursor positions and their committed restore lineage together. */
  async syncResume(): Promise<{ cursors: Record<string, number>; syncLineages: Record<string, string> }> {
    const tx = (await this.db).transaction(["cursors", "settings"]);
    const keys = await tx.objectStore("cursors").getAllKeys(), values = await tx.objectStore("cursors").getAll();
    const syncLineages: Record<string, string> = {}, conversations = new Set(keys);
    for (let entry = await tx.objectStore("settings").openCursor(IDBKeyRange.bound("syncLineage:", "syncLineage:\uffff")); entry; entry = await entry.continue()) {
      const conversationId = entry.key.slice(12);
      if (conversations.has(conversationId) && typeof entry.value === "string") syncLineages[conversationId] = entry.value;
    }
    await tx.done;
    return { cursors: Object.fromEntries(keys.map((key, i) => [key, values[i]!])), syncLineages };
  }
  async cursors(): Promise<Record<string, number>> { const db = await this.db; const tx = db.transaction("cursors"); const keys = await tx.store.getAllKeys(); const values = await tx.store.getAll(); return Object.fromEntries(keys.map((key, i) => [key, values[i]!])); }
  async cursor(conversationId: string): Promise<number> { return (await (await this.db).get("cursors", conversationId)) ?? 0; }
  async activity(): Promise<Record<string, ConversationActivity>> {
    const tx = (await this.db).transaction("activity"), keys = await tx.store.getAllKeys(), values = await tx.store.getAll();
    const result = Object.fromEntries(keys.map((key, i) => [key, values[i]!]));
    const legacy = keys.filter((key) => result[key]!.attention === undefined || result[key]!.replies === undefined || result[key]!.workingReplies === undefined);
    if (legacy.length) {
      // One-time projection for an existing cache. Reread inside the write
      // transaction so sync in another tab cannot be overwritten by backfill.
      const update = await this.write(["activity", "messages"]);
      // Recover only in-flight replies through the existing status index,
      // once for this batch. Do not reread completed history or its long bodies.
      const working = new Map<string, Cache["messages"]["value"][]>();
      for (const message of await update.objectStore("messages").index("status").getAll("streaming")) {
        const rows = working.get(message.conversationId) ?? [];
        rows.push(message); working.set(message.conversationId, rows);
      }
      for (const key of legacy) { result[key] = await this.projectedActivity(update, key, working.get(key) ?? []); await update.objectStore("activity").put(result[key]!, key); }
      await update.done;
    }
    return result;
  }
  private async projectedActivity(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, conversationId: string, working?: Cache["messages"]["value"][]): Promise<ConversationActivity> {
    const activity = await tx.objectStore("activity").get(conversationId) ?? { preview: "", at: 0, unread: {}, lastContentSeq: 0 };
    if (activity.attention === undefined || activity.replies === undefined) {
      const attention: Record<string, MessageAttention> | undefined = activity.attention === undefined ? activity.attention = {} : undefined;
      const replies = activity.replies === undefined ? activity.replies = {} : undefined;
      if (replies) activity.workingReplies ??= {};
      for (let cursor = await tx.objectStore("messages").index("conversation").openCursor(conversationId); cursor; cursor = await cursor.continue()) {
        const request = attention && messageAttention(cursor.value);
        if (request) attention[cursor.value.id] = request;
        if (replies) projectReply(activity, cursor.value, cursor.value.activityAt ?? cursor.value.createdAt);
      }
    }
    if (activity.workingReplies === undefined) {
      activity.workingReplies = {};
      for (const message of working ?? await tx.objectStore("messages").index("status").getAll("streaming")) {
        if (message.conversationId === conversationId) projectWorkingReply(activity, message, message.activityAt ?? message.createdAt);
      }
    }
    return activity;
  }
  private async pruneDeletedReply(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, id: string): Promise<boolean> {
    let changed = false;
    let cursor = await tx.objectStore("conversationDrafts").index("reply").openCursor(id);
    while (cursor) { const { reply: _reply, ...draft } = cursor.value; await cursor.update({ ...draft, active: draft.files.length || draft.previewChoice !== undefined ? 1 : 0 }); changed = true; cursor = await cursor.continue(); }
    return changed;
  }
  private projectAttention(activity: ConversationActivity, message: Message): void {
    const attention = activity.attention ??= {}, request = messageAttention(message);
    if (request) attention[message.id] = request; else delete attention[message.id];
  }
  async claimNotification(id: string): Promise<boolean> { const tx = await this.write(["settings"]); if (await tx.objectStore("settings").get(`notification:${id}`)) return false; await tx.objectStore("settings").put("shown", `notification:${id}`); await tx.done; return true; }
  private async dropSnapshot(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, owner: string) {
    let cursor = await tx.objectStore("syncMessages").index("owner").openCursor(owner);
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    await tx.objectStore("syncState").delete(owner);
  }
  async discardSnapshot(): Promise<void> {
    await this.ownSnapshot();
    const leases = await navigator.locks?.query().catch(() => undefined);
    const owners = leases ? new Set(leases.held?.map((lock) => lock.name)) : undefined;
    const tx = await this.write(["syncState", "syncMessages"]);
    await this.dropSnapshot(tx, this.snapshotOwner);
    let cursor = await tx.objectStore("syncState").openCursor();
    while (cursor) {
      if (owners ? !owners.has(`tarocub-snapshot:${this.databaseName}:${cursor.key}`) : cursor.value.updatedAt < Date.now() - 24 * 60 * 60 * 1000) await this.dropSnapshot(tx, cursor.key);
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  async acceptSnapshot(raw: SnapshotFrame, expected?: { lineage?: string }): Promise<boolean> {
    const frame = snapshotFrameSchema.parse(raw);
    await this.ownSnapshot();
    const tx = await this.write(["syncState", "syncMessages", "messages", "activity", "cursors", "conversations", "conversationDrafts", "settings"]);
    const complete = tx.done; void complete.catch(() => undefined);
    try {
      if (frame.type === "snapshot.begin") {
        if (frame.readSeq > frame.seq || (await tx.objectStore("cursors").get(frame.conversation.id) ?? 0) !== frame.after) throw new Error("snapshot_cursor_mismatch");
        if (frame.mode === "merge" && (frame.after <= 0 || frame.seq < frame.after)) throw new Error("snapshot_cursor_mismatch");
        const previousLineage = await tx.objectStore("settings").get(`syncLineage:${frame.conversation.id}`) as string | undefined;
        if (expected && expected.lineage !== previousLineage) throw new Error("snapshot_lineage_mismatch");
        if (frame.mode === "merge" && frame.lineage !== previousLineage) throw new Error("snapshot_lineage_mismatch");
        await this.dropSnapshot(tx, this.snapshotOwner);
        await tx.objectStore("syncState").put({ ...frame, previousLineage, count: 0, updatedAt: Date.now() }, this.snapshotOwner);
      } else {
        const state = await tx.objectStore("syncState").get(this.snapshotOwner);
        if (!state || state.id !== frame.id) throw new Error("snapshot_not_started");
        if (frame.type === "snapshot.message") {
          if (frame.index !== state.count || frame.message.conversationId !== state.conversation.id || frame.contentSeq > state.seq || frame.unreadSeq > frame.contentSeq) throw new Error("snapshot_message_mismatch");
          await tx.objectStore("syncMessages").add({ ...frame, owner: this.snapshotOwner });
          await tx.objectStore("syncState").put({ ...state, count: state.count + 1, updatedAt: Date.now() }, this.snapshotOwner);
        } else {
          const conversationId = state.conversation.id;
          if (frame.count !== state.count) throw new Error("snapshot_incomplete");
          const lineage = await tx.objectStore("settings").get(`syncLineage:${conversationId}`) as string | undefined;
          if (lineage !== state.previousLineage && lineage !== state.lineage) throw new Error("snapshot_lineage_mismatch");
          const cursor = await tx.objectStore("cursors").get(conversationId) ?? 0;
          if (cursor !== state.after || lineage !== state.previousLineage) {
            // A different tab already committed this (or newer) history. Finish
            // our stream without overwriting it or starting a reconnect loop.
            if (lineage === state.lineage && cursor >= state.seq) { await this.dropSnapshot(tx, this.snapshotOwner); await complete; return true; }
            throw new Error("snapshot_incomplete");
          }
          // No visible state changes until all frames are present. Replacing
          // messages, activity and cursor is one transaction, including deletes.
          const oldQuestions = new Set<string>();
          if (state.mode !== "merge") {
            let old = await tx.objectStore("messages").index("conversation").openCursor(conversationId);
            while (old) { if (activeQuestionDrafts(old.value).size) oldQuestions.add(old.value.id); await old.delete(); old = await old.continue(); }
          }
          const activity: ConversationActivity = state.mode === "merge" ? await this.projectedActivity(tx, conversationId) : { preview: "", at: 0, unread: {}, lastContentSeq: 0, attention: {}, replies: {}, workingReplies: {} };
          activity.unread = Object.fromEntries(Object.entries(activity.unread).filter(([, seq]) => seq > state.readSeq));
          let reprojectPreview = false;
          let staged = await tx.objectStore("syncMessages").index("owner").openCursor(this.snapshotOwner);
          while (staged) {
            const { message, contentSeq, contentAt, unreadSeq } = staged.value;
            const conflicting = await tx.objectStore("messages").get(message.id);
            if (conflicting && conflicting.conversationId !== conversationId) throw new Error("snapshot_message_conflict");
            if (conflicting && activeQuestionDrafts(conflicting).size) oldQuestions.add(message.id);
            await tx.objectStore("messages").put({ ...message, activitySeq: contentSeq, activityAt: contentAt ?? message.createdAt });
            if (message.status === "deleted") {
              await this.pruneDeletedReply(tx, message.id);
              if (state.mode === "merge") reprojectPreview = true;
            }
            delete activity.unread[message.id];
            this.projectAttention(activity, message);
            projectReply(activity, message, contentAt ?? message.createdAt);
            const questions = activeQuestionDrafts(message);
            if (questions.size || oldQuestions.has(message.id)) await this.pruneQuestionDrafts(tx, message.id, questions);
            oldQuestions.delete(message.id);
            if (message.status !== "deleted") {
              activity.at = Math.max(activity.at, contentAt ?? message.createdAt, message.createdAt);
              if (contentSeq >= activity.lastContentSeq) { activity.preview = conversationBlocksPreview(message.blocks); activity.lastContentSeq = contentSeq; }
              if (unreadSeq > state.readSeq) activity.unread[message.id] = unreadSeq;
            }
            staged = await staged.continue();
          }
          if (reprojectPreview) {
            activity.preview = ""; activity.at = 0; activity.lastContentSeq = 0;
            for (let item = await tx.objectStore("messages").index("conversation").openCursor(conversationId); item; item = await item.continue()) {
              const message = item.value;
              if (message.status === "deleted") continue;
              activity.at = Math.max(activity.at, message.activityAt ?? message.createdAt, message.createdAt);
              if ((message.activitySeq ?? 0) >= activity.lastContentSeq) { activity.preview = conversationBlocksPreview(message.blocks); activity.lastContentSeq = message.activitySeq ?? 0; }
            }
          }
          for (const id of oldQuestions) await this.pruneQuestionDrafts(tx, id);
          // ready/conversation.updated owns metadata and may be newer than the
          // snapshot's read transaction. Never roll a concurrent rename back.
          if (!await tx.objectStore("conversations").get(conversationId)) await tx.objectStore("conversations").put(state.conversation);
          await tx.objectStore("activity").put(activity, conversationId);
          await tx.objectStore("cursors").put(state.seq, conversationId);
          if (state.lineage) await tx.objectStore("settings").put(state.lineage, `syncLineage:${conversationId}`);
          else await tx.objectStore("settings").delete(`syncLineage:${conversationId}`);
          await this.dropSnapshot(tx, this.snapshotOwner);
        }
      }
      await complete; if (frame.type === "snapshot.end") this.draftsChanged(); return frame.type === "snapshot.end";
    } catch (error) { try { tx.abort(); } catch { /* Already aborted. */ } await complete.catch(() => undefined); throw error; }
  }
  async apply(raw: HubEvent, userId?: string, expected?: { lineage?: string }): Promise<Message | undefined> {
    const event = eventSchema.parse(raw); const tx = await this.write(["messages", "cursors", "activity", "conversationDrafts"]);
    // Observe transaction failure even when validation rejects before tx.done.
    const complete = tx.done; void complete.catch(() => undefined);
    try {
      if (expected && await tx.objectStore("settings").get(`syncLineage:${event.conversationId}`) !== expected.lineage) throw new Error("sync_lineage_mismatch");
      const last = await tx.objectStore("cursors").get(event.conversationId) ?? 0;
      if (event.seq <= last) { await tx.done; return; }
      if (event.seq !== last + 1) { tx.abort(); await tx.done.catch(() => undefined); throw new Error("sync_gap"); }
      let applied: Message | undefined, draftChanged = false;
      if (event.kind === "message.stream") {
        const delta = messageStreamSchema.parse(event.payload), previous = await tx.objectStore("messages").get(delta.messageId);
        if (!previous || previous.conversationId !== event.conversationId) throw new Error("stream_base_missing");
        const message = applyMessageDelta(previous, delta);
        if (message !== previous) {
          await tx.objectStore("messages").put({ ...message, activitySeq: event.seq, activityAt: Math.max(event.at, message.createdAt) }); applied = message;
          const questions = activeQuestionDrafts(message);
          if (questions.size || activeQuestionDrafts(previous).size) await this.pruneQuestionDrafts(tx, message.id, questions);
          const activity = await this.projectedActivity(tx, event.conversationId);
          this.projectAttention(activity, message);
          projectReply(activity, message, Math.max(event.at, message.createdAt));
          activity.preview = conversationBlocksPreview(message.blocks); activity.at = Math.max(activity.at, event.at, message.createdAt); activity.lastContentSeq = event.seq;
          await tx.objectStore("activity").put(activity, event.conversationId);
        }
      }
      if (event.kind === "message.created" || event.kind === "message.updated") {
        const message = messageSchema.parse(event.payload);
        if (message.conversationId !== event.conversationId) throw new Error("message_conversation_mismatch");
        const old = await tx.objectStore("messages").get(message.id);
        if (!old || message.version > old.version) {
          const contentChanged = !old || message.authorType !== "user";
          await tx.objectStore("messages").put({ ...message, activitySeq: contentChanged ? event.seq : old.activitySeq, activityAt: contentChanged ? Math.max(event.at, message.createdAt) : old.activityAt });
          const questions = activeQuestionDrafts(message);
          if (questions.size || old && activeQuestionDrafts(old).size) await this.pruneQuestionDrafts(tx, message.id, questions);
          applied = message;
          const activity = await this.projectedActivity(tx, event.conversationId);
          this.projectAttention(activity, message);
          projectReply(activity, message, Math.max(event.at, message.createdAt));
          // Enriching immutable user messages must not replace a newer sidebar preview.
          if (message.status !== "deleted" && (!old || message.authorType !== "user")) { activity.preview = conversationBlocksPreview(message.blocks); activity.at = Math.max(activity.at, event.at, message.createdAt); activity.lastContentSeq = event.seq; }
          // Queue edits change user text while retaining the original activity
          // time. Refresh only the message currently represented by the preview.
          if (message.status !== "deleted" && old && message.authorType === "user" && old.activitySeq !== undefined && old.activitySeq === activity.lastContentSeq) {
            activity.preview = conversationBlocksPreview(message.blocks);
          }
          if (message.authorType === "bot" && ["complete", "error"].includes(message.status) && (!old || old.status === "streaming" || old.status === "pending")) activity.unread[message.id] = event.seq;
          if (message.status === "deleted" && old?.status !== "deleted") {
            delete activity.unread[message.id];
            draftChanged = await this.pruneDeletedReply(tx, message.id);
            // Older content cannot supply the current preview. During a bulk
            // clear, avoid cloning the whole conversation for every tombstone.
            // Unknown legacy metadata still takes the safe full projection.
            if (!(typeof activity.lastContentSeq === "number" && old?.activitySeq !== undefined && old.activitySeq < activity.lastContentSeq)) {
              const remaining = (await tx.objectStore("messages").index("conversation").getAll(event.conversationId)).filter(item => item.status !== "deleted");
              remaining.sort((a, b) => (b.activityAt ?? b.createdAt) - (a.activityAt ?? a.createdAt) || (b.activitySeq ?? 0) - (a.activitySeq ?? 0));
              const last = remaining[0];
              activity.preview = last ? conversationBlocksPreview(last.blocks) : "";
              activity.at = last?.activityAt ?? last?.createdAt ?? 0;
              activity.lastContentSeq = last?.activitySeq ?? 0;
            }
          }
          await tx.objectStore("activity").put(activity, event.conversationId);
        }
      }
      if (event.kind === "read" && typeof event.payload === "object" && event.payload && !Array.isArray(event.payload) && event.payload.userId === userId && typeof event.payload.seq === "number") {
        const activity = await tx.objectStore("activity").get(event.conversationId);
        if (activity) { const readSeq = event.payload.seq; activity.unread = Object.fromEntries(Object.entries(activity.unread).filter(([, seq]) => seq > readSeq)); await tx.objectStore("activity").put(activity, event.conversationId); }
      }
      await tx.objectStore("cursors").put(event.seq, event.conversationId); await complete; if (draftChanged) this.draftsChanged(); return applied;
    } catch (error) { try { tx.abort(); } catch { /* Already completed or aborted. */ } await complete.catch(() => undefined); throw error; }
  }
  private async putOutboxFrame(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, frame: ClientFrame): Promise<OutboxEntry> {
    const id = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
    if (!id) throw new Error("frame_not_queueable");
    const outbox = tx.objectStore("outbox"), settings = tx.objectStore("settings");
    const existing = await outbox.get(id);
    let order = existing?.order;
    if (order === undefined) {
      const saved = Number(await settings.get("outboxOrder"));
      const previous = Number.isFinite(saved) ? saved : Math.max(0, ...(await outbox.getAll()).map((entry) => entry.order));
      order = Math.max(Date.now(), Math.ceil(previous) + 1); await settings.put(String(order), "outboxOrder");
    }
    // An explicit retry keeps its place and identity, and starts a fresh budget.
    const entry = { id, order, frame };
    await outbox.put(entry); return entry;
  }
  async enqueue(frame: ClientFrame, designComments?: { identity: Identity; userId: string; draft: WorkbenchDraft }): Promise<void> {
    const id = "clientMsgId" in frame ? frame.clientMsgId : "clientActionId" in frame ? frame.clientActionId : undefined;
    if (!id) throw new Error("frame_not_queueable");
    const tx = await this.write(["outbox", "settings", ...(designComments ? ["workbenchDesign" as const] : [])]), settings = tx.objectStore("settings");
    try {
      const raw = await settings.get(diffReviewReceiptKey(id));
      if (raw !== undefined) {
        const receipt = diffReviewReceiptSchema.parse(JSON.parse(raw as string)), identity = await settings.get("identity") as Identity | undefined;
        if (!identity || receipt.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
        const record = await this.diffReviewRecord(tx, receipt.scope, identity, true);
        if (record?.pending?.clientMsgId !== id || networkCanonical(record.pending.frame) !== networkCanonical(frame)) throw new Error("diff_review_pending_immutable");
        // Generic send cannot change a pinned payload or reset its retry budget.
        await tx.done; return;
      }
      const commentKey = designCommentReceiptKey(id), pendingComments = await settings.get(commentKey);
      if (pendingComments !== undefined) {
        const receipt = designCommentReceiptSchema.parse(JSON.parse(pendingComments as string)), identity = await settings.get("identity") as Identity | undefined;
        if (!identity || receipt.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
        if (receipt.frameHash !== designCommentFingerprint(frame)) throw new Error("design_comment_pending_immutable");
        if (!await tx.objectStore("outbox").get(id)) await this.putOutboxFrame(tx,frame);
        await tx.done;return;
      }
      if (designComments) {
        const { identity, userId } = designComments, draft = workbenchDraftSchema.parse(designComments.draft), context = draft.context;
        const current = await settings.get("identity") as Identity | undefined;
        if (!current || draftOwner(current)!==draftOwner(identity))throw new Error("draft_identity_changed");
        if (frame.type!=="message.send" || !identity.hubPublicKey || !userId || context.kind!=="design" || context.target.deviceId!==identity.deviceId
          || frame.workbench?.kind!=="design" || networkCanonical(frame.workbench.target)!==networkCanonical(context.target) || frame.workbench.revision!==context.revision)throw new Error("design_comment_target_changed");
        if (draft.designCommentVersions && Object.keys(draft.designCommentVersions).length) {
          const scope=JSON.stringify([identity.hubPublicKey,userId,frame.conversationId]);
          if(!await tx.objectStore("workbenchDesign").getKey([scope,context.target.tabId!]))throw new Error("design_comment_original_unavailable");
          const receipt=designCommentReceiptSchema.parse({owner:draftOwner(identity),scope,conversationId:frame.conversationId,target:context.target,revision:context.revision,versions:draft.designCommentVersions,frameHash:designCommentFingerprint(frame)});
          if(await tx.objectStore("outbox").get(id))throw new Error("design_comment_message_id_conflict");
          await settings.put(JSON.stringify(receipt),commentKey);
        }
      }
      await this.putOutboxFrame(tx, frame); await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined); throw error; }
  }
  async retryableFailure(id: string, error: string): Promise<void> {
    const tx = await this.write(["outbox"]), entry = await tx.objectStore("outbox").get(id);
    let scope: DiffReviewScope | undefined;
    if (entry && !entry.error) {
      const retryErrors = (entry.retryErrors ?? 0) + 1, firstRetryAt = entry.firstRetryAt ?? Date.now();
      const exhausted = retryErrors >= 4 && Date.now() - firstRetryAt >= 5000;
      await tx.objectStore("outbox").put({ ...entry, retryErrors, firstRetryAt, ...(exhausted ? { error, retryAt: undefined } : { retryAt: Date.now() + Math.min(15_000, 1000 * 2 ** Math.min(retryErrors - 1, 4)) }) });
      scope = await this.diffReviewReceiptScope(tx, id);
    }
    await tx.done; if (scope) this.diffReviewsChanged(scope);
  }
  async retryFailed(id: string): Promise<boolean> {
    const tx = await this.write(["outbox"]), store = tx.objectStore("outbox");
    // A delayed retry must never recreate an item already removed or ACKed.
    const entry = await store.get(id);
    if (!entry?.error || isUnavailableCardAction(entry)) { await tx.done; return false; }
    await store.put({ id: entry.id, order: entry.order, frame: entry.frame });
    const scope = await this.diffReviewReceiptScope(tx, id);
    await tx.done; if (scope) this.diffReviewsChanged(scope); return true;
  }
  async discardFailed(id: string): Promise<OutboxEntry | undefined> { return this.removeOutbox(id, true); }
  private async diffReviewReceiptScope(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, id: string): Promise<DiffReviewScope | undefined> {
    const raw = await tx.objectStore("settings").get(diffReviewReceiptKey(id));
    // Notification lookup must not change generic outbox error handling.
    try { return diffReviewReceiptSchema.parse(JSON.parse(raw as string)).scope; } catch { return; }
  }
  private async settleDiffReview(tx: IDBPTransaction<Cache, StoreNames<Cache>[], "readwrite">, id: string, accepted: boolean): Promise<DiffReviewScope | undefined> {
    const settings = tx.objectStore("settings"), raw = await settings.get(diffReviewReceiptKey(id));
    if (raw === undefined) return;
    const receipt = diffReviewReceiptSchema.parse(JSON.parse(raw as string)), identity = await settings.get("identity") as Identity | undefined;
    if (!identity || receipt.owner !== draftOwner(identity)) throw new Error("draft_identity_changed");
    const old = await this.diffReviewRecord(tx, receipt.scope, identity);
    if (old?.pending?.clientMsgId === id) {
      const record = settleDiffReviewDraft(old, id, accepted);
      await settings.put(JSON.stringify(record), diffReviewDraftKey(receipt.scope));
      const key = reviewReferenceKey(receipt.scope);
      if (!record.notes.length) await settings.delete(key);
      else {
        // Optional sidecar corruption must never roll back an accepted ACK.
        const rawReferences = await settings.get(key);
        try {
          const sidecar = reviewReferencesSchema.parse(JSON.parse(rawReferences as string));
          if (sidecar.owner === draftOwner(identity) && sidecar.scope.conversationId === receipt.scope.conversationId && sidecar.scope.botId === receipt.scope.botId) {
            sidecar.refs = Object.fromEntries(Object.entries(sidecar.refs).filter(([noteId]) => record.notes.some(note => note.id === noteId)));
            if (Object.keys(sidecar.refs).length) await settings.put(JSON.stringify(sidecar), key); else await settings.delete(key);
          }
        } catch { /* A later review read fails closed; outbox receipt still commits. */ }
      }
    }
    await settings.delete(diffReviewReceiptKey(id)); return receipt.scope;
  }
  private async removeOutbox(id: string, failedOnly = false, messageAccepted = false, acceptance?: DesignCommentAcceptance): Promise<OutboxEntry | undefined> {
    const tx = await this.write(["outbox", "workbenchDesign", "workbenchDesignMeta"]), store = tx.objectStore("outbox");
    let attemptedCommentWrite = false;
    // Return the actual removed entry only after commit. Observe transaction
    // aborts alongside request failures, including reset/identity fences.
    try {
      const entry = await store.get(id);
      if (failedOnly && !entry?.error) { await tx.done; return undefined; }
      if (entry) await store.delete(id);
      // A non-message ACK is not acceptance. Keep the pending receipt so an
      // explicit uncertain retry can use its original immutable ID and frame.
      const scope = messageAccepted || failedOnly ? await this.settleDiffReview(tx, id, messageAccepted) : entry ? await this.diffReviewReceiptScope(tx, id) : undefined;
      let changed: {scope:string;id:string} | undefined;
      if (messageAccepted || failedOnly) {
        const settings=tx.objectStore("settings"),key=designCommentReceiptKey(id),raw=await settings.get(key);
        if(raw!==undefined){
          // Optional comment metadata cannot turn an accepted chat message into
          // a retry. A single transaction either commits both writes or neither.
          try{
            const receipt=designCommentReceiptSchema.parse(JSON.parse(raw as string)),identity=await settings.get("identity") as Identity|undefined;
            if(messageAccepted && acceptance && identity && receipt.owner===draftOwner(identity) && await tx.objectStore("workbenchDesign").getKey([receipt.scope,receipt.target.tabId])){
              const meta=tx.objectStore("workbenchDesignMeta"),metaKey:[string,string,"comments"]=[receipt.scope,receipt.target.tabId,"comments"];
              const next=applyDesignCommentDelivery(await meta.get(metaKey),receipt,acceptance);
              if(next){attemptedCommentWrite=true;await meta.put(next,metaKey);changed={scope:receipt.scope,id:receipt.target.tabId};}
            }
          }catch(error){if(!(error instanceof SyntaxError) && !(error instanceof Error && error.name==="ZodError"))throw error;}
          await settings.delete(key);
        }
      }
      await tx.done; if (scope) this.diffReviewsChanged(scope); if(changed)this.designCommentsChanged(changed.scope,[changed.id]);return entry;
    } catch (error) {
      try { tx.abort(); } catch { /* Already completed. */ } await tx.done.catch(() => undefined);
      // Receipt metadata is optional. If storage is full, commit acceptance
      // using deletions only and leave comments unmarked. Reset/identity/other
      // storage failures still propagate through their normal fences.
      if (attemptedCommentWrite && error instanceof Error && error.name === "QuotaExceededError") return this.removeOutbox(id,failedOnly,messageAccepted,{...acceptance,workbenchContextOmitted:"local_metadata_limit"});
      throw error;
    }
  }
  async outbox(): Promise<Cache["outbox"]["value"][]> { return (await (await this.db).getAll("outbox")).sort((a, b) => a.order - b.order); }
  async fail(id: string, error: string): Promise<void> {
    const tx = await this.write(["outbox"]), entry = await tx.objectStore("outbox").get(id);
    let scope: DiffReviewScope | undefined;
    if (entry && entry.error !== error) {
      await tx.objectStore("outbox").put({ ...entry, error }); scope = await this.diffReviewReceiptScope(tx, id);
    }
    await tx.done; if (scope) this.diffReviewsChanged(scope);
  }
  async acknowledge(id: string, messageAccepted = false, acceptance?: DesignCommentAcceptance): Promise<OutboxEntry | undefined> { return this.removeOutbox(id, false, messageAccepted, acceptance); }
}
export const cache = new ClientCache();
