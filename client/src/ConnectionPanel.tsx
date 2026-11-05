import { RemoteScreenPanel } from "./RemoteScreenPanel.js";
import { RemoteScreenSettings } from "./RemoteScreenSettings.js";
import { useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { LocalConnectionSettings } from "./LocalConnectionSettings.js";
import { RoutesEditor } from "./RoutesEditor.js";
import { LocalRelaySettings } from "./LocalRelaySettings.js";
import { RuntimeHostContext } from "./RuntimeHost.js";
import { captureSettingsPageFocus, useSettingsPageViewport } from "./SettingsPageHeader.js";
import { useDesktopLocalHost } from "./useDesktopLocalHost.js";
import { useBackAction } from "./back-navigation.js";
import { t, useLocale } from "./i18n.js";
import { useDialogDrag } from "./dialog-drag.js";
import "./connection-panel.css";

/** Device-local routes have their own page, separate from general preferences. */
export function ConnectionPanel({ connection, close, returnFocus, backLabel, openScreen }: { connection: HubConnection; openScreen?: () => void; close: () => void; returnFocus?: RefObject<HTMLElement | null>; backLabel?: string }) {
  useLocale();
  const hostName = useContext(RuntimeHostContext);
  const local = useDesktopLocalHost(connection.identity.hubPublicKey);
  const dialog = useRef<HTMLDialogElement>(null), body = useRef<HTMLDivElement>(null), header = useRef<HTMLElement>(null);
  const intentionalClose = useRef(false);
  const [viewing, setViewing] = useState(false);
  // The embedded viewer replaces the header; bind the new one when it returns.
  useDialogDrag(dialog, header, !viewing);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [relayDirty, setRelayDirty] = useState(false), [relayBusy, setRelayBusy] = useState(false);
  const [discard, setDiscard] = useState(false), [configureLocal, setConfigureLocal] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [localBusy, setLocalBusy] = useState(false), [screenBusy, setScreenBusy] = useState(false);
  const anyBusy = busy || relayBusy || localBusy || screenBusy, anyDirty = dirty || relayDirty;
  const requestClose = () => { if (viewing) { setViewing(false); return; } if (anyBusy) return; if (anyDirty) setDiscard(true); else close(); };
  useBackAction(dialog, requestClose);
  useSettingsPageViewport(body);
  // Remove the confirmation first: while it remains modal, the originating
  // page is inert and cannot receive focus from the connection page's cleanup.
  useLayoutEffect(() => { if (discarding) close(); }, [discarding, close]);
  useLayoutEffect(() => {
    const restore = captureSettingsPageFocus(), node = dialog.current;
    intentionalClose.current = false; node?.showModal();
    node?.querySelector<HTMLButtonElement>(".preferences-header button")?.focus();
    return () => { intentionalClose.current = true; node?.close(); if (returnFocus?.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); else restore(); };
  }, [returnFocus]);
  return <><dialog ref={dialog} className={`preferences-dialog is-movable settings-detail connection-dialog${viewing ? " screen-connection-dialog" : ""}${backLabel ? " connection-subpage" : ""}`} aria-label={t("连接状态与线路")} onCancel={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); requestClose(); }} onClose={event => {
    if (event.target !== event.currentTarget || intentionalClose.current || event.currentTarget.open) return;
    if (anyBusy || anyDirty) { event.currentTarget.showModal(); if (anyDirty && !anyBusy) setDiscard(true); } else close();
  }}>
    {viewing ? <RemoteScreenPanel key={connection.identity.hubPublicKey} connection={connection} hostName={hostName ?? connection.identity.name ?? t("当前主机")} visible standalone close={() => setViewing(false)}/> : <>
    <header ref={header} className="preferences-header"><button type="button" className="icon-button" aria-label={backLabel ?? t("关闭连接状态与线路")} disabled={anyBusy} onClick={requestClose}><ChevronLeft className="connection-back" size={24}/><X className="connection-close" size={20}/></button><h2>{t("连接状态与线路")}</h2></header>
    <div ref={body} className="settings-content">
      {hostName && <p className="connection-host-name">{t("当前主机：{0}", hostName)}</p>}
      <p className="settings-lede">{local.localHost ? t("本机保持直连；在这里设置手机和其他电脑访问本机的方式。") : t("管理此设备访问主机的线路。修改只影响此设备，不改变 Bot 的运行位置。")}</p>
      <RemoteScreenSettings connection={connection} local={local.localHost} busyChange={setScreenBusy} open={openScreen ?? (() => setViewing(true))} openBlocked={anyDirty ? t("请先保存或取消连接修改。") : anyBusy ? t("请等待当前操作完成。") : undefined}/>
      <RoutesEditor connection={connection} identityPending={!local.resolved} retryIdentity={local.failed ? local.retry : undefined} localHost={local.localHost} localBusy={relayBusy} configureLocal={() => setConfigureLocal(true)} dirtyChange={setDirty} busyChange={setBusy}/>
      {local.localHost && <LocalRelaySettings key={connection.identity.hubPublicKey} connection={connection} dirtyChange={setRelayDirty} busyChange={setRelayBusy}/>}
    </div></>}
  </dialog>
  {discard && <CreationDialog title={t("放弃未保存的修改？")} showHost={false} closeLabel={t("关闭确认")} close={() => setDiscard(false)}><p>{backLabel ? t("连接修改尚未保存。放弃这些修改并返回？") : t("连接修改尚未保存。放弃这些修改并关闭连接？")}</p><div className="quick-actions"><button onClick={() => setDiscard(false)}>{t("继续编辑")}</button><button className="text-danger" onClick={() => { setDiscard(false); setDiscarding(true); }}>{t("放弃修改")}</button></div></CreationDialog>}
  {configureLocal && connection.identity.hubPublicKey && <CreationDialog mobilePage title={t("局域网与 Tailscale")} busy={localBusy} closeLabel={t("关闭本机对外连接")} close={() => setConfigureLocal(false)}><LocalConnectionSettings key={connection.identity.hubPublicKey} connection={connection} busyChange={setLocalBusy}/></CreationDialog>}
  </>;
}
