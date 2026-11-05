import { useConversationBulk } from './ConversationBulkSelection.js';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, ArrowUpToLine, Check, ChevronDown, ChevronRight, Folder, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { conversationFolderOrder, emptyConversationFolders, isFolderPinned, type FolderEdit } from '../../src/client-protocol/conversation-folders.js';
import type { HubConnection } from './connection.js';
import type { InboxRow } from './conversation-inbox.js';
import { HostSourceBadge } from './HostSourceBadge.js';
import { FolderOrderEditor, useFolderOrder } from './FolderOrderEditor.js';
import { CreationDialog } from './CreationDialog.js';
import { DesktopMenu } from './DesktopMenu.js';
import { RuntimeHostContext } from './RuntimeHost.js';
import { SidebarListOptions, SidebarListSettings } from './SidebarListOptions.js';
import { createPortal } from 'react-dom';
import { useConversationHold } from './useConversationHold.js';
import { t, useLocale } from './i18n.js';
import './conversation-folders.css';

function useFolders(connection: HubConnection) {
  return useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
}
function useFolderSave(connection: HubConnection) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const save = async (edit: FolderEdit, done: () => void, revision?: number) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try { await connection.changeConversationFolders(edit, revision); if (alive.current) done(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t('操作失败')); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return { busy, error, setError, save };
}

type FolderHost = { id: string; name: string; connection: HubConnection };
export function FolderListOptions({ children, options, hosts, defaultConnection, visible, scope }: { children: ReactNode; options: ReactNode; hosts: FolderHost[]; defaultConnection?: HubConnection; visible: boolean; scope: string }) {
  const bulk = useConversationBulk();
  const trigger = useRef<HTMLElement | null>(null);
  const [manager, setManager] = useState<FolderHost>();
  const current = manager && hosts.find(host => host.connection === manager.connection);
  useEffect(() => { setManager(undefined); }, [visible, scope, bulk?.active]);
  useEffect(() => { if (manager && !current) setManager(undefined); }, [manager, current]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)'), close = () => setManager(undefined);
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  const manageFolders = hosts.length ? (element: HTMLElement | null, connection?: HubConnection) => {
    const hostId = element?.closest<HTMLElement>('[data-host-id]')?.dataset.hostId;
    const host = connection ? hosts.find(host => host.connection === connection) : hostId ? hosts.find(host => host.id === hostId) : hosts.find(host => host.connection === defaultConnection) ?? hosts[0];
    if (!visible || bulk?.active || !host) return;
    trigger.current = element; setManager(host);
  } : undefined;
  return <><SidebarListOptions options={options} visible={visible} disabled={bulk?.active} scope={scope} manageFolders={manageFolders}>{children}</SidebarListOptions>
    {visible && !bulk?.active && current && createPortal(<RuntimeHostContext.Provider value={current.name}><FolderManager connection={current.connection} initialView="manage" returnFocus={trigger} close={() => setManager(undefined)}/></RuntimeHostContext.Provider>, document.body)}
  </>;
}

type RenameFolder = { id: string; name: string; revision?: number };
/** Collapsed folders per host. A tab switch remounts the phone list and the
 * App can restart; neither should silently re-expand a folder the user closed.
 * Only presentation state (host key + folder IDs) is kept, in localStorage. */
const COLLAPSED_FOLDERS_KEY = "tarobot-collapsed-folders-v1";
type CollapsedFolders = Record<string, Record<string, true>>;
const noCollapsedFolders: Record<string, true> = Object.freeze({}) as Record<string, true>;
const collapseListeners = new Set<() => void>();
let collapsedFolders: CollapsedFolders | undefined;
function readCollapsedFolders(): CollapsedFolders {
  if (collapsedFolders) return collapsedFolders;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) ?? "{}");
    collapsedFolders = value && typeof value === "object" && !Array.isArray(value) ? value as CollapsedFolders : {};
  } catch { collapsedFolders = {}; }
  return collapsedFolders;
}
function setFolderCollapsed(host: string, key: string, folded: boolean): void {
  const all = readCollapsedFolders(), next = { ...(all[host] ?? {}) };
  if (folded) next[key] = true; else delete next[key];
  collapsedFolders = { ...all, [host]: next };
  try { localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(collapsedFolders)); } catch { /* Memory still keeps this session's choice. */ }
  for (const notify of collapseListeners) notify();
}
const subscribeCollapsedFolders = (notify: () => void) => { collapseListeners.add(notify); return () => { collapseListeners.delete(notify); }; };
/** Both layouts share membership/order. Collapsing affects presentation only;
 * active search and unread/attention filters always reveal matching rows. */
export function FolderSections({ connection, rows, renderRow, filtered = false, holdActions = false, visible, hostName, showHostBadge = false }: { connection: HubConnection; rows: InboxRow[]; renderRow: (row: InboxRow) => ReactNode; filtered?: boolean; holdActions?: boolean; visible: boolean; hostName?: string; showHostBadge?: boolean }) {
  useLocale(); const bulk = useConversationBulk(); const state = useFolders(connection), prefix = useId();
  const collapseHost = connection.identity.hubPublicKey ?? "";
  const collapsed = useSyncExternalStore(subscribeCollapsedFolders, () => readCollapsedFolders()[collapseHost] ?? noCollapsedFolders);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<RenameFolder>();
  const [action, setAction] = useState<{ id: string | null; point?: { x: number; y: number } }>();
  const folders = state.conversationFolders?.folders ?? [];
  useConversationHold(root, `${filtered}`, visible && !bulk?.active && holdActions && !!folders.length, heading => {
    trigger.current = heading;
    setAction({ id: heading.dataset.renameFolderId || null });
  }, '.folder-heading[data-rename-folder-id]');
  useEffect(() => { setRenaming(undefined); setAction(undefined); }, [connection, visible, filtered]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)'), close = () => { setRenaming(undefined); setAction(undefined); };
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  useEffect(() => {
    if (renaming && !folders.some(folder => folder.id === renaming.id)) setRenaming(undefined);
    if (action?.id && !folders.some(folder => folder.id === action.id)) setAction(undefined);
  }, [renaming, action, folders]);
  const openActions = (heading: HTMLElement, id: string | null, point?: { x: number; y: number }) => {
    if (!visible || bulk?.active) return;
    trigger.current = heading; setAction({ id, point: holdActions ? undefined : point });
  };
  // Combined lists that identify sources on folder headings also need the
  // system Unfiled heading for a host with no custom folders. This creates no
  // folder metadata and keeps every action bound to the original connection.
  if (!folders.length && !showHostBadge) return <>{rows.map(row => <div key={row.key}>{renderRow(row)}</div>)}</>;
  const assignments = new Map(state.conversationFolders?.assignments.map(a => [a.conversationId, a.folderId]));
  const known = new Set(folders.map(f => f.id));
  return <div className="folder-sections" ref={root}>{conversationFolderOrder(state.conversationFolders ?? emptyConversationFolders()).map(id => {
    const folder = id === null ? { id: '', name: t('未分组') } : folders.find(folder => folder.id === id)!;
    const children = rows.filter(row => (known.has(assignments.get(row.conversation.id) ?? '') ? assignments.get(row.conversation.id) : '') === folder.id);
    if (filtered && !children.length) return null;
    const key = folder.id || 'unfiled', folded = !filtered && !!collapsed[key];
    const unread = children.reduce((sum, row) => sum + row.unread, 0);
    const attention = children.some(row => row.attention.length > 0);
    const pinned = isFolderPinned(state.conversationFolders ?? emptyConversationFolders(), id);
    return <section className="conversation-folder" data-folder-id={folder.id} data-pinned={pinned || undefined} key={key}>
      <button type="button" className="folder-heading" data-rename-folder-id={folder.id} aria-expanded={!folded} aria-controls={`${prefix}_${key}`} onClick={() => setFolderCollapsed(collapseHost, key, !folded)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openActions(event.currentTarget, id, { x: event.clientX || rect.left, y: event.clientY || rect.bottom }); }}
        onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openActions(event.currentTarget, id, { x: rect.left, y: rect.bottom }); } }}>
        {folded ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span className="folder-label"><span className="folder-name">{folder.name}</span><span className="folder-count">{children.length}</span>{pinned && <Pin size={12} className="folder-pin" role="img" aria-label={t('已置顶')}/>}</span>{showHostBadge && hostName && <HostSourceBadge name={hostName}/>}{folded && unread > 0 && <b className="unread-badge" role="img" aria-label={t("{0} 条新消息", unread)} title={t("{0} 条新消息", unread)}>{unread}</b>}{folded && attention && <span className="folder-attention" role="img" aria-label={t('需要处理')}/>}
      </button>
      <div id={`${prefix}_${key}`} hidden={folded}>{children.length ? children.map(row => <div key={row.key}>{renderRow(row)}</div>) : <p className="folder-empty">{t('暂无对话')}</p>}</div>
    </section>;
  })}{visible && action && <RuntimeHostContext.Provider value={hostName}><FolderActions key={action.id ?? "unfiled"} connection={connection} folderId={action.id} point={action.point} returnFocus={trigger} close={() => setAction(undefined)} rename={folder => { setAction(undefined); setRenaming(folder); }}/></RuntimeHostContext.Provider>}{visible && renaming && <RuntimeHostContext.Provider value={hostName}><FolderManager connection={connection} initialView="rename" initialFolder={renaming} returnFocus={trigger} close={() => setRenaming(undefined)}/></RuntimeHostContext.Provider>}</div>;
}

function FolderActions({ connection, folderId, point, returnFocus, close, rename }: { connection: HubConnection; folderId: string | null; point?: { x: number; y: number }; returnFocus: RefObject<HTMLElement | null>; close: () => void; rename: (folder: RenameFolder) => void }) {
  const state = useFolders(connection), { busy, error, save } = useFolderSave(connection);
  const menuId = useId();
  const folders = state.conversationFolders ?? emptyConversationFolders();
  const order = conversationFolderOrder(folders), index = order.indexOf(folderId);
  const folder = folders.folders.find(folder => folder.id === folderId);
  const name = folderId === null ? t('未分组') : folder?.name ?? '';
  const allowed = state.status === 'online' && !!state.foldersAvailable;
  const canReorder = allowed && state.folderReorderAvailable && index >= 0;
  const pinned = isFolderPinned(folders, folderId);
  const peers = order.filter(id => isFolderPinned(folders, id) === pinned);
  const first = order.indexOf(peers[0]!), last = order.indexOf(peers.at(-1)!);
  const done = () => { returnFocus.current?.focus({ preventScroll: true }); close(); };
  const move = (target: number) => {
    if (!canReorder || busy || target < first || target > last || target === index) return;
    const next = [...order]; next.splice(target, 0, ...next.splice(index, 1));
    void save({ type: 'reorder', folderIds: next }, done, folders.revision);
  };
  const contents = <>
    <p className="folder-action-name">{name}</p>
    <button type="button" data-menu-keep disabled={!allowed || !state.folderPinAvailable || busy} onClick={() => { void save({ type: 'pin', id: folderId, pinned: !pinned }, done, folders.revision); }}>{pinned ? <PinOff size={18}/> : <Pin size={18}/>}<span>{pinned ? t('取消置顶') : t('置顶分组')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === first} onClick={() => move(index - 1)}><ArrowUp size={18}/><span>{t('上移一位')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === last} onClick={() => move(index + 1)}><ArrowDown size={18}/><span>{t('下移一位')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === first} onClick={() => move(first)}><ArrowUpToLine size={18}/><span>{folders.pinnedFolderIds?.length ? t('移到同类分组最上面') : t('移到最上面')}</span></button>
    {folder && <button type="button" disabled={!allowed || busy} onClick={() => rename({ ...folder, revision: folders.revision })}><Pencil size={18}/><span>{t('重命名分组')}</span></button>}
    {!canReorder && <p className="folder-action-note">{state.status !== 'online' ? t('连接恢复后可调整分组顺序。') : t('此主机尚未支持调整分组顺序，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
    {allowed && !state.folderPinAvailable && <p className="folder-action-note">{t('此主机尚未支持置顶分组，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
    {error && <p className="error-text folder-action-note" role="alert">{error}</p>}
    {point && <SidebarListSettings trigger={returnFocus} connection={connection}/>}
  </>;
  return point ? <DesktopMenu id={menuId} label={t('分组操作')} open close={() => { if (!busy) close(); }} trigger={returnFocus} placement="down-start" point={point} className="folder-actions-menu sidebar-list-menu">{contents}</DesktopMenu>
    : <CreationDialog title={t('分组操作')} closeLabel={t('关闭分组')} className="folder-dialog folder-actions-dialog" busy={busy} returnFocus={returnFocus} close={close}><div className="folder-action-list">{contents}</div></CreationDialog>;
}

export function MoveToFolder({ connection, conversationId, showLayoutHint = false, returnFocus, close }: { connection: HubConnection; conversationId: string; showLayoutHint?: boolean; returnFocus: RefObject<HTMLElement | null>; close: () => void }) {
  useLocale(); const state = useFolders(connection), { busy, error, setError, save } = useFolderSave(connection);
  const [creating, setCreating] = useState(false), [name, setName] = useState('');
  const folders = state.conversationFolders?.folders ?? [];
  const current = state.conversationFolders?.assignments.find(a => a.conversationId === conversationId)?.folderId ?? '';
  const allowed = state.status === 'online' && !!state.foldersAvailable;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (creating) input.current?.focus(); }, [creating]);
  return <CreationDialog title={t('移至分组')} closeLabel={t('关闭分组')} className="folder-dialog" returnFocus={returnFocus} busy={busy} close={close}>
    {showLayoutHint && <p className="muted">{t('分组在「按对话」列表中显示')}</p>}
    <div className="folder-choices">{conversationFolderOrder(state.conversationFolders ?? emptyConversationFolders()).map(id => id === null ? { id: '', name: t('未分组') } : folders.find(folder => folder.id === id)!).map(folder => <button type="button" key={folder.id} disabled={!allowed || busy} aria-pressed={current === folder.id} onClick={() => { if (folder.id === current) close(); else void save({ type: 'move', conversationId, folderId: folder.id || null }, close); }}><Folder size={18}/><span>{folder.name}</span>{current === folder.id && <Check size={18}/>}</button>)}</div>
    {creating ? <form className="folder-name-form" onSubmit={event => { event.preventDefault(); if (name.trim()) void save({ type: 'create', id: crypto.randomUUID(), name: name.trim(), conversationId }, close); }}>
      <label>{t('分组名称')}<input ref={input} value={name} maxLength={48} required disabled={busy} onChange={e => setName(e.target.value)} onKeyDown={imeEnter}/></label><button type="submit" className="primary" disabled={busy || !allowed || !name.trim()}>{t('创建并移入')}</button>
    </form> : <button type="button" className="folder-new-choice" disabled={busy || !allowed} onClick={() => { setError(''); setCreating(true); }}><Plus size={18}/>{t('新建分组')}</button>}
    {!allowed && <p className="muted">{t('连接恢复或主机升级后可编辑分组')}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </CreationDialog>;
}

function imeEnter(event: React.KeyboardEvent<HTMLInputElement>) { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }
export function FolderManager({ connection, initialView, initialFolder, returnFocus, close }: { connection: HubConnection; initialView: 'manage' | 'rename'; initialFolder?: RenameFolder; returnFocus: RefObject<HTMLElement | null>; close: () => void }) {
  const state = useFolders(connection), { busy, error, setError, save } = useFolderSave(connection);
  const ordering = useFolderOrder(connection);
  const [view, setView] = useState<'create' | 'manage' | 'rename' | 'delete'>(initialView);
  const [name, setName] = useState(initialFolder?.name ?? ''), [target, setTarget] = useState(initialFolder?.id ?? ''), [revision, setRevision] = useState(initialFolder?.revision);
  const input = useRef<HTMLInputElement>(null);
  const folders = state.conversationFolders?.folders ?? [], folder = folders.find(f => f.id === target);
  const allowed = state.status === 'online' && !!state.foldersAvailable;
  const canEdit = allowed && !busy && !ordering.stale;
  const canReorder = canEdit && !!state.folderReorderAvailable;
  const back = () => { if (initialView === 'rename') { close(); return; } setError(''); setView('manage'); setTarget(''); setRevision(undefined); };
  const edit = (change: FolderEdit) => {
    const expected = revision ?? ordering.base.revision;
    void save(change, () => { ordering.acceptEdit(expected); back(); }, expected).then(() => setRevision(connection.state.conversationFolders?.revision));
  };
  useEffect(() => { if (view === 'create' || view === 'rename') input.current?.select(); }, [view]);
  const title = view === 'create' ? t('新建分组') : view === 'rename' ? t('重命名分组') : view === 'delete' ? t('删除分组') : t('管理分组');
  return <CreationDialog mobilePage onBack={view === "manage" ? undefined : back} title={title} closeLabel={t('关闭分组')} className="folder-dialog folder-manager-dialog" returnFocus={returnFocus} busy={busy} close={close}>
    {view === 'manage' ? <>
      <p className="folder-order-hint muted">{t('拖动手柄排序后保存；点“…”重命名或删除分组。')}</p>
      {!!ordering.base.pinnedFolderIds?.length && <p className="folder-order-hint muted">{t('置顶分组始终在前；可在置顶或普通分组内排序。')}</p>}
      <FolderOrderEditor ordering={ordering} canEdit={canEdit} canReorder={canReorder} canPin={canEdit && !!state.folderPinAvailable}
        pin={(id, pinned) => { const expected = ordering.base.revision; void save({ type: 'pin', id, pinned }, () => ordering.acceptEdit(expected), expected); }}
        rename={(id, value) => { setTarget(id); setName(value); setRevision(ordering.base.revision); setView('rename'); }}
        remove={id => { setTarget(id); setRevision(ordering.base.revision); setView('delete'); }}/>
      <button type="button" className="folder-new-choice" disabled={!canEdit} onClick={() => { setError(''); setName(''); setRevision(ordering.base.revision); setView('create'); }}><Plus size={18}/>{t('新建分组')}</button>
      {ordering.stale && <div className="folder-order-conflict"><p role="status">{t('分组已在其他设备更新，请载入最新顺序后调整。')}</p><button type="button" disabled={busy} onClick={() => { ordering.reload(); setError(''); }}>{t('载入最新顺序')}</button></div>}
      {allowed && !state.folderReorderAvailable && <p className="muted" role="status">{t('此主机尚未支持调整分组顺序，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
      {allowed && !state.folderPinAvailable && <p className="muted" role="status">{t('此主机尚未支持置顶分组，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
      <div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={close}>{t('取消')}</button><button type="button" className="primary" disabled={!canReorder || !ordering.changed} onClick={() => { void save({ type: 'reorder', folderIds: ordering.order }, close, ordering.base.revision); }}>{busy ? t('正在保存…') : t('保存')}</button></div>
    </> : view === 'delete' ? <><p>{folder ? t('删除「{0}」分组？', folder.name) : t('此分组已删除，请重新选择')}</p><p className="muted">{t('对话将移回“未分组”，聊天记录保留。')}</p><div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={back}>{t('取消')}</button><button type="button" className="danger" disabled={busy || !allowed || !folder} onClick={() => edit({ type: 'delete', id: target })}>{t('删除分组')}</button></div></>
      : <form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; edit(view === 'create' ? { type: 'create', id: crypto.randomUUID(), name: name.trim() } : { type: 'rename', id: target, name: name.trim() }); }}>
        <label>{t('分组名称')}<input ref={input} value={name} maxLength={48} required disabled={busy} onChange={e => setName(e.target.value)} onKeyDown={imeEnter}/></label>
        <div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={back}>{t('取消')}</button><button type="submit" className="primary" disabled={busy || !allowed || !name.trim() || view === 'rename' && !folder}>{busy ? t('正在保存…') : t('保存')}</button></div>
      </form>}
    {!allowed && <p className="muted" role="status">{t('连接恢复或主机升级后可编辑分组')}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </CreationDialog>;
}
