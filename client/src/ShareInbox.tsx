import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useBackAction } from "./back-navigation.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { t, useLocale } from "./i18n.js";
import { uploadFile } from "./files.js";
import { useBotLabels } from "./BotReferences.js";
import { shareInbox, supportsShareInbox } from "./share-inbox.js";
import { sharedItemSchema, sendSharedItem, type SharedItem, type ShareBridge, type ShareDelivery } from "./share-controller.js";
import { HostLocation } from "./RuntimeHost.js";
import { useShareDraft } from "./share-drafts.js";

/** Same rule as the composer and Hub: an archived group also closes its topics. */
function archivedReason(conversations: Conversation[], target: Conversation): string | undefined {
  if (target.parentId && conversations.find((c) => c.id === target.parentId)?.archived) return t("这个群组已归档，请先恢复群组。");
  return target.archived ? t("已归档，历史记录仍可查看。恢复后可继续讨论。") : undefined;
}
function targetTitle(conversations: Conversation[], target: Conversation): string {
  const parent = target.parentId ? conversations.find((c) => c.id === target.parentId) : undefined;
  return `${parent ? `${parent.title} / ` : ""}${target.title}${archivedReason(conversations, target) ? ` · ${t("已归档")}` : ""}`;
}
function ShareDraft({ item, connection, conversations, refresh, native }: { item: SharedItem; connection: HubConnection; conversations: Conversation[]; refresh: () => Promise<void>; native: ShareBridge }) {
  const labels = useBotLabels();
  const saved = useShareDraft(item.id, item.text, connection.cache, connection.identity, item.createdAt);
  const { text, recipient, mentions } = saved.draft;
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [progress, setProgress] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const [recovering, setRecovering] = useState(false);
  const latest = useRef(conversations); latest.current = conversations;
  useEffect(() => () => controller.current?.abort(), []);
  // A pinned delivery is the idempotent request: show and resend exactly it, never the editable draft.
  const pinned = item.delivery;
  const available = conversations.filter((c) => !archivedReason(conversations, c));
  const target = pinned ? conversations.find((c) => c.id === pinned.conversationId) : available.find((c) => c.id === recipient);
  const blocked = pinned && target ? archivedReason(conversations, target) : undefined;
  const group = target?.type === "group" ? target : undefined;
  const chosen = pinned ? pinned.mentions ?? [] : group ? mentions : [];
  const unavailable = !pinned && !!recipient && !target;
  const unavailableBots = !!group && chosen.some(id => !group.botIds.includes(id));
  const shownText = pinned?.text ?? text;
  const foreign = !!pinned && (pinned.deviceId !== connection.identity.deviceId || pinned.hubKey !== connection.identity.hubPublicKey);
  const editable = saved.ready && !saved.retired && !busy && !pinned;
  const saveError = saved.error === "draft_changed_elsewhere" ? t("另一窗口已更新此草稿。当前内容仍在此页，请备份后重新打开客户端。")
    : saved.error === "draft_identity_changed" || saved.error === "draft_identity_revoked" ? t("设备授权已失效，新的草稿修改无法保存。请先备份当前内容，再重新配对。")
    : saved.error === "share_draft_retired" ? t("此分享已在另一窗口发送或丢弃，当前编辑不会再次发送。")
    : saved.error === "share_draft_expired" ? t("分享已过期，请重新分享；未发送任何内容。")
    : t("完整草稿未保存，请保持此页打开并重试。");
  async function send() {
    if (controller.current) return;
    const active = new AbortController(); controller.current = active; setBusy(true); setError("");
    try {
      const hubKey = connection.identity.hubPublicKey;
      if (foreign || !target || !hubKey) throw new Error(t("请选择可访问的会话"));
      if (!pinned) {
        if (!saved.ready || saved.retired) return;
        // The draft hook exposes localized recovery guidance below. Do not
        // duplicate its storage error code as a second user-facing alert.
        try { await saved.flush(); } catch { return; }
      }
      if (!pinned && group && !chosen.length) throw new Error(t("请先选择回复的 Bot。"));
      const delivery: ShareDelivery = pinned ?? { hubKey, deviceId: connection.identity.deviceId, conversationId: target.id, text, ...(chosen.length ? { mentions: chosen } : {}) };
      // Checked before pinning/upload and again before the outbox write: an archived target keeps the native item and never enqueues.
      const stillOpen = () => { const current = latest.current.find((c) => c.id === delivery.conversationId); const reason = current ? archivedReason(latest.current, current) : t("请选择可访问的会话"); if (reason) throw new Error(reason); if (current?.type === "group" && delivery.mentions?.some(id => !current.botIds.includes(id))) throw new Error(t("所选 Bot 已不可用，请检查分享目标。")); };
      stillOpen();
      await sendSharedItem(native, item, delivery,
        (file, index) => uploadFile(connection, delivery.conversationId, file, (fraction) => setProgress((index + fraction) / item.files.length), { signal: active.signal, recovering: setRecovering }), async (frame) => { if (active.signal.aborted) throw new Error(t("上传已取消，已完成的分块会保留。")); stillOpen(); await connection.send(frame); await saved.retire(); });
    } catch (e) { setError(e instanceof Error ? e.message : t("操作失败")); }
    finally { controller.current = null; setBusy(false); setRecovering(false); await refresh(); }
  }
  return <article className="share-draft"><label>{t("发送到")}<select aria-label={t("分享目标会话")} disabled={!editable} value={target?.id ?? ""} onChange={(event) => saved.change({ ...saved.draft, recipient: event.target.value, mentions: [] })}><option value="">{t("选择会话")}</option>{(pinned ? target ? [target] : [] : available).map((c) => <option key={c.id} value={c.id}>{targetTitle(conversations, c)}</option>)}</select></label>
    {group && <div className="reply-bots" role="group" aria-label={t("回复的 Bot")}><span>{t("让谁回复")}</span>{[...new Set([...group.botIds, ...chosen])].map((id) => <button key={id} type="button" role="checkbox" aria-checked={chosen.includes(id)} disabled={!editable} onClick={() => saved.change({ ...saved.draft, mentions: mentions.includes(id) ? mentions.filter(b => b !== id) : [...mentions, id] })}>{chosen.includes(id) && <Check size={12}/>} {labels.get(id) ?? connection.state.bots.find((b) => b.id === id)?.name ?? id}</button>)}</div>}
    {group && !pinned && !chosen.length && <p className="muted">{t("请先选择回复的 Bot。")}</p>}
    {group && pinned && !pinned.mentions && <p className="muted">{t("这条旧版分享未指定回复的 Bot。将按原样重试；如需 Bot 回复，请丢弃后重新分享。")}</p>}
    <label>{t("分享内容")}<textarea aria-label={t("分享内容")} value={shownText} disabled={!editable} rows={4} onChange={(event) => saved.change({ ...saved.draft, text: event.target.value })}/></label>
    {!pinned && <p role="status" aria-label={t("草稿状态")}>{saved.error ? t("草稿未保存") : !saved.ready ? t("正在读取分享草稿…") : saved.saving ? t("正在保存草稿…") : saved.retired ? t("此分享已丢弃，请重试清理本机副本。") : t("草稿已保存")}</p>}
    {saved.error && !pinned && <p role="alert">{saveError}<button disabled={saved.saving} onClick={saved.retry}>{t("重试")}</button></p>}
    {unavailable && <p role="alert">{t("原目标会话已不可用，请重新选择；草稿内容仍保留。")}</p>}
    {unavailableBots && <p role="alert">{t("所选 Bot 已不可用，请检查分享目标。")}</p>}
    <ul>{item.files.map((file, index) => <li key={index}>{file.name} · {(file.size / 1048576).toFixed(1)} MB</li>)}</ul>
    {pinned && <p className="muted">{t("重试将继续发送到原会话。")}</p>}{foreign && <p role="alert">{t("这条分享属于另一设备身份，请丢弃后重新分享。")}</p>}{blocked && <p role="alert">{blocked}</p>}
    {(error || item.error) && (error || item.error) !== blocked && <p role="alert" className="error-text">{error || item.error}</p>}
    <div className="quick-actions">{busy && <button onClick={() => controller.current?.abort()}>{t("取消上传")}</button>}<button disabled={busy} onClick={() => { setBusy(true); void saved.retire().then(() => native.remove({ id: item.id })).then(refresh).catch((e: unknown) => setError(String(e))).finally(() => setBusy(false)); }}>{t("丢弃分享")}</button>
      <button className="primary" disabled={busy || foreign || !!item.error || !!blocked || unavailableBots || !target || (!pinned && (!saved.ready || saved.retired || !!saved.error || !!group && !chosen.length)) || (!shownText.trim() && !item.files.length) || (item.files.length > 0 && connection.state.status !== "online")} onClick={() => { void send(); }}>{busy ? recovering ? t("连接中断，等待恢复…") : t("上传 {0}%", Math.round(progress * 100)) : t("发送分享")}</button></div>
  </article>;
}
export function ShareInbox({ connection, conversations, active = true, hosts = [], native = supportsShareInbox() ? shareInbox : undefined }: { connection: HubConnection; conversations: Conversation[]; active?: boolean; hosts?: { hubKey: string; deviceId: string; name: string; open: (conversationId: string) => void }[]; native?: ShareBridge }) {
  useLocale(); const [items, setItems] = useState<SharedItem[]>([]); const [open, setOpen] = useState(false); const [error, setError] = useState("");
  const panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const visible = open && active && !!native && (!!items.length || !!error);
  useLayoutEffect(() => {
    if (!visible) return;
    const node = panel.current; node?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
      if (event.key !== "Tab") return;
      const controls = [...(node?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[href]") ?? [])].filter(item => item.getClientRects().length);
      const first = controls[0], last = controls.at(-1), focused = document.activeElement;
      if (!node?.contains(focused) || focused === node) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && focused === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && focused === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (node?.contains(document.activeElement) || document.activeElement === document.body) trigger.current?.focus({ preventScroll: true }); };
  }, [visible]);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  // Polls, focus and post-send refreshes overlap. Apply results in request order so a slow older
  // list cannot resurrect a removed share; never wait for "the latest" request, or slow polls starve.
  const requested = useRef(0), applied = useRef(0), mounted = useRef(true);
  const previousItems = useRef<string[]>([]), listed = useRef(""), pruned = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useBackAction(panel, () => setOpen(false));
  async function refresh() {
    if (!native) return; const request = ++requested.current;
    let next: SharedItem[] | undefined, failure = "";
    try { next = (await native.list()).items.map((item) => sharedItemSchema.parse(item)); } catch (e) { failure = String(e); }
    if (!mounted.current || request < applied.current) return; applied.current = request;
    if (next) {
      const removed = previousItems.current.filter(id => !next!.some(item => item.id === id)); previousItems.current = next.map(item => item.id);
      // Expiry is coarse: prune at most once a minute (or when items finished),
      // not with a write transaction on every poll.
      if (removed.length || Date.now() - pruned.current > 60_000) { pruned.current = Date.now(); void connection.cache.pruneExpiredShareDrafts(connection.identity).catch(() => undefined); }
      const signature = JSON.stringify(next);
      if (signature !== listed.current) { listed.current = signature; setItems(next); }
      setError("");
      // Another host/window can finish the shared native item. Retire this
      // pairing's old editor too; a delayed save cannot restore its content.
      for (const id of removed) void connection.cache.retireShareDraft(id, connection.identity).catch(() => undefined);
    } else setError(failure);
  }
  useEffect(() => {
    // Only the visible host workspace polls; a hidden host reads again on activation.
    if (!native || !active) return;
    void refresh(); const focus = () => { void refresh(); };
    // iOS extensions write to the shared container while the main app is suspended.
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2500);
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", focus);
    return () => { clearInterval(interval); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); };
  }, [connection, native, active]);
  if (!native || (!items.length && !error)) return null;
  return <><button ref={trigger} className="share-inbox-button" onClick={() => setOpen(true)}>{t("待发送分享 ({0})", items.length)}</button><div className="modal-scrim" hidden={!open} style={open ? undefined : { display: "none" }}><section ref={panel} tabIndex={-1} className="settings-panel" role="dialog" aria-modal="true" aria-label={t("收到的分享")}><header><h2>{t("收到的分享")}</h2><button onClick={() => setOpen(false)}>{t("关闭")}</button></header><HostLocation/><p className="muted">{t("确认会话和内容后发送。本机副本保留 24 小时。")}</p>{error && <p role="alert">{error}</p>}{items.map((item) => {
    const owner = item.delivery && hosts.find((host) => host.hubKey === item.delivery!.hubKey && host.deviceId === item.delivery!.deviceId);
    return owner && (owner.hubKey !== connection.identity.hubPublicKey || owner.deviceId !== connection.identity.deviceId) ? <article className="share-draft" key={item.id}><p>{t("这条分享已指定发送到 {0}。内容和附件仍然保留。", owner.name)}</p><button onClick={() => { setOpen(false); owner.open(item.delivery!.conversationId); }}>{t("切换到 {0}", owner.name)}</button></article> : <ShareDraft key={JSON.stringify([connection.cache.databaseName, connection.identity.hubPublicKey, connection.identity.deviceId, connection.identity.publicKey, item.id])} item={item} connection={connection} conversations={conversations} refresh={refresh} native={native}/>;
  })}</section></div></>;
}
