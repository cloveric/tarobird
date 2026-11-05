import { useId } from "react";
import { Bot as BotIcon, ChevronRight, FilePlus2, MessageSquare, Users } from "lucide-react";
import { Avatar } from "./Avatar.js";
import { t, useLocale } from "./i18n.js";

type Action = { key: string; icon: typeof BotIcon; title: string; detail: string; run: () => void };
/** Connected, nothing selected: the three ways to begin (existing handlers), then how work is organized. */
export function WelcomeHome({ hasBots, newChat, newBot, newGroup, pairDevice }: { pairDevice?: () => void; hasBots: boolean; newChat: () => void; newBot: () => void; newGroup: () => void }) {
  useLocale(); const id = useId();
  const chat: Action = { key: "chat", icon: MessageSquare, title: t("新建对话"), detail: t("为已有 Bot 开一个独立对话"), run: newChat };
  const bot: Action = { key: "bot", icon: BotIcon, title: t("创建一个 Bot"), detail: t("独立的工作区、人设与记忆"), run: newBot };
  const group: Action = { key: "group", icon: Users, title: t("开一个群组"), detail: t("多个 Bot 同群，按话题分开讨论"), run: newGroup };
  const actions = hasBots ? [chat, bot, group] : [bot, chat, group];
  return <div className="welcome brand-welcome">
    <section className="welcome-panel" aria-labelledby={id}>
      <h2 id={id}>{t("开始工作")}</h2>
      <p>{hasBots ? t("选择已有 Bot 开新对话，或创建群组后按话题讨论。") : t("先创建一个 Bot。之后可以为它开多个独立对话，或把它拉进群组。")}</p>
      <ul className="welcome-actions">{actions.map(({ key, icon: Icon, title, detail, run }, index) => <li key={key}><button type="button" className={`welcome-action welcome-${key}${index === 0 ? " is-primary" : ""}`} aria-labelledby={`${id}-${key}`} aria-describedby={`${id}-${key}-detail`} onClick={run}>
        <span className="welcome-action-icon" aria-hidden="true"><Icon size={17}/></span><span className="welcome-action-copy"><strong id={`${id}-${key}`}>{title}</strong><small id={`${id}-${key}-detail`}>{detail}</small></span><ChevronRight className="welcome-action-chevron" size={16} aria-hidden="true"/>
      </button></li>)}</ul>
      {pairDevice && <button type="button" className="secondary" onClick={pairDevice}>{t("添加设备 · 显示二维码")}</button>}
      <h3 className="welcome-model-title">{t("工作结构")}</h3>
      <dl className="welcome-model">
        <div><dt><BotIcon size={15} aria-hidden="true"/>{t("Bot 与独立对话")}</dt><dd>{t("每个 Bot 有自己的工作区、人设和记忆；每个对话的上下文相互独立。")}</dd></div>
        <div><dt><Users size={15} aria-hidden="true"/>{t("群组与话题")}</dt><dd>{t("多个 Bot 在同一群组协作；每个话题分别保存消息和上下文。")}</dd></div>
      </dl>
    </section>
  </div>;
}

/** Empty direct conversation: compact and unboxed, so it never competes with the first reply. */
export function DirectEmpty({ botId, name, archived, online, draftEmpty, commands, attach, dispatcher }: { botId: string; name: string; archived: boolean; online: boolean; draftEmpty: boolean; commands: () => void; attach: () => void; dispatcher?: boolean }) {
  useLocale(); const id = useId();
  return <section className="direct-empty" aria-labelledby={id}>
    <Avatar kind="bot" id={botId} name={name} size={40}/>
    <div className="direct-empty-copy">
      <h2 id={id}>{t("和 {0} 开始这段对话", name)}</h2>
      <p>{dispatcher ? t("跟它说要做什么，它会拆成工单交给本机的 CLI 去做，并在这里汇报结果。") : t("这是一个独立对话，不带入其他对话的上下文；仍使用这个 Bot 的工作区、人设和记忆。")}</p>
      {/* The command shortcut writes "/", so it exists only while there is no draft to overwrite, like the composer hint. */}
      {!archived && <div className="direct-empty-actions">{draftEmpty && <button type="button" disabled={!online} onClick={commands}><kbd aria-hidden="true">/</kbd>{t("查看命令")}</button>}<button type="button" onClick={attach}><FilePlus2 size={15} aria-hidden="true"/>{t("附加文件")}</button></div>}
    </div>
  </section>;
}
