import type { DesignBotDraft } from "./workbench-design-comments.js";
import { workbenchErrorText } from "./workbench-error.js";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeft, ChevronDown, Columns2, FileText, FolderOpen, Globe, LayoutGrid, Presentation, List, Maximize2, Minimize2, MoreHorizontal, Plus, RotateCw, Square, SquarePen, Trash2, Users, X } from "lucide-react";
import { useLocale } from "./i18n.js";
import { WorkbenchSplitPicker } from "./WorkbenchSplitPicker.js";
import { WorkbenchController } from "./workbench-controller.js";
import { scheduleBrowserLayout } from "./workbench-browser.js";
import type { WorkbenchTab } from "./workbench-model.js";
import type { BoardAnnotation } from "./workbench-board.js";
import type { Message } from "../../src/client-protocol/index.js";
import { readReport, readWidget } from "../../src/client-protocol/widget.js";
import { Report } from "./Report.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { SidePanelResize } from "./SidePanelResize.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { WidgetComposeProvider } from "./widget-compose.js";
import { BrowserPage } from "./BrowserPage.js";
import "./workbench.css";

const WorkbenchDesign = lazy(() => import("./WorkbenchDesign.js"));
const WorkbenchSharedDesigns = lazy(() => import("./WorkbenchDesignSharing.js").then(module => ({ default: module.WorkbenchSharedDesigns })));
const WorkbenchMarkdown = lazy(() => import("./WorkbenchMarkdown.js"));
const WorkbenchCanvas = lazy(() => import("./WorkbenchCanvas.js"));
const Widget = lazy(() => import("./Widget.js").then(module => ({ default: module.Widget })));
export { workbenchErrorText } from "./workbench-error.js";

export type WorkbenchProps = { id?: string; compact?: boolean; controller: WorkbenchController; visible: boolean; phone: boolean; onClose(): void; onManageFiles?(): void; onAnnotate?(value: BoardAnnotation): Promise<void> | void; onExpandedChange?(expanded: boolean): void; onDesignCompose?(draft: DesignBotDraft): Promise<"opened"|"declined">; onCompose?(message: Message, text: string): boolean };
export function Workbench({ id = "conversation-workbench", compact = false, controller, visible, phone, onClose, onManageFiles, onAnnotate, onExpandedChange, onDesignCompose, onCompose }: WorkbenchProps) {
  useEffect(()=>controller.setDesignComposer(onDesignCompose),[controller,onDesignCompose]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), locale = useLocale();
  const connection = controller.connection, subscribeConnection = useCallback((listener: () => void) => connection.subscribe(listener), [connection]);
  const sharingAvailable = useSyncExternalStore(subscribeConnection, () => !!connection.state.workbenchDesignShareAvailable);
  const word = (zh: string, en: string) => locale === "en" ? en : zh;
  const panel = useRef<HTMLElement>(null), grid = useRef<HTMLDivElement>(null), tabbar = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null), menuTrigger = useRef<HTMLElement | null>(null), allTabsButton = useRef<HTMLButtonElement>(null);
  const [listTabOptions, setListTabOptions] = useState(false), [splitBusy, setSplitBusy] = useState(false);
  const [sharedList, setSharedList] = useState(false);
  const splitPending = useRef(false);
  const splitFocusReturn = useRef<HTMLElement | null>(null);
  const tabListReturn = useRef<{ id: string; scrollTop: number } | undefined>(undefined), restoreTabList = useRef(false);
  const [menu, setMenu] = useState<"add" | "all" | string>(), [rename, setRename] = useState<string>(), [name, setName] = useState("");
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number }>();
  const [deleting, setDeleting] = useState<string>(), dialog = useRef<HTMLDialogElement>(null);
  const [ratio, setRatio] = useState<{ column: number; row: number }>();
  const [expandedBounds, setExpandedBounds] = useState<CSSProperties>();
  const markdownImporter = useRef<HTMLInputElement>(null), designImporter = useRef<HTMLInputElement>(null);
  const layout = state.layout, maximized = layout.visible.length > 1 ? layout.maximized : null;
  const contextTab = menuPoint ? layout.tabs.find(tab => tab.id === menu) : undefined;
  const deletingTab = [...layout.tabs, ...layout.closed].find(tab => tab.id === deleting);
  const deletingNote = deletingTab?.kind === "markdown";
  const fullscreenBrowser = layout.tabs.find(tab => tab.kind === "browser" && state.browserTabs.get(tab.id)?.fullscreen)?.id;
  const expanded = compact || layout.expanded || !!fullscreenBrowser;
  const shown = fullscreenBrowser ? [fullscreenBrowser] : phone ? (layout.active ? [layout.active] : []) : maximized ? [maximized] : layout.visible;
  // A single page uses the tab bar; its restore action also lives there.
  const showPaneHeaders = !phone && shown.length > 1;
  const hasSplit = layout.visible.length > 1;
  const splitLabel = word(maximized ? "返回分屏" : hasSplit ? "合并分屏" : "分屏", maximized ? "Restore split" : hasSplit ? "Merge panes" : "Split tabs");
  const splitHint = fullscreenBrowser ? word("请先退出网页全屏", "Exit webpage fullscreen first")
    : maximized ? word("恢复之前的分屏组合", "Restore the previous split layout")
    : hasSplit ? word("只显示当前标签，其他标签仍保留", "Show the active tab; keep all other tabs")
    : layout.tabs.length < 2 ? word("至少打开两个标签后可分屏", "Open at least two tabs to split")
    : word("选择 2–4 个标签同时显示", "Choose 2–4 tabs to show together");
  const changeSplit = async (ids?: string[]) => {
    if (splitPending.current || fullscreenBrowser || !state.ready) return;
    splitPending.current = true; setSplitBusy(true);
    const picker = document.getElementById(`${id}-split-picker`);
    if (!ids) setMenu(undefined);
    try {
      await controller.change(ids ? { type: "set-visible", ids } : !maximized && hasSplit ? { type: "single" } : { type: "tile" });
      if (ids && picker?.isConnected) {
        splitFocusReturn.current = menuTrigger.current; setMenu(undefined);
      }
    } catch (error) { controller.setError(error instanceof Error ? error.message : "workbench_failed"); }
    finally { splitPending.current = false; setSplitBusy(false); }
  };
  const action = (run: () => Promise<unknown>) => { setMenu(undefined); void run().catch(error => controller.setError(error instanceof Error ? error.message : "workbench_failed")); };
  const toggleMenu = (value: string, trigger: HTMLElement) => { setListTabOptions(false); menuTrigger.current = trigger; setMenuPoint(undefined); setMenu(current => current === value && !menuPoint ? undefined : value); };
  const openTabMenu = (tab: WorkbenchTab, trigger: HTMLElement, point?: { x: number; y: number }) => {
    const bounds = trigger.getBoundingClientRect();
    setListTabOptions(false); menuTrigger.current = trigger;
    setMenuPoint(point ?? { x: bounds.left + 8, y: bounds.bottom + 4 });
    setMenu(tab.id);
  };
  useLayoutEffect(() => {
    if (splitBusy || menu === "split") return;
    const trigger = splitFocusReturn.current; splitFocusReturn.current = null;
    if (trigger?.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true });
  }, [splitBusy, menu]);
  useEffect(() => { controller.setVisible(visible); return () => controller.setVisible(false); }, [controller, visible]);
  useEffect(() => { onExpandedChange?.(expanded); }, [expanded, onExpandedChange]);
  useLayoutEffect(() => { scheduleBrowserLayout(); }, [visible, phone, shown.join(","), ratio, expanded, sharedList]);
  useLayoutEffect(() => {
    const strip = tabbar.current;
    if (!strip || !visible) return;
    const reveal = () => {
      const selected = strip.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!selected || strip.clientWidth === 0) return;
      const outer = strip.getBoundingClientRect(), tab = selected.getBoundingClientRect();
      // Scroll only the tab strip; scrollIntoView can move the chat/history too.
      if (tab.left < outer.left || tab.width > outer.width) strip.scrollLeft += tab.left - outer.left;
      else if (tab.right > outer.right) strip.scrollLeft += tab.right - outer.right;
    };
    const observer = new ResizeObserver(reveal); observer.observe(strip); reveal();
    return () => observer.disconnect();
  }, [visible, layout.active, layout.tabs.length, locale]);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !visible || phone || expanded) return;
    const header = element.parentElement?.querySelector<HTMLElement>(":scope > .conversation-main > .conversation-header");
    if (!header) return;
    // Match the actual adjacent header, including density and narrow layouts.
    // Keep tabs/actions in one row. Taller docked headers retain compact tabs;
    // compact headers (including ADHD) never increase the chat height.
    const measure = () => {
      const measured = header.getBoundingClientRect().height;
      const height = `${measured}px`;
      element.dataset.headerRoomy = String(measured >= 64);
      if (element.style.getPropertyValue("--workbench-header-height") === height) return;
      element.style.setProperty("--workbench-header-height", height); scheduleBrowserLayout();
    };
    const observer = new ResizeObserver(measure); observer.observe(header); measure();
    return () => { observer.disconnect(); element.style.removeProperty("--workbench-header-height"); delete element.dataset.headerRoomy; };
  }, [visible, phone, expanded]);
  useLayoutEffect(() => {
    if (!visible || !phone && !expanded) { setExpandedBounds(undefined); return; }
    const shell = panel.current?.parentElement, history = shell?.querySelector<HTMLElement>(":scope > .conversation-main > .message-scroll");
    if (!shell || !history) return;
    const measure = () => {
      // Navigation translates the conversation temporarily. Bounding client
      // rects include that animation, but ResizeObserver never reports its end,
      // leaving a permanent 28px offset. Anchor to the untransformed layout.
      let left = 0, top = 0, node: HTMLElement = history;
      while (node !== shell) {
        left += node.offsetLeft; top += node.offsetTop;
        const offsetParent: Element | null = node.offsetParent;
        if (!(offsetParent instanceof HTMLElement)) return;
        if (offsetParent !== shell) { left += offsetParent.clientLeft; top += offsetParent.clientTop; }
        node = offsetParent;
      }
      setExpandedBounds({ position: "absolute", left, top, width: history.offsetWidth, height: history.offsetHeight, right: "auto", bottom: "auto" });
    };
    const observer = new ResizeObserver(measure); observer.observe(shell); observer.observe(history); measure();
    window.addEventListener("resize", measure); return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [visible, phone, expanded]);
  useEffect(() => { if (!visible) { setMenu(undefined); setRename(undefined); setDeleting(undefined); } }, [visible]);
  useEffect(() => { if (menu && menu !== "add" && menu !== "all" && menu !== "split" && !layout.tabs.some(tab => tab.id === menu)) setMenu(undefined); }, [menu, layout.tabs]);
  useEffect(() => {
    // Pointer/keyboard tab menus use the shared portalled context menu.
    // Toolbar disclosures retain their existing in-panel focus handling.
    if (!menu || menu === "split" || menuPoint) return;
    const close = (event: Event) => { if (!(event.target instanceof Element) || !event.target.closest("[data-workbench-menu]")) setMenu(undefined); };
    const leave = (event: FocusEvent) => { if (event.target instanceof Node && !menuElement.current?.contains(event.target) && event.target !== menuTrigger.current) setMenu(undefined); };
    const keys = (event: KeyboardEvent) => {
      const element = menuElement.current;
      if (!element || !(event.target instanceof Node) || !element.contains(event.target) && event.target !== menuTrigger.current) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMenu(undefined); menuTrigger.current?.focus({preventScroll:true}); return; }
      // WebKit may move Tab focus outside the document without a focusin.
      // Close explicitly and let normal Tab traversal continue from the opener.
      if (event.key === "Tab") { setMenu(undefined); menuTrigger.current?.focus({preventScroll:true}); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...element.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      if (!buttons.length) return;
      event.preventDefault(); event.stopPropagation();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const element = menuElement.current, saved = menu === "all" && restoreTabList.current ? tabListReturn.current : undefined;
    restoreTabList.current = false;
    const restored = saved && [...element?.querySelectorAll<HTMLButtonElement>("[data-workbench-tab-options]") ?? []].find(button => button.dataset.workbenchTabOptions === saved.id);
    if (element && saved) element.scrollTop = saved.scrollTop;
    (restored || element?.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({preventScroll:true});
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", keys); document.addEventListener("focusin", leave);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", keys); document.removeEventListener("focusin", leave); };
  }, [menu, menuPoint]);
  useEffect(() => { if (phone || fullscreenBrowser) setMenu(current => current === "split" ? undefined : current); }, [phone, fullscreenBrowser]);
  useEffect(() => { if (rename || deleting) dialog.current?.showModal(); else dialog.current?.close(); }, [rename, deleting]);
  const dragRatio = (event: PointerEvent<HTMLDivElement>, axis: "column" | "row") => {
    if (event.button !== 0) return;
    const element = event.currentTarget, bounds = grid.current!.getBoundingClientRect(); element.setPointerCapture(event.pointerId); event.preventDefault();
    const initial = { column: layout.column, row: layout.row }; let next = initial;
    const move = (pointer: globalThis.PointerEvent) => { next = { ...initial, [axis]: Math.max(.2, Math.min(.8, axis === "column" ? (pointer.clientX - bounds.left) / bounds.width : (pointer.clientY - bounds.top) / bounds.height)) }; setRatio(next); };
    const end = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", cancel); setRatio(undefined); action(() => controller.change({ type: "ratio", axis, value: next[axis] })); };
    const cancel = () => { element.removeEventListener("pointermove", move); element.removeEventListener("pointerup", end); element.removeEventListener("pointercancel", cancel); setRatio(undefined); };
    element.addEventListener("pointermove", move); element.addEventListener("pointerup", end); element.addEventListener("pointercancel", cancel);
  };
  const tabIcon = (tab: WorkbenchTab) => tab.kind === "design" ? tab.designFormat === "slides" ? <Presentation size={14}/> : <LayoutGrid size={14}/> : tab.kind === "browser" ? <Globe size={14}/> : tab.kind === "whiteboard" ? <SquarePen size={14}/> : tab.kind === "markdown" ? <FileText size={14}/> : <Columns2 size={14}/>;
  const tabMenu = (tab: WorkbenchTab) => <>
    {!phone && !!fullscreenBrowser && <small className="workbench-menu-hint">{splitHint}</small>}
    {!phone && layout.visible.length > 0 && !layout.visible.includes(tab.id) && <><button disabled={layout.visible.length >= 4 || !!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : layout.visible.length >= 4 ? word("四个区域已满，点击标签可替换当前区域", "Four panes are in use; select this tab to replace the active pane") : undefined} onClick={() => action(() => controller.change({ type: "split", id: tab.id }))}>{word("加入分屏", "Add to split")}</button>
      {layout.visible.length >= 4 && <small className="workbench-menu-hint">{word("四个区域已满。点击标签可替换当前区域。", "All four regions are in use. Select a tab to replace the active region.")}</small>}</>}
    {!phone && hasSplit && <><button disabled={!!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : undefined} onClick={() => action(() => controller.change({ type: "single", id: tab.id }))}>{word("仅显示此标签", "Show only this tab")}</button>
      {layout.visible.includes(tab.id) && <button disabled={!!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : undefined} onClick={() => action(() => controller.change({ type: "remove", id: tab.id }))}>{word("移出分屏，保留标签", "Remove from split, keep tab")}</button>}<hr/></>}
    <button onClick={() => { setMenu(undefined); setName(tab.title); setRename(tab.id); }}>{word("重命名", "Rename")}</button>
    {layout.tabs.length > 1 && <><button disabled={layout.tabs[0]?.id === tab.id} onClick={() => action(() => controller.change({ type: "move", id: tab.id, direction: -1 }))}>{word("向左移动", "Move left")}</button>
    <button disabled={layout.tabs.at(-1)?.id === tab.id} onClick={() => action(() => controller.change({ type: "move", id: tab.id, direction: 1 }))}>{word("向右移动", "Move right")}</button></>}
    <hr/><button onClick={() => action(() => controller.closeTab(tab.id))}>{word("关闭标签", "Close tab")}</button>
    {tab.kind === "design" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{word("删除这个设计", "Delete this design")}</button>}
    {tab.kind === "markdown" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{word("删除这篇笔记", "Delete this note")}</button>}
    {tab.kind === "whiteboard" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{word("删除这张白板", "Delete this board")}</button>}
  </>;
  return <aside id={id} ref={panel} className={`workbench${phone ? " workbench-phone" : expanded ? " workbench-wide" : " conversation-side-panel"}`} style={expandedBounds} hidden={!visible} onAnimationEnd={event => { if (event.target === event.currentTarget) scheduleBrowserLayout(); }} aria-label={word("工作台", "Workbench")}>
    <SidePanelResize panel={panel} visible={visible && !phone && !expanded} controls={id} label={word("调整工作台宽度", "Resize workbench")}/>
    <div className="workbench-tabrow">
      <div className="workbench-tab-strip">
      <div className="workbench-tabs" role="tablist" aria-label={word("工作台标签", "Workbench tabs")} ref={tabbar}>
        {layout.tabs.map(tab => <button key={tab.id} role="tab" aria-selected={layout.active === tab.id} aria-controls={`${id}-pane-${tab.id}`} tabIndex={layout.active === tab.id ? 0 : -1}
          onClick={() => action(() => controller.change({ type: "select", id: tab.id }))}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); openTabMenu(tab, event.currentTarget, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined); }}
          onKeyDown={event => {
            if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); event.stopPropagation(); openTabMenu(tab, event.currentTarget); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault();
            const index = layout.tabs.findIndex(value => value.id === tab.id), next = event.key === "Home" ? 0 : event.key === "End" ? layout.tabs.length - 1 : (index + (event.key === "ArrowLeft" ? -1 : 1) + layout.tabs.length) % layout.tabs.length;
            const target = layout.tabs[next]; action(() => controller.change({ type: "select", id: target.id })); (tabbar.current?.children[next] as HTMLElement | undefined)?.focus();
          }}>{tabIcon(tab)}<span>{tab.title}</span></button>)}
      </div>
      <button className="workbench-new-tab" data-workbench-menu aria-label={word("新建内容", "New content")} title={word("新建内容", "New content")} aria-controls={`${id}-new-content`} aria-expanded={menu === "add"} onClick={event => toggleMenu("add", event.currentTarget)}><Plus size={18}/></button>
      {menu === "add" && !menuPoint && <div id={`${id}-new-content`} ref={menuElement} className="workbench-menu workbench-new-menu" role="menu" data-workbench-menu data-workbench-overlay>
        {sharingAvailable && <><button onClick={() => { setMenu(undefined); setSharedList(true); }}><Users size={15}/>{word("共享给我的项目", "Projects shared with me")}</button><hr/></>}
        <><button onClick={() => action(() => controller.createDesign(word("画布", "Canvas")))}><LayoutGrid size={15}/>{word("画布", "Canvas")}</button>
          <button onClick={() => { setMenu(undefined); designImporter.current?.click(); }}>{word("导入项目", "Import project")}</button>
          <button onClick={() => action(() => controller.createDesign("PPT", undefined, undefined, undefined, "slides"))}><Presentation size={15}/>PPT</button><button onClick={() => action(() => controller.createBoard(word("白板", "Whiteboard")))}><SquarePen size={15}/>{word("新建白板", "New whiteboard")}</button><button onClick={() => action(() => controller.createMarkdown(word("笔记.md", "Note.md")))}><FileText size={15}/>{word("新建笔记", "New note")}</button><button onClick={() => { setMenu(undefined); markdownImporter.current?.click(); }}>{word("导入 Markdown / 文本", "Import Markdown / text")}</button><button disabled={!state.browser} onClick={() => action(() => controller.openBrowser())}><Globe size={15}/>{word("新建网页", "New webpage")}</button>{!state.browser && <small>{word("网页由桌面版提供", "Webpages are available on desktop")}</small>}</>
      </div>}
      </div>
      <div className="workbench-tab-actions" data-workbench-menu>
        <button ref={allTabsButton} aria-label={word("全部标签和已关闭内容", "All tabs and closed content")} title={word("标签列表与管理", "Tabs and management")} aria-expanded={menu === "all" || !!menu && listTabOptions} onClick={event => toggleMenu("all", event.currentTarget)}><List size={17}/></button>
        {!phone && <button className="workbench-split-toggle" aria-label={splitLabel} title={splitHint} aria-pressed={hasSplit ? !maximized : undefined} aria-haspopup={!hasSplit ? "dialog" : undefined} aria-expanded={!hasSplit ? menu === "split" : undefined} aria-controls={!hasSplit ? `${id}-split-picker` : undefined} aria-disabled={splitBusy || undefined} aria-busy={splitBusy || undefined} disabled={!state.ready || !!fullscreenBrowser || !maximized && !hasSplit && layout.tabs.length < 2} onClick={event => { if (splitBusy) return; if (hasSplit || maximized) void changeSplit(); else toggleMenu("split", event.currentTarget); }}>{hasSplit && !maximized ? <Square size={15}/> : <LayoutGrid size={15}/>}<span>{word(maximized ? "还原" : hasSplit ? "合并" : "分屏", maximized ? "Restore" : hasSplit ? "Merge" : "Split")}</span></button>}
        {!phone && hasSplit && <button className="workbench-split-adjust" aria-label={word("调整分屏", "Choose split tabs")} title={word("调整分屏标签", "Choose split tabs")} aria-haspopup="dialog" aria-expanded={menu === "split"} aria-controls={`${id}-split-picker`} disabled={!!fullscreenBrowser} aria-disabled={splitBusy || undefined} onClick={event => { if (!splitBusy) toggleMenu("split", event.currentTarget); }}><ChevronDown size={15}/></button>}
        {menu === "split" && !phone && !fullscreenBrowser && <WorkbenchSplitPicker id={`${id}-split-picker`} tabs={layout.tabs} visible={layout.visible} busy={splitBusy} trigger={menuTrigger.current} word={word} icon={tabIcon} onApply={ids => void changeSplit(ids)} onClose={() => setMenu(undefined)}/>}
        {!phone && !compact && <button disabled={!!fullscreenBrowser} aria-label={word(expanded ? "返回右侧" : "展开到主区", expanded ? "Return to side" : "Expand workbench")} title={word(expanded ? "返回右侧" : "展开到主区", expanded ? "Return to side" : "Expand workbench")} onClick={() => action(() => controller.change({ type: "expanded", value: !layout.expanded }))}>{expanded ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>}
        <button aria-label={word("返回聊天", "Return to chat")} title={word("返回聊天", "Return to chat")} onClick={onClose}><X size={18}/></button>
        {menu && menu !== "add" && menu !== "split" && !menuPoint && <div ref={menuElement} className="workbench-menu" role="menu" data-workbench-overlay>
          {menu === "all" ? <>{onManageFiles && <button onClick={() => { setMenu(undefined); onManageFiles(); }}><FolderOpen size={15}/>{word("管理所有工作台文件", "Manage all workbench files")}</button>}{!layout.tabs.length && !layout.closed.length && <small>{word("还没有标签，点击 + 新建内容", "No tabs yet. Use + to create content")}</small>}{layout.tabs.map(tab => <div key={tab.id} className="workbench-tab-list-row"><button aria-label={tab.title} aria-describedby={layout.active !== tab.id && !phone && layout.visible.includes(tab.id) ? `${id}-tab-status-${tab.id}` : undefined} aria-current={layout.active === tab.id ? "true" : undefined} title={tab.title} onClick={() => action(() => controller.change({ type: "select", id: tab.id }))}>{tabIcon(tab)}<span>{tab.title}</span>{layout.active === tab.id ? <small>{word("当前", "Active")}</small> : !phone && layout.visible.includes(tab.id) && <small id={`${id}-tab-status-${tab.id}`}>{word("分屏中", "Visible")}</small>}</button><button data-workbench-tab-options={tab.id} aria-label={word(`标签选项：${tab.title}`, `Tab options: ${tab.title}`)} title={word("标签选项", "Tab options")} onClick={() => { tabListReturn.current = { id: tab.id, scrollTop: menuElement.current?.scrollTop ?? 0 }; menuTrigger.current = allTabsButton.current; setMenuPoint(undefined); setListTabOptions(true); setMenu(tab.id); }}><MoreHorizontal size={16}/></button></div>)}{!!layout.closed.length && <><hr/><small>{word("最近关闭 · 内容保留", "Recently closed · content retained")}</small>{layout.closed.slice().reverse().map(tab => <div key={tab.id} className="workbench-closed-row"><button onClick={() => action(() => controller.reopen(tab.id))}>{tabIcon(tab)}<span>{tab.title}</span><RotateCw size={13}/></button>{tab.kind === "whiteboard" || tab.kind === "markdown" || tab.kind === "design" ? <button aria-label={word(tab.kind === "design" ? `删除这个设计：${tab.title}` : tab.kind === "markdown" ? `删除这篇笔记：${tab.title}` : `删除这张白板：${tab.title}`, tab.kind === "design" ? `Delete this design: ${tab.title}` : tab.kind === "markdown" ? `Delete this note: ${tab.title}` : `Delete this board: ${tab.title}`)} onClick={() => { setMenu(undefined); setDeleting(tab.id); }}><Trash2 size={14}/></button> : <button aria-label={word(`移除最近关闭记录：${tab.title}`, `Remove closed reference: ${tab.title}`)} title={word("仅移除此记录，聊天和网站数据保留", "Remove only this reference; chat and website data remain")} onClick={() => action(() => controller.forgetClosed(tab.id))}><X size={14}/></button>}</div>)}</>}</>
              : layout.tabs.find(tab => tab.id === menu) ? <>{listTabOptions && <button onClick={() => { restoreTabList.current = true; setListTabOptions(false); setMenu("all"); }}><ArrowLeft size={14}/>{word("返回标签列表", "Back to tabs")}</button>}<small className="workbench-menu-tab-title">{layout.tabs.find(tab => tab.id === menu)!.title}</small>{tabMenu(layout.tabs.find(tab => tab.id === menu)!)}</> : null}
        </div>}
      </div>
    </div>
    {sharedList && <div className="workbench-shared-list-host">
      <Suspense fallback={<p role="status">{word("正在读取共享设计…", "Loading shared designs…")}</p>}>
        <WorkbenchSharedDesigns controller={controller} onClose={() => { setSharedList(false); menuTrigger.current?.focus({preventScroll:true}); }}/>
      </Suspense>
    </div>}
    {visible && contextTab && menuPoint && <DesktopMenu id={`${id}-tab-context-menu`} label={word("标签选项", "Tab options")} open close={() => setMenu(undefined)} trigger={menuTrigger} placement="down-start" point={menuPoint} className="workbench-context-menu">{tabMenu(contextTab)}</DesktopMenu>}
    <input ref={designImporter} type="file" accept=".tarobot-design.json" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) action(() => controller.importDesign(file)); }}/>
    <input ref={markdownImporter} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" multiple hidden onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; action(async () => { for (const file of files) await controller.importMarkdown(file); }); }}/>
    {state.error && <div className="workbench-error" role="alert"><span>{workbenchErrorText(state.error, locale)}</span><button aria-label={word("关闭提示", "Dismiss")} onClick={() => controller.setError()}><X size={15}/></button></div>}
    {!state.ready ? <div className="workbench-empty" role="status">{word("正在打开工作台…", "Opening workbench…")}</div> : !shown.length ? <div className="workbench-empty"><SquarePen size={25} aria-hidden="true"/><h2>{word("工作台", "Workbench")}</h2><p>{word("写笔记、画图或浏览网页，也可让 Bot 帮你继续。", "Write notes, draw or browse, and ask your Bot to help.")}</p><div><button onClick={() => action(() => controller.createDesign(word("画布", "Canvas")))}><LayoutGrid size={15}/>{word("画布", "Canvas")}</button><button onClick={() => action(() => controller.createDesign("PPT", undefined, undefined, undefined, "slides"))}><Presentation size={15}/>PPT</button><button onClick={() => action(() => controller.createBoard(word("白板", "Whiteboard")))}><Plus size={15}/>{word("白板", "Whiteboard")}</button><button onClick={() => action(() => controller.createMarkdown(word("笔记.md", "Note.md")))}><FileText size={15}/>{word("笔记", "Note")}</button>{state.browser && <button onClick={() => action(() => controller.openBrowser())}><Globe size={15}/>{word("网页", "Webpage")}</button>}</div></div> : null}
    <div ref={grid} className="workbench-panes" data-count={shown.length} style={{ "--workbench-column": `${(ratio?.column ?? layout.column) * 100}%`, "--workbench-row": `${(ratio?.row ?? layout.row) * 100}%` } as CSSProperties}>
      {layout.tabs.map(tab => {
        const index = shown.indexOf(tab.id), active = visible && index >= 0;
        return <section key={tab.id} id={`${id}-pane-${tab.id}`} role="tabpanel" aria-label={tab.title} className={`workbench-pane${layout.active === tab.id ? " workbench-pane-active" : ""}`} data-slot={index} hidden={index < 0}
          onPointerDownCapture={() => { if (layout.active !== tab.id) action(() => controller.change({ type: "select", id: tab.id })); }}>
          {showPaneHeaders && <header className="workbench-pane-header"><span>{tab.title}</span><button aria-label={word("标签选项", "Tab options")} onClick={event => toggleMenu(tab.id, event.currentTarget)}><MoreHorizontal size={14}/></button>
            <button aria-label={word("放大当前区域", "Maximize region")} onClick={() => action(() => controller.change({ type: "maximize", id: tab.id }))}><Maximize2 size={14}/></button>
            <button aria-label={word("移出分屏，保留标签", "Remove from split, keep tab")} onClick={() => action(() => controller.change({ type: "remove", id: tab.id }))}><X size={15}/></button></header>}
          <div className={`workbench-pane-content workbench-${tab.kind}`}>
            {tab.kind === "whiteboard" ? state.boards.has(tab.id) ? <Suspense fallback={<p role="status">{word("正在加载白板…", "Loading whiteboard…")}</p>}><WorkbenchCanvas key={tab.id} scope={controller.scope} document={state.boards.get(tab.id)!} savedRevision={() => controller.boardSavedRevision(tab.id)} visible={active} lang={locale}
              persist={(revision, document) => controller.persistBoard(revision, document)} onDocument={controller.boardDocument} onController={value => controller.bindBoard(tab.id, value)} onAnnotate={onAnnotate} onImportBoard={content => controller.importBoard(content)}/></Suspense> : <p>{word("白板文件不可用。", "Board data is unavailable.")}</p>
              : tab.kind === "design" ? controller.designSession(tab.id) ? <Suspense fallback={<p role="status">{word("正在打开设计…", "Opening design…")}</p>}><WorkbenchDesign controller={controller} session={controller.designSession(tab.id)!} active={active} title={tab.title} botAvailable={tab.designFormat === "slides" ? controller.connection.state.workbenchSlidesAvailable === true : controller.connection.state.workbenchDesignAvailable === true} onActivate={() => { if (controller.getSnapshot().layout.active !== tab.id) action(() => controller.change({ type: "select", id: tab.id })); }}/></Suspense> : <p>{word("正在打开设计…", "Opening design…")}</p>
              : tab.kind === "markdown" ? active && controller.markdownSession(tab.id) ? <Suspense fallback={<p role="status">{word("正在打开笔记…", "Opening note…")}</p>}><WorkbenchMarkdown session={controller.markdownSession(tab.id)!} title={tab.title} botAvailable={controller.connection.state.workbenchMarkdownAvailable === true}/></Suspense> : <p>{word("正在打开笔记…", "Opening note…")}</p>
                : tab.kind === "chart" ? <ChartPane controller={controller} tab={tab} active={active} compact={shown.length > 2} version={state.chartVersion} onCompose={onCompose}/>
                : <BrowserPane controller={controller} tab={tab} active={active}/>}
          </div>
        </section>;
      })}
      {!phone && !maximized && shown.length > 1 && <div className="workbench-divider workbench-divider-column" role="separator" tabIndex={0} aria-label={word("调整左右比例", "Resize columns")} aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout.column * 100)} onPointerDown={event => dragRatio(event, "column")} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); event.stopPropagation(); action(() => controller.change({ type: "ratio", axis: "column", value: layout.column + (event.key === "ArrowLeft" ? -.05 : .05) }));
      }}/>}
      {!phone && !maximized && shown.length > 2 && <div className="workbench-divider workbench-divider-row" role="separator" tabIndex={0} aria-label={word("调整上下比例", "Resize rows")} aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout.row * 100)} onPointerDown={event => dragRatio(event, "row")} onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); event.stopPropagation(); action(() => controller.change({ type: "ratio", axis: "row", value: layout.row + (event.key === "ArrowUp" ? -.05 : .05) }));
      }}/>}
    </div>
    <dialog ref={dialog} className="workbench-dialog" onCancel={event => { event.preventDefault(); setRename(undefined); setDeleting(undefined); }}>
      {rename ? <form onSubmit={event => { event.preventDefault(); const id = rename; setRename(undefined); action(() => controller.change({ type: "rename", id, title: name })); }}><label>{word("重命名标签", "Rename tab")}<input autoFocus value={name} maxLength={128} required onChange={event => setName(event.target.value)}/></label><div><button type="button" onClick={() => setRename(undefined)}>{word("取消", "Cancel")}</button><button type="submit">{word("保存", "Save")}</button></div></form> : deleting ? <><h3>{word(deletingTab?.kind === "design" ? "删除这个设计？" : deletingNote ? "删除这篇笔记？" : "删除这张白板？", deletingTab?.kind === "design" ? "Delete this design?" : deletingNote ? "Delete this note?" : "Delete this board?")}</h3><p>{word(`仅删除此对话中的「${deletingTab?.title ?? ""}」及其在当前设备保存的内容。其他设计、笔记、白板和聊天消息保留。需要保留时请先导出。`, `Delete “${deletingTab?.title ?? ""}” and its saved content from this conversation on this device. Other designs, notes, boards and chat messages remain. Export a copy first if needed.`)}</p><div><button onClick={() => setDeleting(undefined)}>{word("取消", "Cancel")}</button><button className="danger" onClick={() => { const id = deleting; setDeleting(undefined); action(() => deletingTab?.kind === "design" ? controller.deleteDesign(id) : deletingNote ? controller.deleteMarkdown(id) : controller.deleteBoard(id)); }}>{word(deletingTab?.kind === "design" ? "删除设计" : deletingNote ? "删除笔记" : "删除白板", deletingTab?.kind === "design" ? "Delete design" : deletingNote ? "Delete note" : "Delete board")}</button></div></> : null}
    </dialog>
  </aside>;
}

function ChartPane({ controller, tab, active, compact, version, onCompose }: { controller: WorkbenchController; tab: WorkbenchTab; active: boolean; compact: boolean; version: number; onDesignCompose?(draft: DesignBotDraft): Promise<"opened"|"declined">; onCompose?(message: Message, text: string): boolean }) {
  const locale = useLocale();
  const [loaded, setLoaded] = useState<{ controller: WorkbenchController; sourceKey: string; message?: Message; error?: string }>();
  const source = tab.source, sourceKey = JSON.stringify(source);
  const current = loaded?.controller === controller && loaded.sourceKey === sourceKey ? loaded : undefined;
  const message = current?.message, error = current?.error;
  useLayoutEffect(() => {
    let live = true;
    // Conversation revisions include unrelated incoming chat/status changes.
    // Revalidate the source without tearing down its interactive runtime. A
    // different source/controller is hidden immediately by the identity check
    // above; a deleted/inaccessible source still replaces the content with an error.
    if (source) void controller.source(source).then(value => { if (live) setLoaded({controller,sourceKey,message:value}); }, error => { if (live) setLoaded({controller,sourceKey,error:error instanceof Error ? error.message : "workbench_source_unavailable"}); });
    else setLoaded({controller,sourceKey,error:"workbench_source_unavailable"});
    return () => { live = false; };
  }, [controller, sourceKey, version]);
  const block = message?.blocks[source?.blockIndex ?? -1], widget = block && readWidget(block), report = block && readReport(block);
  useEffect(() => {
    if (!active || !source || !message || !report) return;
    const frame = requestAnimationFrame(() => controller.markChartRendered(tab.id, source)); return () => cancelAnimationFrame(frame);
  }, [active, sourceKey, message, controller, tab.id]);
  if (error) return <p className="workbench-unavailable" role="status">{workbenchErrorText(error, locale)}</p>;
  if (!widget) return <p role="status">{locale === "en" ? "Loading source…" : "正在读取来源…"}</p>;
  return <RuntimeHostActiveContext.Provider value={active}><WidgetComposeProvider scope={controller.scope} owner={`workbench:${controller.connection.identity.deviceId}:${controller.getSnapshot().windowId}`} active={active} message={message!} compose={onCompose ?? (() => false)}>{report ? <Report title={widget.title} summary={widget.summary} report={report} compact={compact} showHeader={false}/> : active ? <Suspense fallback={<p role="status">{locale === "en" ? "Loading content…" : "正在加载内容…"}</p>}><Widget widget={widget} showHeader={false} instanceKey={`workbench:${controller.scope}:${tab.id}`} onReady={() => { if (source && active) controller.markChartRendered(tab.id, source); }} onRenderError={() => { if (source && active) controller.markChartFailed(tab.id, source); }}/></Suspense> : null}</WidgetComposeProvider></RuntimeHostActiveContext.Provider>;
}

function BrowserPane({ controller, tab, active }: { controller: WorkbenchController; tab: WorkbenchTab; active: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), locale = useLocale();
  return <BrowserPage controller={controller} tab={tab} active={active} native={state.browserTabs.get(tab.id)} supported={state.browser} errorText={code => workbenchErrorText(code, locale)}/>;
}

export default Workbench;
