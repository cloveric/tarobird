import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useConnectionSelection } from "./connection-selection.js";
import { Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import type { CardElement, Json } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { MarkdownText } from "./MarkdownText.js";
import { t, useLocale } from "./i18n.js";
import "./question-form.css";
import { questionDraftKey, questionDraftSchema, type Question, type QuestionData, type QuestionDraft } from "./question-draft.js";
export { nativeQuestionData } from "./question-draft.js";
function answerCount(q: Question, index: number, values: Record<string, Json>): number {
  const selected = values[`q${index}`], other = values[`q${index}_other`];
  const picked = q.multiSelect ? Array.isArray(selected) ? selected.length : 0 : typeof selected === "string" && selected !== "" ? 1 : 0;
  const custom = q.allowFreeText && typeof other === "string" && other.trim() ? 1 : 0;
  return q.multiSelect ? picked + custom : picked || custom;
}
function validation(q: Question, index: number, values: Record<string, Json>): string {
  const n = answerCount(q, index, values);
  if (q.required && !n) return t("请先回答这个问题");
  if (q.multiSelect && (q.minSelections !== undefined && n > 0 && n < q.minSelections || q.maxSelections !== undefined && n > q.maxSelections)) return t("所选数量不符合要求");
  return "";
}

export function QuestionForm({ data, element, connection, messageId, values: initialValues, act }: {
  data: QuestionData; element: CardElement; connection: HubConnection; messageId: string;
  values: Record<string, Json>;
  act: (element: CardElement, overrides?: Record<string, Json>) => Promise<boolean>;
}) {
  useLocale();
  const cache = connection.cache;
  const [step, setStep] = useState(0), [error, setError] = useState(""), [pending, setPending] = useState(false), [deliveryError, setDeliveryError] = useState(false);
  const [values, setValues] = useState<QuestionDraft["values"]>(() => { const defaults = questionDraftSchema.shape.values.safeParse(initialValues); return defaults.success ? defaults.data : {}; });
  const [loaded, setLoaded] = useState(false), [loadAttempt, setLoadAttempt] = useState(0), [draftError, setDraftError] = useState(false);
  const draft = useRef<QuestionDraft>({ values, step: 0 }), saveRevision = useRef(0);
  const draftKey = questionDraftKey(messageId, data);
  // The first change after a pause is written at once (so a reload keeps it);
  // continued typing and the paired option/other-answer change coalesce into
  // one write per window plus the latest value. Leaving the card or page writes now.
  const queuedSave = useRef<{ timer: ReturnType<typeof setTimeout>; next?: QuestionDraft } | undefined>(undefined);
  const writeSave = useRef<() => void>(() => {});
  const writeDraft = (next: QuestionDraft) => {
    const revision = ++saveRevision.current;
    void cache.saveQuestionDraft(messageId, draftKey, next, connection.identity).then(() => { if (saveRevision.current === revision) setDraftError(false); }, () => { if (saveRevision.current === revision) setDraftError(true); });
  };
  const closeWindow = () => {
    const queued = queuedSave.current; if (!queued) return;
    if (!queued.next) { queuedSave.current = undefined; return; }
    const next = queued.next; queued.next = undefined; writeDraft(next);
    queued.timer = setTimeout(closeWindow, 250);
  };
  writeSave.current = () => {
    const queued = queuedSave.current; if (!queued) return;
    clearTimeout(queued.timer); queuedSave.current = undefined;
    if (queued.next) writeDraft(queued.next);
  };
  const save = (next: QuestionDraft) => {
    draft.current = next;
    if (queuedSave.current) { queuedSave.current.next = next; return; }
    writeDraft(next);
    queuedSave.current = { timer: setTimeout(closeWindow, 250) };
  };
  useEffect(() => {
    const flush = () => writeSave.current();
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); flush(); };
  }, []);
  const change = (name: string, value: Json) => {
    const next = questionDraftSchema.parse({ ...draft.current, values: { ...draft.current.values, [name]: value } });
    setValues(next.values); save(next);
  };
  const [queued, setQueued] = useState(false);
  const locked = useRef(false), failed = useRef(false), heading = useRef<HTMLHeadingElement>(null), prefix = useId();
  const [focusRevision, setFocusRevision] = useState(0);
  useLayoutEffect(() => {
    if (!focusRevision) return;
    // Finish step-navigation focus with its DOM commit. Deferring it to the
    // next frame can blur an answer the user has already started entering.
    // The revision also commits repeated same-step actions; a ref alone could
    // survive a state bailout and steal focus during later typing instead.
    heading.current?.focus({ preventScroll: true });
  }, [focusRevision]);
  const state = useConnectionSelection(connection, value => ({ status: value.state.status, outboxRevision: value.outboxRevision }));
  const submit = element.children!.find((e) => e.name === "askq_submit")!;
  const restoreOutbox = (entries: Awaited<ReturnType<typeof cache.outbox>>) => {
    const entry = entries.find((e) => e.frame.type === "interaction.submit" && e.frame.messageId === messageId && e.frame.actionId === submit.actionId);
    if (entry && entry.frame.type === "interaction.submit") {
      locked.current = true; setPending(true); setQueued(true); failed.current = !!entry.error; setDeliveryError(!!entry.error);
      const restored = questionDraftSchema.shape.values.safeParse(Object.fromEntries(Object.entries(entry.frame.values).filter(([name]) => /^q\d+(?:_other)?$/.test(name))));
      if (restored.success) { draft.current = { ...draft.current, values: restored.data }; setValues(restored.data); }
    } else if (failed.current) { failed.current = false; locked.current = false; setPending(false); setQueued(false); setDeliveryError(false); }
  };
  useEffect(() => {
    let active = true; setError("");
    void Promise.all([cache.questionDraft(messageId, draftKey, connection.identity), cache.outbox()]).then(([saved, entries]) => {
      if (!active) return;
      if (saved) { draft.current = { values: saved.values, step: Math.min(saved.step, data.questions.length - 1) }; setValues(draft.current.values); setStep(draft.current.step); }
      // Recover any submitted answer before enabling controls. A draft is never
      // permission to enqueue a second copy of an existing submission.
      restoreOutbox(entries); setLoaded(true);
    }).catch(() => { if (active) setError(t("未能读取待发送答案，请重新读取后再提交。")); });
    return () => { active = false; };
  }, [connection, draftKey, messageId, loadAttempt]);
  // A queued answer is not a delivered answer. Keep retry/removal with the
  // existing durable outbox instead of creating a second submission. Every
  // outbox mutation advances outboxRevision; other conversations' message
  // events cannot change this card's queued submission.
  const outboxRevision = state.outboxRevision;
  useEffect(() => {
    let active = true;
    if (!loaded) return;
    void cache.outbox().then((entries) => {
      if (!active) return;
      restoreOutbox(entries);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [outboxRevision, messageId, submit.actionId, loaded]);
  const move = (next: number) => { setFocusRevision((revision) => revision + 1); setStep(next); save({ ...draft.current, step: next }); setError(""); };
  const finish = async () => {
    if (locked.current) return;
    for (let i = 0; i < data.questions.length; i++) {
      const problem = validation(data.questions[i]!, i, values);
      if (problem) { move(i); setError(problem); return; }
    }
    locked.current = true; setPending(true); setQueued(false); setError(""); writeSave.current();
    if (await act(submit, values)) setQueued(true);
    else { locked.current = false; setPending(false); }
  };
  const q = data.questions[step]!, name = `q${step}`, otherName = `${name}_other`;
  const current = values[name], other = typeof values[otherName] === "string" ? String(values[otherName]) : "";
  const answered = data.questions.filter((question, i) => answerCount(question, i, values) > 0).length;
  const multiple = data.questions.length > 1;
  const title = !multiple && /^(?:问题|Question)\s*1$/i.test(q.header.trim()) ? t("请确认") : q.header;
  return <section className="native-question" aria-label={t("回答问题")} aria-busy={pending}>
    {multiple && <div className="question-progress"><span>{t("问题 {0} / {1}", step + 1, data.questions.length)}</span><span>{t("已回答 {0} 项", answered)}</span></div>}
    {data.questions.length > 1 && <nav className="question-steps" aria-label={t("切换问题")}>{data.questions.map((question, i) => <button type="button" key={i} disabled={pending || !loaded} aria-current={step === i ? "step" : undefined} aria-label={t("第 {0} 题：{1}", i + 1, question.header)} onClick={() => move(i)}>{answerCount(question, i, values) > 0 ? <Check size={13}/> : i + 1}<span>{question.header}</span></button>)}</nav>}
    {data.notice && <p className="error-text" role="alert">{data.notice}</p>}
    <h3 ref={heading} tabIndex={-1}>{title}</h3>
    <div id={`${prefix}-prompt`}><MarkdownText key={step} text={q.question}/></div>
    <fieldset className="question-options" disabled={pending || !loaded || element.disabled} aria-labelledby={`${prefix}-prompt`}>
      {(q.options.length > 0 || !q.required || q.minSelections !== undefined || q.maxSelections !== undefined) && <legend>{q.multiSelect ? t("可多选") : q.options.length ? t("请选择一项") : t("填写你的回答")}{!q.required && t("（选填）")}{q.minSelections !== undefined && t(" · 至少 {0} 项", q.minSelections)}{q.maxSelections !== undefined && t(" · 最多 {0} 项", q.maxSelections)}</legend>}
      {q.options.map((option, i) => {
        const value = String(i), selected = q.multiSelect ? Array.isArray(current) && current.includes(value) : current === value;
        return <div key={i}><label className={`question-option ${selected ? "selected" : ""}`}>
          <input type={q.multiSelect ? "checkbox" : "radio"} name={`${prefix}-${name}`} aria-label={option.label} aria-describedby={option.description ? `${prefix}-option-${i}` : undefined} checked={selected} onChange={() => {
            setError("");
            if (q.multiSelect) change(name, selected ? (current as Json[]).filter((v) => v !== value) : [...(Array.isArray(current) ? current : []), value]);
            else { change(name, value); change(otherName, ""); }
          }}/>
          <span><strong>{option.label}</strong>{option.description && <span className="question-description" id={`${prefix}-option-${i}`}>{option.description}</span>}</span>
        </label>{option.preview && <details className="question-preview"><summary>{t("查看选项预览")}</summary><pre>{option.preview}</pre></details>}</div>;
      })}
      {q.allowFreeText && <label className="question-custom">{q.options.length ? q.multiSelect ? t("补充其他选项") : t("其他答案") : t("填写你的回答")}<textarea name={otherName} rows={3} maxLength={16000} value={other} placeholder={q.options.length ? t("选项不合适？写下你的答案") : t("填写你的回答")} onChange={(event) => { change(otherName, event.target.value); if (!q.multiSelect && event.target.value.trim()) change(name, ""); setError(""); }}/></label>}
    </fieldset>
    {error && <p className="error-text" role="alert">{error}</p>}
    {!loaded && error && <button type="button" onClick={() => setLoadAttempt((n) => n + 1)}>{t("重新读取")}</button>}
    {draftError && <p className="error-text" role="alert">{t("草稿未能保存在此设备，请先提交或复制答案再离开。")}</p>}
    {pending && <p className={deliveryError ? "error-text" : "muted"} role="status">{deliveryError ? t("答案发送失败，请在待发送项中重试或移除。") : !queued ? t("正在保存答案…") : state.status === "online" ? t("答案已进入发送队列，等待任务确认…") : t("答案已保存，联网后自动提交。")}</p>}
    <footer className={`question-footer${multiple ? "" : " is-single"}`}>{multiple && <button type="button" disabled={pending || !loaded || step === 0} onClick={() => move(step - 1)}><ChevronLeft size={16}/>{t("上一题")}</button>}
      {step < data.questions.length - 1 ? <button type="button" className="primary" disabled={pending || !loaded} onClick={() => { const problem = validation(q, step, values); if (problem) setError(problem); else move(step + 1); }}>{t("下一题")}<ChevronRight size={16}/></button> : <button type="button" className="primary" disabled={pending || !loaded || submit.disabled} onClick={() => { void finish(); }}>{pending && <LoaderCircle size={15} className="spin"/>}{t("提交")}</button>}
    </footer>
    {!pending && <small className="question-footnote">{t("选择后可修改，点击提交才会发送答案。")}</small>}
  </section>;
}
