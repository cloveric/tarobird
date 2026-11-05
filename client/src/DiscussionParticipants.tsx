import { useEffect, useRef, useState } from "react";
import { AtSign, Check, ChevronDown } from "lucide-react";
import { z } from "zod";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import { Avatar } from "./Avatar.js";
import { t } from "./i18n.js";

/** Per-conversation drafting preference, separate from ordinary @ recipients. */
export function useDiscussionParticipants(connection: HubConnection, conversationId: string, members: string[]) {
  const key = `discussion-participants:${conversationId}`;
  const [saved, setSaved] = useState<{ connection: HubConnection; key: string; ids?: string[]; error?: boolean }>();
  const scope = useRef({ connection, key });
  if (scope.current.connection !== connection || scope.current.key !== key) scope.current = { connection, key };
  const writes = useRef(Promise.resolve()), editRevision = useRef(0);
  useEffect(() => {
    const current = scope.current;
    void connection.cache.groupReplyMetadata(key).then(raw => {
      if (scope.current !== current) return;
      const ids = raw ? z.array(z.string()).max(32).nullable().parse(JSON.parse(raw)) ?? undefined : undefined;
      setSaved({ connection, key, ids });
    }).catch(() => { if (scope.current === current) setSaved({ connection, key, error: true }); });
  }, [connection, key]);
  const ready = saved?.connection === connection && saved.key === key;
  const ids = (ready ? saved.ids ?? members : members).filter(id => members.includes(id));
  const change = (next: string[]) => {
    const current = scope.current, revision = ++editRevision.current, value = [...new Set(next.filter(id => members.includes(id)))];
    const ids = value.length === members.length ? undefined : value;
    setSaved({ connection, key, ids });
    writes.current = writes.current.catch(() => undefined).then(() => connection.cache.saveGroupReplyMetadata(key, JSON.stringify(ids ?? null), connection.identity));
    void writes.current.catch(() => { if (scope.current === current && editRevision.current === revision) setSaved(previous => previous?.key === key ? { ...previous, error: true } : previous); });
  };
  return { ids, ready, error: ready && !!saved.error, change };
}

export function DiscussionParticipants({ members, selected, change, locked, disabled, phone = false }: {
  members: { id: string; name: string }[]; selected: string[]; change: (ids: string[]) => void; locked: boolean; disabled: boolean; phone?: boolean;
}) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null);
  const summary = selected.length === members.length ? t("全员") : t("已选 {0} 位", selected.length);
  return <>
    <button ref={trigger} type="button" className={`${phone ? "phone-recipient-trigger" : "composer-recipients"} discussion-participants-trigger`} disabled={disabled} aria-label={t("可发言：{0}", summary)} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><AtSign size={14}/><span>{t("可发言：{0}", summary)}</span><ChevronDown size={12}/></button>
    {open && <CreationDialog title={t("可发言的 Bot")} closeLabel={t("关闭发言选择")} close={() => setOpen(false)} returnFocus={trigger} showHost={false} className="discussion-participants-dialog">
      <p className="creation-help">{t("勾选表示可以参与，不要求每条消息都回复；发言仍遵循群聊顺序。")}</p>
      {locked ? <p className="creation-help" role="status">{t("本次讨论已开始，参与者已固定；停止后可重新选择。")}</p> : <div className="discussion-participant-actions"><button type="button" onClick={() => change(members.map(bot => bot.id))}>{t("全选")}</button><button type="button" onClick={() => change([])}>{t("清空选择")}</button></div>}
      <div className="mobile-chat-action-list">{members.map(bot => <button key={bot.id} type="button" role="checkbox" aria-checked={selected.includes(bot.id)} aria-label={bot.name} disabled={locked} onClick={() => change(selected.includes(bot.id) ? selected.filter(id => id !== bot.id) : [...selected, bot.id])}><span className="recipient-check" aria-hidden="true">{selected.includes(bot.id) && <Check size={14}/>}</span><Avatar kind="bot" id={bot.id} name={bot.name} size={24}/><span>{bot.name}</span></button>)}</div>
      <footer className="rename-conversation-actions"><button type="button" className="primary" onClick={() => setOpen(false)}>{t("完成")}</button></footer>
    </CreationDialog>}
  </>;
}
