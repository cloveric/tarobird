import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { HubConnection } from "./connection.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { t } from "./i18n.js";

type ListSettings = { options: ReactNode; manageFolders?: (trigger: HTMLElement | null, connection?: HubConnection) => void };
const ListSettingsContext = createContext<ListSettings | undefined>(undefined);
export const useSidebarListOptions = () => useContext(ListSettingsContext);

/** Shared list preferences join the folder's own actions without replacing its
 * connection. A divider distinguishes device-wide settings from folder edits. */
export function SidebarListSettings({ trigger, connection }: { trigger: RefObject<HTMLElement | null>; connection?: HubConnection }) {
  const settings = useSidebarListOptions();
  if (!settings) return null;
  return <>
    {settings.manageFolders && <><hr/><button type="button" onClick={() => settings.manageFolders?.(trigger.current, connection)}>{t("管理分组")}</button></>}
    <p className="desktop-menu-heading">{t("列表选项")}</p>
    {settings.options}
  </>;
}

/** Section labels are a keyboard-accessible alternative to right-click. */
export function SidebarListHeading({ children, className = "sidebar-label" }: { children: ReactNode; className?: string }) {
  const settings = useSidebarListOptions();
  return <div className={className} tabIndex={settings ? 0 : undefined} role={settings ? "button" : undefined} aria-haspopup={settings ? "menu" : undefined}>{children}</div>;
}

/** No permanent toolbar. Folder menus consume the same settings; section
 * headings and empty directory space expose a fallback context menu. */
export function SidebarListOptions({ children, options, visible = true, disabled = false, scope, manageFolders }: ListSettings & {
  children: ReactNode; visible?: boolean; disabled?: boolean; scope?: unknown;
}) {
  const [point, setPoint] = useState<{ x: number; y: number }>(), id = useId();
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => { setPoint(undefined); }, [visible, disabled, scope]);
  useEffect(() => {
    const layout = matchMedia('(max-width:760px)'), close = () => setPoint(undefined);
    layout.addEventListener('change', close);
    return () => layout.removeEventListener('change', close);
  }, []);
  const enabled = visible && !disabled;
  return <ListSettingsContext.Provider value={enabled ? { options, manageFolders } : undefined}>
    <div className="sidebar-list-context" tabIndex={enabled ? 0 : -1} role="group" aria-label={t("列表选项")}
      onClick={event => {
        if (!enabled || matchMedia('(max-width:760px)').matches) return;
        const heading = (event.target as Element).closest<HTMLElement>('.sidebar-label[role=button]');
        if (!heading) return;
        const rect = heading.getBoundingClientRect(); trigger.current = heading;
        setPoint({ x: rect.left, y: rect.bottom });
      }}
      onContextMenu={event => {
        if (!enabled || matchMedia('(max-width:760px)').matches || (event.target as Element).closest('.desktop-menu,dialog,input,textarea,a')) return;
        const heading = (event.target as Element).closest<HTMLElement>('.sidebar-label,.host-heading');
        if (!heading && (event.target as Element).closest('button,[role=button]')) return;
        event.preventDefault(); event.stopPropagation();
        trigger.current = heading ?? event.currentTarget;
        setPoint({ x: event.clientX, y: event.clientY });
      }}
      onKeyDown={event => {
        if (!enabled || matchMedia('(max-width:760px)').matches) return;
        const target = event.target as HTMLElement;
        const heading = target.matches('.sidebar-label,.host-heading');
        if (target !== event.currentTarget && !heading) return;
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey) && !(heading && target.matches('[role=button]') && ['Enter', ' '].includes(event.key))) return;
        event.preventDefault(); event.stopPropagation(); trigger.current = target;
        const rect = target.getBoundingClientRect(); setPoint({ x: rect.left, y: rect.top + Math.min(rect.height, 36) });
      }}>
      {children}
      <DesktopMenu id={id} label={t("列表选项")} open={enabled && !!point} point={point} close={() => setPoint(undefined)} trigger={trigger} placement="down-start" className="sidebar-list-menu">
        {options}
        {manageFolders && <><hr/><button type="button" onClick={() => manageFolders(trigger.current)}>{t("管理分组")}</button></>}
      </DesktopMenu>
    </div>
  </ListSettingsContext.Provider>;
}
