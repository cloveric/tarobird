import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Message } from "../../src/client-protocol/index.js";
import { affectedBackgroundTasks, turnStopImpact } from "./turn-stop.js";
import { engineTaskSnapshotSchema } from "../../src/client-protocol/engine-tasks.js";
import { queueRequest } from "./prompt-queue-request.js";
import type { HubConnection } from "./connection.js";
import { CreationDialog } from "./CreationDialog.js";
import "./explanation-list.css";
import { t } from "./i18n.js";

type Request = (conversationId: string, botId?: string, beforeSend?: () => void) => Promise<boolean>;
export const TurnStopContext = createContext<Request | undefined>(undefined);

/** One Workspace owns the confirmation; it cannot outlive its host or chat. */
export function useTurnStop(connection: HubConnection, conversationId: string, messages: Message[], visible: boolean) {
  const scope = useRef({ connection, conversationId, visible });
  if (scope.current.connection !== connection || scope.current.conversationId !== conversationId || scope.current.visible !== visible) scope.current = { connection, conversationId, visible };
  const alive = useRef(true), flight = useRef<{ scope: typeof scope.current; token: symbol } | undefined>(undefined);
  type Pending = { conversationId: string; botId?: string; identity: string; tasks: { id: string; label: string }[]; unverified: boolean; scope: typeof scope.current; resolve: (value: boolean) => void };
  const [pending, setPending] = useState<Pending>();
  const owner = useRef<Pending | undefined>(undefined), opener = useRef<HTMLElement | null>(null);
  const latest = useRef({ conversationId, messages, visible }); latest.current = { conversationId, messages, visible };
  const cancel = () => { const value = owner.current; owner.current = undefined; setPending(undefined); value?.resolve(false); };
  useEffect(() => { alive.current = true; return () => { alive.current = false; owner.current?.resolve(false); owner.current = undefined; }; }, []);
  useEffect(() => {
    if (pending && (pending.scope !== scope.current || !visible || pending.conversationId !== conversationId || turnStopImpact(messages, connection.state.bots, conversationId, pending.botId).identity !== pending.identity)) cancel();
  }, [pending, messages, visible, conversationId, connection]);
  const request = useCallback<Request>(async (target, botId, beforeSend) => {
    const snapshot = scope.current;
    if (!alive.current || !latest.current.visible || latest.current.conversationId !== target || owner.current || flight.current?.scope === snapshot) return false;
    const token = Symbol(); flight.current = { scope: snapshot, token };
    const currentScope = () => alive.current && scope.current === snapshot;
    try {
      const impact = turnStopImpact(latest.current.messages, connection.state.bots, target, botId);
      // Native tasks need not have a saved scoped card. Read them only for an
      // explicit stop, without adding polling or delaying other engines.
      const targets = connection.state.engineTasksAvailable ? connection.state.bots.filter(bot => bot.engine === "claude" && (!botId || bot.id === botId)
        && turnStopImpact(latest.current.messages, connection.state.bots, target, bot.id).identity !== "[]") : [];
      const lookup = targets.length ? queueRequest([], 1500) : undefined;
      const details = await Promise.all(targets.map(async bot => {
        try {
          const result = engineTaskSnapshotSchema.parse(await lookup!.wait(connection.http(`/api/conversations/${target}/tasks?botId=${encodeURIComponent(bot.id)}`, { signal: lookup!.signal })));
          return { tasks: affectedBackgroundTasks(result).map(task => ({ id: `${bot.id}:${task.id}`, label: targets.length > 1 ? `${bot.name} · ${task.label}` : task.label })), unverified: !result.supported || !result.foregroundStopScope };
        } catch { return { tasks: [], unverified: true }; }
      })).finally(() => lookup?.dispose());
      if (!currentScope() || turnStopImpact(latest.current.messages, connection.state.bots, target, botId).identity !== impact.identity) return false;
      const tasks = details.flatMap(detail => detail.tasks), unverified = details.some(detail => detail.unverified);
      const confirmImpact = impact.risk || tasks.length > 0 || unverified;
      if (confirmImpact) {
        opener.current = document.activeElement as HTMLElement;
        const accepted = await new Promise<boolean>(resolve => {
          const value = { conversationId: target, botId, identity: impact.identity, tasks, unverified, scope: snapshot, resolve };
          owner.current = value; setPending(value);
        });
        if (!accepted || !currentScope()) return false;
      }
      if (confirmImpact || targets.length) {
        // The user may have spent time deciding. Recheck the durable cache so a
        // confirmation cannot stop a newer reply which replaced the original.
        const current = await connection.cache.messages(target);
        if (!currentScope() || turnStopImpact(current, connection.state.bots, target, botId).identity !== impact.identity
          || turnStopImpact(latest.current.messages, connection.state.bots, target, botId).identity !== impact.identity) return false;
      }
      beforeSend?.();
      await connection.send({ v: 1, type: "turn.stop", conversationId: target, ...(botId ? { botId } : {}) });
      return true;
    } finally { if (flight.current?.token === token) flight.current = undefined; }
  }, [connection]);
  const confirm = () => { const value = owner.current; owner.current = undefined; setPending(undefined); value?.resolve(true); };
  const dialog = pending && visible && createPortal(<CreationDialog className="confirmation-dialog" title={t("停止当前消息？")} closeLabel={t("取消")} close={cancel} returnFocus={opener}>
    <p>{t("若尚未开始回复，只取消等待；若已开始回复，可能也会中断该 Bot 在此对话中正在运行的后台任务。")}</p>
    {pending.unverified && <p role="status">{t("后台任务列表暂时无法核对；停止仍可能影响此对话中的后台任务。")}</p>}
    {pending.tasks.length > 0 && <details className="turn-stop-tasks" open><summary>{t("当前会受影响的后台任务（{0}）", pending.tasks.length)}</summary><ul>{pending.tasks.map(task => <li key={task.id}>{task.label}</li>)}</ul></details>}
    <p>{t("如果只想停止某一项，可在任务列表中单独停止。")}</p>
    <div className="confirmation-actions"><button type="button" onClick={cancel}>{t("继续运行")}</button><button type="button" className="text-danger" onClick={confirm}>{t("确认停止")}</button></div>
  </CreationDialog>, document.body);
  return { request, dialog };
}
