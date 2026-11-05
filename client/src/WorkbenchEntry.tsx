import { useContext, useId, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { PanelsTopLeft } from "lucide-react";
import { DesktopMenu } from "./DesktopMenu.js";
import { WorkbenchContext } from "./workbench-context.js";
import { t, useLocale } from "./i18n.js";
import type { WorkbenchSource } from "../../src/client-protocol/workbench.js";
import "./workbench-entry.css";

export function WorkbenchChartEntry({source,children}: {source:WorkbenchSource;children:ReactNode}) {
  useLocale(); const workbench = useContext(WorkbenchContext), [error,setError] = useState("");
  return <div className="workbench-chart-entry">{children}{workbench && <button className="workbench-open-chart" onClick={() => { setError(""); void workbench.openChart(source).catch(cause => setError(cause instanceof Error ? cause.message : t("工作台暂不可用"))); }}><PanelsTopLeft size={14}/>{t("在工作台打开")}</button>}{error && <small role="alert">{error}</small>}</div>;
}

/** Ordinary clicks still use the existing system browser. Only an explicit menu action enters the workbench. */
export function WorkbenchLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  useLocale(); const workbench = useContext(WorkbenchContext), trigger=useRef<HTMLAnchorElement>(null), id=useId();
  const [point,setPoint] = useState<{x:number;y:number}>(), [error,setError] = useState("");
  const url = props.href, supported = !!workbench && !!url && /^https?:\/\//i.test(url);
  return <><a {...props} ref={trigger} onContextMenu={event => { if (!supported) return; event.preventDefault(); event.stopPropagation(); setPoint({x:event.clientX,y:event.clientY}); }} onKeyDown={event => { if (supported && (event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect=event.currentTarget.getBoundingClientRect(); setPoint({x:rect.left,y:rect.bottom}); } }}>{props.children}</a>{supported && <DesktopMenu id={id} label={t("链接操作")} open={!!point} point={point} close={() => setPoint(undefined)} trigger={trigger} placement="down-start"><button onClick={() => { if (url) void workbench!.openBrowser(url).catch(cause => setError(cause instanceof Error ? cause.message : t("工作台暂不可用"))); }}>{t("在工作台浏览")}</button><a href={url} target="_blank" rel="noopener noreferrer">{t("在系统浏览器打开")}</a></DesktopMenu>}{error && <small role="alert">{error}</small>}</>;
}
