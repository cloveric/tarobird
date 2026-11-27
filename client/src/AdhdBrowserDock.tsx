import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Globe, Plus, X } from "lucide-react";
import { BrowserPage } from "./BrowserPage.js";
import { getPersonalBrowserController } from "./personal-browser-controller.js";
import { scheduleBrowserLayout } from "./workbench-browser.js";
import { SidePanelResize } from "./SidePanelResize.js";
import { t, useLocale } from "./i18n.js";
import { workbenchErrorText } from "./workbench-error.js";
import "./workbench.css";
import "./adhd-browser.css";

export function AdhdBrowserDock({ visible, close }: { visible: boolean; close(): void }) {
  const [controller] = useState(getPersonalBrowserController);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const locale = useLocale();
  const panel = useRef<HTMLElement>(null), tabs = useRef<HTMLDivElement>(null);
  const run = (operation: () => Promise<unknown>) => void operation().catch(error => controller.setError(error instanceof Error ? error.message : "browser_action_failed"));
  useEffect(() => { run(() => controller.initialize()); }, [controller]);
  useLayoutEffect(() => {
    const element = panel.current;
    const header = element?.parentElement?.querySelector<HTMLElement>(":scope > .adhd-workbench > .adhd-toolbar");
    if (!element || !header || !visible) return;
    const measure = () => {
      const height = `${header.offsetHeight}px`;
      if (element.style.getPropertyValue("--adhd-browser-header-height") === height) return;
      element.style.setProperty("--adhd-browser-header-height", height);
      scheduleBrowserLayout();
    };
    const observer = new ResizeObserver(measure); observer.observe(header); measure();
    return () => { observer.disconnect(); element.style.removeProperty("--adhd-browser-header-height"); };
  }, [visible]);
  useEffect(() => {
    scheduleBrowserLayout();
    const strip = tabs.current, selected = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (visible && strip && selected) {
      const parent = strip.getBoundingClientRect(), child = selected.getBoundingClientRect();
      if (child.left < parent.left) strip.scrollLeft -= parent.left - child.left;
      else if (child.right > parent.right) strip.scrollLeft += child.right - parent.right;
    }
  }, [visible, state.active]);
  const active = state.tabs.find(tab => tab.tab === state.active);
  return <aside ref={panel} id="adhd-personal-browser" className="adhd-browser-dock conversation-side-panel" hidden={!visible} inert={!visible} aria-label={t("浏览器")} onAnimationEnd={scheduleBrowserLayout}>
    <SidePanelResize panel={panel} visible={visible} controls="adhd-personal-browser" label={t("调整浏览器宽度")}/>
    <header className="adhd-browser-header"><Globe size={17}/><span>{t("浏览器")}</span><button aria-label={t("关闭浏览器侧栏")} title={t("关闭侧栏，网页保留")} onClick={close}><X size={18}/></button></header>
    <div className="adhd-browser-tabs"><div ref={tabs} role="tablist" aria-label={t("浏览器标签")}>{state.tabs.map(tab => <div className="adhd-browser-tab" key={tab.tab} data-active={tab.tab === state.active}>
      <button role="tab" aria-selected={tab.tab === state.active} aria-controls={`personal-page-${tab.tab}`} id={`personal-tab-${tab.tab}`} title={tab.title || tab.url || t("新标签页")} onClick={() => controller.select(tab.tab)}>{tab.title || (tab.url !== "about:blank" && tab.url) || t("新标签页")}</button>
      <button disabled={state.busy} aria-label={t("关闭标签：{0}", tab.title || tab.url || t("新标签页"))} onClick={() => run(() => controller.close(tab.tab))}><X size={12}/></button>
    </div>)}</div><button disabled={!state.ready || state.busy} aria-label={t("新建浏览器标签")} title={t("新建标签页")} onClick={() => run(() => controller.openBrowser())}><Plus size={17}/></button></div>
    {state.error && <div className="workbench-error" role="alert"><span>{workbenchErrorText(state.error, locale)}</span>{!state.ready && <button onClick={() => run(() => controller.initialize())}>{t("重试")}</button>}<button aria-label={t("关闭提示")} onClick={() => controller.setError()}><X size={14}/></button></div>}
    {!state.ready && !state.error && <p role="status">{t("正在打开浏览器…")}</p>}
    {state.ready && !active && <div className="workbench-empty"><Globe size={26}/><p>{t("浏览网页，同时继续工作。")}</p><button onClick={() => run(() => controller.openBrowser())}><Plus size={16}/>{t("新建标签页")}</button></div>}
    {state.tabs.map(tab => <section key={tab.tab} className="adhd-browser-page" role="tabpanel" id={`personal-page-${tab.tab}`} aria-labelledby={`personal-tab-${tab.tab}`} hidden={tab.tab !== state.active}>
      <BrowserPage controller={controller} tab={{id:tab.tab, url:tab.url}} native={tab} active={visible && tab.tab === state.active} supported={controller.browser.supported} personal errorText={code => workbenchErrorText(code, locale)}/>
    </section>)}
  </aside>;
}
