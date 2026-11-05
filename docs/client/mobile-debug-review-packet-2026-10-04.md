# Opus follow-up packet

Parent reproduced and fixed initial findings 1,2,3. Confirmed before tests: long chat stuck 6509px away from tail; cross-host return lost search string; search X hid home. Parent ran new tests, long-conversation test now passes including search jump then ordinary reopen. Current build passed. Browser regressions underway. You have not run them yourself.

## App.tsx:178-190
```tsx
178:   useEffect(() => { if (selected) shell?.selection(selected); }, [selected]);
179:   useLayoutEffect(() => {
180:     const action = shell?.command; if (!action) return;
181:     if (action.kind === "select" && action.conversationId) { setFocusTarget(action.messageId ? { conversationId: action.conversationId, messageId: action.messageId } : undefined); if (!action.messageId) { followLatest.current = true; setShowLatest(false); } setSelected(action.conversationId); closeSearch(); setSidebar(false); }
182:     else if (action.kind === "home") { setSidebar(true); setMobileTab("me"); }
183:     else if (action.kind === "bot") setNewBot(true);
184:     else if (action.kind === "direct" || action.kind === "group") setNewChat({ kind: action.kind, ...(action.botId ? { botId: action.botId } : {}) });
185:     shell?.consumed(action.serial);
186:     if (action.kind === "select" && !phone) requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }));
187:   }, [shell?.command?.serial]);
188:   useEffect(() => { if (selected) void cache.saveSelectedConversation(selected).catch(() => setError(t("无法保存当前对话位置。"))); }, [selected]);
189:   useEffect(() => { let alive = true; void Promise.all([cache.conversations(), selected ? Promise.resolve(selected) : cache.selectedConversation()]).then(([c, saved]) => {
190:       if (!alive) return; setConversations(c);
```

## App.tsx:271-294
```tsx
271:   const openMobileHome = () => {
272:     if (voice.phase === "requesting") voice.cancel();
273:     else if (voice.phase === "recording") voice.finish();
274:     setFocusTarget(undefined); closeSearch(); setSidebar(true); setMobileTab("messages");
275:   };
276:   const exitHistorySearch = () => { if (phone) openMobileHome(); else closeSearch(); };
277:   useBackAction(backRoot, () => {
278:     if (recording) {
279:       if (voice.phase === "requesting") voice.cancel();
280:       else if (voice.phase === "recording") voice.finish();
281:       return;
282:     }
283:     if (searchResults !== undefined) { exitHistorySearch(); return; }
284:     if (!phone) return false;
285:     if (sidebar) { if (mobileTab !== "messages") { setMobileTab("messages"); return; } return false; }
286:     openMobileHome();
287:   }, 0);
288:   useLayoutEffect(() => {
289:     if (!chatVisible) return;
290:     const frame = requestAnimationFrame(() => { virtualizer.measure(); if (followLatest.current && scroll.current && !focusTarget) scroll.current.scrollTop = scroll.current.scrollHeight; });
291:     return () => cancelAnimationFrame(frame);
292:   }, [chatVisible, virtualizer]);
293:   const send = async () => {
294:     if (!selected || recording || (!draft.trim() && !files.length) || sendBusy.current) return;
```

## App.tsx:332-346
```tsx
332:   return <RuntimeHostContext.Provider value={shell?.host.name}><AvatarProvider connection={connection}><BotReferences bots={botDirectory}><div ref={backRoot} className={`app-shell ${sidebar ? "mobile-home-open" : "mobile-chat-open"}`}><aside className={`sidebar ${sidebar ? "shown" : ""}`}><div className="brand"><BrandMark/><button className="icon-button" aria-label={t("新建对话")} title={t("新建对话")} onClick={() => shell ? shell.create("direct") : setNewChat({ kind: "direct", ...(activeBot ? { botId: activeBot.id } : {}) })}><Plus size={20}/></button></div>{shell?.controls}<div className="sidebar-create"><button onClick={() => shell ? shell.create("bot") : setNewBot(true)}><BotIcon size={16}/>{t("新建 Bot")}</button><button onClick={() => shell ? shell.create("group") : setNewChat({ kind: "group", ...(activeBot ? { botId: activeBot.id } : {}) })}><Plus size={16}/>{t("新建群组")}</button></div><form className="search-box" onSubmit={search}><Search size={16}/><input aria-label={t("搜索历史消息")} placeholder={shell ? t("搜索 {0} 的消息…", shell.host.name) : t("搜索消息…")} maxLength={256} value={query} onChange={(e) => setQuery(e.target.value)}/><kbd>↵</kbd></form>{shell ? shell.navigation({ conversations, bots: state.bots, selected, pins, activity }) : <ConversationList newChat={(botId) => setNewChat({ kind: "direct", botId })} conversations={conversations} bots={state.bots} selected={selected} pins={pins} activity={activity} select={(id) => { setFocusTarget(undefined); setSelected(id); setSidebar(false); closeSearch(); }}/>}{conversations.some((c) => c.archived && !c.parentId) && <details className="archived-conversations"><summary>{t("已归档")}</summary>{conversations.filter((c) => c.archived && !c.parentId).map((c) => <button key={c.id} onClick={() => { setSelected(c.id); setManage(true); }}>{c.title}</button>)}</details>}{shell && <small className="host-tools-label">{t("当前主机：{0}", shell.host.name)}</small>}<button className="file-center-entry" onClick={() => setFileCenter(true)}><FolderOpen size={18}/>{t("文件中心")}</button><button className="file-center-entry" onClick={() => setCapabilities(true)}><BotIcon size={18}/>{t("Skills 与 MCP")}</button><div className="sidebar-footer">{state.user && <button className="icon-button" aria-label={t("个人头像")} title={t("个人头像")} onClick={(event) => { event.currentTarget.focus(); setSettingsFromMenu(false); setSettingsSection("general"); setSettings(true); }}><Avatar kind="user" id={state.user.id} name={t("我")} size={26}/></button>}<span><i className={`status-dot ${state.status === "online" ? "online" : ""}`}/>{state.status === "online" ? t("已连接") : t("离线")}</span><button className="icon-button" aria-label={t("运行状态")} title={t("运行状态")} onClick={() => setOperations(true)}><Activity size={19}/></button><button className="icon-button" aria-label={t("设置")} onClick={(event) => { event.currentTarget.focus(); setSettingsFromMenu(false); setSettingsSection("general"); setSettings(true); }}><Settings size={19}/></button></div></aside>{sidebar && <button className="sidebar-backdrop" aria-label={t("关闭会话列表")} onClick={() => setSidebar(false)}/>}
333:   {phone && <MobileHome hosts={shell?.mobileHosts({ conversations, bots: state.bots, activity, pins }) ?? [{ id: "local", name: t("我的主机"), connection, conversations, bots: state.bots, activity, pins }]} activeHostId={shell?.host.id ?? "local"} inbox={shell?.mobileInbox} updateInbox={shell?.updateMobileInbox} tab={mobileTab} setTab={setMobileTab}
334:     select={(hostId, id) => { if (shell) shell.mobileSelect(hostId, { kind: "select", conversationId: id }); else { setFocusTarget(undefined); setSelected(id); closeSearch(); setSidebar(false); } }}
335:     newChat={(hostId, botId) => { if (shell) shell.mobileSelect(hostId, { kind: "direct", botId }); else setNewChat({ kind: "direct", botId }); }}
336:     create={(kind) => { if (shell) shell.mobileSelect(shell.host.id, { kind }); else if (kind === "bot") setNewBot(true); else setNewChat({ kind }); }}
337:     selectHost={(hostId) => shell?.mobileSelect(hostId, { kind: "home" })}
338:     open={(kind) => { if (kind === "settings") { setSettingsFromMenu(false); setSettingsSection("general"); setSettings(true); } else if (kind === "files") setFileCenter(true); else if (kind === "capabilities") setCapabilities(true); else if (kind === "operations") setOperations(true); else if (kind === "archives") setArchives(true); else if (kind === "hosts") shell?.manageHosts(); }}
339:     searchHistory={(text) => { setQuery(text); setSearchBot(""); setSearchFrom(""); setSearchTo(""); setSearchFiles(false); setSidebar(false); setFocusTarget(undefined); historySearch.start(new URLSearchParams({ q: text }).toString(), ""); }}/>}
340:   <main className="conversation-main">{phone && searchResults !== undefined ? <header className="conversation-header"><button className="icon-button" aria-label={t("打开会话列表")} onClick={exitHistorySearch}><ChevronLeft size={24}/></button><div className="header-title"><h1>{t("搜索历史消息")}</h1><small>{shell ? t("仅当前主机：{0}", shell.host.name) : t("我的主机")}</small></div></header> : <header className="conversation-header"><button className="icon-button mobile-menu" aria-label={t("打开会话列表")} onClick={openMobileHome}><ChevronLeft size={24}/></button>{current && <button className={`header-avatar-button${replying}`} aria-label={t("打开头像设置")} onClick={() => setManage(true)}><Avatar kind={group ? "group" : "bot"} id={group?.id ?? current.botIds[0] ?? "unknown"} name={group?.title ?? labels.get(current.botIds[0]!) ?? current.title} size={28}/></button>}<div className="header-title"><h1>{current?.title ?? t("欢迎回来")}</h1><div className="header-detail-row">{shell && <small className="runtime-host-label">{t("运行于 {0}", shell.host.name)}</small>}{current && <EffortControl key={current.id} connection={connection} bots={state.bots.filter((bot) => current?.botIds.includes(bot.id)).map((bot) => ({ ...bot, name: labels.get(bot.id) ?? bot.name }))} online={state.status === "online"} owner={state.user?.role === "owner"} summary={group ? <>{current?.parentId ? `${group.title} · ${t("独立话题")}` : t("群内讨论")} · {t("思考强度")}</> : <>{activeBot?.engine}{activeBot?.model && ` · ${activeBot.model}`} · {activeBot?.effort || t("跟随默认")}</>}/>}</div></div><button className="header-new-chat" title={t("为当前 Bot 开一个独立对话")} onClick={() => setNewChat({ kind: "direct", ...(activeBot ? { botId: activeBot.id } : {}) })}><Plus size={15}/><span>{t("新对话")}</span></button><button className={`connection-pill ${state.status}`} title={state.route?.url} aria-label={t("打开连接设置")} onClick={(event) => { event.currentTarget.focus(); setSettingsFromMenu(false); setSettingsSection("connection"); setSettings(true); }}>{state.status === "online" ? <Wifi size={14}/> : <WifiOff size={14}/>}<span>{state.status === "online" ? `${state.route ? routeTitle(state.route, connection.identity.routes, connection.identity.deployment) : ""} · ${state.latency ?? "–"}ms` : state.status === "connecting" ? t("连接中") : t("离线")}</span></button><button className="icon-button desktop-chat-settings" aria-label={t("对话设置")} onClick={(event) => { event.currentTarget.focus(); if (current) setManage(true); else { setSettingsSection("general"); setSettings(true); } }}><Settings size={18}/></button><button ref={chatMoreTrigger} className="icon-button mobile-chat-more" aria-label={t("更多聊天操作")} onClick={(event) => { event.currentTarget.focus(); setChatActions(true); }}><MoreHorizontal size={24}/></button></header>}
341:     {!(phone && searchResults !== undefined) && group && current && <GroupTopics key={group.id} group={group} current={current} conversations={conversations} activity={activity} select={(id) => { setFocusTarget(undefined); setSelected(id); closeSearch(); setSidebar(false); }} create={() => setNewChat({ kind: "topic", group })}/>}
342:     {state.status !== "online" && <div className="offline-banner"><WifiOff size={15}/>{t("当前离线，已缓存的消息仍可阅读。")}{state.outbox > 0 && t("{0} 条消息将在重连后发送。", state.outbox)}</div>}
343:     {(error || state.error) && <div role="alert" className="error-banner">{error || state.error}<button className="icon-button" aria-label={t("关闭提示")} onClick={() => { setError(""); connection.clearError(); }}><X size={14}/></button></div>}
344:     {searchResults ? <section className="search-results" ref={searchPanel} aria-busy={searchBusy}><header><h2 aria-live="polite">{searchBusy ? t("正在搜索…") : historySearch.page || historySearch.hasNext ? t("搜索结果 · 本页 {0} 条", searchResults.length) : t("搜索结果 · {0}", searchResults.length)}</h2><button className="icon-button" aria-label={t("关闭搜索")} onClick={exitHistorySearch}><X size={18}/></button></header><form className="search-filters" onSubmit={search}><label className="search-keywords">{t("关键词")}<input aria-label={t("搜索关键词")} maxLength={256} value={query} onChange={(e) => setQuery(e.target.value)}/></label><label>Bot<select aria-label={t("搜索 Bot")} value={searchBot} onChange={(e) => setSearchBot(e.target.value)}><option value="">{t("全部")}</option>{state.bots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label><label>{t("开始日期")}<input type="date" aria-label={t("搜索开始日期")} value={searchFrom} onChange={(e) => setSearchFrom(e.target.value)}/></label><label>{t("结束日期")}<input type="date" aria-label={t("搜索结束日期")} value={searchTo} onChange={(e) => setSearchTo(e.target.value)}/></label><label><input type="checkbox" checked={searchFiles} onChange={(e) => setSearchFiles(e.target.checked)}/>{t("含附件")}</label><button className="primary" type="submit">{t("应用筛选")}</button></form>{historySearch.params !== searchParams && <p className="muted" role="status">{t("筛选条件已修改，点击“应用筛选”更新结果。")}</p>}{searchError ? <p className="error-text" role="alert">{searchError}</p> : !searchBusy && !searchResults.length ? <p className="muted">{t("没有找到匹配的消息。试试其他关键词或放宽筛选条件。")}</p> : null}{(historySearch.page > 0 || historySearch.hasNext) && <nav className="search-pagination" aria-label={t("搜索翻页")}><button type="button" disabled={searchBusy || historySearch.page === 0} onClick={() => historySearch.turnPage(-1)}>{t("上一页")}</button><span>{t("第 {0} 页", historySearch.page + 1)}</span><button type="button" disabled={searchBusy || !historySearch.hasNext} onClick={() => historySearch.turnPage(1)}>{t("下一页")}</button></nav>}{searchResults.map((m) => <button key={m.id} onClick={() => { setFocusTarget({ conversationId: m.conversationId, messageId: m.id }); closeSearch(); }}><strong>{conversations.find((c) => c.id === m.conversationId)?.title}</strong><p><ReferencePreview text={m.excerpt}/></p><small>{new Date(m.createdAt).toLocaleString()}</small></button>)}</section>
345:     : selected ? <div ref={scroll} className="message-scroll" onWheel={(event) => { if (event.deltaY < 0) readHistory(); }} onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY; }} onTouchMove={(event) => { const y = event.touches[0]?.clientY; if (y !== undefined && touchY.current !== undefined && y > touchY.current + 1) readHistory(); touchY.current = y; }} onPointerDown={(event) => { if (event.target === event.currentTarget) readHistory(); }} onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) readHistory(); }} onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 80) { followLatest.current = true; setShowLatest(false); } }}><div className="conversation-intro"><ShieldCheck size={14}/>{t("此对话仅对已授权设备可见")}</div>{group && current && !messages.length && <div className="conversation-empty"><MessageSquare size={28}/><h2>{current.parentId ? t("从这个话题开始") : t("默认讨论")}</h2><p>{current.parentId ? t("这里的消息只属于「{0}」。", current.title) : t("日常交流留在这里，不同事项可以新建话题。")}</p>{!group.archived && !current.parentId && !conversations.some((c) => c.parentId === group.id) && <button onClick={() => setNewChat({ kind: "topic", group })}><Plus size={16}/>{t("创建第一个话题")}</button>}</div>}{!group && current && !messages.length && !queued.length && <DirectEmpty botId={current.botIds[0] ?? "unknown"} name={labels.get(current.botIds[0] ?? "") ?? activeBot?.name ?? current.title} archived={!!current.archived} online={state.status === "online"} draftEmpty={!draft} commands={() => { if (draft) return; changeDraft("/"); composer.current?.focus(); }} attach={() => fileInput.current?.click()}/>}<div className="virtual-messages" style={{ height: virtualizer.getTotalSize() }}>{virtualizer.getVirtualItems().map((item) => { const message = messages[item.index]!; const bot = botDirectory.find((b) => b.id === message.authorId); return <article ref={virtualizer.measureElement} data-index={item.index} data-message-id={message.id} key={message.id} className={`message ${message.authorType} ${focusTarget?.messageId === message.id ? "focused-message" : ""}`} style={{ transform: `translateY(${item.start}px)` }}><div className={`message-avatar ${message.authorType}${live ? presence(message) : ""}`}><Avatar kind={message.authorType === "bot" ? "bot" : "user"} id={message.authorId} name={labels.get(message.authorId) ?? (message.authorType === "user" ? t("我") : "TaroCub")} size={32}/></div><div className="message-body"><div className="message-meta"><strong>{labels.get(message.authorId) ?? bot?.name ?? (message.authorType === "user" ? t("我") : "TaroCub")}</strong><time>{new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>{(message.forwardedFrom || message.authorType === "user" && message.replyTo) && <MessageReference message={message} original={messages.find((m) => m.id === message.replyTo)} author={messages.find((m) => m.id === message.replyTo) ? messageAuthor(messages.find((m) => m.id === message.replyTo)!, botDirectory) : undefined} available={!message.forwardedFrom || conversations.some((c) => c.id === message.forwardedFrom!.conversationId)} open={() => { const origin = message.forwardedFrom; const conversationId = origin?.conversationId ?? message.conversationId, messageId = origin?.messageId ?? message.replyTo!; report(cache.messages(conversationId).then((items) => { if (!items.some((m) => m.id === messageId && m.status !== "deleted")) { setError(t("原消息已删除或当前不可访问")); return; } followLatest.current = false; setShowLatest(true); setFocusTarget({ conversationId, messageId }); })); }}/>}<MessageContent message={message} connection={connection}/><div className="message-actions"><button aria-label={t("复制消息")} onClick={() => report(navigator.clipboard.writeText(blocksText(message.blocks)))}><Copy size={13}/></button><button aria-label={t("引用回复")} title={t("引用回复")} disabled={!!current?.archived || !!group?.archived} onClick={() => { setReply(message); composer.current?.focus(); }}><MessageSquare size={13}/><span>{t("引用")}</span></button><button aria-label={t("转发消息")} title={message.status === "streaming" ? t("生成完成后可转发") : t("转发消息")} disabled={!["complete", "error"].includes(message.status)} onClick={(event) => { forwardTrigger.current = event.currentTarget; setForwarding(message); }}><Forward size={13}/><span>{t("转发")}</span></button><GoogleExport connection={connection} messageId={message.id}/>{(message.authorType === "user" || message.status === "error" && messages.some((m) => m.id === message.replyTo && m.authorType === "user")) && <button aria-label={t("重新发送消息")} title={t("重新发送消息")} onClick={() => report(retryMessage(message))}><RotateCcw size={13}/></button>}</div></div></article>; })}</div>{queued.filter((q) => q.error || !messages.some((m) => m.clientMsgId === q.id)).map((q) => <div className="queued-message" key={q.id}><span><ReferencePreview text={q.text}/></span><small>{q.error ? t("发送失败：{0}", q.error) : q.blocked ? t("等待前一条消息处理") : t("等待发送")}</small>{q.error && <><button onClick={() => report(cache.outbox().then(async (entries) => { const entry = entries.find((e) => e.id === q.id); if (entry) await connection.send(entry.frame); }))}>{t("重试")}</button><button onClick={() => report(connection.discardFailed(q.id))}>{t("移除待发送项")}</button></>}</div>)}</div>
346:     : <WelcomeHome hasBots={state.status !== "online" || state.bots.length > 0} newChat={() => setNewChat({ kind: "direct", ...(activeBot ? { botId: activeBot.id } : {}) })} newBot={() => setNewBot(true)} newGroup={() => setNewChat({ kind: "group", ...(activeBot ? { botId: activeBot.id } : {}) })}/>}
```

## MobileHome.tsx:17-52
```tsx
17: // Phone-only IM home (messages / bots / me). Pure view: every action is a
18: // callback, nothing here talks to the network or touches stored state.
19: // Hidden on desktop by mobile-im.css; the desktop sidebar is untouched.
20: 
21: export type MobileTab = 'messages' | 'bots' | 'me';
22: export type MobileFilter = 'all' | 'unread' | 'groups';
23: export type MobileInboxState = { query: string; filter: MobileFilter };
24: export type MobileCreateKind = 'bot' | 'group' | 'direct';
25: export type MobileOpenTarget = 'settings' | 'files' | 'capabilities' | 'operations' | 'hosts' | 'archives';
26: type Locale = ReturnType<typeof useLocale>;
27: 
28: export type MobileHost = {
29:   id: string;
30:   name: string;
31:   connection: HubConnection;
32:   conversations: Conversation[];
33:   activity: Record<string, ConversationActivity>;
34:   pins: string[];
35:   bots: Bot[];
36: };
37: 
38: export type MobileHomeProps = {
39:   hosts: MobileHost[];
40:   activeHostId: string;
41:   tab: MobileTab;
42:   setTab: (value: MobileTab) => void;
43:   select: (hostId: string, conversationId: string) => void;
44:   newChat: (hostId: string, botId: string) => void;
45:   create: (kind: MobileCreateKind) => void;
46:   selectHost: (hostId: string) => void;
47:   open: (kind: MobileOpenTarget) => void;
48:   searchHistory: (query: string) => void;
49:   inbox?: MobileInboxState;
50:   updateInbox?: (value: MobileInboxState) => void;
51: };
52: 
```

## MobileHome.tsx:217-258
```tsx
217: }
218: 
219: function titleOf(conversation: Conversation): string {
220:   return conversation.title.trim() || t('未命名会话');
221: }
222: 
223: export function MobileHome(props: MobileHomeProps) {
224:   const { hosts, activeHostId, tab, setTab, create } = props;
225:   const locale = useLocale();
226:   const [localInbox, setLocalInbox] = useState<MobileInboxState>({ query: '', filter: 'all' });
227:   // The inbox lists every host, so its filters belong to the device shell,
228:   // not the currently visible host's cached Workspace.
229:   const { query, filter } = props.inbox ?? localInbox;
230:   const updateInbox = props.updateInbox ?? setLocalInbox;
231:   const setQuery = (query: string) => updateInbox({ query, filter });
232:   const setFilter = (filter: MobileFilter) => updateInbox({ query, filter });
233:   const rows = useMemo(() => buildMobileRows(hosts), [hosts]);
234:   const activeHost = hosts.find((host) => host.id === activeHostId);
235:   const needle = query.trim().toLocaleLowerCase();
236:   const totalUnread = rows.reduce((sum, row) => sum + row.unread, 0);
237:   const title = tab === 'messages' ? t('消息') : tab === 'bots' ? t('Bot') : t('我的');
238:   const pane: PaneProps = { ...props, rows, activeHost, needle, query, filter, locale };
239: 
240:   return (
241:     <div className="mobile-home" data-tab={tab}>
242:       <header className="mh-header">
243:         <div className="mh-titlebar">
244:           <h1 className="mh-title">{title}</h1>
245:           {tab !== 'me' && (
246:             <CreateMenu hostName={activeHost?.name} disabled={hosts.length === 0} onCreate={create} />
247:           )}
248:         </div>
249:         {tab !== 'me' && <SearchField value={query} onChange={setQuery} />}
250:         {tab === 'messages' && <FilterBar value={filter} onChange={setFilter} />}
251:       </header>
252:       <div className="mh-body" key={tab}>
253:         {tab === 'messages' && <MessagesPane {...pane} />}
254:         {tab === 'bots' && <BotsPane {...pane} />}
255:         {tab === 'me' && <MePane {...pane} />}
256:       </div>
257:       <TabBar tab={tab} setTab={setTab} unread={totalUnread} />
258:     </div>
```

## HostApp.tsx:20-37
```tsx
20: import { startDesktopUpdateChecks } from "./DesktopUpdates.js";
21: import { setLocale, t, useLocale } from "./i18n.js";
22: import "./hosts.css";
23: import type { MobileHost, MobileInboxState } from "./MobileHome.js";
24: 
25: export type HostCommand = { serial: number; kind: "select" | "bot" | "group" | "direct" | "home"; conversationId?: string; messageId?: string; botId?: string };
26: export type HostDirectory = { conversations: Conversation[]; activity: Record<string, ConversationActivity>; pins: string[]; bots: Bot[] };
27: export type ManagedWorkspace = {
28:   host: RuntimeHost; active: boolean; command?: HostCommand;
29:   controls: ReactNode; navigation: (current: HostDirectory & { selected: string }) => ReactNode;
30:   mobileHosts: (current: HostDirectory) => MobileHost[];
31:   mobileInbox: MobileInboxState;
32:   updateMobileInbox: (value: MobileInboxState) => void;
33:   mobileSelect: (id: string, value: Omit<HostCommand, "serial">) => void;
34:   manageHosts: () => void;
35:   preferences: Preferences; updatePreferences: (value: Preferences) => void;
36:   create: (kind: "bot" | "group" | "direct") => void;
37:   selection: (id: string) => void;
```

## HostApp.tsx:75-87
```tsx
75:   const [pool] = useState(() => new HostConnections(registry));
76:   const state = useSyncExternalStore((f) => pool.subscribe(f), () => pool.state);
77:   const [loading, setLoading] = useState(true), [legacyReset, setLegacyReset] = useState(false), [error, setError] = useState("");
78:   const [preferences, setPreferences] = useState<Preferences>(defaultPreferences);
79:   const [activeId, setActiveId] = useState(""), [filter, setFilter] = useState("");
80:   const [mobileInbox, setMobileInbox] = useState<MobileInboxState>({ query: "", filter: "all" });
81:   const [pairing, setPairing] = useState(false), [managing, setManaging] = useState(false);
82:   const [chooseCreation, setChooseCreation] = useState<"bot" | "group" | "direct">();
83:   const [commands, setCommands] = useState<Record<string, HostCommand>>({}), [selected, setSelected] = useState<Record<string, string>>({});
84:   const [directories, setDirectories] = useState<Record<string, HostDirectory & { registration: string }>>({});
85:   const sequence = useRef(0), activeRef = useRef(activeId); activeRef.current = activeId;
86:   const entriesRef = useRef(state.hosts); entriesRef.current = state.hosts;
87:   const [visited, setVisited] = useState<string[]>([]);
```

## HostApp.tsx:177-184
```tsx
177:     {!!error && <div className="host-error" role="alert">{error}<button onClick={() => setError("")}>{t("关闭")}</button></div>}
178:     {hosts.filter((entry) => entry.connection && visited.includes(entry.host.id)).map((entry) => <section key={entry.host.registrationId} hidden={pairing || activeId !== entry.host.id} style={pairing || activeId !== entry.host.id ? { display: "none" } : undefined} className="host-workspace" data-active-host={entry.host.id}><Workspace connection={entry.connection!} forget={async () => { setManaging(true); }} shell={{ host: entry.host, active: !pairing && activeId === entry.host.id, command: commands[entry.host.id], controls, navigation: (current) => navigation(entry.host.id, current), mobileHosts: (current) => hosts.flatMap((other) => {
179:         const data = other.host.id === entry.host.id ? current : directories[other.host.id];
180:         return other.connection && data ? [{ id: other.host.id, name: other.host.name, connection: other.connection, ...data }] : [];
181:       }), mobileInbox, updateMobileInbox: setMobileInbox, mobileSelect: command, manageHosts: () => setManaging(true), preferences, updatePreferences: setPreferences, create, selection: (id) => setSelected((old) => old[entry.host.id] === id ? old : { ...old, [entry.host.id]: id }), consumed: (serial) => setCommands((old) => { if (old[entry.host.id]?.serial !== serial) return old; const next = { ...old }; delete next[entry.host.id]; return next; }), shareHosts: hosts.map((other) => ({ hubKey: other.host.publicKey, deviceId: other.host.deviceId, name: other.host.name, open: (conversationId) => command(other.host.id, { kind: "select", conversationId }) })) }}/></section>)}
182:     {(pairing || !state.hosts.length) && <Pairing save={savePairing} beforePair={beforePair} discard={discardPairing} connected={onConnected} cancel={state.hosts.length ? () => setPairing(false) : undefined}/>}
183:     {!pairing && !!state.hosts.length && !state.hosts.some((entry) => entry.connection) && <main className="pairing-page"><BrandMark/><p>{t("主机连接尚未就绪。其他主机的配对和数据会保留。")}</p><button onClick={() => { void registry.recoverPreparations().then(() => pool.refresh()); }}>{t("重试")}</button><button onClick={() => setManaging(true)}>{t("管理运行主机")}</button><button onClick={() => setPairing(true)}>{t("添加主机")}</button></main>}
184:     {chooseCreation && <CreationDialog title={t("选择运行主机")} close={() => setChooseCreation(undefined)}><p>{t("Bot、工作区和会话将保存在所选主机上。群组只能加入这台主机的 Bot。")}</p><div className="host-choices">{hosts.map((entry) => <button key={entry.host.id} disabled={!entry.connection || entry.connection.state.status !== "online" || chooseCreation === "bot" && entry.connection.state.user?.role !== "owner"} onClick={() => { command(entry.host.id, { kind: chooseCreation }); setChooseCreation(undefined); }}><Monitor size={20}/><span><strong>{entry.host.name}</strong><small>{chooseCreation === "bot" && entry.connection?.state.user?.role !== "owner" ? t("需要管理员权限") : entry.connection?.state.status === "online" ? t("已连接") : t("离线")}</small></span></button>)}</div></CreationDialog>}
```

## Existing effort target (initial finding4 needs correction)
```css
.header-title:has(.header-effort){position:relative;min-height:44px;display:flex;flex-direction:column;justify-content:center}
.header-effort{padding:0;min-height:20px;max-width:100%;gap:4px;justify-content:flex-start;color:var(--muted);font-size:12px;line-height:1.4;border:0;background:transparent;text-align:left}
.header-effort>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.header-effort svg{flex-shrink:0}
.header-effort::after{content:"";position:absolute;inset:0;border-radius:var(--radius)}
.header-effort:hover:not(:disabled){color:var(--text)}
.header-effort:focus-visible::after{outline:2px solid var(--blue);outline-offset:2px}
.header-effort:disabled{opacity:1;cursor:default}
```
Header-title is position:relative and min-height44; header-effort::after inset0 already extends to full title region. Primary DOM measurements show message action buttons44px, effort actual box24px but pseudo-element44px. Do not add position:relative to the effort button because it would shrink the existing containing-block overlay.


## Limits
320x400 compact-height running-task composer passed Send/Steer-in-viewport checks. This is NOT an actual soft-keyboard test. Physical iOS/Android keyboard/IME and native package acceptance remain open. Original finding2 scroll-position consistency across host inboxes is still being considered separately; no claim that it is fixed.
