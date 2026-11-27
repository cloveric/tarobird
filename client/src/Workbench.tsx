import type { DesignBotDraft } from "./workbench-design-comments.js";
import { workbenchErrorText } from "./workbench-error.js";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import { ArrowLeft, ChevronDown, Columns2, Download, FileText, FolderOpen, Globe, LayoutGrid, Presentation, List, Maximize2, Minimize2, MoreHorizontal, Plus, Puzzle, RotateCw, Square, SquarePen, Trash2, Users, X } from "lucide-react";
import { getPluginRegistry, resolvePluginScopeId, unavailablePluginRegistry, type PluginRegistry } from "./plugin-registry.js";
import { PluginSandboxFrame } from "./PluginSandboxFrame.js";
import { isPluginSandboxSupported } from "./plugin-sandbox-runtime.js";
import { t, useLocale } from "./i18n.js";
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
import { saveDesignBackup } from "./workbench-design-export.js";
import "./workbench.css";

const WorkbenchDesign = lazy(() => import("./WorkbenchDesign.js"));
const WorkbenchSharedDesigns = lazy(() => import("./WorkbenchDesignSharing.js").then(module => ({ default: module.WorkbenchSharedDesigns })));
const WorkbenchMarkdown = lazy(() => import("./WorkbenchMarkdown.js"));
const WorkbenchCanvas = lazy(() => import("./WorkbenchCanvas.js"));
const Widget = lazy(() => import("./Widget.js").then(module => ({ default: module.Widget })));
export { workbenchErrorText } from "./workbench-error.js";

export type WorkbenchProps = { id?: string; compact?: boolean; controller: WorkbenchController; pluginRegistry?: PluginRegistry; visible: boolean; phone: boolean; onClose(): void; onManageFiles?(): void; onOpenPlugins?(): void; onAnnotate?(value: BoardAnnotation): Promise<void> | void; onExpandedChange?(expanded: boolean): void; onDesignCompose?(draft: DesignBotDraft): Promise<"opened"|"declined">; onCompose?(message: Message, text: string): boolean; onRequestInstallPlugin?(pluginId: string): void };
export function Workbench({ id = "conversation-workbench", compact = false, controller, pluginRegistry: pluginRegistryProp, visible, phone, onClose, onManageFiles, onOpenPlugins, onAnnotate, onExpandedChange, onDesignCompose, onCompose, onRequestInstallPlugin }: WorkbenchProps) {
  useEffect(()=>controller.setDesignComposer(onDesignCompose),[controller,onDesignCompose]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), locale = useLocale();
  const connection = controller.connection, subscribeConnection = useCallback((listener: () => void) => connection.subscribe(listener), [connection]);
  const connectionUserId = useSyncExternalStore(subscribeConnection, () => connection.state.user?.id);
  const resolvedPluginScope = resolvePluginScopeId(connection.identity.hubPublicKey, connectionUserId, connection.identity.deviceId);
  const activePluginRegistry = useMemo(
    () => resolvedPluginScope === null ? unavailablePluginRegistry
      : pluginRegistryProp?.getScopeId() === resolvedPluginScope ? pluginRegistryProp : getPluginRegistry(resolvedPluginScope),
    [pluginRegistryProp, resolvedPluginScope],
  );
  const pluginState = useSyncExternalStore(activePluginRegistry.subscribe, activePluginRegistry.getSnapshot);
  const pluginRuntimeAvailable = isPluginSandboxSupported();
  const pluginUnavailableMessage = pluginRuntimeAvailable ? undefined : t("当前版本缺少插件隔离运行支持，请更新 App 或系统后重试。");
  const workbenchPlugins = activePluginRegistry.enabledContributions(phone ? "phone" : "desktop", "workbench-item");
  const uninstalledWorkbenchPlugins = phone ? [] : activePluginRegistry.catalogForPlatform("desktop").filter(entry =>
    entry.manifest.official && !pluginState.installed[entry.manifest.id] && entry.manifest.contributions.some(c => c.kind === "workbench-item"),
  );
  const sharingAvailable = useSyncExternalStore(subscribeConnection, () => !!connection.state.workbenchDesignShareAvailable);
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
  const markdownImporter = useRef<HTMLInputElement>(null), designImporter = useRef<HTMLInputElement>(null), pptxImporter = useRef<HTMLInputElement>(null);
  const layout = state.layout, maximized = layout.visible.length > 1 ? layout.maximized : null;
  const contextTab = menuPoint ? layout.tabs.find(tab => tab.id === menu) : undefined;
  const deletingTab = [...layout.tabs, ...layout.closed].find(tab => tab.id === deleting);
  const deletingNote = deletingTab?.kind === "markdown";
  const deletingSlides = deletingTab?.kind === "design" && deletingTab.designFormat === "slides";
  const fullscreenBrowser = layout.tabs.find(tab => tab.kind === "browser" && state.browserTabs.get(tab.id)?.fullscreen)?.id;
  const expanded = compact || layout.expanded || !!fullscreenBrowser;
  const shown = fullscreenBrowser ? [fullscreenBrowser] : phone ? (layout.active ? [layout.active] : []) : maximized ? [maximized] : layout.visible;
  // A single page uses the tab bar; its restore action also lives there.
  const showPaneHeaders = !phone && shown.length > 1;
  const hasSplit = layout.visible.length > 1;
  const splitLabel = t(maximized ? "返回分屏" : hasSplit ? "合并分屏" : "分屏");
  const splitHint = fullscreenBrowser ? t("请先退出网页全屏")
    : maximized ? t("恢复之前的分屏组合")
    : hasSplit ? t("只显示当前标签，其他标签仍保留")
    : layout.tabs.length < 2 ? t("至少打开两个标签后可分屏")
    : t("选择 2–4 个标签同时显示");
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
  const tabIcon = (tab: WorkbenchTab) => tab.kind === "design" ? tab.designFormat === "slides" ? <Presentation size={14}/> : <LayoutGrid size={14}/> : tab.kind === "browser" ? <Globe size={14}/> : tab.kind === "whiteboard" ? <SquarePen size={14}/> : tab.kind === "markdown" ? <FileText size={14}/> : tab.kind === "plugin" ? <Puzzle size={14}/> : <Columns2 size={14}/>;
  const tabMenu = (tab: WorkbenchTab) => <>
    {!phone && !!fullscreenBrowser && <small className="workbench-menu-hint">{splitHint}</small>}
    {!phone && layout.visible.length > 0 && !layout.visible.includes(tab.id) && <><button disabled={layout.visible.length >= 4 || !!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : layout.visible.length >= 4 ? t("四个区域已满，点击标签可替换当前区域") : undefined} onClick={() => action(() => controller.change({ type: "split", id: tab.id }))}>{t("加入分屏")}</button>
      {layout.visible.length >= 4 && <small className="workbench-menu-hint">{t("四个区域已满。点击标签可替换当前区域。")}</small>}</>}
    {!phone && hasSplit && <><button disabled={!!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : undefined} onClick={() => action(() => controller.change({ type: "single", id: tab.id }))}>{t("仅显示此标签")}</button>
      {layout.visible.includes(tab.id) && <button disabled={!!fullscreenBrowser || splitBusy} title={fullscreenBrowser ? splitHint : undefined} onClick={() => action(() => controller.change({ type: "remove", id: tab.id }))}>{t("移出分屏，保留标签")}</button>}<hr/></>}
    <button onClick={() => { setMenu(undefined); setName(tab.title); setRename(tab.id); }}>{t("重命名")}</button>
    {layout.tabs.length > 1 && <><button disabled={layout.tabs[0]?.id === tab.id} onClick={() => action(() => controller.change({ type: "move", id: tab.id, direction: -1 }))}>{t("向左移动")}</button>
    <button disabled={layout.tabs.at(-1)?.id === tab.id} onClick={() => action(() => controller.change({ type: "move", id: tab.id, direction: 1 }))}>{t("向右移动")}</button></>}
    <hr/><button onClick={() => action(() => controller.closeTab(tab.id))}>{t("关闭标签")}</button>
    {tab.kind === "design" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{tab.designFormat === "slides" ? t("删除这个演示文稿") : t("删除这个设计")}</button>}
    {tab.kind === "markdown" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{t("删除这篇笔记")}</button>}
    {tab.kind === "whiteboard" && <button className="danger" onClick={() => { setMenu(undefined); setDeleting(tab.id); }}>{t("删除这张白板")}</button>}
  </>;
  return <aside id={id} ref={panel} className={`workbench${phone ? " workbench-phone" : expanded ? " workbench-wide" : " conversation-side-panel"}`} style={expandedBounds} hidden={!visible} onAnimationEnd={event => { if (event.target === event.currentTarget) scheduleBrowserLayout(); }} aria-label={t("工作台")}>
    <SidePanelResize panel={panel} visible={visible && !phone && !expanded} controls={id} label={t("调整工作台宽度")}/>
    <div className="workbench-tabrow">
      <div className="workbench-tab-strip">
      <div className="workbench-tabs" role="tablist" aria-label={t("工作台标签")} ref={tabbar}>
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
      <button className="workbench-new-tab" data-workbench-menu aria-label={t("新建内容")} title={t("新建内容")} aria-controls={`${id}-new-content`} aria-expanded={menu === "add"} onClick={event => toggleMenu("add", event.currentTarget)}><Plus size={18}/></button>
      {menu === "add" && !menuPoint && <div id={`${id}-new-content`} ref={menuElement} className="workbench-menu workbench-new-menu" role="menu" data-workbench-menu data-workbench-overlay>
        {sharingAvailable && <><button onClick={() => { setMenu(undefined); setSharedList(true); }}><Users size={15}/>{t("共享给我的项目")}</button><hr/></>}
        <>{!phone && <button onClick={() => action(() => controller.createDesign(t("演示文稿"), undefined, undefined, undefined, "slides"))}><Presentation size={15}/>{t("演示文稿")}</button>}
          <button onClick={() => { setMenu(undefined); pptxImporter.current?.click(); }}><Presentation size={15}/>{t("导入演示文稿 (.pptx)")}</button>
          <button onClick={() => { setMenu(undefined); designImporter.current?.click(); }}>{t("导入项目")}</button>
          <button onClick={() => action(() => controller.createBoard(t("白板")))}><SquarePen size={15}/>{t("新建白板")}</button><button onClick={() => action(() => controller.createMarkdown(t("笔记.md")))}><FileText size={15}/>{t("新建笔记")}</button><button onClick={() => { setMenu(undefined); markdownImporter.current?.click(); }}>{t("导入 Markdown / 文本")}</button><button disabled={!state.browser} onClick={() => action(() => controller.openBrowser())}><Globe size={15}/>{t("新建网页")}</button>{!state.browser && <small>{t("网页由桌面版提供")}</small>}{(workbenchPlugins.length > 0 || uninstalledWorkbenchPlugins.length > 0 || (onOpenPlugins && !phone)) && <><hr/>{workbenchPlugins.map(({ plugin, contribution }) => { const label = locale === "zh" ? contribution.titleZh ?? contribution.title : contribution.title; return <button key={`${plugin.manifest.id}:${contribution.id}`} data-workbench-plugin={plugin.manifest.id} disabled={!pluginRuntimeAvailable} title={pluginUnavailableMessage} onClick={() => action(() => controller.openPlugin(plugin.manifest.id, contribution.id, label))}><Puzzle size={15}/>{label}</button>; })}{uninstalledWorkbenchPlugins.map(entry => { const name = locale === "zh" ? entry.manifest.nameZh ?? entry.manifest.name : entry.manifest.name; return <button key={`download:${entry.manifest.id}`} data-workbench-plugin-download={entry.manifest.id} disabled={!pluginRuntimeAvailable} title={pluginUnavailableMessage} onClick={() => { setMenu(undefined); onRequestInstallPlugin?.(entry.manifest.id); }}><Puzzle size={15}/>{t("{0}（未安装，点击下载）", name)}</button>; })}{onOpenPlugins && !phone && <button className="workbench-browse-plugins" onClick={() => { setMenu(undefined); onOpenPlugins(); }}><Puzzle size={15}/>{t("浏览插件市场…")}</button>}</>}</>
      </div>}
      </div>
      <div className="workbench-tab-actions" data-workbench-menu>
        <button ref={allTabsButton} aria-label={t("全部标签和已关闭内容")} title={t("标签列表与管理")} aria-expanded={menu === "all" || !!menu && listTabOptions} onClick={event => toggleMenu("all", event.currentTarget)}><List size={17}/></button>
        {!phone && <button className="workbench-split-toggle" aria-label={splitLabel} title={splitHint} aria-pressed={hasSplit ? !maximized : undefined} aria-haspopup={!hasSplit ? "dialog" : undefined} aria-expanded={!hasSplit ? menu === "split" : undefined} aria-controls={!hasSplit ? `${id}-split-picker` : undefined} aria-disabled={splitBusy || undefined} aria-busy={splitBusy || undefined} disabled={!state.ready || !!fullscreenBrowser || !maximized && !hasSplit && layout.tabs.length < 2} onClick={event => { if (splitBusy) return; if (hasSplit || maximized) void changeSplit(); else toggleMenu("split", event.currentTarget); }}>{hasSplit && !maximized ? <Square size={15}/> : <LayoutGrid size={15}/>}<span>{t(maximized ? "还原" : hasSplit ? "合并" : "分屏")}</span></button>}
        {!phone && hasSplit && <button className="workbench-split-adjust" aria-label={t("调整分屏")} title={t("调整分屏标签")} aria-haspopup="dialog" aria-expanded={menu === "split"} aria-controls={`${id}-split-picker`} disabled={!!fullscreenBrowser} aria-disabled={splitBusy || undefined} onClick={event => { if (!splitBusy) toggleMenu("split", event.currentTarget); }}><ChevronDown size={15}/></button>}
        {menu === "split" && !phone && !fullscreenBrowser && <WorkbenchSplitPicker id={`${id}-split-picker`} tabs={layout.tabs} visible={layout.visible} busy={splitBusy} trigger={menuTrigger.current} icon={tabIcon} onApply={ids => void changeSplit(ids)} onClose={() => setMenu(undefined)}/>}
        {!phone && !compact && <button disabled={!!fullscreenBrowser} aria-label={t(expanded ? "返回右侧" : "展开到主区")} title={t(expanded ? "返回右侧" : "展开到主区")} onClick={() => action(() => controller.change({ type: "expanded", value: !layout.expanded }))}>{expanded ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>}
        <button aria-label={t("返回聊天")} title={t("返回聊天")} onClick={onClose}><X size={18}/></button>
        {menu && menu !== "add" && menu !== "split" && !menuPoint && <div ref={menuElement} className="workbench-menu" role="menu" data-workbench-overlay>
          {menu === "all" ? <>{onManageFiles && <button onClick={() => { setMenu(undefined); onManageFiles(); }}><FolderOpen size={15}/>{t("管理所有工作台文件")}</button>}{!layout.tabs.length && !layout.closed.length && <small>{t("还没有标签，点击 + 新建内容")}</small>}{layout.tabs.map(tab => <div key={tab.id} className="workbench-tab-list-row"><button aria-label={tab.title} aria-describedby={layout.active !== tab.id && !phone && layout.visible.includes(tab.id) ? `${id}-tab-status-${tab.id}` : undefined} aria-current={layout.active === tab.id ? "true" : undefined} title={tab.title} onClick={() => action(() => controller.change({ type: "select", id: tab.id }))}>{tabIcon(tab)}<span>{tab.title}</span>{layout.active === tab.id ? <small>{t("当前")}</small> : !phone && layout.visible.includes(tab.id) && <small id={`${id}-tab-status-${tab.id}`}>{t("分屏中")}</small>}</button><button data-workbench-tab-options={tab.id} aria-label={t("标签选项：{0}", tab.title)} title={t("标签选项")} onClick={() => { tabListReturn.current = { id: tab.id, scrollTop: menuElement.current?.scrollTop ?? 0 }; menuTrigger.current = allTabsButton.current; setMenuPoint(undefined); setListTabOptions(true); setMenu(tab.id); }}><MoreHorizontal size={16}/></button></div>)}{!!layout.closed.length && <><hr/><small>{t("最近关闭 · 内容保留")}</small>{layout.closed.slice().reverse().map(tab => <div key={tab.id} className="workbench-closed-row"><button onClick={() => action(() => controller.reopen(tab.id))}>{tabIcon(tab)}<span>{tab.title}</span><RotateCw size={13}/></button>{tab.kind === "whiteboard" || tab.kind === "markdown" || tab.kind === "design" ? <button aria-label={t(tab.kind === "design" ? tab.designFormat === "slides" ? "删除这个演示文稿：{0}" : "删除这个设计：{0}" : tab.kind === "markdown" ? "删除这篇笔记：{0}" : "删除这张白板：{0}", tab.title)} onClick={() => { setMenu(undefined); setDeleting(tab.id); }}><Trash2 size={14}/></button> : <button aria-label={t("移除最近关闭记录：{0}", tab.title)} title={t("仅移除此记录，聊天和网站数据保留")} onClick={() => action(() => controller.forgetClosed(tab.id))}><X size={14}/></button>}</div>)}</>}</>
              : layout.tabs.find(tab => tab.id === menu) ? <>{listTabOptions && <button onClick={() => { restoreTabList.current = true; setListTabOptions(false); setMenu("all"); }}><ArrowLeft size={14}/>{t("返回标签列表")}</button>}<small className="workbench-menu-tab-title">{layout.tabs.find(tab => tab.id === menu)!.title}</small>{tabMenu(layout.tabs.find(tab => tab.id === menu)!)}</> : null}
        </div>}
      </div>
    </div>
    {sharedList && <div className="workbench-shared-list-host">
      <Suspense fallback={<p role="status">{t("正在读取共享设计…")}</p>}>
        <WorkbenchSharedDesigns controller={controller} onClose={() => { setSharedList(false); menuTrigger.current?.focus({preventScroll:true}); }}/>
      </Suspense>
    </div>}
    {visible && contextTab && menuPoint && <DesktopMenu id={`${id}-tab-context-menu`} label={t("标签选项")} open close={() => setMenu(undefined)} trigger={menuTrigger} placement="down-start" point={menuPoint} className="workbench-context-menu">{tabMenu(contextTab)}</DesktopMenu>}
    <input ref={designImporter} type="file" accept=".tarobot-design.json" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) action(() => controller.importDesign(file)); }}/>
    <input ref={pptxImporter} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) action(() => controller.importPptx(file)); }}/>
    <input ref={markdownImporter} type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" multiple hidden onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; action(async () => { for (const file of files) await controller.importMarkdown(file); }); }}/>
    {state.error && <div className="workbench-error" role="alert"><span>{workbenchErrorText(state.error, locale)}</span><button aria-label={t("关闭提示")} onClick={() => controller.setError()}><X size={15}/></button></div>}
    {!state.ready ? <div className="workbench-empty" role="status">{t("正在打开工作台…")}</div> : !shown.length ? <div className="workbench-empty"><SquarePen size={25} aria-hidden="true"/><h2>{t("工作台")}</h2><p>{t("写笔记、画图、做演示文稿或浏览网页，也可让 Bot 帮你继续。")}</p><div>{!phone && <button onClick={() => action(() => controller.createDesign(t("演示文稿"), undefined, undefined, undefined, "slides"))}><Presentation size={15}/>{t("演示文稿")}</button>}<button onClick={() => action(() => controller.createBoard(t("白板")))}><Plus size={15}/>{t("白板")}</button><button onClick={() => action(() => controller.createMarkdown(t("笔记.md")))}><FileText size={15}/>{t("笔记")}</button>{state.browser && <button onClick={() => action(() => controller.openBrowser())}><Globe size={15}/>{t("网页")}</button>}{workbenchPlugins.map(({ plugin, contribution }) => { const label = locale === "zh" ? contribution.titleZh ?? contribution.title : contribution.title; return <button key={`${plugin.manifest.id}:${contribution.id}`} data-workbench-plugin={plugin.manifest.id} disabled={!pluginRuntimeAvailable} title={pluginUnavailableMessage} onClick={() => action(() => controller.openPlugin(plugin.manifest.id, contribution.id, label))}><Puzzle size={15}/>{label}</button>; })}{uninstalledWorkbenchPlugins.map(entry => { const name = locale === "zh" ? entry.manifest.nameZh ?? entry.manifest.name : entry.manifest.name; return <button key={`empty-download:${entry.manifest.id}`} data-workbench-plugin-download={entry.manifest.id} disabled={!pluginRuntimeAvailable} title={pluginUnavailableMessage} onClick={() => onRequestInstallPlugin?.(entry.manifest.id)}><Puzzle size={15}/>{t("{0}（未安装，点击下载）", name)}</button>; })}{onOpenPlugins && !phone && <button className="workbench-browse-plugins" onClick={onOpenPlugins}><Puzzle size={15}/>{t("浏览插件市场…")}</button>}</div></div> : null}
    <div ref={grid} className="workbench-panes" data-count={shown.length} style={{ "--workbench-column": `${(ratio?.column ?? layout.column) * 100}%`, "--workbench-row": `${(ratio?.row ?? layout.row) * 100}%` } as CSSProperties}>
      {layout.tabs.map(tab => {
        const index = shown.indexOf(tab.id), active = visible && index >= 0;
        return <section key={tab.id} id={`${id}-pane-${tab.id}`} role="tabpanel" aria-label={tab.title} className={`workbench-pane${layout.active === tab.id ? " workbench-pane-active" : ""}`} data-slot={index} hidden={index < 0}
          onPointerDownCapture={() => { if (layout.active !== tab.id) action(() => controller.change({ type: "select", id: tab.id })); }}>
          {showPaneHeaders && <header className="workbench-pane-header"><span>{tab.title}</span><button aria-label={t("标签选项")} onClick={event => toggleMenu(tab.id, event.currentTarget)}><MoreHorizontal size={14}/></button>
            <button aria-label={t("放大当前区域")} onClick={() => action(() => controller.change({ type: "maximize", id: tab.id }))}><Maximize2 size={14}/></button>
            <button aria-label={t("移出分屏，保留标签")} onClick={() => action(() => controller.change({ type: "remove", id: tab.id }))}><X size={15}/></button></header>}
          <div className={`workbench-pane-content workbench-${tab.kind}`}>
            {tab.kind === "whiteboard" ? state.boards.has(tab.id) ? <Suspense fallback={<p role="status">{t("正在加载白板…")}</p>}><WorkbenchCanvas key={tab.id} scope={controller.scope} document={state.boards.get(tab.id)!} savedRevision={() => controller.boardSavedRevision(tab.id)} visible={active} lang={locale}
              persist={(revision, document) => controller.persistBoard(revision, document)} onDocument={controller.boardDocument} onController={value => controller.bindBoard(tab.id, value)} onAnnotate={onAnnotate} onImportBoard={content => controller.importBoard(content)}/></Suspense> : <p>{t("白板文件不可用。")}</p>
              : tab.kind === "design" ? tab.designFormat === "slides" && controller.designSession(tab.id) ? <Suspense fallback={<p role="status">{t("正在打开演示文稿…")}</p>}><WorkbenchDesign controller={controller} session={controller.designSession(tab.id)!} active={active} title={tab.title} phone={phone} botAvailable={controller.connection.state.workbenchSlidesAvailable === true} onActivate={() => { if (controller.getSnapshot().layout.active !== tab.id) action(() => controller.change({ type: "select", id: tab.id })); }}/></Suspense> : tab.designFormat !== "slides" ? <div className="workbench-removed-canvas"><p>{t("Baoyu 画布已从工作台移除。可导出此项目。")}</p><button onClick={() => action(async () => saveDesignBackup(await controller.exportRemovedCanvas(tab.id, tab.title), tab.title))}><Download size={15}/>{t("导出项目")}</button></div> : <p>{t("正在打开演示文稿…")}</p>
              : tab.kind === "markdown" ? active && controller.markdownSession(tab.id) ? <Suspense fallback={<p role="status">{t("正在打开笔记…")}</p>}><WorkbenchMarkdown session={controller.markdownSession(tab.id)!} title={tab.title} botAvailable={controller.connection.state.workbenchMarkdownAvailable === true}/></Suspense> : <p>{t("正在打开笔记…")}</p>
                : tab.kind === "chart" ? <ChartPane controller={controller} tab={tab} active={active} compact={shown.length > 2} version={state.chartVersion} onCompose={onCompose}/>
                : tab.kind === "plugin" ? (activePluginRegistry && tab.pluginId && pluginState.installed[tab.pluginId]?.enabled ? <PluginSandboxFrame plugin={pluginState.installed[tab.pluginId]!} title={tab.title} registry={activePluginRegistry} connection={controller.connection} conversationId={controller.conversationId} windowId={state.windowId} tabId={tab.id}/> : <p className="workbench-unavailable" role="status">{t("此插件已停用或已卸载，请在插件页重新启用。")}</p>)
                : <BrowserPane controller={controller} tab={tab} active={active}/>}
          </div>
        </section>;
      })}
      {!phone && !maximized && shown.length > 1 && <div className="workbench-divider workbench-divider-column" role="separator" tabIndex={0} aria-label={t("调整左右比例")} aria-orientation="vertical" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout.column * 100)} onPointerDown={event => dragRatio(event, "column")} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); event.stopPropagation(); action(() => controller.change({ type: "ratio", axis: "column", value: layout.column + (event.key === "ArrowLeft" ? -.05 : .05) }));
      }}/>}
      {!phone && !maximized && shown.length > 2 && <div className="workbench-divider workbench-divider-row" role="separator" tabIndex={0} aria-label={t("调整上下比例")} aria-orientation="horizontal" aria-valuemin={20} aria-valuemax={80} aria-valuenow={Math.round(layout.row * 100)} onPointerDown={event => dragRatio(event, "row")} onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; event.preventDefault(); event.stopPropagation(); action(() => controller.change({ type: "ratio", axis: "row", value: layout.row + (event.key === "ArrowUp" ? -.05 : .05) }));
      }}/>}
    </div>
    <dialog ref={dialog} className="workbench-dialog" onCancel={event => { event.preventDefault(); setRename(undefined); setDeleting(undefined); }}>
      {rename ? <form onSubmit={event => { event.preventDefault(); const id = rename; setRename(undefined); action(() => controller.change({ type: "rename", id, title: name })); }}><label>{t("重命名标签")}<input autoFocus value={name} maxLength={128} required onChange={event => setName(event.target.value)}/></label><div><button type="button" onClick={() => setRename(undefined)}>{t("取消")}</button><button type="submit">{t("保存")}</button></div></form> : deleting ? <><h3>{t(deletingSlides ? "删除这个演示文稿？" : deletingTab?.kind === "design" ? "删除这个设计？" : deletingNote ? "删除这篇笔记？" : "删除这张白板？")}</h3><p>{t("仅删除此对话中的「{0}」及其在当前设备保存的内容。其他设计、笔记、白板和聊天消息保留。需要保留时请先导出。", deletingTab?.title ?? "")}</p><div><button onClick={() => setDeleting(undefined)}>{t("取消")}</button><button className="danger" onClick={() => { const id = deleting; setDeleting(undefined); action(() => deletingTab?.kind === "design" ? controller.deleteDesign(id) : deletingNote ? controller.deleteMarkdown(id) : controller.deleteBoard(id)); }}>{t(deletingSlides ? "删除演示文稿" : deletingTab?.kind === "design" ? "删除设计" : deletingNote ? "删除笔记" : "删除白板")}</button></div></> : null}
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
  if (!widget) return <p role="status">{t("正在读取来源…")}</p>;
  return <RuntimeHostActiveContext.Provider value={active}><WidgetComposeProvider scope={controller.scope} owner={`workbench:${controller.connection.identity.deviceId}:${controller.getSnapshot().windowId}`} active={active} message={message!} compose={onCompose ?? (() => false)}>{report ? <Report title={widget.title} summary={widget.summary} report={report} compact={compact} showHeader={false}/> : active ? <Suspense fallback={<p role="status">{t("正在加载内容…")}</p>}><Widget widget={widget} showHeader={false} instanceKey={`workbench:${controller.scope}:${tab.id}`} onReady={() => { if (source && active) controller.markChartRendered(tab.id, source); }} onRenderError={() => { if (source && active) controller.markChartFailed(tab.id, source); }}/></Suspense> : null}</WidgetComposeProvider></RuntimeHostActiveContext.Provider>;
}

function BrowserPane({ controller, tab, active }: { controller: WorkbenchController; tab: WorkbenchTab; active: boolean }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), locale = useLocale();
  return <BrowserPage controller={controller} tab={tab} active={active} native={state.browserTabs.get(tab.id)} supported={state.browser} errorText={code => workbenchErrorText(code, locale)}/>;
}

export default Workbench;
