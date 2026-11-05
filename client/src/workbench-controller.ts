import { DESIGN_BACKUP_MAX_BYTES, parseDesignBackup, serializeDesignBackup, type DesignBackupContent } from "./workbench-design-backup.js";
import { parseDesignComments, type DesignBotDraft } from "./workbench-design-comments.js";
import { designHistorySchema } from "./workbench-design-history.js";
import { DesignSession } from "./workbench-design-session.js";
import { existingDesignShareManager } from "./workbench-design-collaboration.js";
import { emptyDesignDocument, validateDesignDocument, type DesignDocument } from "./workbench-design.js";
import { designCreateSchema, designFormatSchema, designFormatTitle, DESIGN_DOCUMENT_BYTES, type DesignFormat } from "../../src/client-protocol/workbench-design.js";
import { readBrowserDevicePreview } from "./workbench-browser-tools.js";
import { noteRecoveryKey, readNoteRecovery, rememberNoteRecovery } from "./workbench-note-recovery.js";
import { emptyMarkdown, readMarkdown, MarkdownSession, type MarkdownDocument } from "./workbench-markdown.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { markdownCreateSchema, markdownReadSchema, workbenchSourceSchema, workbenchReceiptSchema, type WorkbenchCommandFrame, type WorkbenchCancelFrame, type WorkbenchContext, type WorkbenchRegistration, type WorkbenchReceipt, type WorkbenchSource } from "../../src/client-protocol/workbench.js";
import { readReport, readWidget } from "../../src/client-protocol/widget.js";
import type { Message, Json } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { changeWorkbench, emptyWorkbench, emptyBoard, boardDocumentSchema, workbenchLayoutSchema, workbenchScope, type WorkbenchLayout, type WorkbenchTab, type LayoutAction, type BoardDocument } from "./workbench-model.js";
import type { BoardController, BoardResult, BoardImport } from "./workbench-board.js";
import { designEditorLocks, workbenchEditorLock, type WorkbenchLibraryTarget } from "./workbench-library.js";
import { WorkbenchBrowserClient, BrowserDispatchRejected, browserAddress, browserPayload, scheduleBrowserLayout, type BrowserEvent, type BrowserTabState, type PreparedBrowserAction } from "./workbench-browser.js";

export type WorkbenchSnapshot = { layout: WorkbenchLayout; ready: boolean; error?: string; browser: boolean; windowId: string; generation: string; boards: ReadonlyMap<string, BoardDocument>; notes: ReadonlyMap<string, MarkdownDocument>; browserTabs: ReadonlyMap<string, BrowserTabState>; chartVersion: number };
const fingerprint = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
const stableId = (kind: string, requestId?: string) => `${kind}_${requestId ? fingerprint(requestId).slice(0, 40) : crypto.randomUUID().replaceAll("-", "")}`;
const errorCode = (error: unknown) => error instanceof Error ? error.message.slice(0, 256) : "workbench_failed";
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
class ChartRenderRejected extends Error {}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_workbench_payload");
  return value as Record<string, unknown>;
}

export class WorkbenchController {
  readonly connection: HubConnection;
  readonly conversationId: string;
  readonly scope: string;
  readonly browser: WorkbenchBrowserClient;
  private readonly userId: string;
  private listeners = new Set<() => void>();
  private designSessions = new Map<string, DesignSession>();
  private designComposer?: (draft: DesignBotDraft) => Promise<"opened" | "declined">;
  setDesignComposer(compose?: (draft: DesignBotDraft) => Promise<"opened" | "declined">) { this.designComposer = compose; return () => { if (this.designComposer === compose) this.designComposer = undefined; }; }
  private designLoading = new Map<string, Promise<DesignSession>>();
  private noteSessions = new Map<string, MarkdownSession>();
  private noteLoading = new Map<string, Promise<MarkdownSession>>();
  private noteUsers = new Map<string, number>();
  private boardControllers = new Map<string, BoardController>();
  private boardUsers = new Map<string, number>();
  // The revision actually stored for each loaded board. A board whose document
  // differs (an earlier save failed) is a retained unsaved edit: never pruned,
  // reported as unsaved to the next editor and guarded on unload.
  private savedBoards = new Map<string, number>();
  private chartRenders = new Map<string, string>();
  private pending = new Map<string, AbortController>();
  private pendingTargets = new Map<string, { tabId?: string; requestId: string; browser: boolean }>();
  private receipts = new Map<string, { fingerprint: string; promise: Promise<WorkbenchReceipt> }>();
  private layoutQueue: Promise<unknown> = Promise.resolve();
  private initialized?: Promise<void>;
  private removeBrowserEvents?: () => void;
  private removeConnection?: () => void;
  private removeLibraryChanges?: () => void;
  private removeDesignCommentChanges?: () => void;
  private beforeUnload = (event: BeforeUnloadEvent) => { if ([...this.noteSessions.values()].some(note => note.dirty()) || [...this.snapshot.boards.keys()].some(id => this.boardUnsaved(id))) { event.preventDefault(); event.returnValue = ""; } };
  private visible = false;
  private disposed = false;
  // Native page URL/title metadata waiting to be saved into the layout.
  private browserMeta = new Map<string, { url: string; title?: string; navigated: boolean }>();
  private browserMetaTimer?: ReturnType<typeof setTimeout>;
  private browserMetaDue = Infinity;
  private browserMetaWritten = 0;
  private chartApplying = false;
  private committedChartLayout?: WorkbenchLayout;
  private snapshot: WorkbenchSnapshot;
  constructor({ connection, conversationId }: { connection: HubConnection; conversationId: string }) {
    const host = connection.identity.hubPublicKey, user = connection.state.user?.id;
    if (!host || !user) throw new Error("workbench_identity_unavailable");
    globalThis.addEventListener?.("beforeunload", this.beforeUnload);
    this.connection = connection; this.conversationId = conversationId; this.userId = user;
    this.scope = workbenchScope(host, user, conversationId);
    this.browser = new WorkbenchBrowserClient({ host, user, conversation: conversationId }, connection);
    this.snapshot = { layout: emptyWorkbench(), ready: false, browser: false, windowId: crypto.randomUUID(), generation: crypto.randomUUID(), boards: new Map(), notes: new Map(), browserTabs: new Map(), chartVersion: 0 };
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = (): WorkbenchSnapshot => this.snapshot;
  private publish(changes: Partial<WorkbenchSnapshot> = {}): void {
    this.snapshot = { ...this.snapshot, ...changes }; this.listeners.forEach(listener => listener()); scheduleBrowserLayout();
  }
  setError(error?: string): void { this.publish({ error }); }
  private check(): void {
    if (this.disposed || this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) throw new Error("workbench_scope_unavailable");
  }
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      this.check();
      let layout = await this.connection.cache.readWorkbench(this.scope);
      this.check();
      if (!layout) {
        layout = emptyWorkbench();
        try { await this.connection.cache.saveWorkbench(this.scope, -1, layout); }
        catch (error) {
          if (errorCode(error) !== "workbench_revision_conflict") throw error;
          // Another window may have initialized this same conversation first.
          // Adopt its committed layout; never overwrite it with our empty one.
          this.check(); const stored = await this.connection.cache.readWorkbench(this.scope); this.check();
          if (!stored) throw error;
          layout = stored;
        }
      }
      this.check();
      const boards = new Map<string, BoardDocument>();
      for (const tab of layout.tabs) if (tab.kind === "whiteboard" && layout.visible.includes(tab.id)) {
        const board = await this.connection.cache.readWorkbenchBoard(this.scope, tab.id);
        this.check();
        if (board) { boards.set(tab.id, board); this.savedBoards.set(tab.id, board.revision); }
      }
      let browser = false, windowId = this.snapshot.windowId;
      const browserEvents: BrowserEvent[] = [], nativeTabs: Record<string, unknown>[] = [];
      if (this.browser.supported) {
        const capability = await this.browser.command("capabilities", undefined);
        this.check();
        if (capability.status === "ok" && typeof capability.window === "string") {
          // Each conversation surface has its own logical Host target. Native
          // BrowserWindow identity is internal and may be shared by many panes.
          browser = true;
          const stop = await this.browser.subscribe(event => { if (this.disposed) return; if (!this.snapshot.ready) { if (browserEvents.length < 1024) browserEvents.push(event); } else this.browserEvent(event); });
          // dispose() may run while subscribe crosses the native bridge. The
          // late listener must be released even though teardown already ran.
          if (this.disposed) { stop(); this.check(); }
          this.removeBrowserEvents = stop; this.check();
          for (const tab of layout.tabs) if (tab.kind === "browser") {
            await this.browser.command("open", tab.id, { url: tab.url ?? "about:blank", title: tab.title, restore: true }); this.check();
          }
          const listed = await this.browser.command("list", undefined);
          this.check();
          if (listed.status !== "ok") throw new Error(listed.error ?? "browser_list_failed");
          if (Array.isArray(listed.tabs)) {
            let recovered = layout;
            for (const value of listed.tabs.slice(0, 64)) {
              if (!value || typeof value !== "object" || typeof value.tab !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.tab)) continue;
              nativeTabs.push(value);
              if (recovered.tabs.some(tab => tab.id === value.tab)) continue;
              if (recovered.tabs.length >= 64) {
                // Native user-close asks about unsaved page changes; never force
                // a recovered page away merely to satisfy the metadata limit.
                const closed = await this.browser.command("close", value.tab);
                this.check();
                if (closed.status !== "ok") this.setError("workbench_tab_limit");
                continue;
              }
              // An opener can create a page while React is unmounted. Recover
              // the native page as a nonselected Tab without disturbing splits.
              let url: string; try { url = browserAddress(typeof value.url === "string" ? value.url : "about:blank"); } catch { continue; }
              recovered = workbenchLayoutSchema.parse({ ...recovered, tabs: [...recovered.tabs, { id: value.tab, kind: "browser", title: typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 128) : "网页", url }], closed: recovered.closed.filter(tab => tab.id !== value.tab) });
            }
            if (recovered !== layout) { recovered = { ...recovered, revision: layout.revision + 1 }; this.check(); await this.connection.cache.saveWorkbench(this.scope, layout.revision, recovered); layout = recovered; }
          }
        }
      }
      this.check(); this.publish({ layout, boards, browser, windowId, ready: true });
      this.removeLibraryChanges = this.connection.cache.subscribeWorkbenchChanges?.(this.scope, ids => this.libraryDeleted(ids));
      this.removeDesignCommentChanges = this.connection.cache.subscribeDesignCommentChanges?.(this.scope, ids => {
        if (this.disposed || this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) return;
        for (const id of ids) void this.designSessions.get(id)?.refreshComments().catch(() => undefined);
      });
      // One unavailable item (deleted meanwhile, unreadable) reports its own error;
      // the rest of the workbench still opens. A scope loss still fails below.
      for (const tab of layout.tabs) if (tab.kind === "design" && layout.visible.includes(tab.id)) await this.ensureDesign(tab.id).catch(error => { this.check(); this.setError(errorCode(error)); });
      for (const tab of layout.tabs) if (tab.kind === "markdown" && layout.visible.includes(tab.id) && this.isVisible) await this.ensureMarkdown(tab.id).catch(error => { this.check(); this.setError(errorCode(error)); });
      this.check();
      for (const value of nativeTabs) this.browserEvent({ ...value, kind: "state", tab: String(value.tab) });
      for (const event of browserEvents) this.browserEvent(event);
      let revision = this.connection.conversationRevision(this.conversationId);
      this.removeConnection = this.connection.subscribe(() => {
        if (this.connection.state.status !== "online") for (const dispatchId of this.pending.keys()) this.cancel({ v: 1, type: "workbench.cancel", dispatchId, reason: "workbench_offline" });
        if (this.connection.isReadOnly || this.connection.isClosed || this.connection.state.user?.id !== this.userId) {
          for (const dispatchId of this.pending.keys()) this.cancel({ v: 1, type: "workbench.cancel", dispatchId, reason: "workbench_scope_unavailable" });
          this.setVisible(false);
          if (this.snapshot.browser) void this.browser.command("revoke_scope", undefined).catch(() => undefined);
          this.publish({ error: "workbench_scope_unavailable", chartVersion: this.snapshot.chartVersion + 1 });
        } else if (this.connection.conversationRevision(this.conversationId) !== revision) {
          revision = this.connection.conversationRevision(this.conversationId);
          this.publish({ chartVersion: this.snapshot.chartVersion + 1 });
        }
      });
    })().catch(error => { this.dispose(); throw error; });
  }
  setVisible(value: boolean): void {
    // A first hidden notification can arrive after initialization loaded board
    // data. It still needs cleanup even though the surface was never shown.
    if (this.visible === value && (value || !this.snapshot.ready)) return; this.visible = value;
    if (!value) for (const dispatchId of this.pending.keys()) this.cancel({ v: 1, type: "workbench.cancel", dispatchId, reason: "workbench_hidden" });
    if (!value) void this.flushBrowserMeta();
    this.publish();
    if (!this.snapshot.ready) return;
    if (value) {
      for (const id of this.snapshot.layout.visible) if (this.snapshot.layout.tabs.find(tab => tab.id === id)?.kind === "design") void this.ensureDesign(id).catch(error => this.setError(errorCode(error)));
      for (const id of this.snapshot.layout.visible) if (this.snapshot.layout.tabs.some(tab => tab.id === id && tab.kind === "markdown")) void this.ensureMarkdown(id).catch(error => this.setError(errorCode(error)));
      void Promise.all(this.snapshot.layout.visible.filter(id => this.snapshot.layout.tabs.some(tab => tab.id === id && tab.kind === "whiteboard")).map(id => this.ensureBoard(id)))
        .catch(error => this.setError(errorCode(error)));
    } else {
      this.pruneMarkdown();
      // Flush before unmounting an editor. If persistence fails, retain its
      // unsaved scene for an explicit retry instead of silently discarding it.
      void Promise.all([...this.boardControllers.values()].map(board => board.flush())).then(() => {
        if (!this.visible && !this.boardUsers.size && !this.disposed) { this.boardControllers.clear(); this.publish({ boards: this.retainedBoards() }); }
      }).catch(error => this.setError(errorCode(error)));
    }
  }
  get isVisible(): boolean { return this.visible && !this.disposed; }
  getRegistration(): WorkbenchRegistration | undefined {
    if (!this.snapshot.ready || this.disposed) return;
    const layout = this.committedChartLayout ?? this.snapshot.layout;
    return { windowId: this.snapshot.windowId, conversationId: this.conversationId, generation: this.snapshot.generation,
      capabilities: [...(this.connection.state.workbenchDesignCommentsAvailable ? ["design.comments.v1" as const] : []), ...(this.connection.state.workbenchDesignHistoryAvailable ? ["design.history.v1" as const] : []), ...(this.connection.state.workbenchSlidesAvailable ? ["design.slides.v1" as const] : []), ...(this.connection.state.workbenchDesignAvailable ? ["design.v1" as const] : []), "whiteboard.v1", "charts.v1", ...(this.connection.state.workbenchMarkdownAvailable ? ["markdown.v1" as const] : []), ...(this.snapshot.browser ? ["browser.v1" as const] : [])],
      tabs: layout.tabs.filter(tab => (tab.designFormat !== "slides" || this.connection.state.workbenchSlidesAvailable) && (tab.kind !== "markdown" || this.connection.state.workbenchMarkdownAvailable) && (tab.kind !== "design" || this.connection.state.workbenchDesignAvailable)).map(tab => ({ id: tab.id, kind: tab.kind, title: tab.title, ...(tab.designFormat && this.connection.state.workbenchSlidesAvailable ? {designFormat: tab.designFormat} : {}), ...(tab.source ? { source: tab.source } : {}), ...(tab.kind === "design" && this.designSessions.has(tab.id) ? { revision: this.designSessions.get(tab.id)!.document.revision } : {}), ...(tab.kind === "markdown" && this.snapshot.notes.has(tab.id) ? { revision: this.snapshot.notes.get(tab.id)!.revision, readOnly: this.noteSessions.get(tab.id)?.readOnly } : {}), ...(tab.kind === "whiteboard" && this.snapshot.boards.has(tab.id) ? { revision: this.snapshot.boards.get(tab.id)!.revision } : {}) })),
      ...(layout.active && (layout.tabs.find(tab => tab.id === layout.active)?.designFormat !== "slides" || this.connection.state.workbenchSlidesAvailable) && (this.connection.state.workbenchDesignAvailable || layout.tabs.find(tab => tab.id === layout.active)?.kind !== "design") && (this.connection.state.workbenchMarkdownAvailable || layout.tabs.find(tab => tab.id === layout.active)?.kind !== "markdown") ? { activeTabId: layout.active } : {}), visible: this.isVisible };
  }
  async context(): Promise<WorkbenchContext | undefined> {
    if (this.chartApplying) throw new Error("workbench_chart_updating");
    this.check(); const tab = this.snapshot.layout.tabs.find(tab => tab.id === this.snapshot.layout.active);
    if (!tab || !this.isVisible || tab.designFormat === "slides" && !this.connection.state.workbenchSlidesAvailable) return;
    let revision: number | undefined, selection: string[] | undefined;
    if (tab.kind === "whiteboard") {
      const board = await this.waitBoard(tab.id); await board.flush();
      const current = await board.read(); revision = current.document.revision; selection = [...current.selection];
    }
    if (tab.kind === "design") { if (!this.connection.state.workbenchDesignAvailable) return; try { const design = await this.ensureDesign(tab.id); await design.flush(); revision = (await design.refresh()).revision; } catch { this.setError("design_context_not_saved"); return; } }
    if (tab.kind === "markdown") { if (!this.connection.state.workbenchMarkdownAvailable) return; try { const note = await this.ensureMarkdown(tab.id); const current = await note.read(); revision = current.document.revision; }
      catch { this.setError("markdown_context_not_saved"); return; } }
    this.check();
    return { target: { deviceId: this.connection.identity.deviceId, windowId: this.snapshot.windowId, tabId: tab.id }, kind: tab.kind, title: tab.title,
      ...(revision !== undefined ? { revision } : {}), ...(selection ? { selection } : {}), ...(tab.source ? { source: structuredClone(tab.source) } : {}) };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    // Another same-origin window committed a newer layout. Adopt it so the next
    // action works, but report this conflict: a stale intent is never replayed.
    const result = this.layoutQueue.catch(() => undefined).then(operation).catch(async (error: unknown) => {
      if (errorCode(error) === "workbench_revision_conflict") await this.adoptStoredLayout().catch(() => undefined);
      throw error;
    });
    this.layoutQueue = result; return result;
  }
  private async adoptStoredLayout(): Promise<void> {
    this.check(); const old = this.snapshot.layout, stored = await this.connection.cache.readWorkbench(this.scope); this.check();
    if (!stored || stored.revision <= old.revision) return;
    // Local editors leaving view save while their Tabs still exist here.
    for (const id of old.visible) if (!stored.visible.includes(id) && !this.boardUsers.has(id)) await this.boardControllers.get(id)?.flush();
    for (const id of old.visible) if (!stored.visible.includes(id)) { await this.noteSessions.get(id)?.flush(); await this.designSessions.get(id)?.flush(); }
    for (const id of stored.visible) if (stored.tabs.find(tab => tab.id === id)?.kind === "whiteboard") await this.ensureBoard(id).catch(() => undefined);
    this.check(); if (this.snapshot.layout !== old) return;
    this.publish({ layout: stored }); this.pruneBoards(); this.pruneMarkdown();
    if (this.isVisible) for (const id of stored.visible) if (stored.tabs.find(tab => tab.id === id)?.kind === "design") void this.ensureDesign(id).catch(error => this.setError(errorCode(error)));
    if (this.isVisible) for (const id of stored.visible) if (stored.tabs.find(tab => tab.id === id)?.kind === "markdown") void this.ensureMarkdown(id).catch(() => undefined);
  }
  change(action: LayoutAction, assertActive?: () => void): Promise<void> { return this.serial(() => this.changeNow(action, assertActive)); }
  /** The device library deleted these items (in this or another window). Drop
   * every in-memory copy at once, then adopt the committed layout in order with
   * other actions. Storage CAS already refuses any stale write-back. */
  private libraryDeleted(ids: string[]): void {
    if (this.disposed) return;
    const hide = (list: string[]) => {
      const boards = new Map(this.snapshot.boards), notes = new Map(this.snapshot.notes);
      for (const id of list) { boards.delete(id); notes.delete(id); this.savedBoards.delete(id); }
      if (!this.disposed) this.publish({ boards, notes });
    };
    hide(ids);
    void this.serial(async () => {
      await this.adoptStoredLayout();
      // A load that read the content just before deletion may finish later.
      await Promise.allSettled(ids.flatMap(id => [this.noteLoading.get(id), this.designLoading.get(id)]));
      // Still referenced after adoption means it was created again meanwhile.
      const known = new Set([...this.snapshot.layout.tabs, ...this.snapshot.layout.closed].map(tab => tab.id)), gone = ids.filter(id => !known.has(id));
      for (const id of gone) {
        this.boardControllers.delete(id);
        this.noteSessions.get(id)?.dispose(); this.noteSessions.delete(id);
        rememberNoteRecovery(noteRecoveryKey(this.connection.identity.deviceId, this.scope, id), undefined);
        const design = this.designSessions.get(id); if (design) this.endDesignShare(design);
        design?.discard(); this.designSessions.delete(id);
      }
      hide(gone);
    }).catch(error => { if (!this.disposed) this.setError(errorCode(error)); });
  }
  /** User navigation from the device library to one exact stored item of this
   * scope: an open Tab is selected, a closed one reopened, and content without
   * a Tab reference (older versions) regains one by its stable ID. */
  async openLibraryFile(target: WorkbenchLibraryTarget, options: { assertActive?: () => void } = {}): Promise<"selected" | "reopened" | "restored"> {
    const { assertActive } = options;
    assertActive?.(); await this.initialize(); this.check(); assertActive?.();
    if (target.scope !== this.scope || target.conversationId !== this.conversationId) throw new Error("workbench_scope_mismatch");
    const { kind, id } = target;
    if (kind !== "whiteboard" && kind !== "markdown" && kind !== "design") throw new Error("workbench_wrong_kind");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error(`${kind}_not_found`);
    return this.serial(async () => {
      this.check(); assertActive?.();
      const open = this.snapshot.layout.tabs.find(tab => tab.id === id), closed = this.snapshot.layout.closed.find(tab => tab.id === id), tab = open ?? closed;
      if (tab && tab.kind !== kind) throw new Error("workbench_wrong_kind");
      if (!await this.connection.cache.hasWorkbenchItem(this.scope, kind, id)) throw new Error(`${kind}_not_found`);
      this.check(); assertActive?.();
      if (open) { await this.changeNow({ type: "select", id }, assertActive); return "selected"; }
      if (closed) { await this.changeNow({ type: "reopen", id }, assertActive); return "reopened"; }
      // Older layouts can lose a reference while retaining the document. The
      // stored format, not the library category/name, selects its editor.
      const document = kind === "design" ? await this.connection.cache.readWorkbenchDesign(this.scope, id) : undefined;
      this.check(); assertActive?.();
      if (kind === "design" && !document) throw new Error("design_not_found");
      const format = designFormatSchema.parse(document?.format ?? "canvas");
      const title = target.title?.trim().slice(0, 128).replace(/[\uD800-\uDBFF]$/, "") || (kind === "whiteboard" ? "白板" : kind === "markdown" ? "笔记.md" : designFormatTitle(format));
      await this.changeNow({ type: "open", tab: { id, kind, title, ...(document?.format ? { designFormat: format } : {}) } }, assertActive); return "restored";
    });
  }
  private rememberNativeTab(tab: WorkbenchTab): Promise<void> {
    return this.serial(async () => {
      this.check(); const old = this.snapshot.layout;
      if (old.tabs.some(value => value.id === tab.id)) return;
      // Record a page already created before cancellation, without opening a
      // new page or replacing the person's active tab/split selection.
      const layout = workbenchLayoutSchema.parse({ ...old, revision: old.revision + 1, tabs: [...old.tabs, tab], closed: old.closed.filter(value => value.id !== tab.id) });
      await this.connection.cache.saveWorkbench(this.scope, old.revision, layout); this.check(); this.publish({ layout });
    });
  }
  private async flushLeavingEditors(next: WorkbenchLayout, assertActive?: () => void): Promise<void> {
    for (const id of this.snapshot.layout.visible) if (!next.visible.includes(id)) {
      if (!this.boardUsers.has(id)) await this.boardControllers.get(id)?.flush();
      this.check(); assertActive?.();
      await this.noteSessions.get(id)?.flush(); this.check(); assertActive?.();
      await this.designSessions.get(id)?.flush(); this.check(); assertActive?.();
    }
  }
  private async changeNow(action: LayoutAction, assertActive?: () => void): Promise<void> {
    this.check(); assertActive?.(); const old = this.snapshot.layout, next = changeWorkbench(old, action);
    await this.flushLeavingEditors(next, assertActive);
    for (const id of next.visible) if (next.tabs.find(tab => tab.id === id)?.kind === "whiteboard") { await this.ensureBoard(id); assertActive?.(); }
    for (const id of next.visible) if (next.tabs.find(tab => tab.id === id)?.kind === "markdown") { await this.ensureMarkdown(id); assertActive?.(); }
    for (const id of next.visible) if (next.tabs.find(tab => tab.id === id)?.kind === "design") { await this.ensureDesign(id); assertActive?.(); }
    assertActive?.(); await this.connection.cache.saveWorkbench(this.scope, old.revision, next); this.check(); this.publish({ layout: next, error: undefined }); assertActive?.();
    this.pruneBoards(); this.pruneMarkdown();
  }
  async closeTab(id: string): Promise<void> {
    const tab = this.tab(id);
    if (tab.kind === "markdown") await this.noteSessions.get(id)?.flush();
    if (tab.kind === "whiteboard") await this.boardControllers.get(id)?.flush();
    if (tab.kind === "browser") {
      const receipt = await this.browser.command("close", id);
      if (receipt.status !== "ok" && receipt.error !== "tab_not_found") throw new Error(receipt.error ?? "browser_close_cancelled");
    }
    await this.serial(async () => { if (this.snapshot.layout.tabs.some(tab => tab.id === id)) await this.changeNow({ type: "close", id }); }); this.boardControllers.delete(id);
  }
  async reopen(id: string): Promise<void> {
    const tab = this.snapshot.layout.closed.find(tab => tab.id === id); if (!tab) throw new Error("workbench_tab_not_found");
    if (tab.kind === "chart") await this.source(tab.source!);
    if (tab.kind === "whiteboard") {
      const board = await this.connection.cache.readWorkbenchBoard(this.scope, id); if (!board) throw new Error("whiteboard_not_found");
      this.adoptStoredBoard(board);
    }
    if (tab.kind === "markdown" && !await this.connection.cache.readWorkbenchMarkdown(this.scope, id)) throw new Error("markdown_not_found");
    await this.change({ type: "reopen", id });
    if (tab.kind === "browser" && this.snapshot.browser) {
      const receipt = await this.browser.command("open", id, { url: tab.url ?? "about:blank" }); if (receipt.status !== "ok") throw new Error(receipt.error ?? "browser_open_failed");
    }
  }
  async forgetClosed(id: string): Promise<void> {
    await this.serial(async () => {
      const tab = this.snapshot.layout.closed.find(value => value.id === id);
      if (!tab || tab.kind === "whiteboard" || tab.kind === "markdown" || tab.kind === "design") throw new Error("workbench_tab_not_found");
      await this.changeNow({ type: "delete", id });
    });
  }
  async deleteBoard(id: string): Promise<void> {
    const tab = [...this.snapshot.layout.tabs, ...this.snapshot.layout.closed].find(tab => tab.id === id);
    if (tab?.kind !== "whiteboard") throw new Error("workbench_wrong_kind");
    await this.serial(async () => {
      this.check(); const own = this.boardControllers.get(id);
      // An editor in another window holds the board's exclusive lock: refuse,
      // never delete under it. This window's owning editor already holds that
      // lock, so it flushes and deletes without a second (waiting) request.
      if (own) {
        if (own.ownsEditor && !own.ownsEditor()) throw new Error("whiteboard_read_only");
        await own.flush(); this.check(); await this.deleteStoredBoard(id);
      } else if (!await this.withExclusiveEditorLock(workbenchEditorLock("whiteboard", this.scope, id), () => this.deleteStoredBoard(id))) throw new Error("whiteboard_read_only");
    });
  }
  private async deleteStoredBoard(id: string): Promise<void> {
    const board = await this.connection.cache.readWorkbenchBoard(this.scope, id); if (!board) throw new Error("whiteboard_not_found");
    this.check(); const old = this.snapshot.layout, layout = changeWorkbench(old, { type: "delete", id });
    await this.connection.cache.deleteWorkbenchBoardAndLayout(this.scope, id, board.revision, old.revision, layout);
    this.boardControllers.delete(id); this.savedBoards.delete(id); const boards = new Map(this.snapshot.boards); boards.delete(id); this.publish({ boards, layout });
  }
  /** Runs `work` only if no editor anywhere holds `name`; never waits. */
  private async withExclusiveEditorLock(name: string, work: () => Promise<void>): Promise<boolean> {
    // Without Web Locks no editor can prove it is not writing: fail closed.
    if (typeof navigator === "undefined" || !navigator.locks) return false;
    let ran = false;
    await navigator.locks.request(name, { ifAvailable: true }, async lock => { if (!lock) return; ran = true; await work(); });
    return ran;
  }
  private tab(id: string, kind?: WorkbenchTab["kind"]): WorkbenchTab {
    const tab = this.snapshot.layout.tabs.find(tab => tab.id === id);
    if (!tab) throw new Error("workbench_tab_closed"); if (kind && tab.kind !== kind) throw new Error("workbench_wrong_kind"); return tab;
  }
  designSession(id: string): DesignSession | undefined { return this.designSessions.get(id); }
  private ensureDesign(id: string): Promise<DesignSession> {
    const existing = this.designSessions.get(id); if (existing) return Promise.resolve(existing);
    const loading = this.designLoading.get(id); if (loading) return loading;
    const promise = (async () => {
      const document = await this.connection.cache.readWorkbenchDesign(this.scope, id); this.check();
      if (!document) throw new Error("design_not_found");
      const session = new DesignSession(document, () => this.connection.cache.readWorkbenchDesign(this.scope, id), async (expected, next, sidecar) => {
        if (this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) throw new Error("workbench_scope_unavailable");
        this.tab(id, "design"); await this.connection.cache.saveWorkbenchDesign(this.scope, expected, next, sidecar);
      }, () => { if (!this.disposed) this.publish(); }, {
        title: () => this.snapshot.layout.tabs.find(tab=>tab.id===id)?.title ?? "Design",
        user: () => ({ id: this.userId, name: this.connection.state.user?.name ?? "You" }),
        comments: {
          load: async () => { const value = await this.connection.cache.readWorkbenchDesignMeta(this.scope,id,"comments"); return value === undefined ? undefined : parseDesignComments(value); },
          save: async (expected,next) => { this.check(); this.tab(id,"design"); await this.connection.cache.saveWorkbenchDesignMeta(this.scope,id,"comments",expected,next); },
        },
        history: {
          load: async () => { const value = await this.connection.cache.readWorkbenchDesignMeta(this.scope,id,"history"); return value === undefined ? undefined : designHistorySchema.parse(value); },
          object: sha => this.connection.cache.readWorkbenchDesignObject(this.scope,id,sha),
        },
        sendToBot: async draft => { this.check(); this.tab(id,"design"); if (!this.isVisible || !this.snapshot.layout.visible.includes(id) || !navigator.userActivation?.isActive) return "declined"; return this.designComposer?.(draft) ?? "declined"; },
      });
      // Its editor frame must hold this shared lock before it can write.
      designEditorLocks.set(session, workbenchEditorLock("design", this.scope, id));
      this.designSessions.set(id, session); this.publish(); return session;
    })();
    this.designLoading.set(id, promise); void promise.finally(() => this.designLoading.delete(id)).catch(() => undefined); return promise;
  }
  async createDesign(title = "画布", requestId?: string, assertActive?: () => void, imported?: DesignDocument, format: DesignFormat = "canvas", importedBackup?: DesignBackupContent): Promise<string> {
    await this.initialize(); this.check(); assertActive?.(); const id = stableId("design", requestId);
    await this.serial(async () => {
      this.check(); assertActive?.(); const existing = await this.connection.cache.readWorkbenchDesign(this.scope, id); this.check(); assertActive?.();
      if (existing) { await this.changeNow({ type: "open", tab: { id, kind: "design", title, ...(existing.format ? {designFormat: designFormatSchema.parse(existing.format)} : {}) } }, assertActive); return; }
      const document = imported ? validateDesignDocument({ ...imported, id, revision: 0, receipts: [] }) : emptyDesignDocument(id, title, format);
      const old = this.snapshot.layout, layout = changeWorkbench(old, { type: "open", tab: { id, kind: "design", title, ...(document.format ? {designFormat: designFormatSchema.parse(document.format)} : {}) } });
      await this.flushLeavingEditors(layout, assertActive); this.check(); assertActive?.();
      await this.connection.cache.createWorkbenchDesignAndLayout(this.scope, document, old.revision, layout, importedBackup);
      this.check(); this.publish({ layout }); assertActive?.(); await this.ensureDesign(id);
    });
    return id;
  }
  async exportDesign(id:string,title:string):Promise<string> {
    this.check();this.tab(id,"design");await (await this.ensureDesign(id)).flush();this.check();
    const backup=await this.connection.cache.readWorkbenchDesignBackup(this.scope,id,title);this.check();
    return serializeDesignBackup(backup);
  }
  async importDesign(file: File): Promise<string> {
    if (!file.name.endsWith(".tarobot-design.json") || file.size > DESIGN_BACKUP_MAX_BYTES) throw new Error("design_invalid_import");
    const value=parseDesignBackup(await file.text(),stableId("import"));this.check();
    return this.createDesign(value.title,undefined,undefined,value.document,designFormatSchema.parse(value.document.format??"canvas"),value);
  }
  async deleteDesign(id: string): Promise<void> {
    await this.serial(async () => {
      this.check(); const tab = [...this.snapshot.layout.tabs, ...this.snapshot.layout.closed].find(tab => tab.id === id && tab.kind === "design");
      if (!tab) throw new Error("design_not_found");
      const session = this.designSessions.get(id);
      await session?.flush(); this.check();
      // Design editors share their lock. Pause this window's own lease (its editor
      // is held inert) so that only another window's editor can refuse; restore
      // it if the deletion does not happen.
      const resume = await session?.suspendEditor();
      let deleted = false;
      try {
        deleted = await this.withExclusiveEditorLock(workbenchEditorLock("design", this.scope, id), async () => {
          const document = await this.connection.cache.readWorkbenchDesign(this.scope, id); if (!document) throw new Error("design_not_found");
          this.check(); const old = this.snapshot.layout, layout = changeWorkbench(old, { type: "delete", id });
          await this.connection.cache.deleteWorkbenchDesignAndLayout(this.scope, id, document.revision, old.revision, layout);
          const design = this.designSessions.get(id); if (design) this.endDesignShare(design);
          design?.discard(); this.designSessions.delete(id); this.publish({ layout });
        });
      } finally { if (!deleted) await resume?.(); }
      if (!deleted) throw new Error("design_in_use");
    });
  }
  async createBoard(title = "白板", requestId?: string, assertActive?: () => void): Promise<string> {
    assertActive?.(); await this.initialize(); this.check(); assertActive?.(); const id = stableId("board", requestId);
    await this.serial(async () => {
      this.check(); assertActive?.();
      const existing = await this.connection.cache.readWorkbenchBoard(this.scope, id); assertActive?.();
      // A replayed request reopens its own board; a new board is written with its Tab.
      if (existing) { this.adoptStoredBoard(existing); await this.changeNow({ type: "open", tab: { id, kind: "whiteboard", title } }, assertActive); }
      else await this.openNewBoard(emptyBoard(id), title, assertActive);
    });
    return id;
  }
  async importBoard(content: BoardImport): Promise<void> {
    await this.initialize(); this.check();
    const id = stableId("board"), document = boardDocumentSchema.parse({ ...emptyBoard(id), scene: content.scene, files: content.files });
    // A rejected import never replaces the scene in the original Tab.
    await this.serial(() => this.openNewBoard(document, content.title));
  }
  /** Board bytes and the open Tab commit in one transaction (never an orphan board). */
  private async openNewBoard(document: BoardDocument, title: string, assertActive?: () => void): Promise<void> {
    this.check(); assertActive?.(); const old = this.snapshot.layout, layout = changeWorkbench(old, { type: "open", tab: { id: document.id, kind: "whiteboard", title } });
    await this.flushLeavingEditors(layout, assertActive);
    await this.connection.cache.createWorkbenchBoardAndLayout(this.scope, document, old.revision, layout);
    this.check(); this.savedBoards.set(document.id, document.revision); this.boardDocument(document); this.publish({ layout, error: undefined }); assertActive?.();
    this.pruneBoards(); this.pruneMarkdown();
  }
  async createMarkdown(title = "笔记.md", content = "", requestId?: string, assertActive?: () => void): Promise<string> {
    await this.initialize(); assertActive?.(); this.check();
    const input = markdownCreateSchema.parse({ title, content }), id = stableId("note", requestId), origin = fingerprint(input);
    await this.serial(async () => {
      this.check(); assertActive?.(); const old = this.snapshot.layout;
      const existing = await this.connection.cache.readWorkbenchMarkdown(this.scope, id); assertActive?.();
      if (existing && existing.origin !== origin) throw new Error("markdown_request_conflict");
      const document = existing ?? emptyMarkdown(id, input.content ?? "", origin);
      const layout = changeWorkbench(old, { type: "open", tab: { id, kind: "markdown", title: input.title ?? "笔记.md" } });
      await this.flushLeavingEditors(layout, assertActive);
      if (existing) await this.connection.cache.saveWorkbench(this.scope, old.revision, layout);
      else await this.connection.cache.createWorkbenchMarkdownAndLayout(this.scope, document, old.revision, layout);
      this.check(); this.markdownDocument(document); this.publish({ layout }); assertActive?.(); this.pruneBoards();
    });
    await this.ensureMarkdown(id); this.pruneMarkdown(); return id;
  }
  async importMarkdown(file: File): Promise<string> {
    const { WORKBENCH_MARKDOWN_BYTES } = await import("../../src/client-protocol/workbench.js");
    if (!/\.(md|markdown|txt)$/i.test(file.name)) throw new Error("markdown_invalid_file");
    if (file.size > WORKBENCH_MARKDOWN_BYTES) throw new Error("markdown_too_large");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer()); } catch { throw new Error("markdown_invalid_encoding"); }
    return this.createMarkdown(file.name.slice(0, 128).replace(/[\uD800-\uDBFF]$/, ""), content);
  }
  markdownSession(id: string): MarkdownSession | undefined { return this.noteSessions.get(id); }
  private markdownDocument = (document: MarkdownDocument): void => {
    const notes = new Map(this.snapshot.notes); notes.set(document.id, document); this.publish({ notes });
  };
  private ensureMarkdown(id: string): Promise<MarkdownSession> {
    const existing = this.noteSessions.get(id); if (existing) return Promise.resolve(existing);
    const loading = this.noteLoading.get(id); if (loading) return loading;
    const promise = (async () => {
      const document = await this.connection.cache.readWorkbenchMarkdown(this.scope, id); this.check();
      if (!document) throw new Error("markdown_not_found");
      const session = new MarkdownSession(document, async (expected, next) => {
        if (this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) throw new Error("workbench_scope_unavailable");
        this.tab(id, "markdown"); await this.connection.cache.saveWorkbenchMarkdown(this.scope, expected, next);
      }, next => { if (!this.disposed) this.markdownDocument(next); }, () => this.connection.cache.readWorkbenchMarkdown(this.scope, id));
      await session.acquire(workbenchEditorLock("markdown", this.scope, id));
      if (this.disposed) { session.dispose(); throw new Error("workbench_scope_unavailable"); }
      const recoveryKey = noteRecoveryKey(this.connection.identity.deviceId, this.scope, id), recovery = readNoteRecovery(recoveryKey);
      if (recovery) { session.restoreDraft(recovery.content, recovery.revision); if (!session.dirty()) rememberNoteRecovery(recoveryKey, undefined); }
      session.subscribe(() => { if (!session.dirty()) rememberNoteRecovery(recoveryKey, undefined); });
      this.noteSessions.set(id, session); this.markdownDocument(session.document);
      // Hiding may have pruned the cache before this read/lock acquisition
      // finished. Release the late owner too; active Bot users stay pinned.
      if (!this.isVisible) this.pruneMarkdown();
      return session;
    })();
    this.noteLoading.set(id, promise); void promise.finally(() => { this.noteLoading.delete(id); }).catch(() => undefined); return promise;
  }
  private pruneMarkdown(): void {
    for (const [id, session] of this.noteSessions) {
      if (!this.disposed && (this.isVisible && this.snapshot.layout.visible.includes(id) || this.noteUsers.has(id))) continue;
      void session.flush().then(() => {
        if (!this.disposed && (this.isVisible && this.snapshot.layout.visible.includes(id) || this.noteUsers.has(id))) return;
        if (session.dirty() || this.noteSessions.get(id) !== session) return;
        session.dispose(); this.noteSessions.delete(id);
        const notes = new Map(this.snapshot.notes); notes.delete(id); if (!this.disposed) this.publish({ notes });
      }).catch(error => { if (!this.disposed) this.setError(errorCode(error)); });
    }
  }
  async deleteMarkdown(id: string): Promise<void> {
    await this.serial(async () => {
      this.check(); const tab = [...this.snapshot.layout.tabs, ...this.snapshot.layout.closed].find(tab => tab.id === id);
      if (tab?.kind !== "markdown") throw new Error("workbench_wrong_kind");
      const session = await this.ensureMarkdown(id); await session.flush(); this.check();
      if (session.dirty()) throw new Error("markdown_revision_conflict");
      if (session.readOnly) throw new Error("markdown_read_only");
      const note = await this.connection.cache.readWorkbenchMarkdown(this.scope, id); if (!note) throw new Error("markdown_not_found");
      const old = this.snapshot.layout, layout = changeWorkbench(old, { type: "delete", id });
      await this.connection.cache.deleteWorkbenchMarkdownAndLayout(this.scope, id, note.revision, old.revision, layout);
      session?.dispose(); this.noteSessions.delete(id); const notes = new Map(this.snapshot.notes); notes.delete(id); this.publish({ notes, layout });
    });
  }
  async openChart(source: WorkbenchSource, title?: string, requestId?: string, assertActive?: () => void): Promise<string> {
    assertActive?.(); await this.initialize(); assertActive?.(); const message = await this.source(source), block = message.blocks[source.blockIndex]; assertActive?.();
    const widget = readWidget(block);
    const existing = requestId ? undefined : this.snapshot.layout.tabs.find(tab => tab.kind === "chart" && JSON.stringify(tab.source) === JSON.stringify(source));
    const id = existing?.id ?? stableId("chart", requestId);
    await this.change({ type: "open", tab: { id, kind: "chart", title: title ?? widget?.title ?? "图表", source: structuredClone(source) } }, assertActive); return id;
  }
  async source(input: WorkbenchSource): Promise<Message> {
    this.check(); const source = workbenchSourceSchema.parse(input);
    const [message, conversation] = await Promise.all([this.connection.cache.workbenchSourceMessage(source.messageId), this.connection.cache.conversation(this.conversationId)]);
    this.check();
    if (!conversation || !message || message.conversationId !== this.conversationId || message.status === "deleted" || message.version !== source.version || !message.blocks[source.blockIndex]) throw new Error("workbench_source_unavailable");
    const block = message.blocks[source.blockIndex]; if (!readWidget(block) && !readReport(block)) throw new Error("workbench_source_unavailable"); return message;
  }
  async openBrowser(input = "about:blank", requestId?: string): Promise<string> {
    await this.initialize(); if (!this.snapshot.browser) throw new Error("workbench_browser_requires_desktop");
    const id = stableId("web", requestId ? `${this.scope}:${requestId}` : undefined), url = browserAddress(input);
    await this.change({ type: "open", tab: { id, kind: "browser", title: "网页", url } });
    const receipt = await this.browser.command("open", id, { url }, requestId);
    if (receipt.status !== "ok") throw new Error(receipt.error ?? "browser_open_failed"); scheduleBrowserLayout(); return id;
  }
  /** The stored revision of a loaded board, for a new editor of a retained document. */
  boardSavedRevision(id: string): number | undefined { return this.savedBoards.get(id); }
  private boardUnsaved(id: string): boolean { const saved = this.savedBoards.get(id), document = this.snapshot.boards.get(id); return saved !== undefined && !!document && document.revision !== saved; }
  /** Loaded boards that must stay in memory: retained unsaved edits only. */
  private retainedBoards(): Map<string, BoardDocument> {
    const boards = new Map([...this.snapshot.boards].filter(([id]) => this.boardUnsaved(id)));
    for (const id of this.savedBoards.keys()) if (!boards.has(id)) this.savedBoards.delete(id);
    return boards;
  }
  /** Shows a stored board, except over a retained unsaved edit (its editor saves
   * it against the stored revision, CAS) or a newer copy already in memory. */
  private adoptStoredBoard(board: BoardDocument): void {
    const loaded = this.snapshot.boards.get(board.id);
    if (loaded && (this.boardUnsaved(board.id) || loaded.revision >= board.revision)) return;
    this.savedBoards.set(board.id, board.revision); this.boardDocument(board);
  }
  boardDocument = (document: BoardDocument): void => {
    const boards = new Map(this.snapshot.boards); boards.set(document.id, document); this.publish({ boards });
  };
  bindBoard(id: string, controller: BoardController | null): void {
    if (controller) this.boardControllers.set(id, controller); else this.boardControllers.delete(id);
  }
  async persistBoard(expectedRevision: number, document: BoardDocument): Promise<void> {
    // Editor retirement may finish a captured local autosave after React has
    // unmounted this controller. Keep the original identity/reset fences while
    // permitting that final write; no Bot command can pass check() after dispose.
    if (this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) throw new Error("workbench_scope_unavailable");
    this.tab(document.id, "whiteboard"); await this.connection.cache.saveWorkbenchBoard(this.scope, expectedRevision, document);
    this.savedBoards.set(document.id, document.revision); if (!this.disposed) this.boardDocument(document);
  }
  private async waitBoard(id: string, signal?: AbortSignal): Promise<BoardController> {
    this.tab(id, "whiteboard"); await this.ensureBoard(id); const deadline = Date.now() + 10_000;
    while (!this.boardControllers.has(id)) {
      this.check(); this.tab(id, "whiteboard"); if (signal?.aborted) throw new Error("workbench_cancelled");
      if (Date.now() >= deadline) throw new Error("whiteboard_not_ready"); await new Promise(resolve => setTimeout(resolve, 30));
    }
    return this.boardControllers.get(id)!;
  }
  private async ensureBoard(id: string): Promise<void> {
    if (this.snapshot.boards.has(id)) return;
    const board = await this.connection.cache.readWorkbenchBoard(this.scope, id);
    this.check(); if (!board) throw new Error("whiteboard_not_found"); this.savedBoards.set(id, board.revision); this.boardDocument(board);
  }
  private pruneBoards(): void {
    const keep = new Set([...this.snapshot.layout.visible, ...this.boardUsers.keys()]);
    const boards = new Map(this.snapshot.boards);
    for (const id of boards.keys()) if (!keep.has(id) && !this.boardUnsaved(id)) { boards.delete(id); this.boardControllers.delete(id); this.savedBoards.delete(id); }
    if (boards.size !== this.snapshot.boards.size) this.publish({ boards });
  }
  async openImage(file: File, options: { attachmentId?: string; tabId?: string } = {}): Promise<BoardResult> {
    const id = options.tabId ?? (this.snapshot.layout.tabs.find(tab => tab.id === this.snapshot.layout.active)?.kind === "whiteboard" ? this.snapshot.layout.active! : await this.createBoard());
    this.tab(id, "whiteboard"); await this.change({ type: "select", id });
    const board = await this.waitBoard(id), current = await board.read();
    return board.insertImage({ requestId: crypto.randomUUID(), expectedRevision: current.document.revision, file, attachmentId: options.attachmentId });
  }
  markChartRendered(id: string, source: WorkbenchSource): void { this.chartRenders.set(id, JSON.stringify(source)); }
  markChartFailed(id: string, source: WorkbenchSource): void { this.chartRenders.set(id, `failed:${JSON.stringify(source)}`); }
  private async updateChart(id: string, source: WorkbenchSource, previous: WorkbenchSource, signal: AbortSignal, check: () => void): Promise<void> {
    await this.serial(async () => {
      check(); const old = this.snapshot.layout, current = this.tab(id, "chart");
      if (JSON.stringify(current.source) === JSON.stringify(source)) return;
      const candidate = changeWorkbench(old, { type: "chart", id, source, previous });
      this.chartApplying = true; this.committedChartLayout = old; this.chartRenders.delete(id); this.publish({ layout: candidate });
      try {
        await this.waitChart(id, source, signal); await this.source(source); check();
        await this.connection.cache.saveWorkbench(this.scope, old.revision, candidate); this.publish({ layout: candidate });
      } catch (error) {
        // All layout writers share this queue. Roll back only our staged view;
        // never replace a newer committed layout from another operation.
        if (this.snapshot.layout === candidate) { this.publish({ layout: old }); throw new ChartRenderRejected(errorCode(error)); }
        throw error;
      } finally { this.chartApplying = false; this.committedChartLayout = undefined; this.publish(); }
    });
  }
  private async waitChart(id: string, source: WorkbenchSource, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.chartRenders.get(id) !== JSON.stringify(source)) {
      this.check(); this.tab(id, "chart"); if (this.chartRenders.get(id) === `failed:${JSON.stringify(source)}`) throw new Error("chart_render_failed"); if (signal.aborted) throw new Error("workbench_cancelled");
      if (Date.now() >= deadline) throw new Error("chart_not_ready"); await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
  /** A page that changes its title (counters, badges, timers) or URL in bursts
   * must not rewrite the layout on every event. A new address is saved at once
   * (bursts coalesce within 250 ms); a title-only change waits up to 5 s. Hiding
   * and disposal save whatever is still pending. */
  private queueBrowserMeta(id: string, url: string, title: string | undefined): void {
    const tab = this.snapshot.layout.tabs.find(value => value.id === id && value.kind === "browser"); if (!tab) return;
    const pending = this.browserMeta.get(id), nextTitle = title?.trim().slice(0, 128) || undefined;
    const navigated = url !== tab.url || !!pending?.navigated;
    if (!pending && url === tab.url && (!nextTitle || nextTitle === tab.title)) return;
    this.browserMeta.set(id, { url, title: nextTitle ?? pending?.title, navigated });
    const wait = navigated ? Math.max(0, 250 - (Date.now() - this.browserMetaWritten)) : 5000;
    if (Date.now() + wait >= this.browserMetaDue) return;
    clearTimeout(this.browserMetaTimer); this.browserMetaDue = Date.now() + wait;
    this.browserMetaTimer = setTimeout(() => void this.flushBrowserMeta(), wait);
  }
  private flushBrowserMeta(): Promise<void> {
    clearTimeout(this.browserMetaTimer); this.browserMetaTimer = undefined; this.browserMetaDue = Infinity;
    if (!this.browserMeta.size) return Promise.resolve();
    const entries = [...this.browserMeta]; this.browserMeta.clear(); this.browserMetaWritten = Date.now();
    return this.serial(async () => {
      for (const [id, meta] of entries) {
        const old = this.snapshot.layout, tab = old.tabs.find(value => value.id === id && value.kind === "browser");
        if (!tab || tab.url === meta.url && (!meta.title || tab.title === meta.title)) continue;
        const action = { type: "browser" as const, id, url: meta.url, title: meta.title };
        // Decided when the write runs: a hide queued just before disposal still saves.
        if (!this.disposed) { await this.changeNow(action); continue; }
        // Disposal: same identity fences and CAS as a final editor save, no publish.
        if (this.connection.isClosed || this.connection.isReadOnly || this.connection.state.user?.id !== this.userId) return;
        const next = changeWorkbench(old, action); await this.connection.cache.saveWorkbench(this.scope, old.revision, next);
        this.snapshot = { ...this.snapshot, layout: next };
      }
    }).catch(error => { if (!this.disposed) this.setError(errorCode(error)); });
  }
  private browserEvent(event: BrowserEvent): void {
    if (this.disposed || !event.tab || !this.snapshot.ready) return;
    if (event.kind === "opened" && !this.snapshot.layout.tabs.some(tab => tab.id === event.tab) && typeof event.opener === "string" && this.snapshot.layout.tabs.some(tab => tab.id === event.opener && tab.kind === "browser")) {
      void this.change({ type: "open", tab: { id: event.tab, kind: "browser", title: "网页", url: typeof event.url === "string" ? event.url : "about:blank" } }).catch(error => this.setError(errorCode(error))); return;
    }
    const tab = this.snapshot.layout.tabs.find(tab => tab.id === event.tab && tab.kind === "browser"); if (!tab) return;
    const previous = this.snapshot.browserTabs.get(tab.id), state: BrowserTabState = { ...previous, tab: tab.id };
    if (event.kind === "state") {
      for (const name of ["url", "title"] as const) if (typeof event[name] === "string") state[name] = event[name];
      for (const name of ["loading", "canGoBack", "canGoForward"] as const) if (typeof event[name] === "boolean") state[name] = event[name];
      if (typeof event.navigation === "number") state.navigation = event.navigation;
      if (typeof event.zoomFactor === "number" && Number.isFinite(event.zoomFactor)) state.zoomFactor = event.zoomFactor;
      if (event.devicePreview) state.devicePreview = readBrowserDevicePreview(event.devicePreview);
      if (typeof event.state === "string") state.sleeping = event.state === "sleeping";
      if (typeof event.control === "string") state.takeover = event.control === "user";
      if (event.responsive === true || event.crashed === false && (event.loading === false || typeof event.navigation === "number" && event.navigation !== previous?.navigation)) { state.error = undefined; state.notice = undefined; }
      if (state.url) this.queueBrowserMeta(tab.id, state.url, state.title);
    } else if (event.kind === "control") state.takeover = event.control === "user";
    else if (event.kind === "fullscreen") state.fullscreen = event.enabled === true;
    else if (event.kind === "popup") state.popup = event.state === "opened";
    else if (event.kind === "tab-request" && typeof event.url === "string") state.requestedUrl = event.url.slice(0, 8192);
    else if (event.kind === "activity") state.activity = event.bot ? String(event.current ?? "pending") : undefined;
    else if (event.kind === "gone") state.error = String(event.reason ?? "page_unavailable");
    else if (event.kind === "blocked" && event.what === "navigation") state.notice = String(event.reason ?? "unsupported_scheme");
    else if (event.kind === "closed") { void this.serial(async () => { if (this.snapshot.layout.tabs.some(value => value.id === tab.id)) await this.changeNow({ type: "close", id: tab.id }); }).catch(error => this.setError(errorCode(error))); return; }
    const browserTabs = new Map(this.snapshot.browserTabs); browserTabs.set(tab.id, state); this.publish({ browserTabs });
  }
  cancel(frame: WorkbenchCancelFrame): void {
    const abort = this.pending.get(frame.dispatchId), target = this.pendingTargets.get(frame.dispatchId);
    if (!abort || !target) return;
    abort.abort();
    if (target.browser && target.tabId) void this.browser.command("cancel", target.tabId, { targetRequestId: target.requestId }).then(result => { if (result.status !== "ok" && !this.disposed) this.setError(result.error ?? "browser_cancel_failed"); }, error => { if (!this.disposed) this.setError(errorCode(error)); });
  }
  handleCommand(frame: WorkbenchCommandFrame): Promise<WorkbenchReceipt> {
    const hash = fingerprint([frame.request, frame.target]), old = this.receipts.get(frame.request.requestId);
    if (old) return old.fingerprint === hash ? old.promise : Promise.resolve({ requestId: frame.request.requestId, target: frame.target, status: "conflict", error: "workbench_request_conflict" });
    const promise = this.execute(frame); this.receipts.set(frame.request.requestId, { fingerprint: hash, promise });
    if (this.receipts.size > 256) this.receipts.delete(this.receipts.keys().next().value!); return promise;
  }
  private async execute(frame: WorkbenchCommandFrame): Promise<WorkbenchReceipt> {
    const { request, target } = frame, base = { requestId: request.requestId, target }, abort = new AbortController();
    this.pending.set(frame.dispatchId, abort); let dispatched = false;
    this.pendingTargets.set(frame.dispatchId, { tabId: target.tabId, requestId: request.requestId, browser: request.operation === "browser" });
    const noteTarget = target.tabId && this.snapshot.layout.tabs.some(tab => tab.id === target.tabId && tab.kind === "markdown") ? target.tabId : undefined;
    if (noteTarget) this.noteUsers.set(noteTarget, (this.noteUsers.get(noteTarget) ?? 0) + 1);
    const boardTarget = target.tabId && this.snapshot.layout.tabs.some(tab => tab.id === target.tabId && tab.kind === "whiteboard") ? target.tabId : undefined;
    if (boardTarget) this.boardUsers.set(boardTarget, (this.boardUsers.get(boardTarget) ?? 0) + 1);
    const deadline = setTimeout(() => abort.abort(), Math.max(0, frame.deadline - Date.now()));
    const check = () => {
      this.check();
      if (abort.signal.aborted || Date.now() >= frame.deadline) throw new Error("workbench_cancelled");
      if (frame.userId !== this.userId || frame.conversationId !== this.conversationId || frame.generation !== this.snapshot.generation || target.windowId !== this.snapshot.windowId || target.deviceId !== this.connection.identity.deviceId) throw new Error("workbench_target_mismatch");
      if (this.connection.state.status !== "online") throw new Error("workbench_offline");
      if (!this.isVisible && request.operation !== "tabs.list") throw new Error("workbench_hidden");
      if (target.tabId) this.tab(target.tabId);
    };
    try {
      await this.initialize(); check();
      const payload = request.payload === undefined ? {} : record(request.payload);
      let board: BoardController | undefined;
      let image: File | undefined, browserAction: PreparedBrowserAction | undefined;
      if (["whiteboard.read", "whiteboard.patch", "whiteboard.undo", "whiteboard.redo", "image.insert"].includes(request.operation)) {
        if (!target.tabId) throw new Error("workbench_target_required"); board = await this.waitBoard(target.tabId, abort.signal);
      }
      if (request.operation === "image.insert") {
        if (typeof payload.attachmentId !== "string") throw new Error("invalid_image_attachment");
        const blob = await this.connection.blob(payload.attachmentId, { signal: abort.signal }); check();
        if (!blob.type.startsWith("image/") || blob.size > 16 * 1024 * 1024) throw new Error("invalid_image_attachment");
        image = new File([blob], "edited-image", { type: blob.type });
      }
      if (request.operation === "browser") browserAction = await this.browser.prepare(payload, request.requestId, abort.signal);
      check();
      const admission = await this.connection.http<{ admitted: boolean; generation: string; target: typeof target }>("/api/workbench/admit", { method: "POST", body: JSON.stringify({ dispatchId: frame.dispatchId }), signal: abort.signal });
      check(); if (!admission.admitted || admission.generation !== frame.generation || JSON.stringify(admission.target) !== JSON.stringify(target)) throw new Error("workbench_admission_changed");
      if (request.operation === "tabs.list") return { ...base, status: "success", result: json(this.getRegistration()) };
      if (request.operation === "design.create") {
        const input = designCreateSchema.parse(payload); dispatched = true;
        const tabId = await this.createDesign(input.title ?? designFormatTitle(input.format ?? "canvas"), request.requestId, check, undefined, input.format); check();
        return { ...base, status: "applied", saved: true, revision: this.designSessions.get(tabId)?.document.revision ?? 0, result: { tabId } };
      }
      if (request.operation.startsWith("design.")) {
        if (!target.tabId) throw new Error("workbench_target_required"); this.tab(target.tabId, "design");
        const session = await this.ensureDesign(target.tabId); check();
        if (request.operation === "design.read") { const value = await session.read(payload); check(); return workbenchReceiptSchema.parse({ ...base, status: "success", ...value }); }
        if (["design.comments.read","design.history.list","design.history.diff"].includes(request.operation)) {
          const value = request.operation === "design.comments.read" ? await session.commentsRead(payload) : request.operation === "design.history.list" ? await session.historyList(payload) : await session.historyDiff(payload); check();
          return workbenchReceiptSchema.parse({...base,status:"success",...value});
        }
        if (["design.comments.reply","design.comments.resolve"].includes(request.operation)) {
          const value = request.operation === "design.comments.reply" ? await session.commentsReply(request.requestId,payload,frame.actor,check) : await session.commentsResolve(request.requestId,payload,frame.actor,check);
          dispatched=true; check(); return workbenchReceiptSchema.parse({...base,status:"applied",saved:true,...value});
        }
        if (request.expectedRevision === undefined) throw new Error("workbench_revision_required");
        if (request.operation === "design.restore") {
          const result = await session.restore(request.requestId,request.expectedRevision,payload,frame.actor,check);dispatched=true;check();
          return {...base,status:"applied",saved:true,revision:result.revision,result:{editorReloadRequested:result.rendered,restoredFrom:result.restoredFrom,changed:result.changed}};
        }
        // The session validates CAS before saving; definite rejection stays a conflict.
        const result = await session.publish(request.requestId, request.expectedRevision, payload, check, frame.actor); dispatched = true; check();
        return { ...base, status: "applied", saved: true, revision: result.revision, result: { editorReloadRequested: result.rendered } };
      }
      if (request.operation === "markdown.create") {
        const input = markdownCreateSchema.parse(payload); dispatched = true;
        const tabId = await this.createMarkdown(input.title, input.content, request.requestId, check); check();
        return { ...base, status: "applied", saved: true, revision: this.snapshot.notes.get(tabId)?.revision ?? 0, result: { tabId } };
      }
      if (request.operation.startsWith("markdown.")) {
        if (!target.tabId) throw new Error("workbench_target_required"); this.tab(target.tabId, "markdown");
        const note = await this.ensureMarkdown(target.tabId); check();
        if (request.operation === "markdown.read") {
          const { offset = 0, limit = 16000 } = markdownReadSchema.parse(payload), value = await note.read(); check();
          return workbenchReceiptSchema.parse({ ...base, status: "success", revision: value.document.revision, result: { tabId: target.tabId, ...readMarkdown(value.document.content, offset, limit), readOnly: value.readOnly } });
        }
        if (request.expectedRevision === undefined) throw new Error("workbench_revision_required");
        const input = { requestId: request.requestId, expectedRevision: request.expectedRevision, assertActive: check }; let result: BoardResult;
        dispatched = true;
        if (request.operation === "markdown.replace") result = await note.replace(input, payload);
        else if (request.operation === "markdown.patch") result = await note.patch(input, payload);
        else if (request.operation === "markdown.undo") result = await note.undo(input);
        else if (request.operation === "markdown.redo") result = await note.redo(input);
        else throw new Error("invalid_markdown_operation");
        return workbenchReceiptSchema.parse({ ...base, ...result });
      }
      if (request.operation === "whiteboard.read") {
        const value = await board!.read(); check();
        const offset = payload.offset ?? 0, limit = payload.limit ?? 100;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 200) throw new Error("invalid_whiteboard_page");
        const elements = value.document.scene.elements.slice(Number(offset), Number(offset) + Number(limit));
        const metadata = { tabId: target.tabId, revision: value.document.revision, selection: value.selection, readOnly: value.readOnly, totalElements: value.document.scene.elements.length,
          images: value.document.scene.elements.filter(element => element.type === "image").map(element => ({ id: element.id, fileId: element.fileId, attachmentId: element.customData && typeof element.customData === "object" && !Array.isArray(element.customData) ? element.customData.attachmentId : undefined })) };
        while (elements.length && new TextEncoder().encode(JSON.stringify({ ...metadata, scene: { appState: value.document.scene.appState, elements } })).length > 450 * 1024) elements.pop();
        if (!elements.length && Number(offset) < value.document.scene.elements.length) throw new Error("whiteboard_element_too_large");
        const nextOffset = Number(offset) + elements.length < value.document.scene.elements.length ? Number(offset) + elements.length : undefined;
        return workbenchReceiptSchema.parse({ ...base, status: "success", revision: value.document.revision, result: json({ ...metadata, scene: { appState: value.document.scene.appState, elements }, nextOffset }) });
      }
      if (request.operation === "whiteboard.create") {
        dispatched = true; const tabId = await this.createBoard(typeof payload.title === "string" ? payload.title : "白板", request.requestId, check);
        const mounted = await this.waitBoard(tabId, abort.signal), current = await mounted.read(); check();
        return { ...base, status: "applied", saved: true, revision: current.document.revision, result: { tabId } };
      }
      if (request.operation === "whiteboard.patch" || request.operation === "whiteboard.undo" || request.operation === "whiteboard.redo" || request.operation === "image.insert") {
        if (request.expectedRevision === undefined) throw new Error("workbench_revision_required");
        let result: BoardResult;
        const input = { requestId: request.requestId, expectedRevision: request.expectedRevision, assertActive: check };
        if (request.operation === "image.insert") {
          dispatched = true; result = await board!.insertImage({ ...input, file: image!, attachmentId: payload.attachmentId as string, ...(typeof payload.originalElementId === "string" ? { originalElementId: payload.originalElementId } : {}), replace: payload.replace === true });
        } else if (request.operation === "whiteboard.patch") {
          if (!Array.isArray(payload.ops)) throw new Error("invalid_whiteboard_patch");
          dispatched = true; result = await board!.apply({ ...input, ops: payload.ops as Parameters<BoardController["apply"]>[0]["ops"] });
        } else { dispatched = true; result = await board![request.operation === "whiteboard.undo" ? "undo" : "redo"](input); }
        return workbenchReceiptSchema.parse({ ...base, ...result });
      }
      if (request.operation === "chart.open" || request.operation === "chart.update") {
        const source = workbenchSourceSchema.parse(payload.source); await this.source(source); check();
        let tabId: string;
        if (request.operation === "chart.open") { dispatched = true; tabId = await this.openChart(source, typeof payload.title === "string" ? payload.title : undefined, request.requestId, check); }
        else {
          if (!target.tabId) throw new Error("workbench_target_required"); tabId = target.tabId;
          const tab = this.tab(tabId, "chart"), previous = workbenchSourceSchema.parse(payload.previousSource);
          if (JSON.stringify(tab.source) !== JSON.stringify(source) && JSON.stringify(tab.source) !== JSON.stringify(previous)) throw new Error("workbench_source_conflict");
          await this.change({ type: "select", id: tabId }, check);
          dispatched = true; await this.updateChart(tabId, source, previous, abort.signal, check);
        }
        await this.waitChart(tabId, source, abort.signal); check(); return { ...base, status: "applied", saved: true, result: { tabId, source } };
      }
      if (request.operation === "browser") {
        if (!this.snapshot.browser) throw new Error("workbench_browser_requires_desktop");
        const parsed = browserPayload(payload); let tabId = target.tabId;
        if (parsed.action === "open") {
          if (typeof parsed.fields.url !== "string") throw new Error("invalid_browser_url");
          tabId = stableId("web", `${this.scope}:${request.requestId}`);
          browserAddress(parsed.fields.url); // Reject unsafe schemes before native dispatch.
          this.pendingTargets.set(frame.dispatchId, { tabId, requestId: request.requestId, browser: true });
        } else if (tabId) this.tab(tabId, "browser");
        check(); dispatched = true;
        const receipt = await this.browser.execute(tabId, browserAction!, request.requestId, abort.signal); scheduleBrowserLayout();
        // Native preflight rejection must not leave a newly saved placeholder.
        // A real navigation error can still have created a page; keep that page
        // addressable so the person can inspect or retry it.
        if (parsed.action === "open" && (receipt.state === "live" || receipt.state === "sleeping" || receipt.status === "ok" && receipt.state === undefined)) {
          const tab: WorkbenchTab = { id: tabId!, kind: "browser", title: (typeof receipt.title === "string" && receipt.title.trim() ? receipt.title : typeof parsed.fields.title === "string" ? parsed.fields.title : "网页").trim().slice(0, 128).replace(/[\uD800-\uDBFF]$/, "") || "网页", url: typeof receipt.url === "string" ? browserAddress(receipt.url) : browserAddress(String(parsed.fields.url)) };
          try { check(); await this.change({ type: "open", tab }, check); }
          catch (error) {
            if (abort.signal.aborted || !this.isVisible || Date.now() >= frame.deadline) await this.rememberNativeTab(tab);
            throw error;
          }
        }
        const status = receipt.status === "ok" ? "success" : receipt.status === "unknown" ? "unknown" : receipt.status === "cancelled" ? "cancelled" : receipt.status === "failed" ? "failed" : "not_executed";
        const outcome = workbenchReceiptSchema.safeParse({ ...base, status, result: json({ ...receipt, ...(tabId ? { tabId } : {}) }), ...(receipt.error ? { error: receipt.error } : {}) });
        if (outcome.success) return outcome.data;
        // The action has an explicit native outcome; an oversized response is
        // a delivery failure, not uncertainty about whether it ran.
        return { ...base, status: "failed", error: "workbench_result_too_large", result: { nativeStatus: receipt.status, action: parsed.action, ...(tabId ? { tabId } : {}) } };
      }
      throw new Error("workbench_operation_unsupported");
    } catch (error) {
      const code = errorCode(error); return { ...base, status: error instanceof ChartRenderRejected || error instanceof BrowserDispatchRejected ? "not_executed" : dispatched ? "unknown" : code.includes("conflict") ? "conflict" : abort.signal.aborted ? "cancelled" : "not_executed", error: code };
    } finally {
      clearTimeout(deadline); this.pending.delete(frame.dispatchId); this.pendingTargets.delete(frame.dispatchId);
      if (boardTarget) { const users = this.boardUsers.get(boardTarget) ?? 0; if (users <= 1) this.boardUsers.delete(boardTarget); else this.boardUsers.set(boardTarget, users - 1); }
      if (noteTarget) { const users = this.noteUsers.get(noteTarget) ?? 0; if (users <= 1) this.noteUsers.delete(noteTarget); else this.noteUsers.set(noteTarget, users - 1); }
      this.pruneBoards(); this.pruneMarkdown();
    }
  }
  /** The design's content is gone: end its share for everyone. If the Host cannot be told now,
   * at least stop serving it from here (it then lists as source-offline until closed). */
  private endDesignShare(session: DesignSession) {
    const sharing = existingDesignShareManager(this.connection); if (!sharing) return;
    void sharing.close(session).catch(() => sharing.forget(session)).catch(() => undefined);
  }
  dispose(): void {
    if (this.disposed) return;
    // Queue the last page address before teardown; its write may finish after it.
    void this.flushBrowserMeta();
    this.disposed = true; this.visible = false;
    for (const dispatchId of this.pending.keys()) this.cancel({ v: 1, type: "workbench.cancel", dispatchId, reason: "workbench_disposed" }); this.pending.clear(); this.pendingTargets.clear();
    // Retain emergency text before asynchronous teardown. Release ownership even
    // if the cache has closed; a reconstructed controller can offer recovery.
    // This window stops serving its shared designs; the shares and grants stay for another window.
    const sharing = existingDesignShareManager(this.connection);
    for (const session of this.designSessions.values()) { if (sharing) void sharing.forget(session).catch(() => undefined); void session.retire().catch(() => undefined); }
    const retiring = [...this.noteSessions].map(async ([id, session]) => {
      const key = noteRecoveryKey(this.connection.identity.deviceId, this.scope, id);
      const retain = () => rememberNoteRecovery(key, session.dirty() ? session.recovery() : undefined);
      retain(); session.setComposing(false);
      try { await session.flush(); } catch { /* Recovery above and below owns the text. */ }
      retain(); session.dispose(); this.noteSessions.delete(id);
    });
    void Promise.allSettled(retiring).then(() => globalThis.removeEventListener?.("beforeunload", this.beforeUnload));
    this.removeBrowserEvents?.(); this.removeConnection?.(); this.removeLibraryChanges?.(); this.removeDesignCommentChanges?.(); this.listeners.clear(); scheduleBrowserLayout();
  }
}
export function createWorkbenchController(options: { connection: HubConnection; conversationId: string }): WorkbenchController { return new WorkbenchController(options); }
