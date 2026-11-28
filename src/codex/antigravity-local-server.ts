import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { promisify } from "node:util";
import { quotaSnapshotSchema, type QuotaPool, type QuotaSnapshot, type QuotaWindow } from "../client-protocol/engine-quota.js";
import { QUOTA_TTL_MS, QuotaReadError } from "./account-quota.js";

const execFileAsync = promisify(execFile);

const SUMMARY_PATH = "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary";
const STATUS_PATH = "/exa.language_server_pb.LanguageServerService/GetUserStatus";
const LOCAL_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type LocalExecFn = (file: string, args: string[], signal?: AbortSignal) => Promise<{ stdout: string }>;
export type LocalConnectRequestFn = (
  port: number,
  tls: boolean,
  pathName: string,
  body: string,
  csrf?: string,
  signal?: AbortSignal,
) => Promise<{ status: number; text: string } | null>;

export type AntigravityLocalProbeDeps = {
  execFile: LocalExecFn;
  request: LocalConnectRequestFn;
  platform: NodeJS.Platform;
};

type CandidateProcess = {
  pid: string;
  cli: boolean;
  csrf?: string;
  extPort?: number;
};

const LANGUAGE_SERVER_BASENAME_RE = /^language[_-]server(?:[_-][a-z0-9]+)*(?:\.exe)?$/i;
const IDE_MARKER_RE = /antigravity[-_]ide/i;
const AGY_BASENAME_RE = /^(?:agy|antigravity[-_]cli)(?:\.(?:exe|cmd|bat))?$/i;
const APP_MARKER_RE = /--app_data_dir(?:=|\s+)"?antigravity(?![\w-])|[\\/]antigravity(?:\.app)?[\\/]/i;
const NON_LISTENING_NETSTAT_STATE_RE = /^(?:ESTABLISHED|CLOSE_WAIT|TIME_WAIT|FIN_WAIT_1|FIN_WAIT_2|SYN_SENT|SYN_RECEIVED|LAST_ACK|CLOSING|BOUND)$/i;

function extractExecutablePath(command: string): string {
  const trimmed = command.trimStart();
  if (!trimmed) return "";
  const first = trimmed[0];
  if (first === "\"" || first === "'") {
    const end = trimmed.indexOf(first, 1);
    return end > 1 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  // On Windows/macOS, an unquoted absolute path may contain spaces before `--flags`.
  if (/^(?:[A-Za-z]:\\|\/)/.test(trimmed)) {
    const beforeFlag = trimmed.split(/\s+--/, 1)[0]?.trim() ?? firstToken;
    const candidateBase = basenameAnySep(beforeFlag);
    if (LANGUAGE_SERVER_BASENAME_RE.test(candidateBase) || AGY_BASENAME_RE.test(candidateBase)) {
      return beforeFlag;
    }
  }
  return firstToken;
}

function basenameAnySep(executablePath: string): string {
  const trimmed = executablePath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function flagValue(line: string, flag: string): string | undefined {
  const match = line.match(new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s"']+))`));
  const raw = match?.[1] ?? match?.[2] ?? match?.[3];
  return raw && raw.length > 0 ? raw : undefined;
}

export function classifyAntigravityProcessLine(line: string): CandidateProcess | null {
  const pidMatch = line.trim().match(/^(\d+)\s+(.+)$/);
  if (!pidMatch) return null;
  const pid = pidMatch[1]!;
  const command = pidMatch[2]!;
  const executablePath = extractExecutablePath(command);
  const base = basenameAnySep(executablePath);
  const isServer = LANGUAGE_SERVER_BASENAME_RE.test(base);
  const isCli = !isServer && AGY_BASENAME_RE.test(base);
  if (!isServer && !isCli) return null;
  if (!isCli && (!APP_MARKER_RE.test(command) || IDE_MARKER_RE.test(command))) return null;
  const csrf = flagValue(command, "--csrf_token");
  if (!isCli && !csrf) return null;
  const extPortRaw = flagValue(command, "--extension_server_port");
  const extPort = extPortRaw !== undefined && /^\d+$/.test(extPortRaw) ? Number(extPortRaw) : NaN;
  return {
    pid,
    cli: isCli,
    csrf,
    extPort: Number.isInteger(extPort) && extPort > 0 && extPort <= 65535 ? extPort : undefined,
  };
}

function isLoopbackOrWildcardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "[::1]"
    || normalized === "0.0.0.0"
    || normalized === "[::]"
    || normalized === "*"
    || normalized === "localhost";
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const colon = endpoint.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = endpoint.slice(0, colon);
  const portText = endpoint.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export function parseNetstatListeningPorts(stdout: string, pid: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP$/i.test(parts[0]!) || parts[parts.length - 1] !== pid) continue;
    const local = parts[1]!;
    const foreign = parts[2]!;
    const state = parts[3]!;
    if (NON_LISTENING_NETSTAT_STATE_RE.test(state)) continue;
    const isListening = /^LISTENING$/i.test(state) || foreign === "0.0.0.0:0" || foreign === "[::]:0";
    if (!isListening) continue;
    const endpoint = parseEndpoint(local);
    if (!endpoint || !isLoopbackOrWildcardHost(endpoint.host)) continue;
    ports.add(endpoint.port);
  }
  return [...ports];
}

export function parseLsofListeningPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!/\(LISTEN\)\s*$/.test(line)) continue;
    const match = line.match(/\bTCP\s+([^\s]+)\s+\(LISTEN\)\s*$/);
    if (!match) continue;
    const endpoint = parseEndpoint(match[1]!);
    if (!endpoint || !isLoopbackOrWildcardHost(endpoint.host)) continue;
    ports.add(endpoint.port);
  }
  return [...ports];
}

export function postLoopbackConnect(
  port: number,
  tls: boolean,
  pathName: string,
  body: string,
  csrf?: string,
  signal?: AbortSignal,
): Promise<{ status: number; text: string } | null> {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let settled = false;
    let gotResponse = false;
    let req: http.ClientRequest | undefined;
    const finish = (value: { status: number; text: string } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const abortReq = () => {
      if (settled) return;
      finish(null);
      try { req?.destroy(); } catch { /* ignore */ }
    };
    const onAbort = () => abortReq();
    signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(abortReq, LOCAL_TIMEOUT_MS);
    deadline.unref?.();

    try {
      req = (tls ? https : http).request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: pathName,
          ...(tls ? { rejectUnauthorized: false } : {}),
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            ...(csrf ? { "X-Codeium-Csrf-Token": csrf } : {}),
          },
          timeout: LOCAL_TIMEOUT_MS,
        },
        res => {
          gotResponse = true;
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on("data", (chunk: Buffer | string) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
            bytes += buf.length;
            if (bytes > MAX_RESPONSE_BYTES) {
              abortReq();
              return;
            }
            chunks.push(buf);
          });
          res.on("error", () => finish(null));
          res.on("aborted", () => finish(null));
          res.on("end", () => {
            if (!res.complete) {
              finish(null);
              return;
            }
            finish({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
          });
          res.on("close", () => {
            if (!res.complete) finish(null);
          });
        },
      );
    } catch {
      finish(null);
      return;
    }

    req.on("timeout", abortReq);
    req.on("error", () => finish(null));
    req.on("close", () => {
      if (!gotResponse) finish(null);
    });
    if (signal?.aborted) {
      abortReq();
      return;
    }
    req.end(body);
  });
}

function poolHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function parseIsoReset(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const iso = new Date(ms).toISOString();
    return Number.isFinite(Date.parse(iso)) ? iso : undefined;
  }
  // The Unix epoch means "no reset scheduled" (see account-quota.ts isoTime).
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) > 0) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function parseGroupModels(name: string, description: unknown): string[] {
  const listed = typeof description === "string"
    ? /^Models within this group:[ \t]*([^\x00-\x1f\x7f]+)$/.exec(description)?.[1]?.split(",").map(s => s.trim()).filter(Boolean)
    : undefined;
  return listed?.length && listed.length <= 32 && listed.every(s => s.length <= 120) ? listed : [name];
}

function inferWindowMeta(bucketId: string, displayName: string): { label: string; periodSeconds?: number } {
  const lower = `${bucketId} ${displayName}`.toLowerCase();
  if (lower.includes("5h") || lower.includes("five hour") || lower.includes("5 hour")) {
    return { label: "5 hours", periodSeconds: 18_000 };
  }
  if (lower.includes("week")) {
    return { label: "7 days", periodSeconds: 604_800 };
  }
  return { label: displayName.slice(0, 120) || bucketId.slice(0, 120) || "Quota" };
}

/** Decode Connect-RPC `RetrieveUserQuotaSummary` response into TaroBird `QuotaSnapshot`,
 * matching the exact group/window structure produced by `agy -p /usage --output-format json`. */
export function decodeAntigravityLocalSummary(body: unknown, now = Date.now()): QuotaSnapshot | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = body as Record<string, unknown>;
  const nested = data.response && typeof data.response === "object" ? data.response as Record<string, unknown> : data;
  if (!Array.isArray(nested.groups) || nested.groups.length === 0) return null;

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const pools: QuotaPool[] = [];

  for (const [groupIndex, rawGroup] of nested.groups.slice(0, 64).entries()) {
    if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
    const group = rawGroup as Record<string, unknown>;
    const name = typeof group.displayName === "string" ? group.displayName.trim()
      : typeof group.name === "string" ? group.name.trim() : "";
    if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) continue;
    if (!Array.isArray(group.buckets)) continue;

    const windows: QuotaWindow[] = [];
    for (const [bucketIndex, rawBucket] of group.buckets.slice(0, 32).entries()) {
      if (!rawBucket || typeof rawBucket !== "object" || Array.isArray(rawBucket)) continue;
      const bucket = rawBucket as Record<string, unknown>;
      const rawId = typeof bucket.bucketId === "string" ? bucket.bucketId.trim()
        : typeof bucket.id === "string" ? bucket.id.trim() : `bucket-${bucketIndex}`;
      const id = /^[a-zA-Z0-9_.:-]{1,128}$/.test(rawId) ? rawId : poolHash(`${rawId}:${bucketIndex}`);
      const displayName = typeof bucket.displayName === "string" ? bucket.displayName.trim()
        : typeof bucket.name === "string" ? bucket.name.trim() : rawId;
      const meta = inferWindowMeta(rawId, displayName);
      const remainingObj = bucket.remaining && typeof bucket.remaining === "object" ? bucket.remaining as Record<string, unknown> : undefined;
      const rem = bucket.remainingFraction ?? remainingObj?.remainingFraction;
      const reset = parseIsoReset(bucket.resetTime ?? remainingObj?.resetTime);
      const common = {
        id,
        label: meta.label,
        ...(meta.periodSeconds ? { periodSeconds: meta.periodSeconds } : {}),
        ...(reset ? { resetsAt: reset } : {}),
        availability: "unknown" as const,
        observedAt,
        expiresAt,
      };
      if (typeof rem === "number" && Number.isFinite(rem) && rem >= 0 && rem <= 1) {
        const usedPercent = Math.round((1 - rem) * 10_000) / 100;
        windows.push({ ...common, metric: "percent", usedPercent });
      } else {
        windows.push({ ...common, metric: "unknown" });
      }
    }

    if (windows.length > 0) {
      pools.push({
        id: poolHash(`${name}:${groupIndex}`),
        label: name,
        models: parseGroupModels(name, group.description),
        sharing: "model",
        availability: "unknown",
        windows,
        balances: [],
        constraints: [],
      });
    }
  }

  if (pools.length === 0) return null;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: "ready",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools,
    constraints: [],
    help: "antigravity_usage",
  };
  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

/** Decode legacy `GetUserStatus` flat model configs into TaroBird `QuotaSnapshot`. */
export function decodeAntigravityLocalStatus(body: unknown, now = Date.now()): QuotaSnapshot | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const userStatus = (body as Record<string, unknown>).userStatus;
  if (!userStatus || typeof userStatus !== "object") return null;
  const cascade = (userStatus as Record<string, unknown>).cascadeModelConfigData;
  if (!cascade || typeof cascade !== "object") return null;
  const configs = (cascade as Record<string, unknown>).clientModelConfigs;
  if (!Array.isArray(configs) || configs.length === 0) return null;

  const observedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + QUOTA_TTL_MS).toISOString();
  const pools: QuotaPool[] = [];

  for (const [index, raw] of configs.slice(0, 64).entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const cfg = raw as Record<string, unknown>;
    const name = typeof cfg.label === "string" && cfg.label.trim() ? cfg.label.trim()
      : typeof cfg.modelName === "string" ? cfg.modelName.trim() : "";
    if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) continue;
    const qi = cfg.quotaInfo && typeof cfg.quotaInfo === "object" ? cfg.quotaInfo as Record<string, unknown> : undefined;
    const rem = qi?.remainingFraction;
    if (typeof rem !== "number" || !Number.isFinite(rem) || rem < 0 || rem > 1) continue;
    const resetsAt = parseIsoReset(qi?.resetTime);
    const usedPercent = Math.round((1 - rem) * 10_000) / 100;
    pools.push({
      id: poolHash(`${name}:${index}`),
      label: name,
      models: [name],
      sharing: "model",
      availability: "unknown",
      windows: [{
        id: `status-${poolHash(`${name}:${index}`)}`,
        label: "Quota",
        metric: "percent",
        usedPercent,
        availability: "unknown",
        observedAt,
        expiresAt,
        ...(resetsAt ? { resetsAt } : {}),
      }],
      balances: [],
      constraints: [],
    });
  }

  if (pools.length === 0) return null;
  const snapshot: QuotaSnapshot = {
    authMode: "subscription",
    capability: { mode: "active" },
    state: "ready",
    availability: "unknown",
    observedAt,
    lastAttemptAt: observedAt,
    pools,
    constraints: [],
    help: "antigravity_usage",
  };
  const parsed = quotaSnapshotSchema.safeParse(snapshot);
  if (!parsed.success) throw new QuotaReadError("invalid_response");
  return parsed.data;
}

async function listListeningPorts(deps: AntigravityLocalProbeDeps, pid: string, signal?: AbortSignal): Promise<number[]> {
  if (signal?.aborted) return [];
  try {
    if (deps.platform === "win32") {
      const { stdout } = await deps.execFile("netstat.exe", ["-ano", "-p", "TCP"], signal);
      return parseNetstatListeningPorts(stdout, pid);
    }
    const { stdout } = await deps.execFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pid], signal);
    return parseLsofListeningPorts(stdout);
  } catch {
    return [];
  }
}

/** Probe only verified Bot-owned `agy` worker PIDs over loopback without spawning
 * a new `agy` process or scanning system-wide processes. Returns null when no
 * verified Bot-owned local server answers so the caller falls back to `agy -p /usage`. */
export async function probeAntigravityLocalServerQuota(options: {
  preferredPids?: readonly number[];
  signal?: AbortSignal;
  now?: () => number;
  deps?: Partial<AntigravityLocalProbeDeps>;
} = {}): Promise<QuotaSnapshot | null> {
  if (options.signal?.aborted) return null;
  const pids: string[] = [];
  const seen = new Set<string>();
  for (const pid of options.preferredPids ?? []) {
    if (Number.isInteger(pid) && pid > 0) {
      const id = String(pid);
      if (!seen.has(id)) {
        seen.add(id);
        pids.push(id);
      }
    }
  }
  if (pids.length === 0) return null;

  const now = options.now ?? Date.now;
  const deps: AntigravityLocalProbeDeps = {
    execFile: options.deps?.execFile ?? (async (file, args, execSignal) => {
      const res = await execFileAsync(file, args, {
        timeout: LOCAL_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        ...(execSignal ?? options.signal ? { signal: execSignal ?? options.signal } : {}),
      });
      return { stdout: String(res.stdout ?? "") };
    }),
    request: options.deps?.request ?? postLoopbackConnect,
    platform: options.deps?.platform ?? process.platform,
  };

  for (const pid of pids) {
    if (options.signal?.aborted) return null;
    const ports = await listListeningPorts(deps, pid, options.signal);
    if (options.signal?.aborted) return null;
    for (const port of ports) {
      if (options.signal?.aborted) return null;
      for (const tls of [false, true]) {
        if (options.signal?.aborted) return null;
        const summaryRes = await deps.request(port, tls, SUMMARY_PATH, "{}", undefined, options.signal);
        if (options.signal?.aborted) return null;
        if (summaryRes?.status === 200) {
          try {
            const snapshot = decodeAntigravityLocalSummary(JSON.parse(summaryRes.text), now());
            if (snapshot) return snapshot;
          } catch { /* try next */ }
        }
        if (options.signal?.aborted) return null;
        const statusRes = await deps.request(port, tls, STATUS_PATH, "{}", undefined, options.signal);
        if (options.signal?.aborted) return null;
        if (statusRes?.status === 200) {
          try {
            const snapshot = decodeAntigravityLocalStatus(JSON.parse(statusRes.text), now());
            if (snapshot) return snapshot;
          } catch { /* try next */ }
        }
      }
    }
  }
  return null;
}
