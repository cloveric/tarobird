import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Users, X, RotateCw } from "lucide-react";
import { useLocale } from "./i18n.js";
import { designFrame } from "./design-frame.js";
import type { WorkbenchController } from "./workbench-controller.js";
import type { DesignSession } from "./workbench-design-session.js";
import { designShareListActions, designShareManager, type DesignShareManager, type DesignShareMember, type DesignShareView } from "./workbench-design-collaboration.js";
import "./workbench-design-sharing.css";

// Authenticated collaboration on one Baoyu document: only through this Host's
// signed App connection, to members of this conversation or the owner's other
// devices. No links, no LAN service. A joined copy has no offline fallback.
type Word = (zh: string, en: string) => string;
type GrantRole = "editor" | "commenter" | "viewer" | "none";
export const shareRoleLabel = (role: string, word: Word) => role === "owner" ? word("所有者", "Owner") : role === "editor" ? word("可编辑", "Can edit") : role === "commenter" ? word("可评论", "Can comment") : role === "viewer" ? word("仅查看", "View only") : word("不共享", "Not shared");
export function shareErrorText(error: unknown, word: Word) {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : "";
  if (code === "design_share_source_offline") return word("共享设备当前离线，暂时无法同步。", "The sharing device is offline; nothing can sync right now.");
  if (code === "design_share_disconnected" || code === "design_share_app_unavailable") return word("与主机的连接已断开。重新连接后点「重新加入」。", "The connection to the Host dropped. Rejoin once it is back.");
  if (code === "design_share_forbidden" || code === "design_share_revoked" || code === "design_share_not_member") return word("你没有这个共享的访问权限。", "You do not have access to this share.");
  if (code === "design_share_closed") return word("这个共享已经结束。", "This share has ended.");
  if (code === "design_share_limit" || code === "design_share_full") return word("共享人数或数量已达上限。", "The share limit has been reached.");
  if (code === "design_share_format_unsupported") return word("只有画布和 PPT 可以共享。", "Only canvases and PPTs can be shared.");
  if (code === "design_share_outcome_unknown") return word("结果未确认。请刷新列表后再试，不会重复执行。", "The result is not confirmed. Refresh and try again.");
  return word("操作没有完成，请重试。", "That did not complete. Try again.");
}
/** One listed share. Open when this device may join it; owners can also end it here
 * or from another of their devices, including a share whose document or window is gone
 * (for example, deleted while offline). Ending asks first and never deletes a design. */
export function DesignShareRow({ share, word, disabled, ending, onOpen, onEnding, onEnd }: { share: DesignShareView; word: Word; disabled: boolean; ending: boolean; onOpen(): void; onEnding(value: boolean): void; onEnd(): void }) {
  const actions = designShareListActions(share);
  return <li className={ending ? "design-sharing-ending" : undefined}>
    <span><strong>{share.title}</strong><span className="design-sharing-muted"> · {share.ownerName} · {shareRoleLabel(share.role, word)} · {share.sourceOnline ? word("源设备在线", "Source online") : word("源设备离线", "Source offline")}</span></span>
    {actions.open && <button disabled={disabled} onClick={onOpen}>{word("打开", "Open")}</button>}
    {actions.end && !ending && <button className="danger" disabled={disabled} aria-label={word(`结束共享：${share.title}`, `End share: ${share.title}`)} onClick={() => onEnding(true)}>{word("结束共享", "End share")}</button>}
    {actions.end && ending && <div className="design-sharing-confirm" role="alertdialog" aria-label={word(`结束共享：${share.title}`, `End share: ${share.title}`)}>
      <p>{word("结束后所有人都会失去访问，这个共享不能再恢复。不会删除任何设计。", "Everyone loses access and this share cannot be reopened. No design is deleted.")}</p>
      <div className="design-sharing-actions"><button disabled={disabled} onClick={() => onEnding(false)}>{word("取消", "Cancel")}</button><button className="danger" disabled={disabled} onClick={onEnd}>{word("结束共享", "End share")}</button></div>
    </div>}
  </li>;
}

export function WorkbenchDesignSharing({ controller, session, title }: { controller: WorkbenchController; session: DesignSession; title: string }) {
  const locale = useLocale(), word: Word = (zh, en) => locale === "en" ? en : zh;
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
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(""); try { await work(); } catch (cause) { setError(shareErrorText(cause, word)); } finally { setBusy(false); } };
  const refresh = () => run(async () => { const [list, people] = await Promise.all([manager.list(conversationId), manager.members(conversationId)]); setShares(list); setMembers(people); });
  const toggle = () => { if (open) { setOpen(false); setConfirmClose(false); setEnding(undefined); return; } setOpen(true); void refresh(); };
  const grants = new Map((entry?.view.members ?? []).map(member => [member.userId, member.role]));
  const others = (members ?? []).filter(member => !member.you);
  const sharedWithMe = (shares ?? []).filter(share => !share.onThisDevice && share.shareId !== entry?.view.shareId);
  // This device's other shares, including ones whose document or window is gone: owners can end them here.
  const fromThisDevice = (shares ?? []).filter(share => share.onThisDevice && share.shareId !== entry?.view.shareId);
  const row = (share: DesignShareView) => <DesignShareRow key={share.shareId} share={share} word={word} disabled={busy || !online} ending={ending === share.shareId}
    onOpen={() => void run(async () => { await manager.join(share, { windowId, user }); setViewing(share.shareId); setOpen(false); })}
    onEnding={value => setEnding(value ? share.shareId : undefined)} onEnd={() => void run(async () => { await manager.closeShare(share.shareId); setEnding(undefined); await refresh(); })}/>;
  const shareable = format === "canvas" || format === "slides";
  return <span className="design-sharing">
    <button disabled={busy && !open} aria-expanded={open} onClick={toggle} title={entry ? (entry.source.attached ? word("正在共享", "Sharing") : word("共享已暂停或离线", "Sharing paused or offline")) : word("共享与协作", "Share and collaborate")}>
      <Users size={14}/>{word("共享", "Share")}{entry ? (entry.source.attached && online ? " ●" : " ○") : ""}
    </button>
    {open && <div role="dialog" aria-label={word("共享与协作", "Share and collaborate")} data-workbench-overlay className="design-sharing-panel">
      <section>
        <div className="design-sharing-head"><strong>{word("这个设计", "This design")}</strong><button className="icon" aria-label={word("关闭", "Close")} onClick={toggle}><X size={14}/></button></div>
        {!online && <p role="alert">{word("当前未连接主机，无法共享或加入。", "Not connected to the Host; sharing is unavailable.")}</p>}
        {!entry ? <>
          <p className="design-sharing-muted">{word("与本对话的成员或你的其他设备一起编辑。只经过已登录的主机连接，不生成链接；这台设备离线时无法同步。", "Edit together with members of this conversation or your other devices. Only through the signed-in Host connection, no links; nothing syncs while this device is offline.")}</p>
          {shareable ? <button className="primary" disabled={busy || !online} onClick={() => void run(async () => { await manager.share(session, { conversationId, windowId, title }); await refresh(); })}>{word("开始共享", "Start sharing")}</button>
            : <p className="design-sharing-muted">{shareErrorText(Object.assign(new Error("design_share_format_unsupported"), { code: "design_share_format_unsupported" }), word)}</p>}
        </> : <>
          <p role="status">{entry.source.attached && online ? word("正在从这台设备共享。", "Sharing from this device.") : word("已离线：恢复连接后会自动从这台设备重新提供。", "Offline: this device will serve again when the connection returns.")}</p>
          <p className="design-sharing-muted">{word("你的其他设备可在「共享给我的」中打开。", "Your other devices can open it from “Shared with me”.")}</p>
          {members === undefined ? <p className="design-sharing-muted">{word("正在读取对话成员…", "Loading conversation members…")}</p>
            : !others.length ? <p className="design-sharing-muted">{word("这个对话里没有其他成员。", "No other members in this conversation.")}</p>
            : <ul className="design-sharing-members">{others.map(member => <li key={member.userId}><span>{member.name || member.userId}</span>
              <select aria-label={word(`${member.name} 的权限`, `Access for ${member.name}`)} disabled={busy || !online} value={grants.get(member.userId) ?? "none"}
                onChange={event => { const role = event.target.value as GrantRole; void run(() => manager.grant(session, member.userId, role === "none" ? null : role)); }}>
                {(["none", "viewer", "commenter", "editor"] as const).map(role => <option key={role} value={role}>{shareRoleLabel(role, word)}</option>)}
              </select></li>)}</ul>}
          {confirmClose ? <div className="design-sharing-confirm" role="alertdialog" aria-label={word("停止共享", "Stop sharing")}>
            <p>{word("停止后所有人都会失去访问，这个共享不能再恢复（可以重新共享为新的共享）。", "Everyone loses access and this share cannot be reopened (you can share again as a new share).")}</p>
            <div className="design-sharing-actions"><button disabled={busy} onClick={() => setConfirmClose(false)}>{word("取消", "Cancel")}</button><button className="danger" disabled={busy} onClick={() => void run(async () => { await manager.close(session); setConfirmClose(false); await refresh(); })}>{word("停止共享", "Stop sharing")}</button></div>
          </div> : <div className="design-sharing-actions">
            <button disabled={busy} onClick={() => void run(() => manager.pause(session))}>{word("暂停（本窗口）", "Pause (this window)")}</button>
            <button className="danger" disabled={busy || !online} onClick={() => setConfirmClose(true)}>{word("停止共享", "Stop sharing")}</button>
          </div>}
        </>}
      </section>
      <section>
        <div className="design-sharing-head"><strong>{word("共享给我的", "Shared with me")}</strong><button className="icon" disabled={busy || !online} aria-label={word("刷新", "Refresh")} onClick={() => void refresh()}><RotateCw size={14}/></button></div>
        {shares === undefined ? <p className="design-sharing-muted">{word("正在读取…", "Loading…")}</p> : !sharedWithMe.length ? <p className="design-sharing-muted">{word("这个对话里暂时没有共享给你的设计。", "Nothing in this conversation is shared with you yet.")}</p>
          : <ul className="design-sharing-list">{sharedWithMe.map(row)}</ul>}
        {!!fromThisDevice.length && <><p className="design-sharing-muted">{word("这台设备共享的其他设计", "Other shares from this device")}</p><ul className="design-sharing-list">{fromThisDevice.map(row)}</ul></>}
      </section>
      {error && <p role="alert">{error}</p>}
    </div>}
    {viewing && <SharedDesignViewer manager={manager} shareId={viewing} online={online} word={word} onClose={() => setViewing(undefined)}/>}
  </span>;
}

/** A joined copy in its own full-window layer above the Workbench. It is not a
 * modal/menu, so the design frame stays visible; App dialogs still hide it. */
function SharedDesignViewer({ manager, shareId, online, word, onClose }: { manager: DesignShareManager; shareId: string; online: boolean; word: Word; onClose(): void }) {
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const entry = manager.mirrorFor(shareId), state = entry?.mirror.state(), surface = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false), [leaveFailed, setLeaveFailed] = useState(false);
  const usable = !!entry && !!state && !state.disconnected && !state.revoked;
  useEffect(() => { if (usable && entry && surface.current) return designFrame(entry.mirror.session).attach(surface.current, setError, () => {}); }, [usable, entry]);
  if (!entry || !state) return null;
  // Leave saves the last edits while this copy can still write. If that fails the
  // copy stays open (retry, or leave without saving); it is never reported as saved.
  const leave = async (discard = false) => {
    setBusy(true); setLeaveFailed(false);
    try { await manager.leave(shareId, { discard }); setBusy(false); onClose(); }
    catch { setBusy(false); setLeaveFailed(true); }
  };
  const rejoin = async () => { setBusy(true); setError(undefined); try { await entry.mirror.resume(); } catch (cause) { setError(shareErrorText(cause, word)); } finally { setBusy(false); } };
  const people = state.peers.map(peer => peer.name || peer.userId);
  return createPortal(<div className="design-shared-viewer" role="region" aria-label={word(`共享的设计：${entry.view.title}`, `Shared design: ${entry.view.title}`)}>
    <header>
      <strong>{entry.view.title}</strong>
      <span className="design-sharing-muted">{entry.view.ownerName} · {shareRoleLabel(state.role, word)} · {state.sourceOnline ? word("源设备在线", "Source online") : word("源设备离线", "Source offline")}{people.length ? ` · ${people.join("、")}` : ""}</span>
      <span className="design-shared-viewer-actions">
        {state.disconnected && !state.revoked && <button disabled={busy || !online} onClick={() => void rejoin()}>{word("重新加入", "Rejoin")}</button>}
        {leaveFailed && <button disabled={busy} onClick={() => void leave(true)}>{word("不保存，直接离开", "Leave without saving")}</button>}
        <button disabled={busy} onClick={() => void leave()}><X size={14}/>{leaveFailed ? word("重试保存并离开", "Retry save and leave") : word("离开", "Leave")}</button>
      </span>
    </header>
    {state.revoked ? <p role="alert">{word("你的访问已被撤销或共享已结束。", "Your access was revoked or the share ended.")}</p>
      : state.disconnected ? <p role="alert">{word("连接已断开。重新加入后继续；断开期间不会在本机保存修改。", "Disconnected. Rejoin to continue; nothing is saved on this device meanwhile.")}</p>
      : !state.sourceOnline ? <p role="status">{word("源设备离线：可以查看，保存会失败。", "The source device is offline: you can look, but saving fails.")}</p>
      : <p className="design-shared-viewer-note">{word("这里的评论会同步给所有者，但不能从这里发给 Bot；需要 Bot 处理时，请在共享它的设备上发送。", "Comments here sync to the owner, but cannot be sent to a Bot from here; send them from the device that shares this design.")}</p>}
    {leaveFailed && <p role="alert">{word("最后的修改没能保存，副本仍然打开。可以重试，或不保存直接离开。", "Your last changes could not be saved, so the copy stays open. Retry, or leave without saving.")}</p>}
    {error && <p role="alert">{word("编辑器尚未就绪或保存失败。", "The editor is not ready or a save failed.")}</p>}
    <div ref={surface} className="design-shared-viewer-surface"/>
  </div>, document.body);
}

/** "Shared with me" without a local design open: for the Workbench + menu or
 * empty state (Root renders it; it owns no other Workbench behaviour). */
export function WorkbenchSharedDesigns({ controller, onClose }: { controller: WorkbenchController; onClose?(): void }) {
  const locale = useLocale(), word: Word = (zh, en) => locale === "en" ? en : zh;
  const connection = controller.connection;
  const subscribe = useCallback((listener: () => void) => connection.subscribe(listener), [connection]);
  const available = useSyncExternalStore(subscribe, () => !!connection.state.workbenchDesignShareAvailable);
  const online = useSyncExternalStore(subscribe, () => connection.state.status === "online");
  const manager = designShareManager(connection, connection.designShares);
  useSyncExternalStore(manager.subscribe, manager.getVersion);
  const [shares, setShares] = useState<DesignShareView[]>(), [busy, setBusy] = useState(false), [error, setError] = useState(""), [viewing, setViewing] = useState<string>(), [ending, setEnding] = useState<string>();
  const windowId = controller.getSnapshot().windowId, conversationId = controller.conversationId;
  const user = () => { const current = connection.state.user; return current ? { id: current.id, name: current.name } : undefined; };
  useEffect(() => { if (!available || !online) return; let live = true; manager.list(conversationId).then(list => { if (live) setShares(list); }, cause => { if (live) setError(shareErrorText(cause, word)); }); return () => { live = false; }; }, [available, online, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!available) return null;
  const visible = (shares ?? []).filter(share => !share.onThisDevice);
  // Shares from this device stay listed so their owner can end them without the document (e.g. deleted while offline).
  const fromThisDevice = (shares ?? []).filter(share => share.onThisDevice);
  const row = (share: DesignShareView) => <DesignShareRow key={share.shareId} share={share} word={word} disabled={busy || !online} ending={ending === share.shareId}
    onOpen={() => { setBusy(true); setError(""); manager.join(share, { windowId, user }).then(() => setViewing(share.shareId), cause => setError(shareErrorText(cause, word))).finally(() => setBusy(false)); }}
    onEnding={value => setEnding(value ? share.shareId : undefined)}
    onEnd={() => { setBusy(true); setError(""); manager.closeShare(share.shareId).then(async () => { setEnding(undefined); setShares(await manager.list(conversationId)); }).catch(cause => setError(shareErrorText(cause, word))).finally(() => setBusy(false)); }}/>;
  return <div className="design-sharing-panel design-shared-list" role="region" aria-label={word("共享给我的项目", "Projects shared with me")}>
    <div className="design-sharing-head"><strong>{word("共享给我的", "Shared with me")}</strong>{onClose && <button className="icon" disabled={busy || !!viewing} aria-label={word("关闭", "Close")} onClick={onClose}><X size={14}/></button>}</div>
    {!online ? <p role="alert">{word("当前未连接主机。", "Not connected to the Host.")}</p> : shares === undefined ? <p className="design-sharing-muted">{word("正在读取…", "Loading…")}</p>
      : !visible.length ? <p className="design-sharing-muted">{word("这个对话里暂时没有共享给你的设计。", "Nothing in this conversation is shared with you yet.")}</p>
      : <ul className="design-sharing-list">{visible.map(row)}</ul>}
    {online && !!fromThisDevice.length && <><p className="design-sharing-muted">{word("这台设备共享的设计", "Shared from this device")}</p><ul className="design-sharing-list">{fromThisDevice.map(row)}</ul></>}
    {error && <p role="alert">{error}</p>}
    {viewing && <SharedDesignViewer manager={manager} shareId={viewing} online={online} word={word} onClose={() => setViewing(undefined)}/>}
  </div>;
}
