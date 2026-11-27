import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  hostResourcesSnapshotSchema,
  type HostResourceStopRequest,
  type HostResourceStopResult,
  type HostResourcesSnapshot,
  type ResourceBotGroup,
  type ResourceConversationGroup,
  type ResourceProcess,
  type ResourceSparklinePoint,
} from "../client-protocol/host-resources.js";
import { isRunActive, anyRun, runSummarySchema } from "../client-protocol/run.js";
import { killProcessTree } from "../codex/process-tree.js";
import { HubError, type HubStore } from "./store.js";

const execFileAsync = promisify(execFile);
const HISTORY_LIMIT = 24;
const MAX_HISTORY_USERS = 128;
const MIN_HISTORY_INTERVAL_MS = 1_500;
const DEFAULT_SAMPLE_CACHE_TTL_MS = 2_500;
const MAX_SELF_PROCESSES = 32;
const MAX_BOT_GROUPS = 128;
const MAX_CONVERSATIONS_PER_BOT = 64;
const MAX_PROCESSES_PER_GROUP = 64;
const MAX_UNATTRIBUTED_PROCESSES = 64;
const MAX_PROCESS_ID_LEN = 200;
const MAX_PROCESS_NAME_LEN = 160;
const MAX_BOT_NAME_LEN = 120;
const MAX_ENGINE_LEN = 48;
const MAX_TITLE_LEN = 256;
const MAX_PLATFORM_LEN = 32;

const ACTIVE_RUN_PHASES = runSummarySchema.shape.phase.options.filter(isRunActive);

// Desktop App process matchers:
// - DIRECT_PARENT_APP_RE applies only when a process directly spawned this Hub (dev/Electron launches).
// - DESKTOP_APP_NAME_RE matches packaged TaroBird desktop binaries even when the Hub is detached (ppid=1),
//   without matching unrelated Electron apps or `tarobot-host` processes.
const DIRECT_PARENT_APP_RE = /^(?:electron|tarobird|tarobot|tarocub-client)(?:[\s.-]|$)/i;
const DIRECT_PARENT_CHILD_RE = /electron|helper|renderer|gpu|utility|network|crashpad|tarobird|tarobot|tarocub-client/i;
const DESKTOP_APP_NAME_RE = /^(?:tarocub-client(?:\.exe)?|tarobird(?:\.exe)?|tarobird\s+helper(?:\b.*)?|tarocub-client\s+helper(?:\b.*)?|tarobot-desktop(?:-core)?(?:\.exe)?)$/i;

export interface OsProcessSample {
  pid: number;
  ppid: number;
  cpuPercent: number;
  memoryBytes: number;
  name: string;
}

export interface HostResourcesOptions {
  store: HubStore;
  hubPid?: number;
  desktopAppPid?: number | (() => number | undefined);
  platform?: NodeJS.Platform;
  childPids: () => Map<string, number>;
  /** Optional exact PID linkage (`conversationId -> root child PIDs`) for a Bot with multiple concurrent turns. */
  turnPids?: (botId: string) => ReadonlyMap<string, readonly number[]> | undefined;
  stopBotTurn: (botId: string, conversationId: string, userId: string) => Promise<boolean>;
  sampleProcesses?: () => Promise<OsProcessSample[]>;
  killPid?: (pid: number) => Promise<void>;
  sampleCacheTtlMs?: number;
  now?: () => number;
}

function roundCpu(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 10) / 10 : 0;
}

function clampString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function makeProcessId(prefix: string, parts: readonly (string | number)[]): string {
  const raw = [prefix, ...parts].join(":");
  if (raw.length <= MAX_PROCESS_ID_LEN) return raw;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const tail = String(parts[parts.length - 1] ?? "");
  return clampString(`${prefix}:${digest}:${tail}`, MAX_PROCESS_ID_LEN);
}

function sortProcessesByUsage(processes: readonly ResourceProcess[]): ResourceProcess[] {
  return [...processes].sort((a, b) =>
    b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.pid - b.pid,
  );
}

function sortConversationsByUsage(conversations: readonly ResourceConversationGroup[]): ResourceConversationGroup[] {
  return [...conversations].sort((a, b) =>
    b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.title.localeCompare(b.title),
  );
}

function sortBotsByUsage(bots: readonly ResourceBotGroup[]): ResourceBotGroup[] {
  return [...bots].sort((a, b) =>
    b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || b.activeTurns - a.activeTurns || a.botName.localeCompare(b.botName),
  );
}

export function sanitizeProcessName(raw: string): string {
  const trimmed = raw.trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (!trimmed) return "process";
  const withoutTrailingSep = trimmed.replace(/[\\/]+$/, "");
  if (!withoutTrailingSep) return "process";
  const lastSep = Math.max(withoutTrailingSep.lastIndexOf("/"), withoutTrailingSep.lastIndexOf("\\"));
  const base = (lastSep >= 0 ? withoutTrailingSep.slice(lastSep + 1) : withoutTrailingSep).trim();
  return clampString(base, 120) || "process";
}

export function buildWindowsProcessSampleScript(): string {
  // Keep strictly compatible with Windows PowerShell 5.1 (no PS7-only operators like `??` or `&&`).
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "$procs = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize",
    "$perf = @{}; Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { if ($null -ne $_.IDProcess) { $perf[[int]$_.IDProcess] = [double]$_.PercentProcessorTime } }",
    "$out = foreach ($p in $procs) { $id = [int]$p.ProcessId; $cpu = if ($perf.ContainsKey($id)) { $perf[$id] } else { 0 }; [pscustomobject]@{ ProcessId=$id; ParentProcessId=[int]$p.ParentProcessId; Name=$p.Name; WorkingSetSize=[double]$p.WorkingSetSize; CpuPercent=$cpu } }",
    "$out | ConvertTo-Json -Compress",
  ].join("; ");
}

export function parsePosixPsOutput(stdout: string): OsProcessSample[] {
  const result: OsProcessSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([0-9]+(?:[.,][0-9]+)?)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpu = Number(match[3]!.replace(",", "."));
    const rssKb = Number(match[4]);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid < 0) continue;
    result.push({
      pid,
      ppid,
      cpuPercent: roundCpu(cpu),
      memoryBytes: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      name: sanitizeProcessName(match[5]!),
    });
  }
  return result;
}

export function parseWindowsProcessJson(stdout: string): OsProcessSample[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const result: OsProcessSample[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pid = Number(row.ProcessId ?? row.Id ?? row.pid);
    const ppid = Number(row.ParentProcessId ?? row.ppid ?? 0);
    const cpu = Number(row.CpuPercent ?? row.cpuPercent ?? 0);
    const mem = Number(row.WorkingSetSize ?? row.WorkingSet64 ?? row.memoryBytes ?? 0);
    const name = typeof row.Name === "string" ? row.Name : typeof row.ProcessName === "string" ? row.ProcessName : "process";
    if (!Number.isInteger(pid) || pid <= 0) continue;
    result.push({
      pid,
      ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
      cpuPercent: roundCpu(cpu),
      memoryBytes: Number.isFinite(mem) && mem > 0 ? mem : 0,
      name: sanitizeProcessName(name),
    });
  }
  return result;
}

async function sampleOsProcesses(platform: NodeJS.Platform): Promise<OsProcessSample[]> {
  if (platform === "win32") {
    const script = buildWindowsProcessSampleScript();
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 4000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const rows = parseWindowsProcessJson(stdout);
      if (rows.length) return rows;
    } catch { /* Fall back to self memory sample below. */ }
    return [{ pid: process.pid, ppid: process.ppid, cpuPercent: 0, memoryBytes: process.memoryUsage().rss, name: "node" }];
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,%cpu=,rss=,comm="], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    const rows = parsePosixPsOutput(stdout);
    if (rows.length) return rows;
  } catch { /* Fall back to self memory sample below. */ }
  return [{ pid: process.pid, ppid: process.ppid, cpuPercent: 0, memoryBytes: process.memoryUsage().rss, name: "node" }];
}

function collectDescendants(
  rootPid: number,
  byParent: Map<number, OsProcessSample[]>,
  stopAtPids?: ReadonlySet<number>,
): OsProcessSample[] {
  const result: OsProcessSample[] = [];
  const visited = new Set<number>([rootPid]);
  const queue = [...(byParent.get(rootPid) ?? [])];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.pid) || stopAtPids?.has(current.pid)) continue;
    visited.add(current.pid);
    result.push(current);
    const children = byParent.get(current.pid);
    if (children) queue.push(...children);
  }
  return result;
}

interface ActiveConversationTurn {
  botId: string;
  conversationId: string;
  startedAt: number;
}

interface UserHistoryBucket {
  points: ResourceSparklinePoint[];
  lastSampleAt: number;
}

interface CachedProcessSample {
  samples: OsProcessSample[];
  sampledAt: number;
  generation: number;
}

interface InflightProcessSample {
  promise: Promise<CachedProcessSample>;
  generation: number;
}

export class HubHostResources {
  private readonly histories = new Map<string, UserHistoryBucket>();
  private sampleCache?: CachedProcessSample;
  private inflightSample?: InflightProcessSample;
  private sampleGeneration = 0;

  constructor(private readonly options: HostResourcesOptions) {}

  private currentTime(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private invalidateSampleCache(): void {
    this.sampleGeneration += 1;
    this.sampleCache = undefined;
  }

  /**
   * Short-TTL cache + single-flight request coalescing for OS process sampling.
   * Raw process samples are shared across concurrent/repeated readers while all
   * per-user filtering, Bot/conversation authorization, and history stay isolated.
   */
  private async readProcessSamples(bypassCache: boolean): Promise<CachedProcessSample> {
    const ttlMs = this.options.sampleCacheTtlMs ?? DEFAULT_SAMPLE_CACHE_TTL_MS;
    const now = this.currentTime();
    if (
      !bypassCache
      && ttlMs > 0
      && this.sampleCache
      && this.sampleCache.generation === this.sampleGeneration
      && now - this.sampleCache.sampledAt < ttlMs
    ) {
      return this.sampleCache;
    }
    if (this.inflightSample && this.inflightSample.generation === this.sampleGeneration) {
      return this.inflightSample.promise;
    }
    const generation = this.sampleGeneration;
    const platform = this.options.platform ?? process.platform;
    const samplePromise = (this.options.sampleProcesses ?? (() => sampleOsProcesses(platform)))();
    const entry: InflightProcessSample = {
      generation,
      promise: samplePromise.then((samples) => {
        const result: CachedProcessSample = { samples, sampledAt: this.currentTime(), generation };
        if (this.sampleGeneration === generation) {
          this.sampleCache = result;
        }
        return result;
      }).finally(() => {
        if (this.inflightSample === entry) {
          this.inflightSample = undefined;
        }
      }),
    };
    this.inflightSample = entry;
    return entry.promise;
  }

  private resolveDesktopAppPid(): number | undefined {
    const configured = typeof this.options.desktopAppPid === "function"
      ? this.options.desktopAppPid()
      : this.options.desktopAppPid;
    if (typeof configured === "number" && Number.isInteger(configured) && configured > 0) return configured;
    const rawEnv = process.env.TAROBIRD_DESKTOP_PID;
    if (rawEnv) {
      const parsed = Number(rawEnv);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }

  private historyBucket(userId: string): UserHistoryBucket {
    let bucket = this.histories.get(userId);
    if (!bucket) {
      if (this.histories.size >= MAX_HISTORY_USERS) {
        const oldestKey = this.histories.keys().next().value;
        if (oldestKey !== undefined) this.histories.delete(oldestKey);
      }
      bucket = { points: [], lastSampleAt: 0 };
      this.histories.set(userId, bucket);
    }
    return bucket;
  }

  private async allActiveTurns(): Promise<ActiveConversationTurn[]> {
    const rows = await this.options.store.db.serial(() => this.options.store.db.all<{
      conversation_id: string;
      author_id: string;
      status: string;
      blocks_json: string;
      created_at: number;
    }>(
      "SELECT conversation_id, author_id, status, blocks_json, created_at FROM messages WHERE author_type='bot' AND status IN ('pending','streaming') ORDER BY created_at ASC LIMIT 256",
    ));
    const seen = new Set<string>();
    const turns: ActiveConversationTurn[] = [];
    for (const row of rows) {
      let active = row.status === "pending" || row.status === "streaming";
      let startedAt = row.created_at;
      try {
        const blocks = JSON.parse(row.blocks_json) as unknown[];
        for (const block of blocks) {
          if (!block || typeof block !== "object" || (block as { type?: string }).type !== "card") continue;
          const run = anyRun(block as Parameters<typeof anyRun>[0]);
          if (run) {
            active = ACTIVE_RUN_PHASES.includes(run.phase);
            if (run.startedAt) startedAt = run.startedAt;
          }
        }
      } catch { /* Keep status-based activity */ }
      if (!active) continue;
      const key = `${row.author_id}\0${row.conversation_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      turns.push({
        botId: row.author_id,
        conversationId: row.conversation_id,
        startedAt,
      });
    }
    return turns;
  }

  async snapshot(userId: string, canStop: boolean, force = false): Promise<HostResourcesSnapshot> {
    const isOwner = canStop;
    const allowForce = isOwner && force;
    const platform = this.options.platform ?? process.platform;
    const hubPid = this.options.hubPid ?? process.pid;
    const [sampleResult, bots, conversations, activeTurnsAll] = await Promise.all([
      this.readProcessSamples(allowForce),
      this.options.store.bots(userId),
      this.options.store.conversations(userId),
      this.allActiveTurns(),
    ]);
    const samples = sampleResult.samples;

    const byPid = new Map<number, OsProcessSample>();
    const byParent = new Map<number, OsProcessSample[]>();
    for (const sample of samples) {
      byPid.set(sample.pid, sample);
      const list = byParent.get(sample.ppid);
      if (list) list.push(sample);
      else byParent.set(sample.ppid, [sample]);
    }

    const conversationIds = new Set(conversations.map((c) => c.id));
    const conversationTitles = new Map(conversations.map((c) => [c.id, clampString(c.title, MAX_TITLE_LEN)]));
    const activeTurnsByBot = new Map<string, ActiveConversationTurn[]>();
    for (const turn of activeTurnsAll) {
      const list = activeTurnsByBot.get(turn.botId);
      if (list) list.push(turn);
      else activeTurnsByBot.set(turn.botId, [turn]);
    }

    const botPids = this.options.childPids();
    // Always track ALL managed Bot gateway trees regardless of userId so ungranted Bots
    // can never leak into `unattributed` or desktop App process trees.
    const allManagedBotTreePids = new Set<number>();
    for (const gatewayPid of botPids.values()) {
      allManagedBotTreePids.add(gatewayPid);
      for (const proc of collectDescendants(gatewayPid, byParent)) {
        allManagedBotTreePids.add(proc.pid);
      }
    }

    const visibleBots = bots.filter((b) => !b.deletedAt);
    const ownedPids = new Set<number>();

    const hostSample = byPid.get(hubPid) ?? {
      pid: hubPid,
      ppid: process.ppid,
      cpuPercent: 0,
      memoryBytes: process.memoryUsage().rss,
      name: "tarobot-host",
    };
    ownedPids.add(hostSample.pid);

    const hostProcess: ResourceProcess = {
      id: makeProcessId("host", [hostSample.pid]),
      pid: hostSample.pid,
      ppid: hostSample.ppid,
      name: "TaroBird Host",
      kind: "host",
      cpuPercent: roundCpu(hostSample.cpuPercent),
      memoryBytes: hostSample.memoryBytes,
      stoppable: false,
    };

    // Detect local desktop App (Electron main/renderer/helpers), whether it directly
    // spawned this Hub or runs alongside a detached Hub (ppid=1) as `tarocub-client` / `TaroBird`.
    const appStopPids = new Set<number>([hostSample.pid, ...allManagedBotTreePids]);
    const appProcesses: ResourceProcess[] = [];
    const addAppProcess = (sample: OsProcessSample, displayName?: string) => {
      if (ownedPids.has(sample.pid) || allManagedBotTreePids.has(sample.pid)) return;
      ownedPids.add(sample.pid);
      appProcesses.push({
        id: makeProcessId("app", [sample.pid]),
        pid: sample.pid,
        ppid: sample.ppid,
        name: clampString(displayName ?? sample.name, MAX_PROCESS_NAME_LEN) || "TaroBird App",
        kind: "app",
        cpuPercent: roundCpu(sample.cpuPercent),
        memoryBytes: sample.memoryBytes,
        stoppable: false,
      });
    };

    const addAppTree = (root: OsProcessSample, filterChildrenByName: boolean) => {
      if (ownedPids.has(root.pid) || allManagedBotTreePids.has(root.pid)) return;
      addAppProcess(root, appProcesses.length === 0 ? "TaroBird App" : root.name);
      for (const child of collectDescendants(root.pid, byParent, appStopPids)) {
        if (filterChildrenByName && !DIRECT_PARENT_CHILD_RE.test(child.name)) continue;
        addAppProcess(child);
      }
    };

    const explicitDesktopPid = this.resolveDesktopAppPid();
    if (explicitDesktopPid) {
      const explicitRoot = byPid.get(explicitDesktopPid);
      if (explicitRoot) addAppTree(explicitRoot, false);
    }

    const parentSample = hostSample.ppid > 1 ? byPid.get(hostSample.ppid) : undefined;
    if (parentSample && DIRECT_PARENT_APP_RE.test(parentSample.name)) {
      addAppTree(parentSample, !DESKTOP_APP_NAME_RE.test(parentSample.name));
    }

    const matchedAppSamples = samples.filter(
      (sample) => !ownedPids.has(sample.pid) && !allManagedBotTreePids.has(sample.pid) && DESKTOP_APP_NAME_RE.test(sample.name),
    );
    const matchedAppPids = new Set(matchedAppSamples.map((sample) => sample.pid));
    for (const candidate of matchedAppSamples) {
      if (!matchedAppPids.has(candidate.ppid)) {
        addAppTree(candidate, false);
      }
    }
    for (const candidate of matchedAppSamples) {
      addAppProcess(candidate);
    }

    const allSelfProcesses: ResourceProcess[] = [hostProcess, ...appProcesses];
    const hostCpu = roundCpu(hostProcess.cpuPercent);
    const hostMem = hostProcess.memoryBytes;
    const appCpu = roundCpu(appProcesses.reduce((s, p) => s + p.cpuPercent, 0));
    const appMem = appProcesses.reduce((s, p) => s + p.memoryBytes, 0);
    const cappedSelfProcesses: ResourceProcess[] = [
      hostProcess,
      ...sortProcessesByUsage(appProcesses).slice(0, MAX_SELF_PROCESSES - 1),
    ];

    const allBotGroups: ResourceBotGroup[] = [];
    let totalBotProcessCount = 0;
    let totalVisibleActiveTasks = 0;

    for (const bot of visibleBots) {
      const gatewayPid = botPids.get(bot.id);
      const gatewaySample = gatewayPid ? byPid.get(gatewayPid) : undefined;
      const allTurns = activeTurnsByBot.get(bot.id) ?? [];
      const visibleTurns = allTurns.filter((turn) => conversationIds.has(turn.conversationId));
      const hasHiddenTurns = allTurns.length > visibleTurns.length;
      if (!gatewaySample && !visibleTurns.length && !bot.online) continue;

      const descendants = gatewayPid ? collectDescendants(gatewayPid, byParent) : [];
      if (gatewayPid) ownedPids.add(gatewayPid);
      for (const proc of descendants) ownedPids.add(proc.pid);

      const safeBotName = clampString(bot.name, MAX_BOT_NAME_LEN);
      const safeEngine = clampString(bot.engine, MAX_ENGINE_LEN);
      const convGroups: ResourceConversationGroup[] = [];
      const botUnattributed: ResourceProcess[] = [];

      const buildTurnProcess = (turn: ActiveConversationTurn, title: string, proc: OsProcessSample): ResourceProcess => ({
        id: makeProcessId("engine", [bot.id, turn.conversationId, proc.pid]),
        pid: proc.pid,
        ppid: proc.ppid,
        name: clampString(proc.name, MAX_PROCESS_NAME_LEN) || "process",
        kind: "engine",
        cpuPercent: roundCpu(proc.cpuPercent),
        memoryBytes: proc.memoryBytes,
        botId: bot.id,
        botName: safeBotName,
        engine: safeEngine,
        conversationId: turn.conversationId,
        conversationTitle: title,
        startedAt: turn.startedAt,
        stoppable: canStop,
      });

      const buildBotEngineProcess = (tag: string, proc: OsProcessSample): ResourceProcess => ({
        id: makeProcessId("engine", [bot.id, tag, proc.pid]),
        pid: proc.pid,
        ppid: proc.ppid,
        name: clampString(proc.name, MAX_PROCESS_NAME_LEN) || "process",
        kind: "engine",
        cpuPercent: roundCpu(proc.cpuPercent),
        memoryBytes: proc.memoryBytes,
        botId: bot.id,
        botName: safeBotName,
        engine: safeEngine,
        stoppable: canStop,
      });

      if (gatewaySample) {
        botUnattributed.push({
          id: makeProcessId("gateway", [bot.id, gatewaySample.pid]),
          pid: gatewaySample.pid,
          ppid: gatewaySample.ppid,
          name: clampString(`${safeEngine || "bot"} gateway`, MAX_PROCESS_NAME_LEN),
          kind: "gateway",
          cpuPercent: roundCpu(gatewaySample.cpuPercent),
          memoryBytes: gatewaySample.memoryBytes,
          botId: bot.id,
          botName: safeBotName,
          engine: safeEngine,
          stoppable: false,
        });
      }

      let botProcessCount = gatewaySample ? 1 : 0;

      if (allTurns.length === 1) {
        const turn = allTurns[0]!;
        if (conversationIds.has(turn.conversationId)) {
          const title = conversationTitles.get(turn.conversationId) ?? clampString(turn.conversationId, MAX_TITLE_LEN);
          const allTurnProcesses = descendants.map((proc) => buildTurnProcess(turn, title, proc));
          botProcessCount += allTurnProcesses.length;
          convGroups.push({
            conversationId: turn.conversationId,
            title,
            active: true,
            cpuPercent: roundCpu(allTurnProcesses.reduce((sum, p) => sum + p.cpuPercent, 0)),
            memoryBytes: allTurnProcesses.reduce((sum, p) => sum + p.memoryBytes, 0),
            stoppable: canStop,
            processes: sortProcessesByUsage(allTurnProcesses).slice(0, MAX_PROCESSES_PER_GROUP),
          });
        } else if (isOwner) {
          for (const proc of descendants) {
            botUnattributed.push(buildBotEngineProcess("unattributed", proc));
          }
          botProcessCount += descendants.length;
        }
        // When `!isOwner` and the single active turn belongs to another user,
        // omit its engine/tool descendants entirely so private activity never leaks.
      } else if (allTurns.length > 1) {
        // Never blindly assign `directChildren[index]` to `allTurns[index]`: persistent
        // shared workers (Codex app-server, Claude stream, Pi RPC, DeepSeek harness),
        // helper subprocesses, and PID wraparound make positional matching inaccurate
        // and unsafe across members. Attribute per-conversation PIDs ONLY when exact
        // `turnPids` linkage is available; otherwise keep each active conversation
        // individually stoppable and group shared engine processes under the Bot.
        const descendantPidSet = new Set(descendants.map((proc) => proc.pid));
        const rawTurnPids = this.options.turnPids?.(bot.id);
        const claimedRootsByTurn = new Map<string, number[]>();
        const allClaimedRoots = new Set<number>();
        if (rawTurnPids && rawTurnPids.size > 0) {
          for (const turn of allTurns) {
            const linked = rawTurnPids.get(turn.conversationId);
            if (!linked?.length) continue;
            const roots: number[] = [];
            for (const pid of linked) {
              if (!descendantPidSet.has(pid) || allClaimedRoots.has(pid)) continue;
              allClaimedRoots.add(pid);
              roots.push(pid);
            }
            if (roots.length) claimedRootsByTurn.set(turn.conversationId, roots);
          }
        }

        const assignedPids = new Set<number>();
        for (const turn of allTurns) {
          const roots = claimedRootsByTurn.get(turn.conversationId) ?? [];
          const tree: OsProcessSample[] = [];
          const treeSeen = new Set<number>();
          for (const rootPid of roots) {
            const rootSample = byPid.get(rootPid);
            if (!rootSample || treeSeen.has(rootSample.pid)) continue;
            treeSeen.add(rootSample.pid);
            tree.push(rootSample);
            for (const child of collectDescendants(rootSample.pid, byParent, allClaimedRoots)) {
              if (treeSeen.has(child.pid)) continue;
              treeSeen.add(child.pid);
              tree.push(child);
            }
          }
          for (const proc of tree) assignedPids.add(proc.pid);

          if (conversationIds.has(turn.conversationId)) {
            const title = conversationTitles.get(turn.conversationId) ?? clampString(turn.conversationId, MAX_TITLE_LEN);
            const allTurnProcesses = tree.map((proc) => buildTurnProcess(turn, title, proc));
            botProcessCount += allTurnProcesses.length;
            convGroups.push({
              conversationId: turn.conversationId,
              title,
              active: true,
              cpuPercent: roundCpu(allTurnProcesses.reduce((sum, p) => sum + p.cpuPercent, 0)),
              memoryBytes: allTurnProcesses.reduce((sum, p) => sum + p.memoryBytes, 0),
              stoppable: canStop,
              processes: sortProcessesByUsage(allTurnProcesses).slice(0, MAX_PROCESSES_PER_GROUP),
            });
          } else if (isOwner) {
            for (const proc of tree) {
              botUnattributed.push(buildBotEngineProcess("unattributed", proc));
            }
            botProcessCount += tree.length;
          }
        }

        // Unlinked/shared engine descendants remain grouped at the Bot level for owners
        // or when every active turn on this Bot belongs to the requesting user. When a
        // non-owner shares a Bot with hidden turns, omit unlinked engine processes so
        // another user's private activity never leaks.
        if (isOwner || !hasHiddenTurns) {
          for (const proc of descendants) {
            if (assignedPids.has(proc.pid)) continue;
            botUnattributed.push(buildBotEngineProcess("unattributed", proc));
            botProcessCount += 1;
          }
        }
      } else {
        // Idle persistent engine workers (e.g., Codex app-server / Claude stream / Pi RPC)
        for (const proc of descendants) {
          botUnattributed.push(buildBotEngineProcess("idle", proc));
        }
        botProcessCount += descendants.length;
      }

      const botCpu = roundCpu(
        convGroups.reduce((s, c) => s + c.cpuPercent, 0) + botUnattributed.reduce((s, p) => s + p.cpuPercent, 0),
      );
      const botMem = convGroups.reduce((s, c) => s + c.memoryBytes, 0) + botUnattributed.reduce((s, p) => s + p.memoryBytes, 0);

      totalBotProcessCount += botProcessCount;
      totalVisibleActiveTasks += visibleTurns.length;

      allBotGroups.push({
        botId: bot.id,
        botName: safeBotName,
        engine: safeEngine,
        online: Boolean(bot.online),
        ...(gatewayPid ? { gatewayPid } : {}),
        cpuPercent: botCpu,
        memoryBytes: botMem,
        activeTurns: visibleTurns.length,
        conversations: sortConversationsByUsage(convGroups).slice(0, MAX_CONVERSATIONS_PER_BOT),
        unattributed: sortProcessesByUsage(botUnattributed).slice(0, MAX_PROCESSES_PER_GROUP),
      });
    }

    // Any remaining descendants of the Hub not attributed to any managed Bot gateway.
    // Only visible to Host owners; managed Bot trees are always excluded regardless of userId.
    const allUnattributed: ResourceProcess[] = [];
    if (isOwner) {
      for (const proc of collectDescendants(hubPid, byParent)) {
        if (ownedPids.has(proc.pid) || allManagedBotTreePids.has(proc.pid)) continue;
        ownedPids.add(proc.pid);
        allUnattributed.push({
          id: makeProcessId("unattributed", [proc.pid]),
          pid: proc.pid,
          ppid: proc.ppid,
          name: clampString(proc.name, MAX_PROCESS_NAME_LEN) || "process",
          kind: "unattributed",
          cpuPercent: roundCpu(proc.cpuPercent),
          memoryBytes: proc.memoryBytes,
          stoppable: false,
        });
      }
    }

    const engineCpu = roundCpu(allBotGroups.reduce((s, b) => s + b.cpuPercent, 0) + allUnattributed.reduce((s, p) => s + p.cpuPercent, 0));
    const engineMem = allBotGroups.reduce((s, b) => s + b.memoryBytes, 0) + allUnattributed.reduce((s, p) => s + p.memoryBytes, 0);
    const totalCpu = roundCpu(hostCpu + appCpu + engineCpu);
    const totalMem = hostMem + appMem + engineMem;
    const now = this.currentTime();

    const bucket = this.historyBucket(userId);
    if (allowForce || !bucket.points.length || now - bucket.lastSampleAt >= MIN_HISTORY_INTERVAL_MS) {
      bucket.lastSampleAt = now;
      bucket.points.push({ at: now, cpuPercent: totalCpu, memoryBytes: totalMem });
      while (bucket.points.length > HISTORY_LIMIT) bucket.points.shift();
    }

    const processCount = allSelfProcesses.length + totalBotProcessCount + allUnattributed.length;

    return hostResourcesSnapshotSchema.parse({
      v: 1,
      sampledAt: sampleResult.sampledAt,
      platform: clampString(platform, MAX_PLATFORM_LEN) || "unknown",
      canStop,
      summary: {
        totalCpuPercent: totalCpu,
        totalMemoryBytes: totalMem,
        hostCpuPercent: hostCpu,
        hostMemoryBytes: hostMem,
        appCpuPercent: appCpu,
        appMemoryBytes: appMem,
        engineCpuPercent: engineCpu,
        engineMemoryBytes: engineMem,
        activeTasks: totalVisibleActiveTasks,
        processCount,
      },
      history: [...bucket.points],
      selfProcesses: cappedSelfProcesses,
      bots: sortBotsByUsage(allBotGroups).slice(0, MAX_BOT_GROUPS),
      unattributed: sortProcessesByUsage(allUnattributed).slice(0, MAX_UNATTRIBUTED_PROCESSES),
    });
  }

  async stop(userId: string, request: HostResourceStopRequest, beforeAction?: () => Promise<void>): Promise<HostResourceStopResult> {
    if (request.conversationId) {
      const conversations = await this.options.store.conversations(userId);
      const conversation = conversations.find((c) => c.id === request.conversationId);
      if (!conversation || !conversation.botIds.includes(request.botId)) {
        throw new HubError("bot_forbidden", 403);
      }
      await beforeAction?.();
      // Graceful conversation turn stop never falls through to `killProcessTree`:
      // persistent engine workers (Codex app-server, Claude, Pi RPC, ACP) may serve other active runs.
      const stopped = await this.options.stopBotTurn(request.botId, request.conversationId, userId);
      this.invalidateSampleCache();
      await this.options.store.audit("host_resources.stopped", userId, {
        botId: request.botId,
        conversationId: request.conversationId,
        method: "turn_stop",
        stopped,
      });
      return { ok: true, stopped, method: "turn_stop" };
    }

    if (!request.pid) {
      throw new HubError("invalid_request", 400);
    }

    // Security boundary: only terminate a verified descendant of this Bot's gateway.
    const gatewayPid = this.options.childPids().get(request.botId);
    if (!gatewayPid || request.pid === gatewayPid || request.pid === (this.options.hubPid ?? process.pid)) {
      throw new HubError("resource_process_not_owned", 403);
    }
    this.invalidateSampleCache();
    const { samples } = await this.readProcessSamples(true);
    const byParent = new Map<number, OsProcessSample[]>();
    for (const sample of samples) {
      const list = byParent.get(sample.ppid);
      if (list) list.push(sample);
      else byParent.set(sample.ppid, [sample]);
    }
    const descendants = collectDescendants(gatewayPid, byParent);
    if (!descendants.some((p) => p.pid === request.pid)) {
      throw new HubError("resource_process_not_owned", 403);
    }
    await beforeAction?.();
    if (this.options.killPid) {
      await this.options.killPid(request.pid);
    } else {
      await killProcessTree(request.pid);
    }
    this.invalidateSampleCache();
    await this.options.store.audit("host_resources.stopped", userId, {
      botId: request.botId,
      pid: request.pid,
      method: "process_tree",
    });
    return { ok: true, stopped: true, method: "process_tree" };
  }
}
