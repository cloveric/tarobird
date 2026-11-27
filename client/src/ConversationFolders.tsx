import { useConversationBulk } from './ConversationBulkSelection.js';
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { ArrowDown, ArrowUp, ArrowUpToLine, Check, ChevronDown, ChevronRight, Folder, Pencil, Pin, PinOff, Plus } from 'lucide-react';
import { conversationFolderOrder, emptyConversationFolders, isFolderPinned, type FolderEdit } from '../../src/client-protocol/conversation-folders.js';
import type { HubConnection } from './connection.js';
import type { InboxRow } from './conversation-inbox.js';
import {
  applyCrossHostFolderMove,
  applyCrossHostFolderPin,
  applySingleHostFolderReorder,
  commitCrossHostFolderOrder,
  crossHostFolderKey,
  folderHostIdentity,
  pruneCrossHostDeletedFolder,
  readCrossHostFolderOrder,
  recordCrossHostFolderPin,
  resolveCrossHostFolderOrder,
  saveCrossHostFolderOrder,
  type CrossHostFolderSource,
  type StoredCrossHostFolderOrder,
} from './cross-host-folder-order.js';
import { buildCrossHostFolderSources, useCrossHostFolderOrder, useCrossHostFolderOrderWriteError, useHostFolderUpdates } from './use-cross-host-folder-order.js';
import { HostSourceBadge } from './HostSourceBadge.js';
import { FolderOrderEditor, FolderOrderList, useFolderOrder, type FolderOrderRow } from './FolderOrderEditor.js';
import { CreationDialog } from './CreationDialog.js';
import { DesktopMenu } from './DesktopMenu.js';
import { RuntimeHostContext } from './RuntimeHost.js';
import { SidebarListOptions, SidebarListSettings } from './SidebarListOptions.js';
import { createPortal } from 'react-dom';
import { useConversationHold } from './useConversationHold.js';
import { t, useLocale } from './i18n.js';
import './conversation-folders.css';

export type CrossHostFolderActionsContext = {
  sources: CrossHostFolderSource[];
  visibleKeys: string[];
  itemKey: string;
  hasAnyPinned: boolean;
};

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

export type FolderHost = { id: string; name: string; connection: HubConnection };
export function FolderListOptions({ children, options, hosts, defaultConnection, visible, scope, combined = false }: {
  children: ReactNode; options: ReactNode; hosts: FolderHost[]; defaultConnection?: HubConnection; visible: boolean; scope: string; combined?: boolean;
}) {
  const bulk = useConversationBulk();
  const trigger = useRef<HTMLElement | null>(null);
  const [manager, setManager] = useState<{ mode: 'single'; host: FolderHost } | { mode: 'cross'; defaultHostId?: string }>();
  const current = manager?.mode === 'single' ? hosts.find(host => host.connection === manager.host.connection) : undefined;
  useEffect(() => { setManager(undefined); }, [visible, scope, bulk?.active, combined]);
  useEffect(() => { if (manager?.mode === 'single' && !current) setManager(undefined); }, [manager, current]);
  useEffect(() => { if (manager?.mode === 'cross' && !hosts.length) setManager(undefined); }, [manager, hosts.length]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)'), close = () => setManager(undefined);
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  const manageFolders = hosts.length ? (element: HTMLElement | null, connection?: HubConnection) => {
    const hostId = element?.closest<HTMLElement>('[data-host-id]')?.dataset.hostId;
    const host = connection ? hosts.find(item => item.connection === connection) : hostId ? hosts.find(item => item.id === hostId) : hosts.find(item => item.connection === defaultConnection) ?? hosts[0];
    if (!visible || bulk?.active) return;
    trigger.current = element;
    // The combined view can have only one ready host while another is opening
    // or being removed. Its manager must still edit the same local order.
    if (combined) {
      setManager({ mode: 'cross', defaultHostId: host?.id });
      return;
    }
    if (!host) return;
    setManager({ mode: 'single', host });
  } : undefined;
  return <><SidebarListOptions options={options} visible={visible} disabled={bulk?.active} scope={scope} manageFolders={manageFolders}>{children}</SidebarListOptions>
    {visible && !bulk?.active && manager?.mode === 'single' && current && createPortal(<RuntimeHostContext.Provider value={current.name}><FolderManager connection={current.connection} initialView="manage" returnFocus={trigger} close={() => setManager(undefined)}/></RuntimeHostContext.Provider>, document.body)}
    {visible && !bulk?.active && manager?.mode === 'cross' && hosts.length > 0 && createPortal(<CrossHostFolderManager hosts={hosts} defaultHostId={manager.defaultHostId} returnFocus={trigger} close={() => setManager(undefined)}/>, document.body)}
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
export function FolderSections({ connection, hostId, rows, renderRow, filtered = false, holdActions = false, visible, hostName, showHostBadge = false, folderFilter, crossHost }: {
  connection: HubConnection; hostId?: string; rows: InboxRow[]; renderRow: (row: InboxRow) => ReactNode; filtered?: boolean; holdActions?: boolean; visible: boolean; hostName?: string; showHostBadge?: boolean; folderFilter?: string | null; crossHost?: CrossHostFolderActionsContext;
}) {
  useLocale(); const bulk = useConversationBulk(); const state = useFolders(connection), prefix = useId();
  const collapseHost = connection.identity.hubPublicKey ?? "";
  const collapsed = useSyncExternalStore(subscribeCollapsedFolders, () => readCollapsedFolders()[collapseHost] ?? noCollapsedFolders);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<RenameFolder>();
  const [action, setAction] = useState<{ id: string | null; point?: { x: number; y: number } }>();
  const folders = state.conversationFolders?.folders ?? [];
  useConversationHold(root, `${filtered}`, visible && !bulk?.active && holdActions && (!!folders.length || !!crossHost), heading => {
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
  if (!folders.length && !showHostBadge && folderFilter === undefined) return <>{rows.map(row => <div key={row.key}>{renderRow(row)}</div>)}</>;
  const assignments = new Map(state.conversationFolders?.assignments.map(a => [a.conversationId, a.folderId]));
  const known = new Set(folders.map(f => f.id));
  const ids = folderFilter !== undefined
    ? (folderFilter === null || known.has(folderFilter) ? [folderFilter] : [])
    : conversationFolderOrder(state.conversationFolders ?? emptyConversationFolders());
  return <div className="folder-sections" ref={root}>{ids.map(id => {
    const folder = id === null ? { id: '', name: t('未分组') } : folders.find(item => item.id === id);
    if (!folder) return null;
    const children = rows.filter(row => (known.has(assignments.get(row.conversation.id) ?? '') ? assignments.get(row.conversation.id) : '') === folder.id);
    if ((filtered || !folders.length && folderFilter !== undefined) && !children.length) return null;
    const key = folder.id || 'unfiled', folded = !filtered && !!collapsed[key];
    const unread = children.reduce((sum, row) => sum + row.unread, 0);
    const attention = children.some(row => row.attention.length > 0);
    const pinned = isFolderPinned(state.conversationFolders ?? emptyConversationFolders(), id);
    return <section className="conversation-folder" data-folder-id={folder.id} data-pinned={pinned || undefined} key={key}>
      <button type="button" className="folder-heading" data-host-id={hostId} data-rename-folder-id={folder.id} aria-expanded={!folded} aria-controls={`${prefix}_${key}`} onClick={() => setFolderCollapsed(collapseHost, key, !folded)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openActions(event.currentTarget, id, { x: event.clientX || rect.left, y: event.clientY || rect.bottom }); }}
        onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); openActions(event.currentTarget, id, { x: rect.left, y: rect.bottom }); } }}>
        {folded ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<span className="folder-label"><span className="folder-name">{folder.name}</span><span className="folder-count">{children.length}</span>{pinned && <Pin size={12} className="folder-pin" role="img" aria-label={t('已置顶')}/>}</span>{showHostBadge && hostName && <HostSourceBadge name={hostName}/>}{folded && unread > 0 && <b className="unread-badge" role="img" aria-label={t("{0} 条新消息", unread)} title={t("{0} 条新消息", unread)}>{unread}</b>}{folded && attention && <span className="folder-attention" role="img" aria-label={t('需要处理')}/>}
      </button>
      <div id={`${prefix}_${key}`} hidden={folded}>{children.length ? children.map(row => <div key={row.key}>{renderRow(row)}</div>) : <p className="folder-empty">{t('暂无对话')}</p>}</div>
    </section>;
  })}{visible && action && <RuntimeHostContext.Provider value={hostName}><FolderActions key={action.id ?? "unfiled"} connection={connection} folderId={action.id} hostName={hostName} showHostBadge={showHostBadge} crossHost={crossHost} point={action.point} returnFocus={trigger} close={() => setAction(undefined)} rename={folder => { setAction(undefined); setRenaming(folder); }}/></RuntimeHostContext.Provider>}{visible && renaming && <RuntimeHostContext.Provider value={hostName}><FolderManager connection={connection} initialView="rename" initialFolder={renaming} returnFocus={trigger} close={() => setRenaming(undefined)}/></RuntimeHostContext.Provider>}</div>;
}

function FolderActions({ connection, folderId, hostName, showHostBadge = false, crossHost, point, returnFocus, close, rename }: {
  connection: HubConnection; folderId: string | null; hostName?: string; showHostBadge?: boolean; crossHost?: CrossHostFolderActionsContext; point?: { x: number; y: number }; returnFocus: RefObject<HTMLElement | null>; close: () => void; rename: (folder: RenameFolder) => void;
}) {
  const state = useFolders(connection), { busy, error, save } = useFolderSave(connection);
  const crossHostOrder = useCrossHostFolderOrder();
  const menuId = useId();
  const folders = state.conversationFolders ?? emptyConversationFolders();
  const folder = folders.folders.find(item => item.id === folderId);
  const name = folderId === null ? t('未分组') : folder?.name ?? '';
  const allowed = state.status === 'online' && !!state.foldersAvailable;
  const pinned = isFolderPinned(folders, folderId);

  let index: number;
  let first: number;
  let last: number;
  let canReorder: boolean;
  let hasPinned: boolean;
  let singleOrder: (string | null)[] = [];

  if (crossHost) {
    const resolved = resolveCrossHostFolderOrder(crossHost.sources, crossHostOrder);
    const pinnedByKey = new Map(resolved.map(item => [item.key, item.pinned]));
    const visibleKeys = crossHost.visibleKeys;
    index = visibleKeys.indexOf(crossHost.itemKey);
    const peers = visibleKeys.filter(key => pinnedByKey.get(key) === pinned);
    first = peers.length ? visibleKeys.indexOf(peers[0]!) : -1;
    last = peers.length ? visibleKeys.indexOf(peers.at(-1)!) : -1;
    canReorder = index >= 0;
    hasPinned = crossHost.hasAnyPinned;
  } else {
    singleOrder = conversationFolderOrder(folders);
    index = singleOrder.indexOf(folderId);
    canReorder = allowed && !!state.folderReorderAvailable && index >= 0;
    const peers = singleOrder.filter(id => isFolderPinned(folders, id) === pinned);
    first = peers.length ? singleOrder.indexOf(peers[0]!) : -1;
    last = peers.length ? singleOrder.indexOf(peers.at(-1)!) : -1;
    hasPinned = !!folders.pinnedFolderIds?.length;
  }

  const done = () => { returnFocus.current?.focus({ preventScroll: true }); close(); };
  const doneAfterReorder = () => {
    close();
    requestAnimationFrame(() => returnFocus.current?.focus({ preventScroll: true }));
  };
  const move = (destination: 'up' | 'down' | 'top') => {
    if (!canReorder || busy) return;
    if (crossHost) {
      if ((destination === 'up' || destination === 'top') && index === first) return;
      if (destination === 'down' && index === last) return;
      applyCrossHostFolderMove(crossHost.sources, crossHost.itemKey, destination, crossHost.visibleKeys);
      doneAfterReorder();
      return;
    }
    const target = destination === 'top' ? first : destination === 'up' ? index - 1 : index + 1;
    if (target < first || target > last || target === index) return;
    const next = [...singleOrder]; next.splice(target, 0, ...next.splice(index, 1));
    const hostKey = folderHostIdentity(connection.identity);
    void save({ type: 'reorder', folderIds: next }, () => {
      if (hostKey && connection.state.conversationFolders) {
        applySingleHostFolderReorder(hostKey, connection.state.conversationFolders, next);
      }
      done();
    }, folders.revision);
  };
  const togglePin = () => {
    const sourcesBefore = crossHost?.sources;
    const targetKey = crossHost?.itemKey;
    const hostKey = folderHostIdentity(connection.identity);
    const singleSourceBefore = !crossHost && hostKey && connection.state.conversationFolders
      ? { hostId: hostKey, hostKey, hostName: hostName ?? '', folders: connection.state.conversationFolders, online: true, foldersAuthoritative: true }
      : undefined;
    void save({ type: 'pin', id: folderId, pinned: !pinned }, () => {
      if (sourcesBefore && targetKey) {
        applyCrossHostFolderPin(sourcesBefore, targetKey, !pinned);
        doneAfterReorder();
      } else {
        if (singleSourceBefore && hostKey) {
          const existing = readCrossHostFolderOrder();
          if (existing.pinned.length > 0 || existing.ordinary.length > 0) {
            applyCrossHostFolderPin([singleSourceBefore], crossHostFolderKey({ hostKey, folderId }), !pinned);
          }
        }
        done();
      }
    }, folders.revision);
  };

  const contents = <>
    {showHostBadge && hostName
      ? <div className="folder-action-header"><p className="folder-action-name">{name}</p><HostSourceBadge name={hostName}/></div>
      : <p className="folder-action-name">{name}</p>}
    <button type="button" data-menu-keep disabled={!allowed || !state.folderPinAvailable || busy} onClick={togglePin}>{pinned ? <PinOff size={18}/> : <Pin size={18}/>}<span>{pinned ? t('取消置顶') : t('置顶分组')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === first} onClick={() => move('up')}><ArrowUp size={18}/><span>{t('上移一位')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === last} onClick={() => move('down')}><ArrowDown size={18}/><span>{t('下移一位')}</span></button>
    <button type="button" data-menu-keep disabled={!canReorder || busy || index === first} onClick={() => move('top')}><ArrowUpToLine size={18}/><span>{hasPinned ? t('移到同类分组最上面') : t('移到最上面')}</span></button>
    {folder && <button type="button" disabled={!allowed || busy} onClick={() => rename({ ...folder, revision: folders.revision })}><Pencil size={18}/><span>{t('重命名分组')}</span></button>}
    {!crossHost && !canReorder && <p className="folder-action-note">{state.status !== 'online' ? t('连接恢复后可调整分组顺序。') : t('此主机尚未支持调整分组顺序，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
    {crossHost && !allowed && <p className="folder-action-note">{t('连接恢复或主机升级后可编辑分组')}</p>}
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
    const hostKey = folderHostIdentity(connection.identity);
    void save(change, () => {
      if (change.type === 'delete' && hostKey) pruneCrossHostDeletedFolder(hostKey, change.id);
      ordering.acceptEdit(expected);
      back();
    }, expected).then(() => setRevision(connection.state.conversationFolders?.revision));
  };
  useEffect(() => { if (view === 'create' || view === 'rename') input.current?.select(); }, [view]);
  const title = view === 'create' ? t('新建分组') : view === 'rename' ? t('重命名分组') : view === 'delete' ? t('删除分组') : t('管理分组');
  return <CreationDialog mobilePage onBack={view === "manage" ? undefined : back} title={title} closeLabel={t('关闭分组')} className="folder-dialog folder-manager-dialog" returnFocus={returnFocus} busy={busy} close={close}>
    {view === 'manage' ? <>
      <p className="folder-order-hint muted">{t('拖动手柄排序后保存；点“…”重命名或删除分组。')}</p>
      {!!ordering.base.pinnedFolderIds?.length && <p className="folder-order-hint muted">{t('置顶分组始终在前；可在置顶或普通分组内排序。')}</p>}
      <FolderOrderEditor ordering={ordering} canEdit={canEdit} canReorder={canReorder} canPin={canEdit && !!state.folderPinAvailable}
        pin={(id, pinned) => {
          const expected = ordering.base.revision;
          const hostKey = folderHostIdentity(connection.identity);
          const sourceBefore = hostKey && connection.state.conversationFolders
            ? { hostId: hostKey, hostKey, hostName: '', folders: connection.state.conversationFolders, online: true, foldersAuthoritative: true }
            : undefined;
          void save({ type: 'pin', id, pinned }, () => {
            ordering.acceptEdit(expected);
            if (sourceBefore && hostKey) {
              const existing = readCrossHostFolderOrder();
              if (existing.pinned.length > 0 || existing.ordinary.length > 0) {
                applyCrossHostFolderPin([sourceBefore], crossHostFolderKey({ hostKey, folderId: id }), pinned);
              }
            }
          }, expected);
        }}
        rename={(id, value) => { setTarget(id); setName(value); setRevision(ordering.base.revision); setView('rename'); }}
        remove={id => { setTarget(id); setRevision(ordering.base.revision); setView('delete'); }}/>
      <button type="button" className="folder-new-choice" disabled={!canEdit} onClick={() => { setError(''); setName(''); setRevision(ordering.base.revision); setView('create'); }}><Plus size={18}/>{t('新建分组')}</button>
      {ordering.stale && <div className="folder-order-conflict"><p role="status">{t('分组已在其他设备更新，请载入最新顺序后调整。')}</p><button type="button" disabled={busy} onClick={() => { ordering.reload(); setError(''); }}>{t('载入最新顺序')}</button></div>}
      {allowed && !state.folderReorderAvailable && <p className="muted" role="status">{t('此主机尚未支持调整分组顺序，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
      {allowed && !state.folderPinAvailable && <p className="muted" role="status">{t('此主机尚未支持置顶分组，请更新运行 Bot 的电脑上的 TaroBird。')}</p>}
      <div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={close}>{t('取消')}</button><button type="button" className="primary" disabled={!canReorder || !ordering.changed} onClick={() => {
        const hostKey = folderHostIdentity(connection.identity);
        void save({ type: 'reorder', folderIds: ordering.order }, () => {
          if (hostKey && connection.state.conversationFolders) {
            applySingleHostFolderReorder(hostKey, connection.state.conversationFolders, ordering.order);
          }
          close();
        }, ordering.base.revision);
      }}>{busy ? t('正在保存…') : t('保存')}</button></div>
    </> : view === 'delete' ? <><p>{folder ? t('删除「{0}」分组？', folder.name) : t('此分组已删除，请重新选择')}</p><p className="muted">{t('对话将移回“未分组”，聊天记录保留。')}</p><div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={back}>{t('取消')}</button><button type="button" className="danger" disabled={busy || !allowed || !folder} onClick={() => edit({ type: 'delete', id: target })}>{t('删除分组')}</button></div></>
      : <form onSubmit={event => { event.preventDefault(); if (!name.trim()) return; edit(view === 'create' ? { type: 'create', id: crypto.randomUUID(), name: name.trim() } : { type: 'rename', id: target, name: name.trim() }); }}>
        <label>{t('分组名称')}<input ref={input} value={name} maxLength={48} required disabled={busy} onChange={e => setName(e.target.value)} onKeyDown={imeEnter}/></label>
        <div className="folder-dialog-actions"><button type="button" disabled={busy} onClick={back}>{t('取消')}</button><button type="submit" className="primary" disabled={busy || !allowed || !name.trim() || view === 'rename' && !folder}>{busy ? t('正在保存…') : t('保存')}</button></div>
      </form>}
    {!allowed && <p className="muted" role="status">{t('连接恢复或主机升级后可编辑分组')}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
  </CreationDialog>;
}

type CrossHostEditTarget = { hostId: string; folderId: string; revision: number };
/** Unified folder manager for the combined multi-host view. Reordering updates
 * App-local cross-host display order without migrating folders or altering per-host
 * Hub sync contracts; create/rename/delete/pin route strictly to the owning host. */
export function CrossHostFolderManager({ hosts, defaultHostId, returnFocus, close }: {
  hosts: FolderHost[]; defaultHostId?: string; returnFocus: RefObject<HTMLElement | null>; close: () => void;
}) {
  useLocale();
  useHostFolderUpdates(hosts);
  const stored = useCrossHostFolderOrder();
  const writeError = useCrossHostFolderOrderWriteError();
  const [draft, setDraft] = useState<StoredCrossHostFolderOrder | undefined>();
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [view, setView] = useState<'manage' | 'create' | 'rename' | 'delete'>('manage');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [target, setTarget] = useState<CrossHostEditTarget | undefined>();
  const [name, setName] = useState('');
  const [createHostId, setCreateHostId] = useState('');
  const createHostSelectId = useId();
  const alive = useRef(true), saving = useRef(false), input = useRef<HTMLInputElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (view === 'create' || view === 'rename') input.current?.select(); }, [view]);

  const sources = buildCrossHostFolderSources(hosts);
  const hostById = new Map(hosts.map(host => [host.id, host]));
  const editableHosts = hosts.filter(host => host.connection.state.status === 'online' && !!host.connection.state.foldersAvailable);
  const syncSupported = hosts.some(host => host.connection.state.crossHostFolderOrderAvailable && host.connection.state.user?.role === 'owner');
  const savedItems = resolveCrossHostFolderOrder(sources, stored);
  const displayedItems = resolveCrossHostFolderOrder(sources, draft ?? stored);
  const savedKeys = savedItems.map(item => item.key);
  const displayedKeys = displayedItems.map(item => item.key);
  const changed = draft !== undefined && JSON.stringify(displayedKeys) !== JSON.stringify(savedKeys);
  const hasPinned = displayedItems.some(item => item.pinned);

  const targetHost = target ? hostById.get(target.hostId) : undefined;
  const targetState = targetHost?.connection.state;
  const targetAllowed = targetState?.status === 'online' && !!targetState.foldersAvailable;
  const targetFolder = target ? targetState?.conversationFolders?.folders.find(item => item.id === target.folderId) : undefined;
  const createHost = hostById.get(createHostId) ?? editableHosts[0];
  const createAllowed = createHost?.connection.state.status === 'online' && !!createHost.connection.state.foldersAvailable;

  useEffect(() => {
    if ((view === 'rename' || view === 'delete') && !targetHost) {
      setView('manage'); setTarget(undefined); setError('');
    }
  }, [view, targetHost]);

  const back = () => { setError(''); setView('manage'); setTarget(undefined); };
  const requestClose = () => {
    if (busy) return;
    if (changed) {
      setDiscardConfirm(true);
      return;
    }
    close();
  };
  const runHostEdit = async (connection: HubConnection, edit: FolderEdit, revision: number | undefined, onSuccess: () => void) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      await connection.changeConversationFolders(edit, revision);
      if (alive.current) onSuccess();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t('操作失败'));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };

  const rows: FolderOrderRow[] = displayedItems.map(item => {
    const host = hostById.get(item.hostId);
    const state = host?.connection.state;
    const allowed = state?.status === 'online' && !!state.foldersAvailable;
    return {
      key: item.key,
      folderId: item.folderId,
      name: item.folderId === null ? t('未分组') : item.name ?? '',
      hostName: item.hostName,
      pinned: item.pinned,
      canEdit: allowed && !busy,
      canPin: allowed && !!state?.folderPinAvailable && !busy,
    };
  });

  const openCreate = () => {
    const preferred = editableHosts.find(host => host.id === defaultHostId) ?? editableHosts[0];
    setError('');
    setName('');
    setCreateHostId(preferred?.id ?? '');
    setView('create');
  };

  const title = view === 'create' ? t('新建分组') : view === 'rename' ? t('重命名分组') : view === 'delete' ? t('删除分组') : t('管理分组');
  const dialogHostName = view === 'rename' || view === 'delete' ? targetHost?.name : undefined;

  return <RuntimeHostContext.Provider value={dialogHostName}>
    <CreationDialog mobilePage showHost={!!dialogHostName} onBack={view === 'manage' ? undefined : back} title={title} closeLabel={t('关闭分组')} className="folder-dialog folder-manager-dialog" returnFocus={returnFocus} busy={busy} close={requestClose}>
      {view === 'manage' ? <>
        <p className="folder-order-hint muted">{t('拖动手柄排序后保存；点“…”重命名或删除分组。')}</p>
        <p className="folder-order-hint muted">{syncSupported ? t('跨主机显示顺序会在已升级主机间同步；分组内容和置顶仍归属各自所属主机。') : t('跨主机显示顺序暂保存在本设备，升级主机后可跨设备同步；分组内容和置顶仍归属各自所属主机。')}</p>
        {hasPinned && <p className="folder-order-hint muted">{t('置顶分组始终在前；可在置顶或普通分组内排序。')}</p>}
        <FolderOrderList
          rows={rows}
          canReorder={!busy}
          showMoveTop
          reorder={nextKeys => setDraft(prev => commitCrossHostFolderOrder(prev ?? stored, sources, nextKeys))}
          pin={(row, nextPinned) => {
            const item = displayedItems.find(entry => entry.key === row.key);
            const host = item ? hostById.get(item.hostId) : undefined;
            if (!item || !host) return;
            const sourcesBefore = sources;
            const expected = host.connection.state.conversationFolders?.revision ?? 0;
            void runHostEdit(host.connection, { type: 'pin', id: item.folderId, pinned: nextPinned }, expected, () => {
              applyCrossHostFolderPin(sourcesBefore, item.key, nextPinned);
              setDraft(prev => prev ? recordCrossHostFolderPin(prev, sourcesBefore, item.key, nextPinned) : undefined);
            });
          }}
          rename={row => {
            const item = displayedItems.find(entry => entry.key === row.key);
            const host = item ? hostById.get(item.hostId) : undefined;
            if (!item || !host || item.folderId === null) return;
            setError('');
            setName(row.name);
            setTarget({ hostId: host.id, folderId: item.folderId, revision: host.connection.state.conversationFolders?.revision ?? 0 });
            setView('rename');
          }}
          remove={row => {
            const item = displayedItems.find(entry => entry.key === row.key);
            const host = item ? hostById.get(item.hostId) : undefined;
            if (!item || !host || item.folderId === null) return;
            setError('');
            setTarget({ hostId: host.id, folderId: item.folderId, revision: host.connection.state.conversationFolders?.revision ?? 0 });
            setView('delete');
          }}
        />
        <button type="button" className="folder-new-choice" disabled={busy || !editableHosts.length} onClick={openCreate}><Plus size={18}/>{t('新建分组')}</button>
        {!editableHosts.length && <p className="muted" role="status">{t('连接恢复或主机升级后可编辑分组')}</p>}
        <div className="folder-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>{t('取消')}</button>
          <button type="button" className="primary" disabled={busy || !changed} onClick={() => { saveCrossHostFolderOrder(sources, displayedKeys); close(); }}>{t('保存')}</button>
        </div>
      </> : view === 'delete' ? <>
        <p>{targetFolder ? t('删除「{0}」分组？', targetFolder.name) : t('此分组已删除，请重新选择')}</p>
        <p className="muted">{t('对话将移回“未分组”，聊天记录保留。')}</p>
        {!targetAllowed && <p className="muted" role="status">{t('连接恢复或主机升级后可编辑分组')}</p>}
        <div className="folder-dialog-actions">
          <button type="button" disabled={busy} onClick={back}>{t('取消')}</button>
          <button type="button" className="danger" disabled={busy || !targetAllowed || !targetFolder || !targetHost || !target} onClick={() => {
            if (!targetHost || !target) return;
            const hostKey = folderHostIdentity(targetHost.connection.identity, targetHost.id);
            const deletedId = target.folderId;
            void runHostEdit(targetHost.connection, { type: 'delete', id: deletedId }, target.revision, () => {
              if (hostKey) pruneCrossHostDeletedFolder(hostKey, deletedId);
              back();
            })
              .then(() => { if (alive.current) setTarget(old => old ? { ...old, revision: targetHost.connection.state.conversationFolders?.revision ?? old.revision } : old); });
          }}>{t('删除分组')}</button>
        </div>
      </> : <form onSubmit={event => {
        event.preventDefault();
        if (!name.trim()) return;
        if (view === 'create') {
          if (!createHost || !createAllowed) return;
          void runHostEdit(createHost.connection, { type: 'create', id: crypto.randomUUID(), name: name.trim() }, undefined, back);
          return;
        }
        if (!targetHost || !target || !targetAllowed || !targetFolder) return;
        void runHostEdit(targetHost.connection, { type: 'rename', id: target.folderId, name: name.trim() }, target.revision, back)
          .then(() => { if (alive.current) setTarget(old => old ? { ...old, revision: targetHost.connection.state.conversationFolders?.revision ?? old.revision } : old); });
      }}>
        {view === 'create' && <><label htmlFor={createHostSelectId}>{t('所属主机')}</label><select id={createHostSelectId} value={createHost?.id ?? ''} disabled={busy} onChange={e => setCreateHostId(e.target.value)}>{hosts.map(host => {
          const ready = host.connection.state.status === 'online' && !!host.connection.state.foldersAvailable;
          return <option key={host.id} value={host.id} disabled={!ready}>{ready ? host.name : t('{0}（不可用）', host.name)}</option>;
        })}</select></>}
        <label>{t('分组名称')}<input ref={input} value={name} maxLength={48} required disabled={busy} onChange={e => setName(e.target.value)} onKeyDown={imeEnter}/></label>
        {(view === 'create' ? !createAllowed : !targetAllowed) && <p className="muted" role="status">{t('连接恢复或主机升级后可编辑分组')}</p>}
        <div className="folder-dialog-actions">
          <button type="button" disabled={busy} onClick={back}>{t('取消')}</button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || (view === 'create' ? !createAllowed : !targetAllowed || !targetFolder)}>{busy ? t('正在保存…') : t('保存')}</button>
        </div>
      </form>}
      {(error || writeError) && <p className="error-text" role="alert">{error || t('未能保存跨主机分组顺序，请检查浏览器存储权限后重试。')}</p>}
    </CreationDialog>
    {discardConfirm && <CreationDialog title={t('放弃未保存的修改？')} closeLabel={t('关闭确认')} close={() => setDiscardConfirm(false)} showHost={false}>
      <p>{t('分组顺序尚未保存，放弃这些修改并关闭？')}</p>
      <div className="quick-actions">
        <button type="button" onClick={() => setDiscardConfirm(false)}>{t('继续编辑')}</button>
        <button type="button" className="text-danger" onClick={() => { setDiscardConfirm(false); close(); }}>{t('放弃修改')}</button>
      </div>
    </CreationDialog>}
  </RuntimeHostContext.Provider>;
}
