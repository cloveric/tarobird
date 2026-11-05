import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Trash2 } from "lucide-react";
import type { Bot, HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";
import "./delete-bot.css";

export function DeleteBotControl({ connection, bot, deleted }: { connection: HubConnection; bot: Bot; deleted: () => void }) {
  const state = useSyncExternalStore(notify => connection.subscribe(notify), () => connection.state);
  const trigger = useRef<HTMLButtonElement>(null), locked = useRef(false), alive = useRef(true);
  const [confirming, setConfirming] = useState<Bot>(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const owner = state.user?.role === "owner";
  const supported = !!state.botDeletionAvailable;
  const managed = bot.managed === 1 || !!bot.deletedAt;
  const allowed = owner && state.status === "online" && supported && managed;
  const remove = async () => {
    if (locked.current || !allowed || !confirming) return;
    locked.current = true; setBusy(true); setError("");
    try { await connection.deleteBot(confirming); if (alive.current) deleted(); }
    catch (cause) {
      if (alive.current) setError(cause instanceof HubHttpError && cause.message === "bot_name_conflict" ? t("Bot 名称已在其他设备修改，请取消并重新确认。")
        : cause instanceof HubHttpError && cause.message === "bot_stop_unconfirmed" ? t("Bot 已停用，但尚未确认进程退出。请重试以完成停止。")
        : cause instanceof HubHttpError && cause.status === 403 ? t("仅拥有者可删除 Bot")
        : t("未能确认删除结果，请检查连接后重试。重复确认不会重复删除。"));
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  if (bot.deletedAt && !confirming) return null;
  return <section className="bot-delete-setting">
    <button ref={trigger} type="button" className="danger" disabled={!allowed} onClick={() => { setConfirming(bot); setError(""); }}><Trash2 size={16}/>{t("删除 Bot")}</button>
    <p className="muted">{!owner ? t("仅拥有者可删除 Bot") : !supported ? t("请更新此主机以使用删除 Bot 功能。") : !managed ? t("此 Bot 由外部程序管理，请在所属主机停止并移除。") : state.status !== "online" ? t("连接恢复后即可操作") : t("历史对话和文件会保留。")}</p>
    {confirming && <CreationDialog title={t("删除 Bot")} closeLabel={t("取消删除 Bot")} close={() => setConfirming(undefined)} busy={busy} returnFocus={trigger} className="delete-bot-dialog">
      <p>{t("确定删除「{0}」？", confirming.name)}</p>
      <ul><li>{t("停止此 Bot、正在运行的任务及其定时任务，并取消待执行操作。")}</li><li>{t("从所有设备的 Bot 列表和群聊中移除；其他 Bot 不受影响。")}</li><li>{t("独立对话会归档，历史消息、附件和主机工作区文件保留。")}</li></ul>
      <p className="muted">{t("删除后不能继续与此 Bot 对话；需要时可新建 Bot。")}</p>
      {!allowed && <p role="status">{owner ? t("连接恢复后即可操作") : t("仅拥有者可删除 Bot")}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="delete-bot-actions"><button type="button" disabled={busy} onClick={() => setConfirming(undefined)}>{t("取消")}</button><button type="button" className="danger" disabled={busy || !allowed} onClick={() => void remove()}>{busy ? t("正在删除…") : t("确认删除 Bot")}</button></div>
    </CreationDialog>}
  </section>;
}
