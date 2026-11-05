import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, GripVertical, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { conversationFolderOrder, emptyConversationFolders, isFolderPinned, pinnedFolderOrder } from '../../src/client-protocol/conversation-folders.js';
import type { HubConnection } from './connection.js';
import { useFolderOrderDrag } from './folder-order-drag.js';
import { t, useLocale } from './i18n.js';

// The manager retains this draft while its create/rename/delete form is open.
export function useFolderOrder(connection: HubConnection) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [base, setBase] = useState(() => state.conversationFolders ?? emptyConversationFolders());
  const [order, setOrder] = useState(() => conversationFolderOrder(base));
  const changed = JSON.stringify(order) !== JSON.stringify(conversationFolderOrder(base));
  const stale = (state.conversationFolders?.revision ?? 0) !== base.revision;
  const reload = () => {
    const latest = connection.state.conversationFolders ?? emptyConversationFolders();
    setBase(latest); setOrder(conversationFolderOrder(latest));
  };
  const acceptEdit = (revision: number) => {
    const latest = connection.state.conversationFolders ?? emptyConversationFolders();
    // A concurrent update after our receipt still needs explicit reconciliation.
    if (revision !== base.revision || latest.revision !== revision + 1) return;
    const canonical = conversationFolderOrder(latest);
    if (!changed) setOrder(canonical);
    else setOrder(previous => {
      const unpinned = canonical.filter(id => isFolderPinned(base, id) && !isFolderPinned(latest, id));
      const next = previous.filter(id => canonical.includes(id) && !unpinned.includes(id));
      const added = canonical.filter(id => !next.includes(id) && !unpinned.includes(id));
      // Keep unsaved moves; insert newly created folders before trailing Unfiled.
      next.splice(next.at(-1) === null ? next.length - 1 : next.length, 0, ...added);
      const ordered = pinnedFolderOrder(latest, next);
      // Leaving a pin at the front of the draft would undo its restored position
      // on Save. Restore that row's rank, retaining the other rows' pending moves.
      for (const id of unpinned) ordered.splice(canonical.indexOf(id), 0, id);
      return ordered;
    });
    setBase(latest);
  };
  return { base, order, setOrder, changed, stale, reload, acceptEdit };
}

export function FolderOrderEditor({ ordering, canEdit, canReorder, canPin, pin, rename, remove }: {
  ordering: ReturnType<typeof useFolderOrder>; canEdit: boolean; canReorder: boolean; canPin: boolean;
  pin: (id: string | null, pinned: boolean) => void;
  rename: (id: string, name: string) => void; remove: (id: string) => void;
}) {
  useLocale();
  const { base, order, setOrder } = ordering;
  const [expanded, setExpanded] = useState<string | null | undefined>();
  const [announcement, setAnnouncement] = useState('');
  const list = useRef<HTMLOListElement>(null), prefix = useId();
  const nameOf = (id: string | null) => id === null ? t('未分组') : base.folders.find(folder => folder.id === id)!.name;
  const announce = (next: (string | null)[], index: number) => setAnnouncement(t('「{0}」已移到第 {1} 位', nameOf(next[index]!), index + 1));
  const sameSection = (a: string | null, b: string | null) => isFolderPinned(base, a) === isFolderPinned(base, b);
  useFolderOrderDrag(list, order, canReorder, setOrder, announce, sameSection);
  const move = (index: number, target: number) => {
    if (!canReorder || target < 0 || target >= order.length || target === index) return;
    while (target !== index && !sameSection(order[index]!, order[target]!)) target += target < index ? 1 : -1;
    if (target === index) return;
    const next = [...order]; next.splice(target, 0, ...next.splice(index, 1));
    setOrder(next); announce(next, target);
  };
  return <>
    <ol ref={list} className="folder-order-list" aria-label={t('分组顺序')}>{order.map((id, index) => {
      const name = nameOf(id), open = expanded === id, panelId = `${prefix}-${id ?? 'unfiled'}`;
      const pinned = isFolderPinned(base, id);
      return <li key={id ?? ''} data-order-id={id ?? ''}>
        <div className="folder-manager-row"><span className="folder-order-name" title={name}>{name}</span>{pinned && <Pin size={14} className="folder-pin" role="img" aria-label={t('已置顶')}/>}
          <button type="button" className="icon-button" aria-label={t('分组操作：{0}', name)} aria-expanded={open} aria-controls={panelId} onClick={() => setExpanded(open ? undefined : id)}><MoreHorizontal size={18}/></button>
          <button type="button" className="icon-button folder-order-handle" data-folder-drag-handle disabled={!canReorder} aria-label={t('拖动排序：{0}', name)} onKeyDown={event => {
            const target = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : undefined;
            if (target !== undefined) { event.preventDefault(); move(index, target); }
          }}><GripVertical size={18}/></button>
        </div>
        {open && <div id={panelId} className="folder-manager-options">
          <button type="button" disabled={!canPin} aria-label={pinned ? t('取消置顶分组「{0}」', name) : t('置顶分组「{0}」', name)} onClick={() => pin(id, !pinned)}>{pinned ? <PinOff size={16}/> : <Pin size={16}/>}<span>{pinned ? t('取消置顶') : t('置顶分组')}</span></button>
          <button type="button" disabled={!canReorder || index === 0 || !sameSection(id, order[index - 1]!)} aria-label={t('上移 {0}', name)} onClick={() => move(index, index - 1)}><ArrowUp size={16}/>{t('上移一位')}</button>
          <button type="button" disabled={!canReorder || index === order.length - 1 || !sameSection(id, order[index + 1]!)} aria-label={t('下移 {0}', name)} onClick={() => move(index, index + 1)}><ArrowDown size={16}/>{t('下移一位')}</button>
          {id !== null && <><button type="button" disabled={!canEdit} aria-label={t('重命名分组「{0}」', name)} onClick={() => rename(id, name)}><Pencil size={16}/>{t('重命名分组')}</button>
            <button type="button" className="text-danger" disabled={!canEdit} aria-label={t('删除分组「{0}」', name)} onClick={() => remove(id)}><Trash2 size={16}/>{t('删除分组')}</button></>}
        </div>}
      </li>;
    })}</ol>
    <span className="folder-order-announcement" aria-live="polite">{announcement}</span>
  </>;
}
