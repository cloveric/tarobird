import { useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { t } from "./i18n.js";

export function HostAddressSyncHelp() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" className="icon-button network-sync-help-button" aria-label={t("了解同步主机地址")} title={t("了解同步主机地址")} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><CircleHelp size={17} aria-hidden="true"/></button>
    {open && <CreationDialog title={t("同步主机地址有什么用？")} close={() => setOpen(false)} closeLabel={t("关闭说明")} returnFocus={trigger} showHost={false} className="network-subpage network-sync-help">
      <p>{t("让同一 TaroBird 网络内的其他主机和已授权设备知道，可以用哪些地址连接这台主机。")}</p>
      <h3>{t("什么时候需要？")}</h3>
      <p>{t("例如：先用局域网加入网络，后来又添加了 Tailscale 或 VPS 地址。仅在当前设备「编辑线路 → 保存」，不代表其他成员也拿到了新地址；请在这里核对地址后，点击「确认同步」。")}</p>
      <h3>{t("会同步什么？")}</h3>
      <p>{t("只同步连接地址；Bot、聊天记录和文件仍留在原主机。其他成员连接并更新网络信息后，才会收到新地址。")}</p>
      <p className="network-note">{t("这不会替你开通 Tailscale、部署 VPS 或打开端口，也不代表地址一定能连通。")}</p>
      <footer className="network-actions"><button type="button" className="primary" onClick={() => setOpen(false)}>{t("知道了")}</button></footer>
    </CreationDialog>}
  </>;
}
