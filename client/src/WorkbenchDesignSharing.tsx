import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Users, X, RotateCw } from "lucide-react";
import { formatList, getLocale, t, useLocale } from "./i18n.js";
import { designFrame } from "./design-frame.js";
import { workbenchErrorText } from "./workbench-error.js";
import type { WorkbenchController } from "./workbench-controller.js";
import type { DesignSession } from "./workbench-design-session.js";
import { designShareListActions, designShareManager, type DesignShareManager, type DesignShareMember, type DesignShareView } from "./workbench-design-collaboration.js";
import "./workbench-design-sharing.css";

// Authenticated collaboration on one Workbench document: only through this Host's
// signed App connection, to members of this conversation or the owner's other
// devices. No links, no LAN service. A joined copy has no offline fallback.
type GrantRole = "editor" | "commenter" | "viewer" | "none";
export const shareRoleLabel = (role: string) => role === "owner" ? t("所有者") : role === "editor" ? t("可编辑") : role === "commenter" ? t("可评论") : role === "viewer" ? t("仅查看") : t("不共享");
export function shareErrorText(error: unknown) {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : "";
  if (code === "design_share_source_offline") return t("共享设备当前离线，暂时无法同步。");
  if (code === "design_share_disconnected" || code === "design_share_app_unavailable") return t("与主机的连接已断开。重新连接后点「重新加入」。");
  if (code === "design_share_forbidden" || code === "design_share_revoked" || code === "design_share_not_member") return t("你没有这个共享的访问权限。");
  if (code === "design_share_closed") return t("这个共享已经结束。");
  if (code === "design_share_limit" || code === "design_share_full") return t("共享人数或数量已达上限。");
  if (code === "design_canvas_removed") return workbenchErrorText("design_canvas_removed", getLocale());
  if (code === "design_share_format_unsupported") return t("只有 PPT 可以共享。");
  if (code === "design_share_outcome_unknown") return t("结果未确认。请刷新列表后再试，不会重复执行。");
  return t("操作没有完成，请重试。");
}
/** One listed share. Open when this device may join it; owners can also end it here
 * or from another of their devices, including a share whose document or window is gone
 * (for example, deleted while offline). Ending asks first and never deletes a design. */
export function DesignShareRow({ share, disabled, ending, onOpen, onEnding, onEnd }: { share: DesignShareView; disabled: boolean; ending: boolean; onOpen(): void; onEnding(value: boolean): void; onEnd(): void }) {
  const actions = designShareListActions(share);
  const removedCanvas = share.format !== "slides";
  return <li className={ending ? "design-sharing-ending" : undefined}>
    <span><strong>{share.title}</strong><span className="design-sharing-muted"> · {share.ownerName} · {shareRoleLabel(share.role)} · {share.sourceOnline ? t("源设备在线") : t("源设备离线")}{removedCanvas ? ` · ${t("画布已移除，不支持打开")}` : ""}</span></span>
    {actions.open && <button disabled={disabled} onClick={onOpen}>{t("打开")}</button>}
    {actions.end && !ending && <button className="danger" disabled={disabled} aria-label={t("结束共享：{0}", share.title)} onClick={() => onEnding(true)}>{t("结束共享")}</button>}
    {actions.end && ending && <div className="design-sharing-confirm" role="alertdialog" aria-label={t("结束共享：{0}", share.title)}>
      <p>{t("结束后所有人都会失去访问，这个共享不能再恢复。不会删除任何设计。")}</p>
      <div className="design-sharing-actions"><button disabled={disabled} onClick={() => onEnding(false)}>{t("取消")}</button><button className="danger" disabled={disabled} onClick={onEnd}>{t("结束共享")}</button></div>
    </div>}
  </li>;
}

export function WorkbenchDesignSharing({ controller, session, title }: { controller: WorkbenchController; session: DesignSession; title: string }) {
  useLocale();
  const connection = controller.connection;
  // HubConnection.subscribe is a method: bind it once for React.
  const subscribe = useCallback((listener: () => void) => connection.subscribe(listener), [connection]);
  const available = useSyncExternalStore(subscribe, () => !!connection.state.workbenchDesignShareAvailable);
  const online = useSyncExternalStore(subscribe, () => connection.state.status === "online");
  const manager = designShareManager(connection, connection.designShares);
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [members, setMembers] = useState<DesignShareMember[]>(), [shares, setShares] = useState<DesignShareView[]>();
  const [confirmClose, setConfirmClose] = useState(false), [viewing, setViewing] = useState<string>(), [ending, setEnding] = useState<string>();
  const format = session.document.format ?? "canvas";
  if (!available || session.shared) return null;
  const entry = manager.sourceFor(session), conversationId = controller.conversationId, windowId = controller.getSnapshot().windowId;
  const user = () => { const current = connection.state.user; return current ? { id: current.id, name: current.name } : undefined; };
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(shareErrorText(cause)); } finally { setBusy(false); } };
  const refresh = () => run(async () => { const [list, people] = await Promise.all([manager.list(conversationId), manager.members(conversationId)]); setShares(list); setMembers(people); });
  const toggle = () => { if (open) { setOpen(false); setConfirmClose(false); setEnding(undefined); return; } setOpen(true); void refresh(); };
  const grants = new Map((entry?.view.members ?? []).map(member => [member.userId, member.role]));
  const others = (members ?? []).filter(member => !member.you);
  const sharedWithMe = (shares ?? []).filter(share => !share.onThisDevice && share.shareId !== entry?.view.shareId);
  // This device's other shares, including ones whose document or window is gone: owners can end them here.
  const fromThisDevice = (shares ?? []).filter(share => share.onThisDevice && share.shareId !== entry?.view.shareId);
  const row = (share: DesignShareView) => <DesignShareRow key={share.shareId} share={share} disabled={busy || !online} ending={ending === share.shareId}
    onOpen={() => void run(async () => { await manager.join(share, { windowId, user }); setViewing(share.shareId); setOpen(false); })}
    onEnding={value => setEnding(value ? share.shareId : undefined)} onEnd={() => void run(async () => { await manager.closeShare(share.shareId); setEnding(undefined); await refresh(); })}/>;
  const shareable = format === "slides";
  return <span className="design-sharing">
    <button disabled={busy && !open} aria-expanded={open} onClick={toggle} title={entry ? (entry.source.attached ? t("正在共享") : t("共享已暂停或离线")) : t("共享与协作")}>
      <Users size={14}/>{t("共享")}{entry ? (entry.source.attached && online ? " ●" : " ○") : ""}
    </button>
    {open && <div role="dialog" aria-label={t("共享与协作")} data-workbench-overlay className="design-sharing-panel">
      <section>
        <div className="design-sharing-head"><strong>{t("这个设计")}</strong><button className="icon" aria-label={t("关闭")} onClick={toggle}><X size={14}/></button></div>
        {!online && <p role="alert">{t("当前未连接主机，无法共享或加入。")}</p>}
        {!entry ? <>
          <p className="design-sharing-muted">{t("与本对话的成员或你的其他设备一起编辑。只经过已登录的主机连接，不生成链接；这台设备离线时无法同步。")}</p>
          {shareable ? <button className="primary" disabled={busy || !online} onClick={() => void run(async () => { await manager.share(session, { conversationId, windowId, title }); await refresh(); })}>{t("开始共享")}</button>
            : <p className="design-sharing-muted">{shareErrorText(Object.assign(new Error(format === "canvas" ? "design_canvas_removed" : "design_share_format_unsupported"), { code: format === "canvas" ? "design_canvas_removed" : "design_share_format_unsupported" }))}</p>}
        </> : <>
          <p role="status">{entry.source.attached && online ? t("正在从这台设备共享。") : t("已离线：恢复连接后会自动从这台设备重新提供。")}</p>
          <p className="design-sharing-muted">{t("你的其他设备可在「共享给我的」中打开。")}</p>
          {members === undefined ? <p className="design-sharing-muted">{t("正在读取对话成员…")}</p>
            : !others.length ? <p className="design-sharing-muted">{t("这个对话里没有其他成员。")}</p>
            : <ul className="design-sharing-members">{others.map(member => <li key={member.userId}><span>{member.name || member.userId}</span>
              <select aria-label={t("{0} 的权限", member.name)} disabled={busy || !online} value={grants.get(member.userId) ?? "none"}
                onChange={event => { const role = event.target.value as GrantRole; void run(() => manager.grant(session, member.userId, role === "none" ? null : role)); }}>
                {(["none", "viewer", "commenter", "editor"] as const).map(role => <option key={role} value={role}>{shareRoleLabel(role)}</option>)}
              </select></li>)}</ul>}
          {confirmClose ? <div className="design-sharing-confirm" role="alertdialog" aria-label={t("停止共享")}>
            <p>{t("停止后所有人都会失去访问，这个共享不能再恢复（可以重新共享为新的共享）。")}</p>
            <div className="design-sharing-actions"><button disabled={busy} onClick={() => setConfirmClose(false)}>{t("取消")}</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await manager.close(session); setConfirmClose(false); await refresh(); })}>{t("停止共享")}</button></div>
          </div> : <div className="design-sharing-actions">
            <button disabled={busy} onClick={() => void run(() => manager.pause(session))}>{t("暂停（本窗口）")}</button>
            <button className="danger" disabled={busy || !online} onClick={() => setConfirmClose(true)}>{t("停止共享")}</button>
          </div>}
        </>}
      </section>
      <section>
        <div className="design-sharing-head"><strong>{t("共享给我的")}</strong><button className="icon" disabled={busy || !online} aria-label={t("刷新")} onClick={() => void refresh()}><RotateCw size={14}/></button></div>
        {shares === undefined ? <p className="design-sharing-muted">{t("正在读取…")}</p> : !sharedWithMe.length ? <p className="design-sharing-muted">{t("这个对话里暂时没有共享给你的设计。")}</p>
          : <ul className="design-sharing-list">{sharedWithMe.map(row)}</ul>}
        {!!fromThisDevice.length && <><p className="design-sharing-muted">{t("这台设备共享的其他设计")}</p><ul className="design-sharing-list">{fromThisDevice.map(row)}</ul></>}
      </section>
      {error && <p role="alert">{error}</p>}
    </div>}
    {viewing && <SharedDesignViewer manager={manager} shareId={viewing} online={online} onClose={() => setViewing(undefined)}/>}
  </span>;
}

/** A joined copy in its own full-window layer above the Workbench. It is not a
 * modal/menu, so the design frame stays visible; App dialogs still hide it. */
function SharedDesignViewer({ manager, shareId, online, onClose }: { manager: DesignShareManager; shareId: string; online: boolean; onClose(): void }) {
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const entry = manager.mirrorFor(shareId), state = entry?.mirror.state(), surface = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [leaveFailed, setLeaveFailed] = useState(false);
  const usable = !!entry && !!state && !state.disconnected && !state.revoked;
  const locale = useLocale();
  useEffect(() => {
    if (usable && entry && surface.current) {
      return designFrame(entry.mirror.session).attach(surface.current, code => {
        setError(!code ? undefined : code === "design_canvas_removed" ? workbenchErrorText(code, locale) : t("编辑器尚未就绪或保存失败。"));
      }, () => {});
    }
  }, [usable, entry, locale]);
  if (!entry || !state) return null;
  // Leave saves the last edits while this copy can still write. If that fails the
  // copy stays open (retry, or leave without saving); it is never reported as saved.
  const leave = async (discard = false) => {
    setBusy(true); setLeaveFailed(false);
    try { await manager.leave(shareId, { discard }); setBusy(false); onClose(); }
    catch { setBusy(false); setLeaveFailed(true); }
  };
  const rejoin = async () => { setBusy(true); setError(undefined); try { await entry.mirror.resume(); } catch (cause) { setError(shareErrorText(cause)); } finally { setBusy(false); } };
  const people = state.peers.map(peer => peer.name || peer.userId);
  return createPortal(<div className="design-shared-viewer" role="region" aria-label={t("共享的设计：{0}", entry.view.title)}>
    <header>
      <strong>{entry.view.title}</strong>
      <span className="design-sharing-muted">{entry.view.ownerName} · {shareRoleLabel(state.role)} · {state.sourceOnline ? t("源设备在线") : t("源设备离线")}{people.length ? ` · ${formatList(people)}` : ""}</span>
      <span className="design-shared-viewer-actions">
        {state.disconnected && !state.revoked && <button disabled={busy || !online} onClick={() => void rejoin()}>{t("重新加入")}</button>}
        {leaveFailed && <button disabled={busy} onClick={() => void leave(true)}>{t("不保存，直接离开")}</button>}
        <button disabled={busy} onClick={() => void leave()}><X size={14}/>{leaveFailed ? t("重试保存并离开") : t("离开")}</button>
      </span>
    </header>
    {state.revoked ? <p role="alert">{t("你的访问已被撤销或共享已结束。")}</p>
      : state.disconnected ? <p role="alert">{t("连接已断开。重新加入后继续；断开期间不会在本机保存修改。")}</p>
      : !state.sourceOnline ? <p role="status">{t("源设备离线：可以查看，保存会失败。")}</p>
      : <p className="design-shared-viewer-note">{t("这里的评论会同步给所有者，但不能从这里发给 Bot；需要 Bot 处理时，请在共享它的设备上发送。")}</p>}
    {leaveFailed && <p role="alert">{t("最后的修改没能保存，副本仍然打开。可以重试，或不保存直接离开。")}</p>}
    {error && <p role="alert">{error}</p>}
    <div ref={surface} className="design-shared-viewer-surface"/>
  </div>, document.body);
}

/** "Shared with me" without a local design open: for the Workbench + menu or
 * empty state (Root renders it; it owns no other Workbench behaviour). */
export function WorkbenchSharedDesigns({ controller, onClose }: { controller: WorkbenchController; onClose?(): void }) {
  useLocale();
  const connection = controller.connection;
  const subscribe = useCallback((listener: () => void) => connection.subscribe(listener), [connection]);
  const available = useSyncExternalStore(subscribe, () => !!connection.state.workbenchDesignShareAvailable);
  const online = useSyncExternalStore(subscribe, () => connection.state.status === "online");
  const manager = designShareManager(connection, connection.designShares);
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const [shares, setShares] = useState<DesignShareView[]>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [viewing, setViewing] = useState<string>(), [ending, setEnding] = useState<string>();
  const windowId = controller.getSnapshot().windowId, conversationId = controller.conversationId;
  const user = () => { const current = connection.state.user; return current ? { id: current.id, name: current.name } : undefined; };
  useEffect(() => { if (!available || !online) return; let live = true; manager.list(conversationId).then(list => { if (live) setShares(list); }, cause => { if (live) setError(shareErrorText(cause)); }); return () => { live = false; }; }, [available, online, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!available) return null;
  const visible = (shares ?? []).filter(share => !share.onThisDevice);
  // Shares from this device stay listed so their owner can end them without the document (e.g. deleted while offline).
  const fromThisDevice = (shares ?? []).filter(share => share.onThisDevice);
  const row = (share: DesignShareView) => <DesignShareRow key={share.shareId} share={share} disabled={busy || !online} ending={ending === share.shareId}
    onOpen={() => { setBusy(true); setError(""); manager.join(share, { windowId, user }).then(() => setViewing(share.shareId), cause => setError(shareErrorText(cause))).finally(() => setBusy(false)); }}
    onEnding={value => setEnding(value ? share.shareId : undefined)}
    onEnd={() => { setBusy(true); setError(""); manager.closeShare(share.shareId).then(async () => { setEnding(undefined); setShares(await manager.list(conversationId)); }).catch(cause => setError(shareErrorText(cause))).finally(() => setBusy(false)); }}/>;
  return <div className="design-sharing-panel design-shared-list" role="region" aria-label={t("共享给我的项目")}>
    <div className="design-sharing-head"><strong>{t("共享给我的")}</strong>{onClose && <button className="icon" disabled={busy || !!viewing} aria-label={t("关闭")} onClick={onClose}><X size={14}/></button>}</div>
    {!online ? <p role="alert">{t("当前未连接主机。")}</p> : shares === undefined ? <p className="design-sharing-muted">{t("正在读取…")}</p>
      : !visible.length ? <p className="design-sharing-muted">{t("这个对话里暂时没有共享给你的设计。")}</p>
      : <ul className="design-sharing-list">{visible.map(row)}</ul>}
    {online && !!fromThisDevice.length && <><p className="design-sharing-muted">{t("这台设备共享的设计")}</p><ul className="design-sharing-list">{fromThisDevice.map(row)}</ul></>}
    {error && <p role="alert">{error}</p>}
    {viewing && <SharedDesignViewer manager={manager} shareId={viewing} online={online} onClose={() => setViewing(undefined)}/>}
  </div>;
}
