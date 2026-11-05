import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Hash, List, MoreHorizontal, MessageSquare, Plus, Search, Users } from "lucide-react";
import type { Conversation } from "../../src/client-protocol/index.js";
import type { ConversationActivity } from "./storage.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";
import { conversationPreview } from "./conversation-preview.js";

import type { HubConnection } from "./connection.js";
import { TopicActions } from "./TopicActions.js";
import "./topic-actions.css";

type Props = { connection: HubConnection; group: Conversation; current: Conversation; conversations: Conversation[]; activity: Record<string, ConversationActivity>; select: (id: string) => void; create: () => void };
export function GroupTopics({ connection, group, current, conversations, activity, select, create }: Props) {
  useLocale();
  const [directory, setDirectory] = useState(false);
  const activeTab = useRef<HTMLButtonElement>(null);
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const topics = conversations.filter((c) => c.parentId === group.id).sort((a, b) => (activity[b.id]?.at ?? b.createdAt) - (activity[a.id]?.at ?? a.createdAt));
  const active = topics.filter((c) => !c.archived).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  useEffect(() => { activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [current.id, active.length]);
  const open = (id: string) => { setDirectory(false); select(id); };
  // One row: group/back control, topic strip, directory and creation. Whether this
  // is the group discussion or a topic (and of which group) is the header subtitle.
  return <section className="group-topic-navigation" aria-label={t("群内话题导航")}>
    <div className="topic-bar"><button className="group-breadcrumb" aria-label={t("返回群组「{0}」", group.title)} title={group.title} onClick={() => open(group.id)}>{current.parentId ? <ArrowLeft size={16}/> : <Users size={16}/>}<span>{group.title}</span></button><nav className="topic-tabs" aria-label={t("群组话题")}><button ref={current.id === group.id ? activeTab : undefined} aria-current={current.id === group.id ? "page" : undefined} onClick={() => open(group.id)}><MessageSquare size={14}/>{t("默认讨论")}</button>{active.map((topic) => <button key={topic.id} ref={current.id === topic.id ? activeTab : undefined} aria-current={current.id === topic.id ? "page" : undefined} title={topic.title} onClick={() => open(topic.id)}><Hash size={14}/><span>{topic.title}</span>{Object.keys(activity[topic.id]?.unread ?? {}).length > 0 && <i className="topic-unread-dot" aria-label={t("有未读消息")}/>}</button>)}</nav><button ref={directoryTrigger} className="topic-directory-button" aria-label={t("全部话题")} title={t("全部话题")} onClick={() => setDirectory(true)}><List size={16}/><span>{t("全部话题")}</span><span className="mobile-topic-label" aria-hidden="true">{t("话题")}</span><b>{active.length}</b></button><button className="topic-create" disabled={group.archived} title={t("新建话题")} onClick={create}><Plus size={16}/><span>{t("新建话题")}</span></button></div>
    {directory && <TopicDirectory connection={connection} returnFocus={directoryTrigger} group={group} topics={topics} current={current.id} activity={activity} select={open} create={() => { setDirectory(false); create(); }} close={() => setDirectory(false)}/>}
  </section>;
}

/** Desktop: the topic strip collapses into one header control. Its label says where
 * you are (the group discussion, or which group this topic belongs to) and how many
 * topics are active; a dot marks unread elsewhere in the group. It opens the same
 * directory (search, archived, group discussion, new topic) as the phone strip. */
export function TopicSwitcher({ connection, group, current, conversations, activity, select, create, compact = false }: Props & { compact?: boolean }) {
  useLocale();
  const [directory, setDirectory] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const topics = conversations.filter((c) => c.parentId === group.id).sort((a, b) => (activity[b.id]?.at ?? b.createdAt) - (activity[a.id]?.at ?? a.createdAt));
  const active = topics.filter((c) => !c.archived);
  const unreadElsewhere = [group, ...active].some((c) => c.id !== current.id && Object.keys(activity[c.id]?.unread ?? {}).length > 0);
  const open = (id: string) => { setDirectory(false); select(id); };
  return <>
    <button ref={trigger} type="button" className={`header-topic${compact ? " is-compact" : ""}`} aria-haspopup="dialog" aria-label={compact ? `${group.title} · ${t("{0} 个话题", active.length)} · ${t("全部话题")}` : undefined} title={compact ? `${group.title} · ${t("{0} 个话题", active.length)} · ${t("全部话题")}` : t("全部话题")} onClick={() => setDirectory(true)}>
      {current.parentId ? <Users size={13} aria-hidden="true"/> : <MessageSquare size={13} aria-hidden="true"/>}
      {!compact && <span className="header-topic-label">{current.parentId ? group.title : t("默认讨论")}</span>}
      <span className="header-topic-count">{compact ? active.length : t("{0} 个话题", active.length)}</span>
      {unreadElsewhere && <><i className="topic-unread-dot" aria-hidden="true"/><span className="header-topic-unread">{t("有未读消息")}</span></>}
      <ChevronDown size={12} aria-hidden="true"/>
    </button>
    {directory && <TopicDirectory connection={connection} returnFocus={trigger} group={group} topics={topics} current={current.id} activity={activity} select={open} create={() => { setDirectory(false); create(); }} close={() => setDirectory(false)}/>}
  </>;
}

function TopicDirectory({ connection, group, topics, current, activity, select, create, close, returnFocus }: { connection: HubConnection; group: Conversation; topics: Conversation[]; current: string; activity: Props["activity"]; select: (id: string) => void; create: () => void; close: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  const [query, setQuery] = useState(""), [archived, setArchived] = useState(false);
  const [actionId, setActionId] = useState<string>();
  const currentTopic = useRef(current); currentTopic.current = current;
  const actionTrigger = useRef<HTMLElement | null>(null), search = useRef<HTMLInputElement>(null);
  const actionReturn = useMemo(() => ({ get current() { return actionTrigger.current?.isConnected ? actionTrigger.current : search.current; } }), []);
  const target = !group.archived ? topics.find(topic => topic.id === actionId) : undefined;
  useEffect(() => { if (actionId && !target) setActionId(undefined); }, [actionId, target]);
  const activeCount = topics.filter((c) => !c.archived).length;
  const visible = topics.filter((c) => c.archived === archived && c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <CreationDialog returnFocus={returnFocus} title={t("群内话题")} close={close} closeLabel={t("关闭话题列表")}><div className="topic-directory">
    <div className="topic-directory-group"><Users size={22}/><strong>{group.title}</strong></div>
    <p className="creation-help">{t("各话题分别保存消息，默认使用独立上下文。")}</p>
    <label className="topic-search"><Search size={17}/><input ref={search} autoFocus aria-label={t("搜索群内话题")} placeholder={t("按名称查找话题…")} value={query} onChange={(e) => setQuery(e.target.value)}/></label>
    <div className="topic-directory-filters"><button aria-label={t("进行中")} aria-pressed={!archived} onClick={() => setArchived(false)}>{t("进行中")}<span>{activeCount}</span></button><button aria-label={t("已归档")} aria-pressed={archived} onClick={() => setArchived(true)}>{t("已归档")}<span>{topics.length - activeCount}</span></button></div>
    {!archived && !query.trim() && <button className="topic-default-row" onClick={() => select(group.id)}><MessageSquare size={18}/><span><strong>{t("默认讨论")}</strong><small>{t("群里的日常交流")}</small></span><ChevronRight size={16}/></button>}
    <div className="topic-directory-list">{visible.map((topic) => { const item = activity[topic.id], unread = Object.keys(item?.unread ?? {}).length; return <div className="topic-directory-item" key={topic.id}><button className={`topic-directory-row ${current === topic.id ? "selected" : ""}`} onClick={() => select(topic.id)}><Hash size={18}/><span><strong>{topic.title}</strong><small>{(item?.preview ? conversationPreview(item.preview) : undefined) || (archived ? t("记录保留，可随时恢复") : t("还没有消息，开始讨论吧"))}</small></span>{unread > 0 ? <b className="unread-badge">{unread}</b> : <ChevronRight size={16}/>}</button>{!topic.archived && !group.archived && <button type="button" className="topic-row-actions" aria-label={t("管理话题「{0}」", topic.title)} aria-haspopup="dialog" onClick={event => { actionTrigger.current = event.currentTarget; setActionId(topic.id); }}><MoreHorizontal size={20}/></button>}</div>; })}{!visible.length && <div className="topic-directory-empty"><Hash size={28}/><p>{query.trim() ? t("没有找到这个话题") : archived ? t("暂无已归档话题") : t("还没有话题")}</p>{!query.trim() && !archived && <small>{t("为不同事项开个话题，之后更容易找到。")}</small>}</div>}</div>
    <button className="primary full topic-directory-create" disabled={group.archived} onClick={create}><Plus size={17}/>{t("新建话题")}</button>
    {target && <TopicActions key={target.id} connection={connection} topic={target} removed={() => { setActionId(undefined); if (currentTopic.current === target.id) select(group.id); }} returnFocus={actionReturn} close={() => setActionId(undefined)}/>}
  </div></CreationDialog>;
}
