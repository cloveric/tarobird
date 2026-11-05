import type { MarkdownWorkerChunk, MarkdownWorkerRequest, MarkdownWorkerResult } from "./markdown.worker.js";
import type { MarkdownDependency } from "./markdown-parser.js";

type Deliver = (chunks: MarkdownWorkerChunk[] | undefined) => void;
type Owner = { alive: boolean; failures: number; isolated: boolean; latest?: Job; dependency?: MarkdownDependency };
type Job = { owner: number; state: Owner; id: number; text: string; valid: () => boolean; deliver: Deliver };
// One shared worker and at most one queued revision per mounted document.
let worker: Worker | undefined, sequence = 0, current: Job | undefined;
const waiting = new Map<number, Job>(), deferred = new Map<number, Job>();
const failedOwners = new Set<number>();
const unavailable = new Set<MarkdownDependency>(), dependencyFailures = new Map<MarkdownDependency, number>();
let stopTimer: ReturnType<typeof setTimeout> | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
let restartTimer: ReturnType<typeof setTimeout> | undefined;
let failures = 0, constructionFailed = false, blocked = false, recoveringCircuit = false, drainQueued = false;
function scheduleDrain() {
  if (drainQueued) return; drainQueued = true;
  queueMicrotask(() => { drainQueued = false; drain(); });
}
function stopWorker() {
  clearTimeout(timeout); clearTimeout(stopTimer);
  if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); worker = undefined; }
}
function idle() {
  clearTimeout(stopTimer);
  stopTimer = setTimeout(() => { if (!current && !waiting.size) stopWorker(); }, 30_000);
}
function resetFailures() { failures = 0; constructionFailed = false; failedOwners.clear(); }
function fail(construction = false) {
  stopWorker(); clearTimeout(restartTimer); restartTimer = undefined;
  const failed = current; current = undefined;
  const notify = new Map<number, Job>();
  failures++; constructionFailed ||= construction;
  if (failed) {
    failedOwners.add(failed.owner);
    // Count even superseded work: streaming revisions must not replenish an
    // owner's failure budget. Constructor errors belong to the platform.
    if (!construction && failed.state.alive && ++failed.state.failures >= 2) {
      failed.state.isolated = true; waiting.delete(failed.owner); deferred.delete(failed.owner);
      const latest = failed.state.latest;
      if (latest?.valid()) notify.set(latest.owner, latest);
    } else if (failed.valid() && !waiting.has(failed.owner)) waiting.set(failed.owner, failed);
  }
  // One poisonous document is isolated locally. Failures from distinct owners
  // (or construction failure) indicate an unavailable shared platform.
  if (failures >= 2 && (constructionFailed || failedOwners.size >= 2)) {
    blocked = true; recoveringCircuit = false;
    for (const job of waiting.values()) if (job.valid() && !job.state.isolated) {
      deferred.set(job.owner, job); notify.set(job.owner, job);
    }
    waiting.clear();
  } else if (waiting.size) restartTimer = setTimeout(() => { restartTimer = undefined; drain(); }, 100);
  // Shared state is settled before callbacks may submit or dispose work.
  notify.forEach(job => job.deliver(undefined));
}
function drain() {
  if (current || restartTimer || blocked || !waiting.size) return;
  clearTimeout(stopTimer);
  const [owner, job] = waiting.entries().next().value!; waiting.delete(owner); current = job;
  if (!worker) {
    try {
      const active = new Worker(new URL("./markdown.worker.ts", import.meta.url), { type: "module" }); worker = active;
      active.onmessage = (event: MessageEvent<MarkdownWorkerResult>) => {
        if (worker !== active || !current || current.id !== event.data.id) return;
        const finished = current; current = undefined; clearTimeout(timeout); resetFailures();
        // A mixed document can restore math before its highlighter fails. Its
        // successful engine must still release matching deferred history.
        for (const dependency of event.data.dependencies ?? []) {
          dependencyFailures.delete(dependency);
          for (const [owner, pending] of deferred) if (pending.state.dependency === dependency && pending.valid() && !pending.state.isolated) {
            if (!waiting.has(owner)) waiting.set(owner, pending);
            deferred.delete(owner);
          }
        }
        if ("dependency" in event.data && event.data.dependency) {
          const dependency = event.data.dependency;
          finished.state.dependency = dependency;
          // An older request may have skipped a paused engine just before a
          // user retries another message. It did not attempt a new import and
          // must not consume that newer recovery's failure budget.
          if (!event.data.skipped && !unavailable.has(dependency)) {
            // A fresh realm retries a failed dynamic import once per engine,
            // not once per message. Fifty formulas must not start 100 Workers.
            stopWorker();
            const failures = (dependencyFailures.get(dependency) ?? 0) + 1;
            dependencyFailures.set(dependency, failures);
            if (failures < 2) {
              if (finished.valid() && !waiting.has(finished.owner)) waiting.set(finished.owner, finished);
              scheduleDrain(); return;
            }
            unavailable.add(dependency);
          }
          if (finished.valid()) deferred.set(finished.owner, finished);
          finished.deliver(undefined);
          drain(); if (!current && !waiting.size) idle();
          return;
        }
        // A parser rejection is healthy transport but does not prove a manual
        // recovery succeeded. It never requeues that rejected document.
        const chunks = "chunks" in event.data ? event.data.chunks : undefined;
        if (chunks) {
          finished.state.failures = 0; finished.state.dependency = undefined;
        }
        if (chunks && recoveringCircuit) {
          recoveringCircuit = false;
          for (const pending of deferred.values()) if (pending.valid() && !pending.state.isolated && !waiting.has(pending.owner)) {
            waiting.set(pending.owner, pending);
          }
          deferred.clear();
        }
        finished.deliver(chunks);
        drain(); if (!current && !waiting.size) idle();
      };
      active.onerror = event => { event.preventDefault(); if (worker === active) fail(); };
      active.onmessageerror = () => { if (worker === active) fail(); };
    } catch { fail(true); return; }
  }
  const active = worker, request: MarkdownWorkerRequest = { id: job.id, text: job.text, unavailable: [...unavailable] };
  try {
    active.postMessage(request);
    timeout = setTimeout(() => { if (worker === active && current?.id === job.id) fail(); }, 15_000);
  } catch { fail(); }
}
export function createMarkdownJob(): { update: (text: string, deliver: Deliver) => void; retry: () => void; dispose: () => void } {
  const owner = ++sequence, state: Owner = { alive: true, failures: 0, isolated: false };
  let revision = 0, generation = 0, deliveredRevision = 0;
  function update(text: string, deliver: Deliver) {
    if (!state.alive) return;
    if (state.latest && !text.startsWith(state.latest.text)) generation++;
    const epoch = generation;
    const version = ++revision, valid = () => state.alive && version === revision;
    const job: Job = { owner, state, id: ++sequence, text, valid, deliver: chunks => {
      // Faster streaming must not starve completed formatting until the entire
      // answer ends. A successful prefix may advance the display while its
      // append-only successor parses. Replacements, failures and disposed
      // owners keep the strict revision fence; scheduling/retry is unchanged.
      const prefix = chunks && state.alive && epoch === generation && version > deliveredRevision && state.latest?.text.startsWith(text);
      if (valid() || prefix) { deliveredRevision = version; deliver(chunks); }
    } };
    state.latest = job; deferred.delete(owner);
    if (state.isolated) { job.deliver(undefined); return; }
    if (blocked) { deferred.set(owner, job); job.deliver(undefined); return; }
    waiting.set(owner, job); scheduleDrain();
  }
  return {
    update,
    retry() {
      if (!state.alive || !state.latest) return;
      // Coalesce repeated clicks without resetting an active recovery budget.
      if (current?.owner === owner && current.valid() || waiting.has(owner)) return;
      state.isolated = false; state.failures = 0;
      if (state.dependency) { unavailable.delete(state.dependency); dependencyFailures.delete(state.dependency); state.dependency = undefined; }
      if (blocked) { blocked = false; resetFailures(); recoveringCircuit = true; }
      // Reuse the callback without wrapping an already revision-fenced delivery.
      const retried = { ...state.latest, id: ++sequence }; state.latest = retried;
      deferred.delete(owner); waiting.set(owner, retried); scheduleDrain();
    },
    dispose() {
      state.alive = false; revision++; state.latest = undefined; waiting.delete(owner); deferred.delete(owner);
      // An abandoned slow parse must not hold the next conversation for 15 s.
      if (current?.owner === owner) { stopWorker(); current = undefined; scheduleDrain(); }
      if (!current && !waiting.size) { clearTimeout(restartTimer); restartTimer = undefined; idle(); }
    },
  };
}
