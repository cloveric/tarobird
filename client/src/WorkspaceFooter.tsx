import type { RefObject } from "react";
import { Activity, Archive, CalendarClock, ChevronsUpDown, FolderOpen, Monitor, PanelsTopLeft, Plug, Plus, Settings, Wifi } from "lucide-react";
import { Avatar } from "./Avatar.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { t, useLocale } from "./i18n.js";

export type WorkspaceTool = "profile" | "settings" | "connection" | "files" | "capabilities" | "schedules" | "operations" | "archives";
type Props = {
  hostName: string; status: string; userId?: string; archivedCount: number;
  menuId: string; menuOpen: boolean; trigger: RefObject<HTMLButtonElement | null>;
  toggleMenu: () => void; closeMenu: () => void; open: (tool: WorkspaceTool) => void;
  openAdhd?: () => void; adhdBlocked?: boolean; manageHosts?: () => void; addHost?: () => void;
};

/** One footer for the ordinary inbox and ADHD; actions retain their owning host. */
export function WorkspaceFooter({ hostName, status, userId, archivedCount, menuId, menuOpen, trigger, toggleMenu, closeMenu, open, openAdhd, adhdBlocked, manageHosts, addHost }: Props) {
  useLocale();
  const statusLabel = status === "online" ? t("已连接") : status === "connecting" ? t("连接中") : t("离线");
  return <div className="sidebar-footer">
    {userId && <button className="icon-button" data-settings-entry="profile" aria-label={t("个人头像")} title={t("个人头像")} onClick={event => { event.currentTarget.focus(); open("profile"); }}><Avatar kind="user" id={userId} name={t("我")} size={26}/></button>}
    <button ref={trigger} className="workspace-trigger" aria-label={t("工作台：{0}，{1}", hostName, statusLabel)} aria-expanded={menuOpen} aria-controls={menuOpen ? menuId : undefined} onClick={toggleMenu}><span className="workspace-trigger-text"><small>{t("工作台")}</small><span><i className={`status-dot ${status}`}/><span>{hostName}</span></span></span><ChevronsUpDown size={14}/></button>
    <DesktopMenu id={menuId} label={t("工作台")} open={menuOpen} close={closeMenu} trigger={trigger} placement="up-start" className="workspace-menu">
      <p className="desktop-menu-heading"><i className={`status-dot ${status}`}/><span>{t("当前主机：{0}", hostName)}</span><span className="desktop-menu-value">{statusLabel}</span></p>
      {openAdhd && <button disabled={adhdBlocked} onClick={openAdhd}><PanelsTopLeft size={16}/><span className="desktop-menu-label">{t("ADHD 多对话面板")}</span></button>}
      <button onClick={() => open("files")}><FolderOpen size={16}/><span className="desktop-menu-label">{t("文件中心")}</span></button>
      <button onClick={() => open("capabilities")}><Plug size={16}/><span className="desktop-menu-label">{t("Skills 与 MCP")}</span></button>
      <button onClick={() => open("schedules")}><CalendarClock size={16}/><span className="desktop-menu-label">{t("定时任务")}</span></button>
      <button onClick={() => open("operations")}><Activity size={16}/><span className="desktop-menu-label">{t("运行状态")}</span></button>
      <button onClick={() => open("archives")}><Archive size={16}/><span className="desktop-menu-label">{t("已归档对话")}</span>{archivedCount > 0 && <span className="desktop-menu-value">{archivedCount}</span>}</button>
      <hr/><button data-settings-entry="connection" onClick={() => open("connection")}><Wifi size={16}/><span className="desktop-menu-label">{t("连接状态与线路")}</span></button>
      {manageHosts && <button onClick={() => manageHosts()}><Monitor size={16}/><span className="desktop-menu-label">{t("设备与网络")}</span></button>}
      {addHost && <button onClick={addHost}><Plus size={16}/><span className="desktop-menu-label">{t("连接另一台主机")}</span></button>}
    </DesktopMenu>
    <button className="icon-button" data-settings-entry="settings" aria-label={t("设置")} onClick={event => { event.currentTarget.focus(); open("settings"); }}><Settings size={19}/></button>
  </div>;
}
