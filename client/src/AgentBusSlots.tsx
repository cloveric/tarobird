import { listedConversations } from "./dispatcher.js";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Minus, Network, Plus } from "lucide-react";
import { AGENT_BUS_INSTRUCTION_CHARS, type AgentBusConfig } from "../../src/client-protocol/agent-bus.js";
import type { AdhdHost } from "./AdhdBoard.js";
import { busCoordinatorExecutes, busInstructionCopy, busRoleName, busSlotKey } from "./agent-bus-view.js";
import { t } from "./i18n.js";

type Member = AgentBusConfig["coordinator"];
const draftRecords = Symbol("agentBusDraftRecords");
type DraftMember = Member & { [draftRecords]?: ReadonlyMap<string, string | undefined> };
type Conversation = NonNullable<AdhdHost["directory"]>["conversations"][number];
type Focus = { key: string; target: "bot" | "instruction" | "up" | "down" };

/** Scroll only the Bus panel, never the clipped dock or the ADHD board. */
export function revealInBusPanel(element: HTMLElement) {
  const container = element.closest<HTMLElement>(".agent-bus-panel-scroll"); if (!container) return;
  const bounds = container.getBoundingClientRect(), box = element.getBoundingClientRect();
  const delta = box.top < bounds.top ? box.top - bounds.top - 12 : Math.min(Math.max(0, box.bottom - bounds.bottom + 12), Math.max(0, box.top - bounds.top - 12));
  if (delta) container.scrollTo({ top: container.scrollTop + delta, behavior: "smooth" });
}

/** Two to six visible lines, then the field scrolls; CSS owns both bounds. */
function InstructionField({ value, label, placeholder, ariaLabel, describedBy, disabled, readOnly, visible, change }: {
  value: string; label: string; placeholder: string; ariaLabel: string; describedBy?: string; disabled: boolean; readOnly?: boolean; visible: boolean; change: (value: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const element = field.current; if (!element) return;
    element.style.height = "";
    // A hidden editor has no layout; keep the CSS minimum until it is shown.
    if (!element.scrollHeight) return;
    const style = getComputedStyle(element);
    element.style.height = `${element.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
  }, []);
  useLayoutEffect(fit, [fit, value, visible]);
  useLayoutEffect(() => { addEventListener("resize", fit); return () => removeEventListener("resize", fit); }, [fit]);
  // No maxLength: it silently cuts a paste or IME commit. Keep every character
  // and let the schema block saving, with the count beside the field.
  const length = value.trim().length, over = length > AGENT_BUS_INSTRUCTION_CHARS;
  return <label className="agent-bus-instruction"><span>{label}{length > AGENT_BUS_INSTRUCTION_CHARS * 0.9 && <small data-invalid={over || undefined}>{length}/{AGENT_BUS_INSTRUCTION_CHARS}</small>}</span>
    <textarea ref={field} data-focus="instruction" rows={2} aria-label={ariaLabel} aria-invalid={over || undefined} aria-describedby={over ? describedBy : undefined} disabled={disabled && !readOnly} readOnly={readOnly} value={value} placeholder={placeholder} onChange={event => change(event.target.value)}/></label>;
}

/** The configuration's division of labour: every slot, its Bot, its own task
 * and its record conversation, editable in place without selecting a node. */
export function AgentBusSlots({ config, change, bots, conversations, label, editable, readOnly, visible, issue, hintId, parked }: {
  config: AgentBusConfig; change: (next: AgentBusConfig, options?: { clearParked?: boolean }) => void;
  bots: { id: string; name: string; online?: number | boolean }[]; conversations: Conversation[];
  label: (id: string) => string; editable: boolean; readOnly?: boolean; visible: boolean; issue?: { index?: number }; hintId: string;
  parked: { members: number; coordinatorInstruction: boolean };
}) {
  const list = useRef<HTMLOListElement>(null), pending = useRef<Focus | undefined>(undefined);
  const reorderable = config.mode === "chain" || config.mode === "fan", all = [config.coordinator, ...config.members];
  useLayoutEffect(() => {
    const focus = pending.current; if (!focus) return;
    pending.current = undefined;
    const slot = list.current?.querySelector<HTMLElement>(`[data-slot="${focus.key}"]`); if (!slot) return;
    const opposite = focus.target === "up" ? "down" : focus.target === "down" ? "up" : focus.target;
    const target = [focus.target, opposite].map(name => slot.querySelector<HTMLButtonElement>(`[data-focus="${name}"]`)).find(item => item && !item.disabled);
    target?.focus({ preventScroll: true }); revealInBusPanel(slot);
  });
  const setMember = (index: number, member: Member, options?: { clearParked?: boolean }) =>
    change(index < 0 ? { ...config, coordinator: member } : { ...config, members: config.members.map((item, i) => i === index ? member : item) }, options);
  // A task and its draft record choices belong to this slot, including while
  // it is reordered/parked. Symbols follow object spreads but never enter the
  // persisted config. Returning to a Bot restores only a still-eligible record.
  const chooseBot = (index: number, member: DraftMember, botId: string) => {
    if (botId === member.botId) return;
    const remembered = new Map(member[draftRecords]);
    remembered.set(member.botId, member.conversationId);
    const previous = remembered.get(botId);
    const available = previous && conversations.some(chat => chat.id === previous && !chat.archived && chat.type === "direct" && chat.botIds.length === 1 && chat.botIds[0] === botId)
      && !all.some((other, at) => at !== index + 1 && other.conversationId === previous);
    const { conversationId: _, ...rest } = member;
    const next: DraftMember = { ...rest, botId, ...(available ? { conversationId: previous } : {}), [draftRecords]: remembered };
    setMember(index, next);
  };
  const chooseConversation = (index: number, member: Member, id: string) => { const { conversationId: _, ...rest } = member; setMember(index, id ? { ...rest, conversationId: id } : rest); };
  const move = (index: number, target: number) => {
    const members = [...config.members]; [members[index], members[target]] = [members[target]!, members[index]!];
    pending.current = { key: busSlotKey(members[target]!), target: target < index ? "up" : "down" }; change({ ...config, members });
  };
  const remove = (index: number) => {
    if (!editable || !reorderable || config.members.length <= 1) return;
    const members = config.members.filter((_, i) => i !== index);
    pending.current = { key: busSlotKey(members[Math.min(index, members.length - 1)]!), target: "bot" };
    change({ ...config, members }, { clearParked: true });
  };
  const insert = (member: Member, at: number, target: Focus["target"]) => {
    pending.current = { key: busSlotKey(member), target };
    change({ ...config, members: [...config.members.slice(0, at), member, ...config.members.slice(at)] }, { clearParked: true });
  };
  const slot = (member: Member, index: number) => {
    const key = busSlotKey(member), role = busRoleName(config.mode, index), copy = busInstructionCopy(config.mode, index), invalid = issue?.index === index;
    const executes = index >= 0 || busCoordinatorExecutes(config.mode);
    const chosen = all.filter((_, i) => i !== index + 1).map(item => item.conversationId).filter(Boolean);
    const chats = listedConversations(conversations).filter(chat => !chat.archived && chat.type === "direct" && chat.botIds.length === 1 && chat.botIds[0] === member.botId);
    const steps = config.mode === "chain";
    return <li key={key} data-slot={key} data-slot-index={index} className={`agent-bus-slot ${index < 0 ? "is-source" : ""} ${invalid ? "is-invalid" : ""}`}>
      <span className={`agent-bus-step ${index < 0 ? "is-source" : ""}`} aria-hidden="true">{index < 0 ? <Network size={14}/> : String(index + 1).padStart(2, "0")}</span>
      <div className="agent-bus-slot-main">
        <div className="agent-bus-slot-head">
          <span className="agent-bus-slot-role">{role}</span>
          <select data-focus="bot" aria-label={t("{0} Bot", role)} aria-invalid={invalid && !member.botId || undefined} aria-describedby={invalid ? hintId : undefined} disabled={!editable} value={member.botId} onChange={event => chooseBot(index, member, event.target.value)}>
            <option value="">{t("选择 Bot")}</option>
            {member.botId && !bots.some(bot => bot.id === member.botId) && <option value={member.botId}>{t("成员已不可用")}</option>}
            {bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}{bots.filter(other => other.name === bot.name).length > 1 ? ` · ${bot.id.slice(-6)}` : ""}{!bot.online ? ` · ${t("离线")}` : ""}</option>)}
          </select>
          {index >= 0 && reorderable && <div className="agent-bus-member-actions">
            <button type="button" data-focus="up" aria-label={steps ? t("上移步骤 {0}", index + 1) : t("上移成员 {0}", index + 1)} disabled={!editable || index === 0} onClick={() => move(index, index - 1)}><ArrowUp size={14}/></button>
            <button type="button" data-focus="down" aria-label={steps ? t("下移步骤 {0}", index + 1) : t("下移成员 {0}", index + 1)} disabled={!editable || index === config.members.length - 1} onClick={() => move(index, index + 1)}><ArrowDown size={14}/></button>
            <button type="button" className="is-remove" aria-label={steps ? t("移除步骤 {0}", index + 1) : t("移除成员 {0}", index + 1)} title={config.members.length <= 1 ? t("至少保留一位成员") : t("移除成员，保留对话记录")} disabled={!editable || config.members.length <= 1} onClick={() => remove(index)}><Minus size={14}/></button>
          </div>}
        </div>
        {executes
          ? <InstructionField value={member.instruction ?? ""} label={copy.label} placeholder={copy.placeholder} ariaLabel={t("{0} · {1}", role, copy.label)} describedBy={invalid ? hintId : undefined} disabled={!editable} readOnly={readOnly} visible={visible} change={instruction => setMember(index, { ...member, instruction })}/>
          : <p className="agent-bus-slot-note">{t("仅发起与汇报")}</p>}
        {index < 0 && parked.coordinatorInstruction && <p className="agent-bus-slot-note is-parked" role="status">{t("发起者的任务已暂存，只在并行询问、回答后复核和研究团队中使用；以当前方式保存后会移除。")}</p>}
        {/* An explicit new step for the coordinator's Bot. It never reuses the
            coordinator's conversation and never changes a saved Bus by itself. */}
        {index < 0 && config.mode === "chain" && !!member.botId && config.members[0]?.botId !== member.botId && <button type="button" className="agent-bus-delegate-first" disabled={!editable || config.members.length >= 11} onClick={() => insert({ botId: member.botId }, 0, "instruction")}><Plus size={13}/>{t("让 {0} 执行第 1 步", label(member.botId))}</button>}
        {!!member.botId && <label className="agent-bus-slot-record"><span>{t("记录对话")}</span>
          <select aria-label={t("{0} 的记录对话", role)} value={member.conversationId ?? ""} disabled={!editable} onChange={event => chooseConversation(index, member, event.target.value)}>
            <option value="">{t("保存时创建或复用专用对话")}</option>
            {member.conversationId && !chats.some(chat => chat.id === member.conversationId) && <option value={member.conversationId}>{t("对话已不可用")}</option>}
            {chats.map(chat => <option key={chat.id} value={chat.id} disabled={chosen.includes(chat.id)}>{chat.title}{chosen.includes(chat.id) ? ` · ${t("已用于其他步骤")}` : ""}{chats.filter(other => other.title === chat.title).length > 1 ? ` · ${chat.id.slice(-6)}` : ""}</option>)}
          </select></label>}
      </div>
    </li>;
  };
  return <section className="agent-bus-roster" aria-label={t("分工")}>
    <div className="agent-bus-roster-heading"><h3>{t("分工")}</h3><small>{t("{0} 位成员", all.length)}</small></div>
    <ol ref={list} className={`agent-bus-slots ${config.mode === "chain" || config.mode === "crew" ? "is-sequence" : ""}`}>{all.map((member, i) => slot(member, i - 1))}</ol>
    {reorderable && <button type="button" className="agent-bus-add" disabled={!editable || config.members.length >= 11} onClick={() => insert({ botId: "" }, config.members.length, "bot")}><Plus size={14}/>{config.mode === "chain" ? t("添加步骤") : t("添加成员")}</button>}
    {parked.members > 0 && <p className="agent-bus-slot-note is-parked" role="status">{t("另有 {0} 位成员已暂存：切回可容纳更多成员的方式时恢复，保存或增删成员后不再保留。", parked.members)}</p>}
  </section>;
}

/** Three lines by default; offer the full text only when it is clipped. */
function ClampedText({ text }: { text: string }) {
  const body = useRef<HTMLParagraphElement>(null), [open, setOpen] = useState(false), [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = body.current; if (!element || open) return;
    const measure = () => setClipped(element.scrollHeight > element.clientHeight + 1);
    measure(); addEventListener("resize", measure); return () => removeEventListener("resize", measure);
  }, [text, open]);
  return <><p ref={body} className={`agent-bus-division-text ${open ? "" : "is-clamped"}`}>{text}</p>
    {(clipped || open) && <button type="button" className="agent-bus-division-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t("收起") : t("展开全文")}</button>}</>;
}

/** Read-only division of labour a run executes with (its immutable snapshot). */
export function AgentBusDivision({ config, heading, label, edit }: { config: AgentBusConfig; heading: string; label: (id: string) => string; edit?: () => void }) {
  return <section className="agent-bus-division" aria-label={heading}>
    <div className="agent-bus-roster-heading"><h3>{heading}</h3>{edit ? <button type="button" onClick={edit}>{t("编辑分工")}</button> : <small>{t("运行中不可修改")}</small>}</div>
    <ol>{[config.coordinator, ...config.members].map((member, i) => {
      const index = i - 1, instruction = member.instruction?.trim(), executes = index >= 0 || busCoordinatorExecutes(config.mode);
      return <li key={i}>
        <span className={`agent-bus-step ${index < 0 ? "is-source" : ""}`} aria-hidden="true">{index < 0 ? <Network size={14}/> : String(index + 1).padStart(2, "0")}</span>
        <div><strong>{busRoleName(config.mode, index)} · {member.botId ? label(member.botId) : t("未选择 Bot")}</strong>
          {!executes ? <p className="agent-bus-division-text is-muted">{t("仅发起与汇报")}</p> : instruction ? <ClampedText text={instruction}/> : <p className="agent-bus-division-text is-muted">{t("未填写 · {0}", busInstructionCopy(config.mode, index).blank)}</p>}</div>
      </li>;
    })}</ol>
  </section>;
}
