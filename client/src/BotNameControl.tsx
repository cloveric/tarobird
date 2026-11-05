import { timeoutSignal } from "./abort-signals.js";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Pencil } from "lucide-react";
import { botNameSchema } from "../../src/client-protocol/bots.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t, useLocale } from "./i18n.js";
import type { Bot, HubConnection } from "./connection.js";
import "./bot-name-control.css";

export function BotNameControl({ connection, bot }: { connection: HubConnection; bot: Bot }) {
  useLocale();
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  const owner = state.user?.role === "owner";
  return <>
    <button ref={trigger} className="bot-name-setting" aria-label={t("修改 Bot 名称")} disabled={!owner || state.status !== "online"} onClick={() => setOpen(true)}>
      <span>{t("Bot 名称")}</span><strong>{bot.name}</strong><Pencil size={16} aria-hidden="true"/>
    </button>
    {open && owner && <RenameBot key={bot.id} connection={connection} bot={bot} close={() => setOpen(false)} returnFocus={trigger}/>}
  </>;
}

function RenameBot({ connection, bot, close, returnFocus }: { connection: HubConnection; bot: Bot; close: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const [name, setName] = useState(bot.name), [baseline, setBaseline] = useState(bot.name);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null), saving = useRef(false), alive = useRef(false);
  const allowed = state.status === "online" && state.user?.role === "owner";
  const changedElsewhere = bot.name !== baseline && bot.name !== name.trim();
  useEffect(() => { alive.current = true; input.current?.select(); return () => { alive.current = false; }; }, []);
  const save = async () => {
    if (saving.current || !allowed || !name.trim() || changedElsewhere) return;
    if (name.trim() === baseline) { close(); return; }
    saving.current = true; setBusy(true); setError("");
    try {
      botNameSchema.parse(await connection.http(`/api/bots/${bot.id}/name`, { method: "PUT", signal: timeoutSignal(20_000), body: JSON.stringify({ name: name.trim(), expectedName: baseline }) }));
      // The HTTP response is the durable receipt. Live Bot status updates refresh
      // all clients; never overwrite a newer status/name with this older response.
      if (alive.current) close();
    } catch (e) {
      if (alive.current) setError(e instanceof HubHttpError && e.message === "bot_name_conflict" ? t("名称已在其他设备修改，请重新读取后再保存。")
        : e instanceof HubHttpError && e.status === 403 ? t("仅拥有者可修改 Bot 设置")
        : e instanceof HubHttpError && e.status === 404 ? t("主机尚不支持修改 Bot 名称，或此 Bot 已不可用。请更新主机后重试。")
        : t("未能确认操作结果，请核对最新状态后再试。"));
    } finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  const reload = async () => {
    if (saving.current || !allowed) return;
    saving.current = true; setBusy(true);
    try {
      const latest = botNameSchema.parse(await connection.http(`/api/bots/${bot.id}/name`, { signal: timeoutSignal(20_000) }));
      if (alive.current) { setName(latest.name); setBaseline(latest.name); setError(""); input.current?.focus(); }
    } catch { if (alive.current) setError(t("未能读取最新 Bot 名称，请稍后重试。")); }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  };
  return <CreationDialog mobilePage title={t("修改 Bot 名称")} className="rename-conversation" closeLabel={t("关闭重命名")} close={close} busy={busy} initialFocus={input} returnFocus={returnFocus}>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>{t("Bot 名称")}<input ref={input} value={name} required maxLength={100} disabled={busy || !allowed} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault(); }}/></label>
      <p className="creation-help">{t("所有设备同步更新 Bot 名称，对话名称不变。")}</p>
      {!allowed && <p className="muted" role="status">{state.status !== "online" ? t("连接恢复后即可操作") : t("仅拥有者可修改 Bot 设置")}</p>}
      {(error || changedElsewhere) && <div role="alert" className="bot-name-notice"><p>{error || t("名称已在其他设备修改，请重新读取后再保存。")}</p><button type="button" disabled={busy || !allowed} onClick={() => void reload()}>{t("读取最新名称")}</button></div>}
      <div className="rename-conversation-actions"><button type="button" disabled={busy} onClick={close}>{t("取消")}</button><button className="primary" type="submit" disabled={busy || !allowed || changedElsewhere || !name.trim()}>{busy ? t("正在保存…") : t("保存")}</button></div>
    </form>
  </CreationDialog>;
}
