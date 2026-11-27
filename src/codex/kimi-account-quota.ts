import { StringDecoder } from "node:string_decoder";
import {
  ENGINE_QUOTA_REFRESH_MS,
  quotaSnapshotSchema,
  type QuotaBalance,
  type QuotaReason,
  type QuotaSnapshot,
  type QuotaWindow,
} from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError, unavailableQuota } from "./account-quota.js";
import {
  AdapterQuotaCache,
  type AdapterQuotaScope,
  type EngineQuotaReadOptions,
  type EngineQuotaReadResult,
} from "./adapter-account-quota.js";
import { killProcessTree } from "./process-tree.js";

export type KimiQuotaSpawnOptions = {
  stdio: ["pipe", "pipe", "pipe"];
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  windowsHide?: boolean;
};

export type KimiQuotaChildLike = {
  pid?: number;
  stdin?: { end(chunk?: string): void; on?(event: "error", listener: (error: Error) => void): void };
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  kill?: (signal?: string) => void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): void;
};

export type KimiQuotaSpawn = (
  command: string,
  args: string[],
  options: KimiQuotaSpawnOptions,
) => KimiQuotaChildLike;

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const KIMI_WINDOWS: Array<{ key: "limit5h" | "limit7d" | "monthTotal" | "monthCode"; id: string; label: string; periodSeconds: number }> = [
  { key: "limit5h", id: "five_hour", label: "5 hours", periodSeconds: 18_000 },
  { key: "limit7d", id: "seven_day", label: "7 days", periodSeconds: 604_800 },
  { key: "monthTotal", id: "month_total", label: "Monthly", periodSeconds: 30 * 86_400 },
  { key: "monthCode", id: "month_code", label: "Coding · 30 days", periodSeconds: 30 * 86_400 },
];

type OwnedRead = { abort: AbortController; closed: Promise<void> };
const owned = new WeakMap<AdapterQuotaCache, Set<OwnedRead>>();

export async function cancelOwnedKimiQuotaReads(cache: AdapterQuotaCache): Promise<void> {
  const reads = [...(owned.get(cache) ?? [])];
  if (reads.length === 0) return;
  for (const read of reads) read.abort.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(reads.map(read => read.closed)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("quota_process_close_timeout")), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopChild(child: KimiQuotaChildLike): Promise<void> {
  if (child.pid) return killProcessTree(child.pid, { graceMs: 300 });
  try { child.kill?.("SIGTERM"); } catch { /* already gone */ }
  return Promise.resolve();
}

function parseIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

/** Parse Kimi's local `GET /api/v1/oauth/usage` response envelope into a TaroBird `QuotaSnapshot`.
 * Distinguishes normal plan quotas + top-up pack balance, 401 (not signed in), 404 (non-Kimi For Coding),
 * and API-key-only errors. */
export function parseKimiManagedUsage(payload: unknown, now = Date.now()): QuotaSnapshot {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new QuotaReadError("invalid_response");
  }
  const envelope = payload as Record<string, unknown>;
  const data = (envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
    ? envelope.data
    : envelope) as Record<string, unknown>;

  if (data.kind === "error") {
    const status = typeof data.status === "number" ? data.status : undefined;
    const message = typeof data.message === "string" ? data.message : "";
    if (
      status === 401
      || /no token for|run \/login|re-?login required|authorization failed|not logged in|unauthorized|try \/login|please login/i.test(message)
    ) {
      return unavailableQuota("kimi", "login_required", now, "unknown");
    }
    if (status === 404 || /usage endpoint not available|kimi for coding/i.test(message)) {
      // Keep capability.mode="active" so the owner can explicitly refresh after upgrading to
      // Kimi For Coding on the web without restarting the Host or modifying credential files.
      return {
        ...unavailableQuota("kimi", "mode_not_supported", now, "other"),
        capability: { mode: "active", reason: "mode_not_supported" },
      };
    }
    if (status === 429 || /rate.?limit|too many requests/i.test(message)) {
      return unavailableQuota("kimi", "rate_limited", now, "subscription");
    }
    if (status === 408 || status === 504 || /request timed out|timed out|\btimeout\b/i.test(message)) {
      return unavailableQuota("kimi", "timeout", now, "subscription");
    }
    if (/api.?key/i.test(message)) {
      return unavailableQuota("kimi", "mode_not_supported", now, "api_key");
    }
    return unavailableQuota("kimi", "native_error", now, "subscription");
  }

  if (data.kind !== "ok" || !data.quota || typeof data.quota !== "object" || Array.isArray(data.quota)) {
    throw new QuotaReadError("invalid_response");
  }
  const quota = data.quota as Record<string, unknown>;
  const usages = quota.usages && typeof quota.usages === "object" && !Array.isArray(quota.usages)
    ? quota.usages as Record<string, unknown>
    : {};

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const windows: QuotaWindow[] = [];

  for (const spec of KIMI_WINDOWS) {
    const raw = usages[spec.key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.usedRatio !== "number" || !Number.isFinite(entry.usedRatio) || entry.usedRatio < 0 || entry.usedRatio > 1000) {
      throw new QuotaReadError("invalid_response");
    }
    const usedPercent = Math.round(entry.usedRatio * 10_000) / 100;
    const resetsAt = parseIso(entry.resetAt);
    windows.push({
      id: spec.id,
      label: spec.label,
      periodSeconds: spec.periodSeconds,
      metric: "percent",
      usedPercent,
      availability: "unknown",
      observedAt,
      expiresAt,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const balances: QuotaBalance[] = [];
  if (quota.extraUsage && typeof quota.extraUsage === "object" && !Array.isArray(quota.extraUsage)) {
    const extra = quota.extraUsage as Record<string, unknown>;
    const currencyRaw = typeof extra.currency === "string" ? extra.currency.trim().toUpperCase() : "CNY";
    const unit = /^[A-Za-z0-9._-]{1,16}$/.test(currencyRaw) ? currencyRaw : "CNY";
    if (typeof extra.balanceCents === "number" && Number.isFinite(extra.balanceCents) && extra.balanceCents >= 0) {
      balances.push({
        id: "top_up",
        kind: "currency",
        amount: (extra.balanceCents / 100).toFixed(2),
        unit,
        observedAt,
        expiresAt,
      });
    }
    if (
      extra.monthlyChargeLimitEnabled === true
      && typeof extra.monthlyChargeLimitCents === "number"
      && extra.monthlyChargeLimitCents > 0
      && typeof extra.monthlyUsedCents === "number"
      && extra.monthlyUsedCents >= 0
    ) {
      const usedPercent = Math.round((extra.monthlyUsedCents / extra.monthlyChargeLimitCents) * 10_000) / 100;
      windows.push({
        id: "extra_monthly",
        label: "Top-up monthly limit",
        periodSeconds: 30 * 86_400,
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
      });
    }
  }

  const hasData = windows.length > 0 || balances.length > 0;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: hasData ? "ready" : "unknown",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools: hasData ? [{
      id: "kimi",
      label: "Kimi Code",
      sharing: "shared",
      availability: "unknown",
      windows,
      balances,
      constraints: [],
    }] : [],
    constraints: [],
    help: "kimi_usage",
  };

  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

export function normalizeLoopbackOrigin(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username || u.password) return undefined;
    if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost" && u.hostname !== "[::1]") return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    throw new Error("quota_aborted");
  }
  void promise.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("quota_aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedResponseText(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error("quota_aborted");
  const contentLengthHeader = res.headers?.get?.("content-length");
  if (contentLengthHeader !== null && contentLengthHeader !== undefined && /^\d+$/.test(contentLengthHeader.trim())) {
    if (Number(contentLengthHeader.trim()) > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new QuotaReadError("invalid_response");
    }
  }
  if (res.body && typeof res.body.getReader === "function") {
    const reader = res.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error("quota_aborted");
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new QuotaReadError("invalid_response");
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    if (signal.aborted) throw new Error("quota_aborted");
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), totalBytes).toString("utf8");
  }
  const text = await res.text();
  if (signal.aborted) throw new Error("quota_aborted");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new QuotaReadError("invalid_response");
  return text;
}

/** Start a short-lived local `kimi web --port 0 --json`, query its loopback
 * `GET /api/v1/oauth/usage` endpoint once with the ephemeral bearer token, and
 * terminate the process tree immediately. Never sends model turns or reads Kimi credentials. */
export async function readOwnedKimiQuota(input: {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawn: KimiQuotaSpawn;
  cache: AdapterQuotaCache;
  scope: AdapterQuotaScope;
  options: EngineQuotaReadOptions;
  captureScope: () => AdapterQuotaScope;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<EngineQuotaReadResult> {
  if (owned.get(input.cache)?.size) return input.cache.failure(input.scope, "timeout");
  if (input.options.signal?.aborted) return input.cache.failure(input.scope, "cancelled");
  const now = input.now ?? Date.now;
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = Math.max(1, Math.min(ENGINE_QUOTA_REFRESH_MS, input.options.timeoutMs ?? ENGINE_QUOTA_REFRESH_MS));

  const abort = new AbortController();
  let timedOut = false;
  let closedResolve!: () => void;
  const closed = new Promise<void>(resolve => { closedResolve = resolve; });
  const entry: OwnedRead = { abort, closed };
  const reads = owned.get(input.cache) ?? new Set<OwnedRead>();
  owned.set(input.cache, reads);
  reads.add(entry);
  void closed.then(() => reads.delete(entry));

  const cancel = () => abort.abort();
  input.options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);

  const fail = (reason: QuotaReason, authMode = input.scope.authMode): EngineQuotaReadResult => {
    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
    return input.cache.store(after, { snapshot: unavailableQuota("kimi", reason, now(), authMode) });
  };

  let child: KimiQuotaChildLike | undefined;
  let didClose = false;
  let didStop = true;
  let childClosePromise: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;
  const terminate = () => {
    if (!child) return Promise.resolve();
    if (didClose) return stopping ?? Promise.resolve();
    if (!stopping) {
      didStop = false;
      stopping = stopChild(child).then(() => { didStop = true; });
    }
    return stopping;
  };
  let stopWaitPromise: Promise<void> | undefined;
  // Stopping the process tree and waiting for its close share one cleared 2 s allowance so the read
  // finishes within its limit plus 2 s (inside ENGINE_QUOTA_HUB_REFRESH_MS) with no leaked timers.
  const stopAndAwaitClose = (): Promise<void> => {
    if (!child) return Promise.resolve();
    return stopWaitPromise ??= (async () => {
      const stopPromise = terminate();
      if (didClose && didStop) return;
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      const allowance = new Promise<void>(resolve => { stopTimer = setTimeout(resolve, 2000); });
      try {
        await Promise.race([Promise.all([stopPromise, childClosePromise]), allowance]);
      } finally {
        if (stopTimer) clearTimeout(stopTimer);
      }
    })();
  };

  const onAbort = () => { void terminate(); };
  abort.signal.addEventListener("abort", onAbort, { once: true });

  try {
    try {
      child = input.spawn(input.executable, ["web", "--port", "0", "--json"], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        env: input.env,
        cwd: input.cwd,
        windowsHide: true,
      });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      return fail(code === "ENOENT" ? "cli_unavailable" : "native_error");
    }

    let spawnErrorCode: string | undefined;
    childClosePromise = new Promise<void>(resolve => {
      const done = () => { if (!didClose) { didClose = true; resolve(); } };
      child!.once("error", err => {
        spawnErrorCode = err && typeof err === "object" && "code" in err ? String(err.code) : "error";
        done();
      });
      child!.once("close", () => done());
    });
    // Drain stderr continuously so diagnostic logs from `kimi web` never fill the OS pipe buffer and deadlock.
    child.stderr?.on("data", () => undefined);
    child.stdin?.on?.("error", () => undefined);
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (abort.signal.aborted) void terminate();

    const ready = await new Promise<{ origin: string; token?: string } | { error: QuotaReason }>((resolve) => {
      let settled = false;
      const finish = (value: { origin: string; token?: string } | { error: QuotaReason }) => {
        if (settled) return;
        settled = true;
        abort.signal.removeEventListener("abort", onReadyAbort);
        resolve(value);
      };
      const onReadyAbort = () => finish({ error: timedOut ? "timeout" : "cancelled" });
      abort.signal.addEventListener("abort", onReadyAbort, { once: true });
      if (abort.signal.aborted) { onReadyAbort(); return; }

      const decoder = new StringDecoder("utf8");
      let buf = "";
      let bytes = 0;
      child!.stdout?.on("data", chunk => {
        const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > MAX_STDOUT_BYTES) { finish({ error: "invalid_response" }); return; }
        buf += text;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("{")) continue;
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            const rawOrigin = typeof parsed.origin === "string" ? parsed.origin.trim() : "";
            const origin = rawOrigin ? normalizeLoopbackOrigin(rawOrigin) : undefined;
            const token = typeof parsed.token === "string" ? parsed.token.trim() : undefined;
            if (origin) {
              finish({ origin, token });
              return;
            }
          } catch { /* wait for valid ready JSON line */ }
        }
      });
      void childClosePromise.then(() => {
        finish({ error: spawnErrorCode === "ENOENT" ? "cli_unavailable" : "native_error" });
      });
    });

    if ("error" in ready) {
      await stopAndAwaitClose();
      if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
      if (!didClose || !didStop) return fail("native_error");
      return fail(ready.error);
    }

    if (input.captureScope().revision !== input.scope.revision) {
      await stopAndAwaitClose();
      return input.cache.failure(input.captureScope(), "auth_changed");
    }

    const usageUrl = new URL("/api/v1/oauth/usage", ready.origin).toString();
    const res = await raceWithAbort(fetchFn(usageUrl, {
      method: "GET",
      headers: ready.token ? { Authorization: `Bearer ${ready.token}` } : {},
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    }), abort.signal);

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      clearTimeout(timer);
      await stopAndAwaitClose();
      const after = input.captureScope();
      if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
      if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
      if (!didClose || !didStop) return fail("native_error");
      // Local `kimi web` wraps upstream API errors (401/404/429) inside HTTP 200 envelopes.
      // A raw HTTP 404 means this CLI version lacks `/api/v1/oauth/usage`, not a non-coding account.
      if (res.status === 404) return fail("native_unverified");
      if (res.status === 429) return fail("rate_limited");
      return fail("native_error");
    }

    // Drain and parse the bounded HTTP response body BEFORE terminating `kimi web` so chunked
    // responses are never aborted mid-stream.
    const bodyText = await raceWithAbort(readBoundedResponseText(res, MAX_HTTP_BODY_BYTES, abort.signal), abort.signal);
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      throw new QuotaReadError("invalid_response");
    }
    const snapshot = parseKimiManagedUsage(payload, now());

    clearTimeout(timer);
    await stopAndAwaitClose();

    const after = input.captureScope();
    if (after.revision !== input.scope.revision) return input.cache.failure(after, "auth_changed");
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    if (!didClose || !didStop) return fail("native_error");
    return input.cache.store(after, { snapshot });
  } catch (error) {
    await stopAndAwaitClose();
    if (abort.signal.aborted) return fail(timedOut ? "timeout" : "cancelled");
    if (!didClose || !didStop) return fail("native_error");
    const reason = error instanceof QuotaReadError ? error.reason : "native_error";
    return fail(reason);
  } finally {
    clearTimeout(timer);
    input.options.signal?.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", onAbort);
    await stopAndAwaitClose();
    closedResolve();
  }
}
