import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Check, ChevronDown, FolderInput, ListChecks, Plus, Trash2, X } from 'lucide-react';
import { CONVERSATION_BATCH_LIMIT, conversationBatchSchema, type ConversationBatch } from '../../src/client-protocol/conversation-batch.js';
import { conversationFolderOrder, emptyConversationFolders } from '../../src/client-protocol/conversation-folders.js';
import type { Conversation } from '../../src/client-protocol/index.js';
import type { HubConnection } from './connection.js';
import { HubHttpError } from './http-error.js';
import type { InboxHost } from './conversation-inbox.js';
import { CONVERSATION_BATCH_RECORD, availableConversation, toggleConversationSelection } from './conversation-bulk.js';
import { CreationDialog } from './CreationDialog.js';
import { useBackAction } from './back-navigation.js';
import { t, useLocale } from './i18n.js';
import './conversation-bulk.css';

type Host = Pick<InboxHost, 'id' | 'name' | 'connection' | 'conversations'>;
type Selection = { connection: HubConnection; ids: string[]; titles: Record<string, string> };
type View = 'review' | 'archive' | 'move';
type UiConversationBatch = Exclude<ConversationBatch, { action: 'restore' }>;
type Context = {
  active: boolean; busy: boolean; ids: readonly string[]; host?: Host; error: string; notice: string;
  begin: (connection: HubConnection, chat: Conversation, trigger: HTMLElement | null) => void;
  toggle: (connection: HubConnection, chat: Conversation) => void;
  checked: (connection: HubConnection, chat: Conversation) => boolean;
  reason: (connection: HubConnection, chat: Conversation) => string | undefined;
  excludeTopics: () => void; excludeUnowned: () => void; excludeUnavailable: () => void; unavailable: number;
  cancel: () => void; review: () => void; move: () => void; archive: () => void;
  pending: boolean; pendingAction?: ConversationBatch['action']; broken: boolean; canMove: boolean; canArchive: boolean; operationProblem: string;
};
const BulkContext = createContext<Context | undefined>(undefined);
export const useConversationBulk = () => useContext(BulkContext);
const emptySubscribe = () => () => undefined;
const emptySnapshot = () => undefined;

/** Only selection is local. All writes use the owning connection and one
 * authenticated, atomic Host operation; never the message outbox. */
export function ConversationBulkProvider({ hosts, visible = true, scopeKey, children, archived, showGroupHint = false }: {
  hosts: Host[]; visible?: boolean; scopeKey: string; children: ReactNode; showGroupHint?: boolean;
  archived?: (host: Host, ids: string[]) => void;
}) {
  useLocale();
  const [selection, setSelection] = useState<Selection>();
  const [view, setView] = useState<View>();
  const [pending, setPending] = useState<ConversationBatch>();
  const [conflicting, setConflicting] = useState<string>();
  const [recordRaw, setRecordRaw] = useState<string>(), [broken, setBroken] = useState(false), [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false), [name, setName] = useState('');
  const [moveRevision, setMoveRevision] = useState(0);
  const [destination, setDestination] = useState<string | undefined>();
  const alive = useRef(true), sending = useRef(false), epoch = useRef(0), current = useRef(selection); current.current = selection;
  const trigger = useRef<HTMLElement | null>(null), cancelButton = useRef<HTMLButtonElement>(null);
  const host = hosts.find(item => item.connection === selection?.connection);
  const connection = host?.connection;
  const state = useSyncExternalStore(connection ? notify => connection.subscribe(notify) : emptySubscribe, connection ? () => connection.state : emptySnapshot);
  const scope = hosts.map(item => `${item.id}:${item.connection.identity.deviceId}`).join('|');
  const refs = useRef(hosts); refs.current = hosts;
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  const reset = (restoreFocus = false) => { if (sending.current) return; epoch.current++; current.current = undefined; setSelection(undefined); setPending(undefined); setRecordRaw(undefined); setConflicting(undefined); setBroken(false); setDiscarding(false); setView(undefined); setError(''); if (restoreFocus) trigger.current?.focus({ preventScroll: true }); trigger.current = null; };
  const restoreRecord = (item: Host, raw: string) => {
    let body: UiConversationBatch | undefined;
    try { const parsed = conversationBatchSchema.parse(JSON.parse(raw)); if (parsed.action !== 'restore') body = parsed; } catch { /* Allow explicit removal of an unreadable local record. */ }
    setSelection({ connection: item.connection, ids: body?.conversationIds ?? [], titles: Object.fromEntries(item.conversations.map(chat => [chat.id, chat.title])) });
    setRecordRaw(raw); setBroken(!body); setPending(body); setConflicting(undefined);
    setNotice(body ? t('上次批量操作的结果待确认。') : t('上次操作记录无法读取，请先丢弃本地记录后再整理。'));
    return body;
  };
  useEffect(() => { if (!notice || pending || broken) return; const timer = setTimeout(() => setNotice(''), 8000); return () => clearTimeout(timer); }, [notice, pending, broken]);
  useEffect(() => {
    if (sending.current) return;
    reset();
    if (!visible) return;
    const turn = epoch.current;
    void (async () => {
      for (const item of refs.current) {
        const raw = await item.connection.cache.operationRecord(CONVERSATION_BATCH_RECORD);
        if (!alive.current || turn !== epoch.current || current.current) return;
        if (!raw) continue;
        restoreRecord(item, raw); return;
      }
    })().catch(() => { if (alive.current && turn === epoch.current) setNotice(t('无法读取上次批量操作，请重新打开列表后再试。')); });
  }, [scope, scopeKey, visible]);
  useEffect(() => { if (selection && !host && !sending.current) reset(); }, [host, selection, busy]);
  const begin = (target: HubConnection, chat: Conversation, element: HTMLElement | null) => {
    if (sending.current || !visible) return;
    trigger.current = element; epoch.current++; setNotice(''); setError(''); setView(undefined); setConflicting(undefined);
    const item = refs.current.find(h => h.connection === target); if (!item) return;
    const turn = epoch.current;
    void target.cache.operationRecord(CONVERSATION_BATCH_RECORD).then(raw => {
      if (!alive.current || turn !== epoch.current) return;
      if (raw) restoreRecord(item, raw);
      else { setSelection({ connection: target, ids: [chat.id], titles: Object.fromEntries(item.conversations.map(c => [c.id, c.title])) }); setPending(undefined); setRecordRaw(undefined); setBroken(false); }
    }).catch(() => { if (alive.current && turn === epoch.current) setNotice(t('无法读取上次批量操作，请重新打开列表后再试。')); });
  };
  const ids = selection?.ids ?? [];
  const chats = ids.map(id => host?.conversations.find(chat => chat.id === id));
  const unavailable = chats.filter(chat => !chat || !availableConversation(chat, host!.conversations)).length;
  const live = chats.length > 0 && chats.every(chat => chat && availableConversation(chat, host!.conversations));
  const operationProblem = conflicting ? t('另一窗口已有批量操作，请先核对上次结果。') : broken ? t('上次操作记录无法读取，请先丢弃本地记录后再整理。') : !ids.length ? t('请先选择对话') : connection?.isReadOnly || connection?.isClosed ? t('此主机连接已不可用，请到主机管理检查。') : !host || state?.status !== 'online' ? t('连接恢复后即可操作')
    : !state.conversationBatchAvailable ? t('升级此主机后可批量整理对话。') : !live && !pending ? t('部分对话已不可用，请在已选列表中取消选择。') : '';
  const owned = chats.every(chat => chat?.ownerId === state?.user?.id);
  const hasTopics = chats.some(chat => chat?.parentId);
  const toggle = (target: HubConnection, chat: Conversation) => {
    if (sending.current || pending || broken || conflicting || !selection) return;
    if (target !== connection) { if (!ids.length) begin(target, chat, trigger.current); return; }
    if (!ids.includes(chat.id) && ids.length >= CONVERSATION_BATCH_LIMIT) { setError(t('一次最多选择 {0} 个对话', CONVERSATION_BATCH_LIMIT)); return; }
    setSelection({ ...selection, ids: toggleConversationSelection(ids, chat, host!.conversations) }); setError('');
  };
  const reason = (target: HubConnection, chat: Conversation) => !selection ? undefined
    : busy || pending || broken || conflicting ? t('正在核对操作结果') : target !== connection && ids.length ? t('请先完成此主机的整理')
    : chat.parentId && ids.includes(chat.parentId) ? t('随所属群组一并处理') : undefined;
  const show = (next: View) => {
    if (conflicting && host) {
      const restored = restoreRecord(host, conflicting); setError('');
      if (restored) setView(restored.action); else setDiscarding(true);
      return;
    }
    if (broken) { setDiscarding(true); return; }
    setView(pending?.action === 'archive' ? 'archive' : pending?.action === 'move' ? 'move' : next);
    setCreating(false); setName(''); setDestination(undefined); setMoveRevision(state?.conversationFolders?.revision ?? 0); setError('');
  };
  const submit = async (body: ConversationBatch) => {
    if (!host || !connection || sending.current || state?.status !== 'online' || !state.conversationBatchAvailable) return;
    sending.current = true; setBusy(true); setError('');
    let raw = JSON.stringify(conversationBatchSchema.parse(body));
    let claimed = false;
    try {
      const previous = await connection.cache.operationRecord(CONVERSATION_BATCH_RECORD);
      if (previous) {
        try { if (JSON.stringify(conversationBatchSchema.parse(JSON.parse(previous))) === raw) raw = previous; }
        catch { if (alive.current) { setConflicting(previous); setView(undefined); } throw new Error(t('上次操作记录无法读取，请先丢弃本地记录后再整理。')); }
      }
      // A restored retry must still own its record; never resurrect a record
      // another window completed or explicitly discarded. Recheck with CAS.
      const acquired = previous === raw
        ? await connection.cache.updateOperationIfMatches(CONVERSATION_BATCH_RECORD, raw, raw)
        : !pending && previous === '' && await connection.cache.updateOperationIfMatches(CONVERSATION_BATCH_RECORD, '', raw);
      if (!acquired) {
        const other = await connection.cache.operationRecord(CONVERSATION_BATCH_RECORD);
        if (!other && pending) {
          if (alive.current) { setView(undefined); setSelection(undefined); setPending(undefined); setRecordRaw(undefined); trigger.current = null; setNotice(t('该操作已在其他窗口处理或放弃，请核对列表后重新选择。')); }
          return;
        }
        // Never replace the destructive target under a pointer/Enter key.
        // The user must reopen and review the other window's operation.
        if (alive.current) { setView(undefined); if (other) { setConflicting(other); setPending(undefined); setRecordRaw(undefined); } }
        throw new Error(t('另一窗口已有批量操作，请先核对上次结果。'));
      }
      claimed = true; if (alive.current) { setPending(body); setRecordRaw(raw); }
      const result = await connection.batchConversations(body);
      await connection.cache.clearOperationIfMatches(CONVERSATION_BATCH_RECORD, raw);
      if (!alive.current) return;
      if (body.action === 'archive' && refs.current.some(item => item.connection === connection)) archived?.(host, result.conversations.filter(chat => chat.archived).map(chat => chat.id));
      setNotice(result.replayed ? t('已核对上次操作，不会重复执行。') : body.action === 'archive' ? t('已删除 {0} 个对话，可在已归档对话中恢复。', result.receipt.conversationIds.length) : t('已移动 {0} 个对话', result.receipt.conversationIds.length));
      setSelection(undefined); setView(undefined); setPending(undefined); setRecordRaw(undefined); trigger.current = null;
    } catch (e) {
      // These responses are produced before COMMIT. Unknown/network/auth errors
      // retain the exact request so reconnect/reload cannot create a second write.
      const code = e instanceof HubHttpError ? e.code : '';
      const rejected = ['folders_changed', 'folder_not_found', 'folder_name_exists', 'folder_exists', 'folder_limit', 'folder_assignment_limit', 'conversation_not_available', 'conversation_batch_topic_move', 'conversation_batch_request_conflict', 'conversation_owner_required', 'conversation_forbidden', 'conversation_not_found'].includes(code);
      if (claimed && rejected) { await connection.cache.clearOperationIfMatches(CONVERSATION_BATCH_RECORD, raw); if (alive.current) { setPending(undefined); setRecordRaw(undefined); } }
      if (code === 'folders_changed' || code === 'folder_not_found') { await connection.refreshConversationFolders().catch(() => undefined); if (alive.current) { setMoveRevision(connection.state.conversationFolders?.revision ?? 0); setDestination(undefined); } }
      // Uncertain receipts have one action-specific recovery panel; do not
      // repeat that explanation in a second error banner.
      if (alive.current) setError(code === 'folders_changed' ? t('分组已变化，已载入最新列表，请重新选择。')
        : code === 'folder_name_exists' ? t('已有同名分组，请换一个名称')
        : code === 'conversation_not_available' ? t('部分对话已不可用，请在已选列表中取消选择。')
        : code === 'conversation_owner_required' ? t('仅对话创建者可删除；本次未作任何更改。')
        : rejected ? t('未能完成批量操作，请核对选择后再试。')
        : claimed ? '' : e instanceof Error ? e.message : t('操作失败'));
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const archive = () => { void submit(pending ?? { action: 'archive', requestId: `cb_${crypto.randomUUID()}`, conversationIds: [...ids] }); };
  const discard = async () => {
    if (!connection || !recordRaw || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      if (!await connection.cache.updateOperationIfMatches(CONVERSATION_BATCH_RECORD, recordRaw, '')) throw new Error(t('记录已被另一窗口更新，请重新打开列表后核对。'));
      sending.current = false;
      if (alive.current) { reset(); setNotice(t('已放弃本地记录，未撤销已执行的操作。')); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : t('操作失败')); }
    finally { sending.current = false; if (alive.current) setBusy(false); }
  };
  const move = () => {
    if (pending) { void submit(pending); return; }
    if (!creating && destination === undefined || creating && !name.trim()) return;
    void submit({ action: 'move', requestId: `cb_${crypto.randomUUID()}`, conversationIds: [...ids], revision: moveRevision,
      target: creating ? { newFolder: { id: `folder_${crypto.randomUUID()}`, name: name.trim() } } : { folderId: destination || null } });
  };
  const context: Context = { active: !!selection, busy, ids, host, error, notice, begin, toggle, reason,
    checked: (target, chat) => target === connection && (ids.includes(chat.id) || !!chat.parentId && ids.includes(chat.parentId)),
    excludeTopics: () => selection && !busy && !pending && setSelection({ ...selection, ids: ids.filter(id => !host?.conversations.find(chat => chat.id === id)?.parentId) }),
    excludeUnowned: () => selection && !busy && !pending && setSelection({ ...selection, ids: ids.filter(id => host?.conversations.find(chat => chat.id === id)?.ownerId === state?.user?.id) }),
    excludeUnavailable: () => selection && !busy && !pending && setSelection({ ...selection, ids: ids.filter(id => { const chat = host?.conversations.find(chat => chat.id === id); return chat && availableConversation(chat, host!.conversations); }) }), unavailable,
    cancel: () => reset(true), review: () => show('review'), archive: () => show('archive'), move: () => show('move'), pending: !!pending || broken || !!conflicting, pendingAction: pending?.action, broken,
    canArchive: !busy && !operationProblem && (pending ? pending.action === 'archive' : owned),
    canMove: !busy && !operationProblem && (pending ? pending.action === 'move' : !hasTopics), operationProblem,
  };
  const folders = state?.conversationFolders ?? emptyConversationFolders();
  const pendingFolderId = pending?.action === 'move' && 'folderId' in pending.target ? pending.target.folderId : undefined;
  const affectedTopics = host?.conversations.filter(chat => chat.parentId && ids.includes(chat.parentId) && !chat.archived).length ?? 0;
  const list = <ul className="conversation-bulk-review">{ids.map(id => { const chat = host?.conversations.find(chat => chat.id === id); return <li key={id}><span>{chat?.title ?? selection?.titles[id] ?? id}{(!chat || !availableConversation(chat, host!.conversations)) && <small> · {t('已不可用')}</small>}</span>{view === 'review' && !pending && <button type="button" className="icon-button" aria-label={t('取消选择：{0}', selection?.titles[id] ?? id)} onClick={() => setSelection({ ...selection!, ids: ids.filter(value => value !== id) })}><X size={16}/></button>}</li>; })}</ul>;
  return <BulkContext.Provider value={context}>{children}
    {visible && discarding && <CreationDialog title={t('放弃本地操作记录')} showHost={false} busy={busy} initialFocus={cancelButton} close={() => setDiscarding(false)}>
      <p>{t('只清除此设备的待确认记录，不会撤销已执行的删除或移动。请先核对列表；原请求仍可能完成。')}</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      <footer className="conversation-bulk-dialog-actions"><button ref={cancelButton} disabled={busy} onClick={() => setDiscarding(false)}>{t('取消')}</button><button disabled={busy} onClick={() => void discard()}>{t('放弃记录')}</button></footer>
    </CreationDialog>}
    {visible && !discarding && host && view && selection && <CreationDialog title={view === 'archive' ? t('删除选中对话') : view === 'move' ? t('移动选中对话') : t('已选 {0} 个对话', ids.length)} closeLabel={t('关闭批量操作')} showHost={false} className="conversation-bulk-dialog" busy={busy} returnFocus={trigger} initialFocus={view === 'archive' ? cancelButton : undefined} close={() => setView(undefined)}>
      <div className="conversation-bulk-body">
        <p className="conversation-bulk-host">{host.name} · {t('已选 {0} 个对话', ids.length)}</p>
        {view === 'archive' && <div className="conversation-bulk-impact">
          <p>{t('从列表移除，保留聊天记录、草稿和 Bot。')}</p>
          <p className="muted">{t('当前回复会继续；自动讨论在当前发言后暂停。')}</p>
          {affectedTopics > 0 && <p className="muted">{t('所选群组中的 {0} 个话题也会隐藏，恢复群组后重新显示。', affectedTopics)}</p>}
        </div>}
        {view === 'review' ? <>{list}<ConversationBulkExclusions/></> : <details className="conversation-bulk-details"><summary><span>{t('查看已选对话')}</span><ChevronDown size={16}/></summary>{list}</details>}
        {view === 'archive' && <details className="conversation-bulk-details conversation-bulk-recovery"><summary><span>{t('删除后如何恢复')}</span><ChevronDown size={16}/></summary><p className="muted">{t('对话可在「我的 / 工作台 → 已归档对话」恢复；单独删除的话题在群组的已归档话题中恢复。')}</p></details>}
        {pending && !busy && <div className="conversation-bulk-pending" role="alert">
          <p className="conversation-bulk-pending-title">{pending.action === 'archive' ? t('删除结果待确认') : t('移动结果待确认')}</p>
          <p>{pending.action === 'archive' ? t('尚未收到主机确认。重试会继续删除这 {0} 个对话，已完成的不会重复执行。', ids.length) : t('尚未收到主机确认。重试会继续移动这 {0} 个对话，已完成的不会重复执行。', ids.length)}</p>
          {pending.action === 'move' && <p>{t('原目标分组：{0}', 'newFolder' in pending.target ? pending.target.newFolder.name : pending.target.folderId === null ? t('未分组') : folders.folders.find(folder => folder.id === pendingFolderId)?.name ?? pending.target.folderId)}</p>}
          <button type="button" disabled={busy} onClick={() => { setError(''); setDiscarding(true); }}>{t('不再重试')}</button>
        </div>}
        {view === 'move' && !pending && <>
          {showGroupHint && <p className="muted">{t('分组会显示在「按对话」列表中。')}</p>}
          <div className="folder-choices" role="radiogroup" aria-label={t('目标分组')}>{conversationFolderOrder(folders).map(id => <button type="button" role="radio" aria-checked={!creating && destination === (id ?? '')} disabled={busy} key={id ?? ''} onClick={() => { setCreating(false); setDestination(id ?? ''); }}><FolderInput size={17}/><span>{id === null ? t('未分组') : folders.folders.find(folder => folder.id === id)?.name}</span>{!creating && destination === (id ?? '') && <Check size={17}/>}</button>)}</div>
          <button type="button" className="folder-new-choice" disabled={busy} aria-expanded={creating} onClick={() => { setCreating(true); setDestination(undefined); }}><Plus size={17}/>{t('新建分组')}</button>
          {creating && <label className="conversation-bulk-name">{t('分组名称')}<input autoFocus value={name} maxLength={48} disabled={busy} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key !== 'Enter') return; event.preventDefault(); if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && context.canMove && name.trim()) move(); }}/></label>}
        </>}
        {operationProblem && <p className="muted" role="status">{operationProblem}</p>}
        {error && <p role="alert" className="error-text">{error}</p>}
      </div>
      <footer className={`conversation-bulk-dialog-actions ${view === 'archive' ? 'conversation-bulk-archive-actions' : ''}`}><button ref={cancelButton} disabled={busy} onClick={() => setView(undefined)}>{t('取消')}</button>
        {view === 'archive' && <button className="text-danger" disabled={!context.canArchive} onClick={archive}>{busy ? t('正在删除…') : pending ? t('重试删除 {0} 个对话', ids.length) : t('删除 {0} 个对话', ids.length)}</button>}
        {view === 'move' && <button className="primary" disabled={!context.canMove || !pending && (creating ? !name.trim() : destination === undefined)} onClick={move}>{busy ? t('正在移动…') : pending ? t('重试移动 {0} 个对话', ids.length) : creating ? t('创建并移入') : t('移动 {0} 个对话', ids.length)}</button>}
      </footer>
    </CreationDialog>}
  </BulkContext.Provider>;
}

export function ConversationBulkCheck({ checked }: { checked: boolean }) {
  return <span className="conversation-bulk-check" data-checked={checked} aria-hidden="true">{checked && <Check size={13}/>}</span>;
}
export function ConversationBulkActions() {
  const bulk = useConversationBulk(); if (!bulk?.active) return null;
  return <div className="conversation-bulk-actions" role="group" aria-label={t('批量整理对话')}>
    <button type="button" disabled={!bulk.canMove} onClick={bulk.move}><FolderInput size={17}/>{t('移至分组')}</button>
    <button type="button" className="text-danger" disabled={!bulk.canArchive} onClick={bulk.archive}><Trash2 size={17}/>{t('删除')}</button>
  </div>;
}
export function ConversationBulkToolbar({ mobile = false }: { mobile?: boolean }) {
  const bulk = useConversationBulk(), root = useRef<HTMLDivElement>(null);
  useBackAction(root, () => { if (!bulk?.active) return false; if (!bulk.busy) bulk.cancel(); }, 150);
  useEffect(() => {
    if (!bulk?.active) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && !document.querySelector('dialog[open]')) { event.preventDefault(); event.stopPropagation(); if (!bulk.busy) bulk.cancel(); } };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [bulk]);
  if (!bulk) return null;
  if (!bulk.active) return bulk.notice ? <p className="conversation-bulk-notice" role="status">{bulk.notice}</p> : null;
  const pendingStatus = bulk.pendingAction === 'archive' ? t('删除结果待确认') : bulk.pendingAction === 'move' ? t('移动结果待确认') : t('上次操作结果待确认');
  const status = bulk.busy ? t('正在处理…') : bulk.error || bulk.operationProblem || (bulk.pending ? pendingStatus : !bulk.canMove ? t('话题随群组分组；移动时请选择所属群组。') : !bulk.canArchive ? t('含其他人创建的对话，可以移动分组，但不能批量删除。') : t('点击对话可增减选择'));
  return <div ref={root} className={`conversation-bulk-toolbar ${mobile ? 'is-mobile' : ''}`}>
    <div className="conversation-bulk-heading"><button className="conversation-bulk-count" type="button" disabled={bulk.busy} onClick={bulk.review}><ListChecks size={18}/>{t('已选 {0} 项', bulk.ids.length)}</button><button type="button" disabled={bulk.busy} onClick={bulk.cancel}>{t('取消多选')}</button></div>
    <p className="conversation-bulk-scope">{bulk.host?.name} · {t('仅此主机')}</p>
    {!mobile && <ConversationBulkActions/>}
    <p className="conversation-bulk-status conversation-bulk-stable-status" role="status"><span title={status}>{status}</span><button type="button" disabled={bulk.busy} onClick={bulk.review}>{bulk.broken ? t('处理记录') : bulk.pending ? t('核对') : t('查看')}</button></p>
  </div>;
}

function ConversationBulkExclusions() {
  const bulk = useConversationBulk();
  if (!bulk || bulk.pending) return null;
  return <div className="conversation-bulk-exclusions">
    {!!bulk.unavailable && !bulk.pending && <p className="conversation-bulk-status"><button type="button" disabled={bulk.busy} onClick={bulk.excludeUnavailable}>{t('移除 {0} 个不可用项', bulk.unavailable)}</button></p>}
    {!bulk.operationProblem && !bulk.pending && bulk.ids.length > 0 && !bulk.canMove && <p className="conversation-bulk-status">{t('话题随群组分组；移动时请选择所属群组。')}<button type="button" onClick={bulk.excludeTopics}>{t('取消选择话题')}</button></p>}
    {!bulk.operationProblem && !bulk.pending && bulk.ids.length > 0 && !bulk.canArchive && <p className="conversation-bulk-status">{t('含其他人创建的对话，可以移动分组，但不能批量删除。')}<button type="button" onClick={bulk.excludeUnowned}>{t('仅保留可删除项')}</button></p>}
  </div>;
}
