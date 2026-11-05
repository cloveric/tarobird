import { useEffect, useMemo, useSyncExternalStore } from "react";
import { SIDE_QUESTION_LIMIT, sideReplySchema, type SideCapabilityView, type SideErrorCode, type SideView } from "../../src/client-protocol/side.js";
import { MAX_FILE_BYTES, type Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { timeoutSignal } from "./abort-signals.js";
import { formatFileLimit, uploadFile } from "./files.js";
import { negotiateSideCapability } from "./side-capability.js";
import { t } from "./i18n.js";

export function sideErrorText(code: SideErrorCode): string {
  const messages: Record<SideErrorCode, string> = {
    unsupported: "此引擎暂不支持临时侧边对话。", no_main_session: "请先在主对话发送一条消息，再打开侧边对话。", busy: "请等待主对话本轮完成，再重新打开侧边对话。", limit_reached: "临时对话已达到上限，请关闭后重新开始。", budget_exhausted: "此 Bot 的预算已用尽，请在主机上调整预算后重试。", expired: "侧边会话已结束，请基于最新主对话重新开始。", cancelled: "已停止", failed: "侧边回答未能完成，请重试或重新开始。",
    attachment_unavailable: "附件已失效或无法读取，请重新添加。", attachment_unsupported: "此引擎暂不支持这个附件类型，请更换文件。", attachment_too_large: "附件数量或大小超过侧边对话上限，请减少后重试。",
  };
  return t(messages[code]);
}
type Snapshot = {
  capability?: SideCapabilityView; shown: boolean; view?: SideView;
  draft: string; files: File[]; error: string; ended: boolean; sending: boolean;
  focusRequest: number; uploadProgress?: number; uploadRecovering: boolean;
};
type PendingAsk = { text: string; files: File[]; attachments: string[]; requestId: string };

/** One memory-only controller per parent conversation. Navigation detaches the
 * view, not the native session; explicit Close still disposes it immediately. */
class SideSession {
  private snapshot: Snapshot = { shown: false, draft: "", files: [], error: "", ended: false, sending: false, focusRequest: 0, uploadRecovering: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposal: Promise<unknown> = Promise.resolve();
  private pendingOpen?: Promise<void>;
  private disposeCurrent?: () => Promise<unknown>;
  private uncertain?: PendingAsk;
  private stopRequested = false;
  private upload?: AbortController;
  private uploaded = new WeakMap<File, string>();
  private sentFiles = new Map<string, File[]>();
  private pollGeneration = 0;
  private capabilityGeneration = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private online = false;
  readonly scroll = { top: 0, follow: true };
  readonly focus = { handled: 0 };
  readonly route: string;
  readonly query: string;
  constructor(readonly connection: HubConnection, readonly conversationId: string, readonly botId: string, public runtimeKey: string) {
    this.route = `/api/conversations/${encodeURIComponent(conversationId)}/side`;
    this.query = `botId=${encodeURIComponent(botId)}`;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  private patch(value: Partial<Snapshot>) { this.snapshot = { ...this.snapshot, ...value }; this.listeners.forEach(listener => listener()); }
  setDraft = (draft: string) => this.patch({ draft });
  setError = (error: string) => this.patch({ error });
  addFiles = (files: File[]) => {
    if (this.upload || !files.length) return;
    const all = [...this.snapshot.files, ...files], error = this.validateFiles(all);
    if (error) { this.setError(error); return; }
    this.patch({ files: all, error: "" });
  };
  // A finishing encoder may outlive the view during ordinary navigation, but
  // explicit Close/restart invalidates its receipt even if the same chat reopens.
  captureTarget = () => {
    const generation = this.generation;
    const valid = () => generation === this.generation && this.snapshot.shown && !this.snapshot.ended;
    // A finished recording has no other copy. Keep it even past a draft limit,
    // as the main composer does; sending still validates and names the limit.
    return { add: (file: File) => { if (!valid() || this.upload) return false; const files = [...this.snapshot.files, file]; this.patch({ files, error: this.validateFiles(files) ?? "" }); return true; }, fail: (error: string) => { if (valid()) this.setError(error); } };
  };
  private validateFiles(files: File[]): string | undefined {
    if (!files.length) return;
    const capability = this.snapshot.capability?.attachments;
    if (!capability) return t("当前主机或引擎暂不支持侧边附件，请升级后重试。");
    if (files.length > capability.maxCount) return t("侧边问题最多添加 {0} 个附件。", capability.maxCount);
    if (!capability.images && files.some(file => file.type.startsWith("image/"))) return t("此引擎的侧边对话暂不支持图片。");
    if (files.reduce((sum, file) => sum + file.size, 0) > capability.maxTotalBytes) return t("侧边附件总大小不能超过 {0}。", formatFileLimit(capability.maxTotalBytes));
    for (const file of files) {
      const maximum = Math.min(this.connection.state.maxFileBytes ?? MAX_FILE_BYTES, file.type.startsWith("image/") ? capability.maxImageBytes : capability.maxFileBytes);
      if (file.size <= 0) return t("文件不能为空，且大小必须有效。");
      if (file.size > maximum) return t("{0} 超过单个附件上限 {1}，请选择较小文件或调整 Hub 设置。", file.name, formatFileLimit(maximum));
    }
  }
  checkFiles = (files: File[]) => this.validateFiles([...this.snapshot.files, ...files]);
  removeFile = (index: number) => { if (!this.upload) this.patch({ files: this.snapshot.files.filter((_, i) => i !== index) }); };
  private accept(view: SideView) {
    if (!this.snapshot.view || view.id !== this.snapshot.view.id || view.revision >= this.snapshot.view.revision) this.patch({ view });
  }
  private clearSent(pending: PendingAsk) {
    this.sentFiles.set(pending.requestId, pending.files);
    const ids = new Set(this.snapshot.view?.exchanges.map(exchange => exchange.id)); ids.add(pending.requestId);
    for (const id of this.sentFiles.keys()) if (!ids.has(id)) this.sentFiles.delete(id);
    this.patch({ draft: this.snapshot.draft.trim() === pending.text ? "" : this.snapshot.draft, files: this.snapshot.files.filter(file => !pending.files.includes(file)), error: "" });
  }
  retry = (id: string) => {
    const exchange = this.snapshot.view?.exchanges.find(item => item.id === id);
    if (!exchange || this.snapshot.sending || this.snapshot.files.length || this.snapshot.draft.trim()) return;
    this.patch({ draft: exchange.question, files: this.sentFiles.get(id) ?? [], error: "" });
  };
  setOnline(online: boolean) {
    if (this.online === online) return;
    this.online = online;
    if (online && this.active) void this.refreshCapability();
    this.pollSoon();
  }
  activate(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    if (active && this.online) void this.refreshCapability();
    this.pollSoon();
  }
  updateRuntime(runtimeKey: string) {
    if (runtimeKey === this.runtimeKey) return;
    this.runtimeKey = runtimeKey; this.capabilityGeneration++;
    void this.close(); this.patch({ capability: undefined });
    if (this.active && this.online) void this.refreshCapability();
  }
  private async refreshCapability() {
    // A runtime change has already cleared this; otherwise it is the capability
    // this runtime last confirmed.
    const serial = ++this.capabilityGeneration, previous = this.snapshot.capability;
    // Older Hosts drop only the opt-ins they explicitly reject; a transient
    // failure retries the same request and never strips negotiated tools.
    const outcome = await negotiateSideCapability(shape => this.connection.http(`${this.route}?${this.query}&attachments=1${shape.delivery ? "&delivery=1" : ""}${shape.tools ? "&tools=1" : ""}${shape.audio ? "&audio=1" : ""}`, { signal: timeoutSignal(10_000) })
      .then(raw => sideReplySchema.parse(raw)), { current: () => serial === this.capabilityGeneration });
    if (serial !== this.capabilityGeneration || outcome.kind === "stale") return;
    this.patch({ capability: outcome.kind === "ok" ? outcome.value.ok ? outcome.value.capability : undefined : outcome.kind === "transient" ? previous : undefined });
  }
  close = () => {
    this.generation++; this.pollGeneration++; this.capabilityGeneration++;
    clearTimeout(this.timer); this.upload?.abort(); this.upload = undefined;
    this.disposal = Promise.allSettled([this.disposal, this.disposeCurrent?.(), this.pendingOpen]);
    this.disposeCurrent = undefined; this.uncertain = undefined; this.stopRequested = false;
    this.uploaded = new WeakMap(); this.sentFiles.clear(); this.scroll.top = 0; this.scroll.follow = true;
    this.patch({ shown: false, view: undefined, draft: "", files: [], error: "", ended: false, sending: false, uploadProgress: undefined, uploadRecovering: false });
    return this.disposal;
  };
  open = async (seed = "", restart = false, files: File[] = []) => {
    if (!this.active || !this.online || !this.snapshot.capability?.supported) return;
    const fileError = this.checkFiles(files);
    if (fileError) { this.setError(fileError); return; }
    this.patch({ focusRequest: this.snapshot.focusRequest + 1 });
    if (this.snapshot.shown && !restart) { if (seed) this.setDraft(seed); this.addFiles(files); return; }
    const retained = restart ? [...this.snapshot.files, ...files] : files;
    if (restart) await this.close();
    const serial = ++this.generation; this.patch({ shown: true, draft: seed, files: retained, error: "", ended: false });
    await this.disposal;
    if (serial !== this.generation) return;
    const creating = (async () => { try {
      const result = sideReplySchema.parse(await this.connection.http(this.route, { method: "POST", body: JSON.stringify({ botId: this.botId, requestId: crypto.randomUUID(), ...(this.snapshot.capability?.tools === "inherited" ? { tools: "inherited" } : {}), ...(this.snapshot.capability?.delivery ? { delivery: true } : {}) }), signal: timeoutSignal(20_000) }));
      const dispose = result.ok && result.view ? () => this.connection.http(`${this.route}/${result.view!.id}?${this.query}`, { method: "DELETE", signal: timeoutSignal(90_000) }) : undefined;
      if (serial !== this.generation) { await dispose?.().catch(() => undefined); return; }
      if (!result.ok || !result.view) { this.patch({ error: sideErrorText(result.ok ? "failed" : result.error), ended: true }); return; }
      this.disposeCurrent = dispose; this.accept(result.view); this.pollSoon();
    } catch { if (serial === this.generation) this.patch({ error: t("未能连接侧边对话，请重新开始。"), ended: true }); } })();
    this.pendingOpen = creating;
    try { await creating; } finally { if (this.pendingOpen === creating) this.pendingOpen = undefined; }
  };
  private async requestStop(id: string, serial: number, askConfirmed: boolean) {
    try {
      const result = sideReplySchema.parse(await this.connection.http(`${this.route}/${id}/stop`, { method: "POST", body: JSON.stringify({ botId: this.botId }), signal: timeoutSignal(10_000) }));
      if (serial !== this.generation) return;
      if (result.ok && result.view) { this.accept(result.view); if (askConfirmed || result.view.phase === "stopping") this.stopRequested = false; }
      else if (!result.ok) this.setError(sideErrorText(result.error));
    } catch { if (serial === this.generation) this.setError(t("停止状态暂未确认，请重试。")); }
  }
  private pollSoon() {
    const token = ++this.pollGeneration;
    clearTimeout(this.timer);
    if (!this.snapshot.shown || !this.snapshot.view?.id || !this.online || this.snapshot.ended) return;
    const id = this.snapshot.view.id, serial = this.generation;
    const poll = async () => {
      try {
        const result = sideReplySchema.parse(await this.connection.http(`${this.route}/${id}?${this.query}&revision=${this.snapshot.view?.revision ?? 0}`, { signal: timeoutSignal(10_000) }));
        if (token !== this.pollGeneration || serial !== this.generation) return;
        if (!result.ok) { this.patch({ error: sideErrorText(result.error), ended: true }); return; }
        if (this.snapshot.error === t("连接暂时中断，正在重新连接…")) this.setError("");
        if (result.view) {
          this.accept(result.view);
          if (this.uncertain && result.view.exchanges.some(e => e.id === this.uncertain!.requestId)) {
            this.clearSent(this.uncertain); this.uncertain = undefined;
            if (this.stopRequested) await this.requestStop(id, serial, true);
          }
        }
      } catch { if (token === this.pollGeneration && serial === this.generation) this.setError(t("连接暂时中断，正在重新连接…")); }
      if (token === this.pollGeneration && serial === this.generation) this.timer = setTimeout(() => void poll(), this.active && this.snapshot.view?.phase !== "idle" ? 600 : 25_000);
    };
    void poll();
  }
  send = async () => {
    const text = this.snapshot.draft.trim(), files = [...this.snapshot.files], id = this.snapshot.view?.id, serial = this.generation;
    if (!id || !this.online || this.snapshot.sending || !text && !files.length || text.length > SIDE_QUESTION_LIMIT || this.snapshot.view?.phase !== "idle" || this.snapshot.ended) return;
    const fileError = this.validateFiles(files);
    if (fileError) { this.setError(fileError); return; }
    this.patch({ sending: true, error: "" }); this.stopRequested = false;
    let submitted = false;
    try {
      const attachments: string[] = [], controller = new AbortController(); this.upload = controller;
      if (files.length) this.patch({ uploadProgress: 0 });
      for (const [index, file] of files.entries()) {
        const attachment = this.uploaded.get(file) ?? await uploadFile(this.connection, this.conversationId, file, value => { if (serial === this.generation) this.patch({ uploadProgress: (index + value) / files.length }); }, { signal: controller.signal, recovering: uploadRecovering => { if (serial === this.generation) this.patch({ uploadRecovering }); } });
        if (serial !== this.generation) return;
        this.uploaded.set(file, attachment); if (!attachments.includes(attachment)) attachments.push(attachment);
      }
      controller.signal.throwIfAborted(); this.upload = undefined; this.patch({ uploadProgress: undefined, uploadRecovering: false });
      const same = this.uncertain?.text === text && JSON.stringify(this.uncertain.attachments) === JSON.stringify(attachments);
      const pending: PendingAsk = { text, files, attachments, requestId: same ? this.uncertain!.requestId : crypto.randomUUID() };
      this.uncertain = pending; submitted = true;
      const result = sideReplySchema.parse(await this.connection.http(`${this.route}/${id}`, { method: "POST", body: JSON.stringify({ botId: this.botId, requestId: pending.requestId, text, ...(attachments.length ? { attachments } : {}) }), signal: timeoutSignal(20_000) }));
      if (serial !== this.generation) return;
      if (!result.ok) { this.uncertain = undefined; this.setError(sideErrorText(result.error)); return; }
      this.uncertain = undefined; this.clearSent(pending); if (result.view) this.accept(result.view);
      if (this.stopRequested) await this.requestStop(id, serial, true);
    } catch (error) {
      if (serial === this.generation) this.setError(submitted ? t("发送状态暂未确认。重试同一问题不会重复发送。") : error instanceof Error ? error.message : t("上传失败，请重试。"));
    } finally {
      if (serial === this.generation) { this.upload = undefined; this.patch({ sending: false, uploadProgress: undefined, uploadRecovering: false }); this.pollSoon(); }
    }
  };
  stop = async () => {
    if (this.upload) { this.upload.abort(); return; }
    const id = this.snapshot.view?.id, serial = this.generation; if (!id) return;
    this.stopRequested = true;
    await this.requestStop(id, serial, !this.snapshot.sending && !this.uncertain); this.pollSoon();
  };
}

export function useSideConversation(connection: HubConnection, conversationId: string, botId: string, eligible: boolean, online: boolean, runtimeKey: string, conversations: readonly Conversation[]) {
  const sessions = useMemo(() => new Map<string, SideSession>(), [connection]);
  const key = JSON.stringify([conversationId, botId]);
  const session = useMemo(() => {
    let value = sessions.get(key);
    if (!value) { value = new SideSession(connection, conversationId, botId, runtimeKey); sessions.set(key, value); }
    return value;
  }, [sessions, key, connection, conversationId, botId]);
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => {
    const refresh = () => {
      const state = connection.state;
      for (const item of sessions.values()) {
        const bot = state.bots.find(value => value.id === item.botId);
        if (item.getSnapshot().shown && (connection.isClosed || connection.isReadOnly)) void item.close();
        if (bot) item.updateRuntime(JSON.stringify([bot.engine, bot.model, bot.effort]));
        item.setOnline(state.status === "online" && !!bot?.online);
      }
    };
    const unsubscribe = connection.subscribe(refresh); refresh();
    return () => { unsubscribe(); for (const item of sessions.values()) void item.close(); };
  }, [connection, sessions]);
  useEffect(() => {
    for (const item of sessions.values()) {
      const conversation = conversations.find(value => value.id === item.conversationId);
      if (item.getSnapshot().shown && (!conversation || conversation.archived || conversation.type !== "direct" || conversation.parentId || conversation.botIds.length !== 1 || conversation.botIds[0] !== item.botId)) void item.close();
    }
  }, [sessions, conversations]);
  useEffect(() => {
    session.updateRuntime(runtimeKey); session.setOnline(online); session.activate(eligible);
    for (const [id, item] of sessions) if (item !== session && !item.getSnapshot().shown) sessions.delete(id);
    return () => session.activate(false);
  }, [session, sessions, eligible, online, runtimeKey]);
  return { ...snapshot, scope: key, connection, scroll: session.scroll, focus: session.focus, setDraft: session.setDraft, setError: session.setError, addFiles: session.addFiles, captureTarget: session.captureTarget, checkFiles: session.checkFiles, removeFile: session.removeFile, open: session.open, close: session.close, send: session.send, stop: session.stop, retry: session.retry };
}
export type SideConversationController = ReturnType<typeof useSideConversation>;
