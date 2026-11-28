import { RemoteScreenPanel } from "./RemoteScreenPanel.js";
import { RemoteScreenSettings } from "./RemoteScreenSettings.js";
import { isMobileScreenApp } from "./mobile-screen-viewer-transport.js";
import { useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { captureSettingsPageFocus, useSettingsPageViewport } from "./SettingsPageHeader.js";
import { useDesktopLocalHost } from "./useDesktopLocalHost.js";
import { useBackAction } from "./back-navigation.js";
import { t, useLocale } from "./i18n.js";
import { useDialogDrag } from "./dialog-drag.js";
import "./connection-panel.css";

/** Remote screen access for the current Host, as its own settings page beside
 * "Connection status and routes" and "Devices and network". The section and
 * its behaviour are those it had inside the connection page; only its place
 * changed. Without `openScreen` the viewer opens inside this page. */
export function ScreenControlPanel({ connection, close, returnFocus, backLabel, openScreen }: { connection: HubConnection; openScreen?: () => void; close: () => void; returnFocus?: RefObject<HTMLElement | null>; backLabel?: string }) {
  useLocale();
  const hostName = useContext(RuntimeHostContext);
  const local = useDesktopLocalHost(connection.identity.hubPublicKey);
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), header = useRef<HTMLElement>(null);
  const intentionalClose = useRef(false);
  const [viewing, setViewing] = useState(false), [busy, setBusy] = useState(false);
  // The embedded viewer replaces the header; bind the new one when it returns.
  useDialogDrag(dialog, header, !viewing);
  const requestClose = () => { if (viewing) { setViewing(false); return; } if (!busy) close(); };
  useBackAction(dialog, requestClose);
  useSettingsPageViewport(body);
  useLayoutEffect(() => {
    const restore = captureSettingsPageFocus(), node = dialog.current;
    intentionalClose.current = false; node?.showModal();
    node?.querySelector<HTMLButtonElement>(".preferences-header button")?.focus();
    return () => { intentionalClose.current = true; node?.close(); if (returnFocus?.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); else restore(); };
  }, [returnFocus]);
  return <dialog ref={dialog} className={`preferences-dialog is-movable settings-detail connection-dialog screen-control-dialog${viewing ? " screen-connection-dialog" : ""}${viewing && isMobileScreenApp() ? " screen-mobile-dialog" : ""}${backLabel ? " connection-subpage" : ""}`} aria-label={t("屏幕控制设置")} onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); requestClose(); }} onClose={event => {
    if (event.target !== event.currentTarget || intentionalClose.current || event.currentTarget.open) return;
    if (busy) event.currentTarget.showModal(); else close();
  }}>
    {viewing ? <RemoteScreenPanel key={connection.identity.hubPublicKey} connection={connection} hostName={hostName ?? connection.identity.name ?? t("当前主机")} visible standalone close={() => setViewing(false)} openSettings={() => setViewing(false)}/> : <>
    <header ref={header} className="preferences-header"><button type="button" className="icon-button" aria-label={backLabel ?? t("关闭屏幕控制设置")} disabled={busy} onClick={requestClose}><ChevronLeft className="connection-back" size={24}/><X className="connection-close" size={20}/></button><h2>{t("屏幕控制设置")}</h2></header>
    <div ref={body} className="settings-content">
      {hostName && <p className="connection-host-name">{t("当前主机：{0}", hostName)}</p>}
      <RemoteScreenSettings connection={connection} local={local.localHost} busyChange={setBusy} open={openScreen ?? (() => setViewing(true))} openBlocked={busy ? t("请等待当前操作完成。") : undefined}/>
    </div></>}
  </dialog>;
}
