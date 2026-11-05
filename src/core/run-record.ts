import { runToolAction, runToolLabels } from "../client-protocol/run-tools.js";
import { randomUUID } from "node:crypto";
import type { EngineStreamEvent } from "../codex/adapter.js";
import { RUN_BYTE_LIMIT, RUN_ENTRY_LIMIT, isContextMaintenance, type RunEntry, type RunSummary, type RunScope } from "../client-protocol/run.js";

export type RunRecord = { rootScopeId?: string; id: string; startedAt: number; updatedAt: number; revision: number; entries: RunEntry[]; bytes: number; truncated: boolean; phase: RunSummary["phase"]; model?: string; effort?: string; endedAt?: number };
export function createRunRecord(model?: string, effort?: string): RunRecord {
  const now = Date.now(); return { id: randomUUID(), startedAt: now, updatedAt: now, revision: 0, entries: [], bytes: 0, truncated: false, phase: "thinking", ...(model ? { model: model.slice(0, 512) } : {}), ...(effort ? { effort: effort.slice(0, 512) } : {}) };
}
function json(value: unknown): string { try { return JSON.stringify(value, null, 2) ?? ""; } catch { return "[unavailable]"; } }
// Evidence may fill the journal while many tools still await their receipts.
// Reserve bounded space for every entry's revision, terminal status, timestamp,
// exit code and duration; reaching the capture limit must not freeze a spinner.
const CAPTURE_BYTE_LIMIT = RUN_BYTE_LIMIT - RUN_ENTRY_LIMIT * 256;
type ScopeBudget = { bytes: number; count: number; scopes: Map<string, { bytes: number; count: number }> };
const scopeBudgets = new WeakMap<RunRecord, ScopeBudget>();
function scopedBudget(record: RunRecord): ScopeBudget {
  let budget = scopeBudgets.get(record);
  if (!budget) {
    budget = { bytes: 0, count: 0, scopes: new Map() };
    for (const entry of record.entries) if (entry.scope) {
      const bytes = Buffer.byteLength(JSON.stringify(entry));
      const value = budget.scopes.get(entry.scope.id) ?? { bytes: 0, count: 0 };
      value.bytes += bytes; value.count++; budget.scopes.set(entry.scope.id, value);
      budget.bytes += bytes; budget.count++;
    }
    scopeBudgets.set(record, budget);
  }
  return budget;
}
function update(record: RunRecord, entry: RunEntry, previous?: RunEntry): void {
  const text = entry.text, input = entry.input, output = entry.output;
  let diffRemaining = 32768, sourceRemaining = 16384;
  const changes = entry.changes?.slice(0, 20).map(change => { const diff = change.diff.slice(0, diffRemaining); diffRemaining -= diff.length; return { path: change.path.slice(0, 2048), diff }; });
  const sources = entry.sources?.slice(0, 30).flatMap(source => { const url = source.url.slice(0, 4096), title = source.title?.slice(0, 512); sourceRemaining -= url.length + (title?.length ?? 0); return sourceRemaining >= 0 ? [{ url, title }] : []; });
  const evidenceTruncated = JSON.stringify(changes) !== JSON.stringify(entry.changes) || JSON.stringify(sources) !== JSON.stringify(entry.sources);
  // Keep live public progress moving after a long thought reaches its capture
  // cap. Other evidence retains its original prefix; all caps remain explicit.
  const capturedText = entry.kind === "thinking" ? text?.slice(-32768).replace(/^[\uDC00-\uDFFF]/, "") : text?.slice(0, 32768);
  entry = { ...entry, changes, sources, ...(evidenceTruncated ? { truncated: true } : {}), text: capturedText, input: input?.slice(0, 32768), output: output?.slice(0, 65536),
    ...((text?.length ?? 0) > 32768 || (input?.length ?? 0) > 32768 || (output?.length ?? 0) > 65536 ? { truncated: true } : {}) };
  let bytes = Buffer.byteLength(JSON.stringify(entry));
  const oldBytes = previous ? Buffer.byteLength(JSON.stringify(previous)) : 0;
  if (!previous && record.entries.length >= RUN_ENTRY_LIMIT) { record.truncated = true; return; }
  const budget = entry.scope ? scopedBudget(record) : undefined;
  const perScope = entry.scope ? budget!.scopes.get(entry.scope.id) ?? { bytes: 0, count: 0 } : undefined;
  const scopedLimit = !!budget && (!previous && (budget.count >= 500 || perScope!.count >= 200)
    || budget.bytes + bytes - oldBytes > Math.floor(CAPTURE_BYTE_LIMIT / 4)
    || perScope!.bytes + bytes - oldBytes > 512 * 1024);
  if (scopedLimit || record.bytes + bytes - oldBytes > CAPTURE_BYTE_LIMIT) {
    record.truncated = true;
    if (!previous) return;
    // Retain the already captured evidence and the actual new receipt. Its
    // reserved metadata fits even when the final output itself cannot fit.
    entry = { ...previous, revision: entry.revision, status: entry.status, truncated: true,
      ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }) };
    bytes = Buffer.byteLength(JSON.stringify(entry));
  }
  if (entry.truncated) record.truncated = true;
  record.bytes += bytes - oldBytes;
  if (budget && entry.scope) {
    const value = perScope!; value.bytes += bytes - oldBytes; value.count += previous ? 0 : 1;
    budget.scopes.set(entry.scope.id, value); budget.bytes += bytes - oldBytes; budget.count += previous ? 0 : 1;
  }
  if (previous) record.entries[record.entries.indexOf(previous)] = entry; else record.entries.push(entry);
}
/** Capture public engine events BEFORE transport-card truncation. Exact native
 * IDs win; ambiguous id-less results never complete an unrelated parallel tool. */
export function recordRunEvent(record: RunRecord, event: EngineStreamEvent, now = Date.now(), scope?: RunScope): void {
  if (event.type === "scoped") {
    if (record.endedAt) return;
    const phase = record.phase;
    const inner = event.event;
    if (inner.type === "scope_status") {
      record.updatedAt = now; record.revision++;
      if (inner.status !== "running") {
        const ids = new Set([event.scope.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const entry of record.entries) if (entry.scope?.parentId && ids.has(entry.scope.parentId) && !ids.has(entry.scope.id)) { ids.add(entry.scope.id); changed = true; }
        }
        for (const entry of [...record.entries]) if (entry.scope && ids.has(entry.scope.id) && ["running", "waiting"].includes(entry.status))
          update(record, { ...entry, revision: record.revision, status: inner.status === "stopped" ? "stopped" : "unknown", endedAt: now }, entry);
      }
      if (inner.text) recordRunEvent(record, { type: "assistant_text", text: inner.text, delta: false }, now, event.scope);
    } else if (inner.type === "result") {
      const previous = record.entries.filter(entry => entry.scope?.id === event.scope.id).at(-1);
      if (inner.text && !(previous?.kind === "text" && previous.text === inner.text)) recordRunEvent(record, { type: "assistant_text", text: inner.text, delta: false }, now, event.scope);
    } else recordRunEvent(record, inner, now, event.scope);
    record.phase = phase; // Child/review activity never changes the parent turn phase.
    return;
  }
  if (record.endedAt || event.type === "task_notification") return;
  record.updatedAt = now; record.revision++;
  const sameScope = (entry: RunEntry) => entry.scope?.id === scope?.id;
  const add = (entry: Omit<RunEntry, "seq" | "revision" | "at">) => update(record, { ...entry, ...(scope ? { scope } : {}), seq: record.entries.length + 1, revision: record.revision, at: now });
  // Real resumed output/action ends a missing-receipt spinner without claiming
  // success. Late explicit receipts can still resolve this unknown entry.
  if (["assistant_text", "thinking", "tool_use", "permission_request"].includes(event.type)) {
    for (const entry of [...record.entries]) if (sameScope(entry) && isContextMaintenance(entry) && entry.status === "running")
      update(record, { ...entry, revision: record.revision, status: "unknown", endedAt: now }, entry);
  }
  if (event.type === "engine_retry") {
    const callId = `engine-retry-${event.attempt}`;
    const previous = record.entries.find(entry => sameScope(entry) && entry.name === "engine_retry" && entry.callId === callId);
    if (previous && !["running", "waiting"].includes(previous.status)) return;
    if (event.status === "waiting") {
      // A confirmed failed foreground attempt cannot leave old tools spinning.
      // Preserve uncertain outcomes; a later actual receipt can still fill them.
      for (const entry of [...record.entries]) if (sameScope(entry) && ["running", "waiting"].includes(entry.status))
        update(record, { ...entry, revision: record.revision, status: entry.name === "engine_retry" ? "error" : "unknown", endedAt: now }, entry);
    }
    const status = event.status === "waiting" ? "waiting" : event.status === "retrying" ? "running" : event.status === "resumed" ? "done" : event.status === "cancelled" ? "stopped" : "error";
    const entry = { kind: "text" as const, name: "engine_retry", callId, status: status as RunEntry["status"],
      input: json({ reason: event.reason, attempt: event.attempt, delayMs: event.delayMs }),
      ...(["waiting", "running"].includes(status) ? {} : { endedAt: now }) };
    if (previous) update(record, { ...previous, ...entry, revision: record.revision }, previous); else add(entry);
    record.phase = ["waiting", "running"].includes(status) ? "working" : "thinking";
  } else if (event.type === "subagent_activity") {
    // A receipt is not an executing tool and must not change the parent phase,
    // settle an unrelated task, or imply a duration that the CLI never supplied.
    const name = `subagent_${event.kind}`;
    if (!record.entries.some(entry => sameScope(entry) && entry.name === name && entry.callId === event.id)) {
      add({ kind: "text", name, callId: event.id, status: "done", input: json({ agentId: event.agentId, label: event.label, model: event.model, effort: event.effort }) });
    }
  } else if (event.type === "background_review_wait" || event.type === "native_input_wait") {
    const previous = record.entries.filter(entry => sameScope(entry) && entry.name === event.type && entry.status === "waiting").at(-1);
    if (event.status === "started") {
      if (!previous) add({ kind: "text", name: event.type, status: "waiting" });
      record.phase = "working";
    } else if (previous) {
      update(record, { ...previous, revision: record.revision, status: event.status === "cancelled" ? "stopped" : "done", endedAt: now }, previous);
      record.phase = "thinking";
    }
  } else if (event.type === "context_compaction") {
    const name = event.checkpoint ? "context_checkpoint" : "context_compaction";
    const previous = record.entries.find(entry => sameScope(entry) && entry.kind === "text" && entry.name === name && entry.callId === event.id);
    // Duplicate/delayed starts cannot reopen a settled maintenance operation.
    if (previous && previous.status !== "running" && !(previous.status === "unknown" && event.status !== "started")) return;
    const status = event.status === "started" ? "running" : event.status === "completed" ? "done" : event.status === "unknown" ? "unknown" : "error";
    const entry = { kind: "text" as const, name, callId: event.id.slice(0, 512), status: status as RunEntry["status"], ...(status === "running" || !previous ? {} : { endedAt: now }),
      ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0 ? { durationMs: event.durationMs } : {}) };
    if (previous) update(record, { ...previous, ...entry, revision: record.revision }, previous);
    else add(entry);
    // Completion-only/late receipts must not replace an already active answer.
    if (status === "running") record.phase = "working";
    else if (previous?.status === "running") record.phase = "thinking";
  } else if (event.type === "assistant_text" || event.type === "thinking") {
    const kind = event.type === "thinking" ? "thinking" : "text";
    record.phase = kind === "thinking" ? "thinking" : "answering";
    const last = record.entries.filter(sameScope).at(-1);
    if (last?.kind === kind && !last.name && (kind === "thinking" ? event.delta !== false : event.delta === true)) update(record, { ...last, revision: record.revision, text: (last.text ?? "") + event.text }, last);
    else add({ kind, status: "done", text: event.text });
  } else if (event.type === "tool_use" || event.type === "permission_request") {
    if (runToolAction(event.toolName) === "plan") {
      const previous = event.toolUseId ? record.entries.find(e => sameScope(e) && e.kind === "plan" && e.callId === event.toolUseId) : undefined;
      const plan = { kind: "plan" as const, status: "done" as const, name: event.toolName.slice(0, 512), callId: event.toolUseId?.slice(0, 512), input: json(event.toolInput) };
      if (previous) update(record, { ...previous, ...plan, revision: record.revision }, previous); else add(plan);
      return;
    }
    const waiting = event.type === "permission_request";
    record.phase = waiting ? /AskUserQuestion|request_user_input/.test(event.toolName) ? "waiting_answer" : "waiting_approval" : "working";
    const previous = event.toolUseId ? record.entries.find(e => sameScope(e) && e.kind === "tool" && e.callId === event.toolUseId) : undefined;
    if (previous && ["done", "error", "stopped", "unknown"].includes(previous.status)) record.phase = "working";
    const entry = { kind: "tool" as const, status: waiting ? "waiting" as const : "running" as const, name: event.toolName.slice(0, 512), ...(event.toolUseId ? { callId: event.toolUseId.slice(0, 512) } : {}), ...(event.toolInput === undefined ? {} : { input: json(event.toolInput) }) };
    // Duplicate start events cannot reopen an already completed call.
    if (previous) update(record, { ...previous, ...entry, status: ["done", "error", "stopped", "unknown"].includes(previous.status) ? previous.status : entry.status, seq: previous.seq, at: previous.at, revision: record.revision }, previous);
    else add(entry);
  } else if (event.type === "tool_progress" || event.type === "tool_result") {
    if (event.type === "tool_result") {
      const plan = event.toolUseId ? record.entries.find(e => sameScope(e) && e.kind === "plan" && e.callId === event.toolUseId) : undefined;
      if (plan) { update(record, { ...plan, revision: record.revision, status: event.isError ? "error" : "done", output: event.output, endedAt: now }, plan); return; }
      if (runToolAction(event.toolName) === "plan") return;
    }
    const candidates = record.entries.filter(e => sameScope(e) && e.kind === "tool" && (event.toolUseId ? e.callId === event.toolUseId : ["running", "waiting"].includes(e.status) && (event.type !== "tool_result" || !event.toolName || e.name === event.toolName)));
    const previous = candidates.length === 1 ? candidates[0] : undefined;
    const evidence = event.type === "tool_result" ? {
      ...(Number.isSafeInteger(event.exitCode) ? { exitCode: event.exitCode } : {}),
      ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0 ? { durationMs: event.durationMs } : {}),
      ...(event.truncated ? { truncated: true } : {}),
      ...(event.changes ? { changes: event.changes } : {}), ...(event.sources ? { sources: event.sources } : {}),
    } : {};
    if (event.type === "tool_progress" && previous && !["running", "waiting"].includes(previous.status)) return;
    if (event.type === "tool_progress" && previous && runToolAction(previous.name) === "delegate") {
      update(record, { ...previous, revision: record.revision, status: "running", text: (previous.text ?? "") + (event.delta === false && previous.text ? "\n\n" : "") + event.text }, previous);
      record.phase = "working";
      return;
    }
    if (previous) update(record, { ...previous, ...evidence, revision: record.revision, status: event.type === "tool_result" ? event.isError ? "error" : "done" : "running", output: event.type === "tool_result" ? event.output ?? previous.output : (previous.output ?? "") + (event.delta === false && previous.output ? "\n\n" : "") + event.text, ...(event.type === "tool_result" ? { endedAt: now } : {}) }, previous);
    else if (event.type === "tool_result") add({ ...evidence, kind: "tool", name: event.toolName?.slice(0, 512), callId: event.toolUseId?.slice(0, 512), status: event.isError ? "error" : "done", output: event.output, endedAt: now });
    record.phase = "working";
  } else if (event.type === "user_input_request") {
    // This request is non-blocking: record it without claiming the CLI paused.
    add({ kind: "question", status: "done", name: event.toolName, input: json(event.toolInput) });
  } else if (event.type === "background_task_started" || event.type === "background_task_finished") {
    if (event.origin === "unattributed") return;
    // A lifecycle receipt is evidence, not another tool or a turn completion.
    // Reuse the v1 narrative kind so old clients can still read the journal.
    const previous = record.entries.find(e => sameScope(e) && e.kind === "text" && e.name === event.type && e.callId === event.taskId.slice(0, 512));
    if (!previous) add({ kind: "text", name: event.type, callId: event.taskId.slice(0, 512), status: "done", text: event.type === "background_task_started" ? event.description : event.summary, input: json({ status: event.type === "background_task_started" ? "running" : event.status }) });
  } else if (event.type === "result") record.phase = "delivering";
}
export function summarizeRun(record: RunRecord, status: string): RunSummary {
  const phase: RunSummary["phase"] = status === "running" ? record.phase : status === "done" ? "done" : status === "interrupted" ? "stopped" : status === "delivering" ? record.phase === "stopping" ? "stopping" : "delivering" : status === "partial" ? "partial" : "error";
  if (!["running", "delivering"].includes(status) && !record.endedAt) {
    record.endedAt = Date.now(); record.updatedAt = record.endedAt; record.revision++;
    for (const entry of [...record.entries]) if (["running", "waiting"].includes(entry.status)) update(record, { ...entry, revision: record.revision, status: status === "interrupted" ? "stopped" : "unknown", endedAt: record.endedAt }, entry);
  }
  const tools = record.entries.filter(e => e.kind === "tool" && e.scope?.id === record.rootScopeId);
  const active = record.entries.filter(e => e.scope?.id === record.rootScopeId
    && (e.kind === "tool" || isContextMaintenance(e) || e.kind === "text" && ["background_review_wait", "native_input_wait", "engine_retry"].includes(e.name ?? ""))
    && ["running", "waiting"].includes(e.status)).at(-1);
  // Summary carries no raw command, output or thought transcript.
  let input: string | undefined;
  try {
    const raw = JSON.parse(active?.input ?? "{}");
    // Only semantic labels belong in the summary; raw commands remain on demand.
    const labels: Record<string, unknown> = Object.fromEntries(Object.entries(runToolLabels(raw, active?.name)).map(([key, value]) => [key, value.slice(0, 160)]));
    if (active?.name === "engine_retry") {
      if (["capacity", "connection", "rate-limit"].includes(raw.reason)) labels.reason = raw.reason;
      for (const key of ["attempt", "delayMs"]) if (Number.isFinite(raw[key]) && raw[key] >= 0) labels[key] = raw[key];
    }
    const action = Array.isArray(raw?.commandActions) && raw.commandActions.length === 1 ? raw.commandActions[0] : undefined;
    if (action && ["read", "search", "listFiles"].includes(action.type)) labels.commandActions = [Object.fromEntries(["type", "path", "name", "query"].flatMap(key => typeof action[key] === "string" ? [[key, action[key].slice(0, 160)]] : []))];
    input = JSON.stringify(labels);
  } catch { /* A truncated input has no reliable semantic label. */ }
  const current = active ? { seq: active.seq, revision: active.revision, kind: active.kind, status: active.status, at: active.at, name: active.name, input } : undefined;
  return { version: 1, id: record.id, revision: record.revision, phase, startedAt: record.startedAt, updatedAt: record.updatedAt, endedAt: record.endedAt, count: tools.length, completed: tools.filter(e => e.status === "done").length, failed: tools.filter(e => e.status === "error").length, current, truncated: record.truncated, model: record.model, effort: record.effort };
}
