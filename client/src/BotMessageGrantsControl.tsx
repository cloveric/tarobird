import { useRef, useState, type RefObject } from "react";
import { ChevronRight, Link } from "lucide-react";
import type { Bot, HubConnection } from "./connection.js";
import { BotMessageGrants } from "./BotMessageGrants.js";
import { CreationDialog } from "./CreationDialog.js";
import { t, useLocale } from "./i18n.js";

export function BotMessageGrantsControl({ connection, bot, online, owner }: {
  connection: HubConnection; bot: Bot; online: boolean; owner: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  return <><button ref={trigger} className="details-link message-grants-entry" aria-label={t("Bot 消息授权")} disabled={!owner} onClick={() => setOpen(true)}>
    <Link size={18}/><span><strong>{t("Bot 消息授权")}</strong><small>{t("管理当前主机 Bot 之间的直接消息权限")}</small></span><ChevronRight size={16}/>
  </button>{open && owner && <GrantsDialog key={`${connection.identity.hubPublicKey}:${bot.id}`} connection={connection} bot={bot} online={online} close={() => setOpen(false)} returnFocus={trigger}/>}</>;
}

function GrantsDialog({ connection, bot, online, close, returnFocus }: {
  connection: HubConnection; bot: Bot; online: boolean; close: () => void; returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const confirmationReturn = useRef<HTMLElement | null>(null);
  const leave = () => { if (busy) return; if (dirty) { confirmationReturn.current = document.activeElement as HTMLElement | null; setConfirm(true); } else close(); };
  return <><CreationDialog mobilePage title={t("Bot 消息授权")} closeLabel={t("返回 Bot 设置")} close={leave} back busy={busy} returnFocus={returnFocus} className="settings-panel message-grants-panel">
    <BotMessageGrants connection={connection} initialBotId={bot.id} active online={online} onDirty={setDirty} onBusy={setBusy}/>
  </CreationDialog>{confirm && <CreationDialog title={t("放弃未保存的修改？")} closeLabel={t("关闭确认")} close={() => setConfirm(false)} returnFocus={confirmationReturn} showHost={false}>
    <p>{t("设置修改尚未保存。放弃这些修改并继续？")}</p>
    <div className="quick-actions"><button onClick={() => setConfirm(false)}>{t("继续编辑")}</button><button className="text-danger" onClick={() => { confirmationReturn.current = returnFocus.current; close(); }}>{t("放弃修改")}</button></div>
  </CreationDialog>}</>;
}
