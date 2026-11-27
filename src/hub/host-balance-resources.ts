import os from "node:os";
import { hostBalanceResourcesSchema, type HostBalanceResources } from "../client-protocol/host-balance-resources.js";
import type { HubStore } from "./store.js";

export interface CpuTotals {
  busy: number;
  total: number;
}

export interface CpuSamplerState {
  previousTotals?: CpuTotals;
  lastDeltaSample?: { percent: number; at: number };
}

export interface HostBalanceSamplerOptions {
  cpus?: () => os.CpuInfo[];
  loadavg?: () => number[];
  totalmem?: () => number;
  availableMemory?: () => number | undefined;
  freemem?: () => number;
  delay?: (ms: number) => Promise<void>;
  sampleWindowMs?: number;
  now?: () => number;
  state?: CpuSamplerState;
}

const DEFAULT_CPU_SAMPLE_WINDOW_MS = 100;
const DELTA_CACHE_TTL_MS = 2_000;
const defaultSamplerState: CpuSamplerState = {};

export function sumCpuTimes(cpus: readonly Pick<os.CpuInfo, "times">[]): CpuTotals {
  let busy = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    const sum = t.user + t.nice + t.sys + t.irq + t.idle;
    busy += sum - t.idle;
    total += sum;
  }
  return { busy, total };
}

export function computeCpuDeltaPercent(previous: CpuTotals, next: CpuTotals): number | undefined {
  const totalDelta = next.total - previous.total;
  const busyDelta = next.busy - previous.busy;
  if (totalDelta <= 0 || busyDelta < 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((busyDelta / totalDelta) * 100)));
}

function defaultAvailableMemory(): number | undefined {
  const proc = process as NodeJS.Process & { availableMemory?: () => number };
  if (typeof proc.availableMemory !== "function") return undefined;
  try {
    const value = proc.availableMemory();
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readAvailableMemoryBytes(
  totalBytes: number,
  availableMemory: () => number | undefined = defaultAvailableMemory,
  freemem: () => number = os.freemem,
): number {
  const rawAvailable = availableMemory();
  const raw = rawAvailable !== undefined && Number.isFinite(rawAvailable) && rawAvailable >= 0
    ? rawAvailable
    : freemem();
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(totalBytes, Math.floor(raw)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sampleCpuPercent(
  cores: number,
  loadAvg1m: number,
  initialCpus: readonly os.CpuInfo[],
  options: Required<Pick<HostBalanceSamplerOptions, "cpus" | "delay" | "sampleWindowMs" | "now" | "state">>,
): Promise<number> {
  if (cores <= 0) return 0;
  const currentTotals = sumCpuTimes(initialCpus);

  // On POSIX, loadavg[0] / cores gives a smooth 1-minute utilization estimate.
  if (loadAvg1m > 0) {
    options.state.previousTotals = currentTotals;
    return Math.min(100, Math.max(0, Math.round((loadAvg1m / cores) * 100)));
  }

  // On Windows (where os.loadavg() is always [0, 0, 0]) or idle POSIX hosts with 0.00 load,
  // compute live utilization from deltas between os.cpus() snapshots rather than since-boot totals.
  const now = options.now();
  if (options.state.previousTotals) {
    const delta = computeCpuDeltaPercent(options.state.previousTotals, currentTotals);
    options.state.previousTotals = currentTotals;
    if (delta !== undefined) {
      options.state.lastDeltaSample = { percent: delta, at: now };
      return delta;
    }
    if (options.state.lastDeltaSample && now - options.state.lastDeltaSample.at < DELTA_CACHE_TTL_MS) {
      return options.state.lastDeltaSample.percent;
    }
  }

  await options.delay(options.sampleWindowMs);
  const nextTotals = sumCpuTimes(options.cpus());
  options.state.previousTotals = nextTotals;
  const delta = computeCpuDeltaPercent(currentTotals, nextTotals);
  if (delta !== undefined) {
    options.state.lastDeltaSample = { percent: delta, at: options.now() };
    return delta;
  }
  return 0;
}

export async function readHostBalanceResources(
  store: HubStore,
  options: HostBalanceSamplerOptions = {},
): Promise<HostBalanceResources> {
  const readCpus = options.cpus ?? os.cpus;
  const readLoadAvg = options.loadavg ?? os.loadavg;
  const readTotalMem = options.totalmem ?? os.totalmem;
  const readAvailMem = options.availableMemory ?? defaultAvailableMemory;
  const readFreeMem = options.freemem ?? os.freemem;
  const delay = options.delay ?? sleep;
  const sampleWindowMs = options.sampleWindowMs ?? DEFAULT_CPU_SAMPLE_WINDOW_MS;
  const now = options.now ?? Date.now;
  const state = options.state ?? defaultSamplerState;

  const cpus = readCpus();
  const cpuCores = Math.max(1, cpus.length || 1);
  const loadAvg1m = Math.max(0, Math.round((readLoadAvg()[0] ?? 0) * 100) / 100);
  const cpuPercent = await sampleCpuPercent(cpuCores, loadAvg1m, cpus, {
    cpus: readCpus,
    delay,
    sampleWindowMs,
    now,
    state,
  });

  const memoryTotalBytes = Math.max(1, Math.floor(readTotalMem()));
  const memoryFreeBytes = readAvailableMemoryBytes(memoryTotalBytes, readAvailMem, readFreeMem);
  const memoryUsedPercent = Math.min(
    100,
    Math.max(0, Math.round(((memoryTotalBytes - memoryFreeBytes) / memoryTotalBytes) * 100)),
  );

  const [turnsRow, ticketsRow] = await store.db.serial(async () => {
    const turns = await store.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE author_type='bot' AND status IN ('pending','streaming')",
    );
    const tickets = await store.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM dispatch_tickets WHERE status='working' AND paused=0",
    ).catch(() => ({ count: 0 }));
    return [turns, tickets] as const;
  });

  return hostBalanceResourcesSchema.parse({
    cpuPercent,
    cpuCores,
    loadAvg1m,
    memoryUsedPercent,
    memoryFreeBytes,
    memoryTotalBytes,
    activeTurns: Math.max(0, Number(turnsRow?.count ?? 0)),
    activeTickets: Math.max(0, Number(ticketsRow?.count ?? 0)),
    capturedAt: now(),
  });
}
