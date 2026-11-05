import { randomUUID } from "node:crypto";
import type { EngineStreamEvent } from "../codex/adapter.js";
import type { RunScope } from "../client-protocol/run.js";
import type { Locale } from "../runtime/locale.js";
import { backgroundTaskBody, backgroundTaskContext } from "./background-task-notice.js";
import { renderCoreNotificationCard } from "./card-renderer.js";
import { renderBackgroundTaskHeader } from "../runtime/background-task-header.js";
import { createRunRecord, recordRunEvent, summarizeRun, type RunRecord } from "./run-record.js";
import type { CoreChannelLike } from "./types.js";

type ScopedEvent = Extract<EngineStreamEvent, { type: "scoped" }>;
type Notification = Extract<EngineStreamEvent, { type: "task_notification" }>;
type Context = { channel: CoreChannelLike; chatId: string; conversationKey: string; replyTo?: string; replyInThread?: boolean; locale: Locale };
type Foreground = { apply(event: EngineStreamEvent): Promise<void>; isFinished?(): boolean };
type ScopeState = {
  owner: object; groupId: string; context: Context; scope: RunScope; origin: "bound" | "unattributed";
  record: RunRecord; status: string; body: string; detached: boolean; background: boolean; closed: boolean;
  messageId?: string; tail: Promise<unknown>; timer?: ReturnType<typeof setTimeout>; touchedAt: number;
};
type Registry = { states: Map<string, ScopeState>; forgotten: Map<string, { owner: object; foregroundOnly: boolean }> };
const registries = new WeakMap<CoreChannelLike, Registry>();
// Retained callbacks can outlive their foreground turns by hours. Bound both
// their number and captured evidence; the durable journal owns published rows.
const MAX_SCOPES = 32, MAX_SCOPE_BYTES = 512 * 1024, RETAIN_MS = 30 * 60_000;
function registry(channel: CoreChannelLike): Registry {
  let value = registries.get(channel);
  if (!value) { value = { states: new Map(), forgotten: new Map() }; registries.set(channel, value); }
  return value;
}
function key(conversationKey: string, scopeId: string): string { return `${conversationKey}\0${scopeId}`; }
function cancelTimer(state: ScopeState): void { if (state.timer) clearTimeout(state.timer); state.timer = undefined; }
function serial<T>(state: ScopeState, fn: () => Promise<T>): Promise<T> {
  const next = state.tail.catch(() => undefined).then(fn);
  state.tail = next.catch(() => undefined); return next;
}
function statusText(state: ScopeState): string {
  const en = state.context.locale === "en";
  if (state.status === "done") return en ? "The follow-up process has finished." : "后续处理已结束。";
  if (state.status === "interrupted") return en ? "The follow-up process was interrupted." : "后续处理已中断。";
  if (state.status === "error") return en ? "The follow-up process did not complete." : "后续处理未完成。";
  if (state.status === "partial") return en ? "The engine did not confirm the final state." : "引擎未确认最终状态。";
  return en ? "Follow-up work is in progress. Public steps are available in the process details." : "正在继续处理，可在过程详情查看公开步骤。";
}
function childFinishedBody(state: ScopeState): string {
  const note = state.context.locale === "en" ? "Subagent execution has finished." : "子代理执行已结束。";
  return state.body.includes(note) ? state.body : [state.body, note].filter(Boolean).join("\n\n");
}
function card(state: ScopeState, finalBody?: string, finalStatus?: string): Record<string, unknown> | null {
  const { locale } = state.context;
  const body = finalBody ?? (state.body || statusText(state));
  const header = state.background ? renderBackgroundTaskHeader(locale, finalStatus ?? (state.closed ? state.status : "running"))
    : locale === "en" ? "Subagent process" : "子代理过程";
  const background = state.background ? { origin: state.origin, context: backgroundTaskContext({ origin: state.origin }, locale)!, status: finalStatus ?? (state.closed ? state.status : "running") } : undefined;
  const rendered = renderCoreNotificationCard(header, body, locale, background, "gateway");
  // Only bound background subagents share a parent-turn group. Review scopes
  // carry the final report and remain standalone, as do unattributed scopes.
  const group = state.background && state.origin === "bound" && state.scope.kind === "subagent" ? { appScopedGroup: { version: 1, groupId: state.groupId, scopeId: state.scope.id } } : {};
  return rendered ? { ...rendered, ...(state.scope.label?.trim() ? { appScopedTask: { version: 1, label: state.scope.label.trim().slice(0, 500), kind: state.scope.kind } } : {}), ...group, appRun: { summary: summarizeRun(state.record, state.status), entries: state.record.entries, background: true } } : null;
}
async function publish(state: ScopeState, finalCard?: Record<string, unknown>): Promise<boolean> {
  // Older Hubs treat static fallback cards as completed messages. Never publish
  // live standalone progress there or trigger an early completion notification.
  if (state.context.channel.supportsScopedRunPresentation?.() === false) return false;
  const rendered = finalCard ?? card(state);
  if (!rendered) return false;
  const { channel, chatId, replyTo, replyInThread } = state.context;
  try {
    if (state.messageId) {
      if (!channel.updateCard) return false;
      await channel.updateCard(state.messageId, rendered);
    } else {
      const reply = state.origin === "bound" ? replyTo : undefined;
      state.messageId = (await channel.send(chatId, { card: rendered }, { ...(reply ? { replyTo: reply, replyInThread: Boolean(replyInThread) } : {}) })).messageId;
    }
    return true;
  } catch { return false; }
}
function flush(state: ScopeState): Promise<boolean> { cancelTimer(state); return serial(state, () => publish(state)); }
function schedule(state: ScopeState): void {
  if (state.timer || state.closed) return;
  state.timer = setTimeout(() => { state.timer = undefined; void serial(state, () => publish(state)); }, 100);
  state.timer.unref?.();
}
function rememberSkipped(reg: Registry, id: string, owner: object, foregroundOnly = false): void {
  reg.forgotten.set(id, { owner, foregroundOnly });
  while (reg.forgotten.size > MAX_SCOPES * 8) reg.forgotten.delete(reg.forgotten.keys().next().value!);
}
function forget(reg: Registry, id: string, state: ScopeState): void {
  cancelTimer(state); reg.states.delete(id); rememberSkipped(reg, id, state.owner);
}
function prune(reg: Registry): void {
  const now = Date.now();
  // An engine-sealed review still awaiting its final report is live ownership.
  const reclaimable = (state: ScopeState) => state.closed && !["running", "delivering"].includes(state.status);
  for (const [id, state] of reg.states) if (reclaimable(state) && now - state.touchedAt > RETAIN_MS) forget(reg, id, state);
  while (reg.states.size >= MAX_SCOPES) {
    const candidate = [...reg.states].find(([, state]) => reclaimable(state));
    if (!candidate) break; forget(reg, candidate[0], candidate[1]);
  }
}
function capture(state: ScopeState, event: ScopedEvent): void {
  if (state.record.bytes < MAX_SCOPE_BYTES) { recordRunEvent(state.record, event); return; }
  state.record.truncated = true;
  // Preserve real terminal receipts without retaining more output at the cap.
  if (event.event.type === "scope_status") recordRunEvent(state.record, { ...event, event: { ...event.event, text: undefined } });
  else if (event.event.type === "tool_result") {
    const inner = event.event;
    if (inner.toolUseId && state.record.entries.some(entry => entry.scope?.id === event.scope.id && entry.callId === inner.toolUseId)) {
      recordRunEvent(state.record, { ...event, event: { type: "tool_result", toolUseId: inner.toolUseId, isError: inner.isError, exitCode: inner.exitCode, durationMs: inner.durationMs } });
    }
  }
}

/** A callback owns its scope records for its whole lifetime. Foreground child
 * events enter only that run's journal; detached/review events get a read-only
 * card and never acquire the conversation's active-run or stop controls. */
export function createScopedRunPresentation(context: Context): {
  apply(event: EngineStreamEvent, options?: { foreground?: Foreground; foregroundActive?: boolean }): Promise<boolean>;
  markForegroundEnded(): void;
} {
  // One group per callback; a request message can start several callbacks.
  const owner = {}, groupId = randomUUID(); let foregroundEnded = false;
  return {
    markForegroundEnded() { foregroundEnded = true; },
    async apply(event, options = {}) {
      if (event.type !== "scoped") return false;
      if (context.channel.profile !== "gateway") return true;
      const reg = registry(context.channel), scope = event.rootScope ?? event.scope, id = key(context.conversationKey, scope.id);
      const foregroundActive = !foregroundEnded && options.foregroundActive !== false && !!options.foreground && !options.foreground.isFinished?.();
      const canAttach = scope.kind !== "background" && !event.detached && foregroundActive;
      const closesRoot = event.scope.id === scope.id && event.event.type === "scope_status" && event.event.status !== "running";
      const forgotten = reg.forgotten.get(id);
      if (forgotten) {
        if (forgotten.owner === owner && forgotten.foregroundOnly && canAttach) {
          if (closesRoot) rememberSkipped(reg, id, owner);
          await options.foreground!.apply(event);
        }
        return true;
      }
      let state = reg.states.get(id);
      if (state && (state.owner !== owner || state.origin !== event.origin)) return true;
      if (!state) {
        prune(reg);
        // Capacity limits may suppress a new standalone detail card, never an
        // existing live root or the original foreground controller's journal.
        if (reg.states.size >= MAX_SCOPES) {
          rememberSkipped(reg, id, owner, canAttach && !closesRoot);
          if (canAttach) await options.foreground!.apply(event);
          return true;
        }
        state = { owner, groupId, context, scope, origin: event.origin, record: createRunRecord(), status: "running", body: "", detached: false, background: scope.kind === "background" || !!event.detached, closed: false, tail: Promise.resolve(), touchedAt: Date.now() };
        state.record.rootScopeId = scope.id;
        // Claim before any asynchronous publication: one stdout batch can invoke
        // this callback repeatedly without awaiting the first invocation.
        reg.states.set(id, state);
      }
      if (state.closed) return true;
      state.touchedAt = Date.now();
      capture(state, event);
      const attached = !state.detached && canAttach;
      if (attached) {
        const pending = options.foreground!.apply(event);
        if (closesRoot) { state.closed = true; forget(reg, id, state); }
        await pending; return true;
      }
      const firstDetached = !state.detached; state.detached = true;
      state.background ||= !!event.detached || scope.kind === "background" || foregroundEnded || (!!options.foreground && !foregroundActive);
      const inner = event.event, isRoot = event.scope.id === scope.id;
      if (isRoot) {
        if (inner.type === "assistant_text") state.record.phase = "answering";
        else if (inner.type === "thinking") state.record.phase = "thinking";
        else if (inner.type === "permission_request") state.record.phase = /AskUserQuestion|request_user_input/.test(inner.toolName) ? "waiting_answer" : "waiting_approval";
        else if (["tool_use", "tool_result", "tool_progress"].includes(inner.type)) state.record.phase = "working";
      }
      if (isRoot && inner.type === "assistant_text") {
        state.body = (inner.delta === true ? state.body + inner.text : [state.body, inner.text].filter(Boolean).join("\n\n")).slice(-12_000);
      }
      if (isRoot && inner.type === "result") {
        // Result carries text, not success/failure. The following scope_status
        // owns execution termination (including a failed result's error).
        state.status = "delivering";
        state.body = inner.text.slice(-12_000) || state.body;
      }
      if (isRoot && inner.type === "scope_status" && inner.status !== "running") {
        state.closed = true;
        state.status = inner.status === "done" ? scope.kind === "background" ? "delivering" : "done"
          : inner.status === "stopped" ? "interrupted" : inner.status === "unknown" ? "partial" : inner.status;
        if (scope.kind === "subagent" && inner.status === "done") state.body = childFinishedBody(state);
      }
      if (firstDetached || state.closed || (isRoot && inner.type === "result")) await flush(state);
      else schedule(state);
      return true;
    },
  };
}

/** Final text/files retain their established delivery path. Reuse a process
 * card only when its callback, conversation and provenance agree exactly. */
export async function finishScopedRunPresentation(input: Pick<Context, "channel" | "conversationKey" | "replyTo">, event: Notification, deliveryConfirmed = true): Promise<boolean> {
  if (!event.scopeId || input.channel.profile !== "gateway") return false;
  const state = registries.get(input.channel)?.states.get(key(input.conversationKey, event.scopeId));
  if (!state?.detached || state.origin !== event.origin || (state.origin === "bound" && state.context.replyTo !== input.replyTo)) return false;
  // Seal capture now, even while the first publication is awaiting its receipt.
  // Otherwise a late delta can arm a timer behind the queued final and replace
  // the final body with an obsolete progress snapshot.
  state.closed = true; state.touchedAt = Date.now();
  cancelTimer(state);
  return await serial(state, async () => {
    const status = event.status?.trim().toLowerCase() ?? "";
    const completed = ["done", "completed", "success", "succeeded"].includes(status);
    state.status = !deliveryConfirmed ? "partial" : ["failed", "error"].includes(status) ? "error"
      : event.reason === "engine_exit" || ["stopped", "interrupted", "cancelled", "canceled", "aborted", "killed"].includes(status) ? "interrupted"
      : completed ? "done" : "partial";
    const en = state.context.locale === "en";
    let body = backgroundTaskBody(event, state.context.locale);
    if (event.settlesCurrentTurn) body = en ? "The result is included in the main reply." : "结果已并入本轮回复。";
    else if (event.suppressUserDelivery) {
      if (!deliveryConfirmed) body = en ? "The report could not be fully delivered; the public process has been preserved." : "回报未能完整交付，公开过程已保留。";
      else if (completed && state.status === "done") body = event.reason === "no_result"
        ? (en ? "No separate reply was generated; the public process has been preserved." : "未生成单独回复，公开过程已保留。")
        : (en ? "The result has been collected into the main turn; the public process has been preserved." : "结果已由主任务收集，公开过程已保留。");
      else body = statusText(state);
    }
    if ((event.settlesCurrentTurn || event.suppressUserDelivery) && !state.messageId) return false;
    const finalStatus = state.status === "done" ? "completed" : state.status === "error" ? "failed" : state.status === "interrupted" ? "interrupted" : "unknown";
    const finalCard = card(state, body, finalStatus);
    if (!finalCard) { state.body = statusText(state); await publish(state); return false; }
    // A card carrying the user-facing report never collapses into a group row.
    if (!event.settlesCurrentTurn && !event.suppressUserDelivery) delete finalCard.appScopedGroup;
    if (!deliveryConfirmed && finalCard.appBackgroundTask) finalCard.appBackgroundTask = { ...(finalCard.appBackgroundTask as object), delivery: "unconfirmed" };
    return await publish(state, finalCard);
  });
}
