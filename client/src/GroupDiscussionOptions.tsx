import { ArrowDown, ArrowUp, Check, ListOrdered, MessageSquare, MessagesSquare, PanelsTopLeft } from "lucide-react";
import { useRef } from "react";
import type { GroupDiscussionPolicy } from "../../src/client-protocol/group-discussion.js";
import { GROUP_DISCUSSION_MAX_MEMBERS, automaticGroupDiscussion } from "../../src/client-protocol/group-discussion.js";
import { Avatar } from "./Avatar.js";
import { BotName } from "./BotName.js";
import { t } from "./i18n.js";
import type { Bot } from "./connection.js";
import "./group-discussion.css";

/** Only edits a draft. Saving or selecting a mode never starts a discussion. */
export function GroupDiscussionOptions({ value, change, bots, disabled, parallelAvailable }: {
  value: GroupDiscussionPolicy; change: (value: GroupDiscussionPolicy) => void;
  bots: Bot[]; disabled: boolean; parallelAvailable: boolean;
}) {
  const orderList = useRef<HTMLOListElement>(null);
  const modes = [
    { id: "mentions" as const, title: t("普通群聊"), description: t("@ 谁，谁回应；不 @ 时只记录发言。"), icon: MessageSquare },
    { id: "parallel" as const, title: t("并行回复"), description: t("不 @ 时全员各自回复你；@ 谁就只让谁回复，不互相讨论。"), icon: MessagesSquare },
    { id: "sequential" as const, title: t("轮流讨论"), description: t("按顺序回应，参考前面的观点。"), icon: ListOrdered },
    { id: "independent" as const, title: t("独立评议"), description: t("先各自思考，收齐观点后再讨论。"), icon: PanelsTopLeft },
  ];
  const move = (index: number, delta: number) => {
    const order = [...value.botOrder], next = index + delta;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next]!, order[index]!];
    change({ ...value, botOrder: order });
    // The clicked control may become disabled after moving to an edge.
    requestAnimationFrame(() => {
      orderList.current?.children[next]?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
  };
  return <section className="group-discussion-options">
    <fieldset className="group-mode-fieldset" disabled={disabled}>
      <legend>{t("群聊方式")}</legend>
      <div className="group-mode-choices">{modes.map(({ id, title, description, icon: Icon }) =>
        <label key={id} className={`group-mode-choice${value.mode === id ? " is-selected" : ""}`}>
          <input type="radio" name="group-discussion-mode" value={id} disabled={id === "parallel" && !parallelAvailable} checked={value.mode === id} onChange={() => change({ ...value, mode: id })}/>
          <Icon size={19} aria-hidden="true"/><span><strong>{title}</strong><small>{description}</small></span>
          <Check size={15} className="group-mode-check" aria-hidden="true"/>
        </label>)}</div>
    </fieldset>
    {!parallelAvailable && <p className="group-mode-footnote">{t("更新主机后可使用并行回复。")}</p>}
    {value.mode === "parallel" && <p className="group-mode-footnote">{t("保存后，直接在群里发消息即可。各 Bot 保留自己的对话上下文，回复不会自动触发其他 Bot。")}</p>}
    {automaticGroupDiscussion(value.mode) && <div className="group-discussion-properties">
      <div className="group-order-heading"><strong>{t("发言顺序")}</strong><span>{t("{0} 位参与者", value.botOrder.length)}</span></div>
      <ol ref={orderList} className="group-discussion-order">{value.botOrder.map((id, index) => {
        const bot = bots.find(item => item.id === id), name = bot?.name ?? id;
        return <li key={id}><span className="group-order-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
          <Avatar kind="bot" id={id} name={name} size={26}/><span className="group-order-name"><BotName id={id} name={name} bot={bot}/></span>
          <div className="group-order-controls"><button type="button" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={t("上移 {0}", name)} title={t("上移 {0}", name)}><ArrowUp size={16}/></button>
            <button type="button" disabled={disabled || index === value.botOrder.length - 1} onClick={() => move(index, 1)} aria-label={t("下移 {0}", name)} title={t("下移 {0}", name)}><ArrowDown size={16}/></button></div>
        </li>;
      })}</ol>
      {value.botOrder.length > GROUP_DISCUSSION_MAX_MEMBERS && <p role="alert" className="error-text">{t("自动讨论最多支持 {0} 个 Bot，请调整群成员。", GROUP_DISCUSSION_MAX_MEMBERS)}</p>}
      <label className="group-round-limit"><span><strong>{t("最多讨论轮数")}</strong><small>{t("每位 Bot 发言一次算一轮，到达上限后保留各方意见。")}</small></span>
        <select aria-label={t("最多讨论轮数")} disabled={disabled} value={value.maxRounds} onChange={event => change({ ...value, maxRounds: Number(event.target.value) })}>
          {[1, 2, 3, 4, 5].map(rounds => <option key={rounds} value={rounds}>{rounds === 1 ? t("1 轮") : t("{0} 轮", rounds)}</option>)}
        </select>
      </label>
      <p className="group-mode-footnote">{t("保存后，在输入框发送问题即可开始讨论；保存设置本身不会启动任务。")}</p>
    </div>}
  </section>;
}
