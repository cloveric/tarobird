import { currentPermission, permissionOptions } from "../state/permission-options.js";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { z } from "zod";
import { botDashboardSchema, dashboardUsageBucketSchema, type BotDashboard, type DashboardLive } from "../client-protocol/dashboard.js";
import { ConfigFileSchema } from "../state/config-file-schema.js";
import { CrewRunRecordSchema, type CrewRunRecord } from "../state/crew-run-schema.js";
import { normalizeCronTimezone } from "../state/cron-timezone.js";
import { parseCronStoreState } from "../state/cron-store.js";
import { SessionStateSchema } from "../state/session-state-schema.js";
import { UsageRecordSchema } from "../state/usage-state-schema.js";
import { CURRENT_SCHEMA_VERSION } from "../state/schema-version.js";
import { redactSecrets } from "./secret-redaction.js";
import { createCronSnapshotter } from "./cron-snapshot.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const clean = (value: string, limit = 2000) => Array.from(Buffer.from(redactSecrets(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " "), "utf8").toString("utf8")).slice(0, limit).join("");
const maybe = (value: string | undefined | null, limit?: number) => value == null ? null : clean(value, limit);

/** Bounded, read-only state reader. Callers supply only fixed Bot-owned paths. */
function dashboardReader(stateDir: string, warnings: string[]) {
  async function raw(relative: string): Promise<unknown | null> {
    let handle;
    try {
      handle = await open(path.join(stateDir, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid file");
      // Bound the read itself as well as stat, even if a writer grows the file.
      const data = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < data.length) { const { bytesRead } = await handle.read(data, offset, data.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
      if (offset > stat.size) throw new Error("file changed");
      const value: unknown = JSON.parse(data.subarray(0, offset).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid state");
      if (value && typeof value === "object" && "schemaVersion" in value && typeof value.schemaVersion === "number" && value.schemaVersion > CURRENT_SCHEMA_VERSION) throw new Error("unsupported schema");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push(`${relative.startsWith("crew-runs/") ? "crew-runs" : relative}: unreadable`);
      return null;
    } finally { await handle?.close(); }
  }
  async function validated<T>(relative: string, schema: z.ZodType<T>): Promise<T | null> {
    const value = await raw(relative); if (value === null) return null;
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    warnings.push(`${relative.startsWith("crew-runs/") ? "crew-runs" : relative}: invalid`); return null;
  }
  return { raw, validated };
}

export async function readDashboardUsage(stateDir: string, warnings: string[] = []): Promise<BotDashboard["usage"]> {
  const { validated } = dashboardReader(stateDir, warnings);
  const currentUsage = await validated("usage.json", UsageRecordSchema);
  const usage = currentUsage ?? await validated("usage.last-good.json", UsageRecordSchema);
  if (!currentUsage && usage) warnings.push("usage.last-good.json: fallback");
  const bucket = (value: z.infer<typeof UsageRecordSchema>) => dashboardUsageBucketSchema.parse({ ...value, unmeteredRequestCount: value.unmeteredRequestCount ?? 0 });
  function periods(value: Record<string, z.infer<typeof UsageRecordSchema>> | undefined, monthly = false) {
    const result: NonNullable<BotDashboard["usage"]>["daily"] = {};
    for (const [key, item] of Object.entries(value ?? {})) {
      const iso = monthly ? `${key}-01` : key;
      const date = new Date(`${iso}T00:00:00.000Z`);
      if (!(monthly ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(key) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) { warnings.push("usage.json: invalid period"); continue; }
      result[key] = bucket(item);
    }
    return result;
  }
  return usage ? { source: currentUsage ? "current" : "last-good", total: bucket(usage), daily: periods(usage.daily), monthly: periods(usage.monthly, true) } : null;
}

/** Owner read surface: fixed paths, no repair/quarantine writes. */
export async function readBotDashboard(stateDir: string, live: DashboardLive | null = null): Promise<BotDashboard> {
  const warnings: string[] = [], { raw, validated } = dashboardReader(stateDir, warnings);
  const [config, sessions, usage, cronRaw] = await Promise.all([
    validated("config.json", ConfigFileSchema), validated("session.json", SessionStateSchema),
    readDashboardUsage(stateDir, warnings), raw("cron-jobs.json"),
  ]);
  let cron: BotDashboard["cron"] = cronRaw === null && !warnings.some((warning) => warning.startsWith("cron-jobs.json:")) ? [] : null;
  if (cronRaw !== null) {
    try {
      const timezone = normalizeCronTimezone(config?.timezone), snapshotJob = createCronSnapshotter();
      const rows: NonNullable<BotDashboard["cron"]> = [];
      // Keep native validation/defaults, including legacy one-shot notifications.
      // Yield between batches so a large overview cannot monopolize stop/chat I/O.
      const source = cronRaw as { jobs?: unknown };
      const batches = Array.isArray(source.jobs) ? source.jobs : undefined;
      for (let offset = 0; offset < Math.max(batches?.length ?? 0, 1); offset += 32) {
        await yieldToIO();
        const jobs = parseCronStoreState(batches ? { ...source, jobs: batches.slice(offset, offset + 32) } : cronRaw, timezone).jobs;
        for (const job of jobs) {
          const snapshot = snapshotJob(job);
          rows.push({ id: job.id, title: clean(job.description || job.prompt, 200), channel: job.conversationKey?.startsWith("lark:gw_") || job.larkChatId?.startsWith("gw_") ? "gateway" : job.channel,
            conversation: clean(job.conversationKey ?? job.larkChatId ?? String(job.chatId), 300), kind: snapshot.kind, enabled: job.enabled,
            schedule: clean(snapshot.schedule), timezone: snapshot.timezone, nextRunAt: snapshot.nextRunAt, lastRunAt: snapshot.lastRunAt, lastSuccessAt: snapshot.lastSuccessAt,
            lastError: maybe(job.lastError), failureCount: job.failureCount, maxFailures: job.maxFailures, prompt: clean(job.prompt, 4000),
            sessionMode: job.sessionMode, deliveryMode: job.deliveryMode, mute: job.mute, silent: job.silent, timeoutMins: job.timeoutMins,
            history: job.runHistory.map((row) => ({ ranAt: row.ranAt, success: row.success, error: maybe(row.error) })),
          });
        }
      }
      cron = rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.nextRunAt ?? "~").localeCompare(b.nextRunAt ?? "~") || a.id.localeCompare(b.id));
    } catch { warnings.push("cron-jobs.json: invalid"); }
  }
  let latest: CrewRunRecord | null = null;
  try {
    const root = path.join(stateDir, "crew-runs");
    if (!(await lstat(root)).isDirectory()) throw new Error("invalid directory");
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await validated(`crew-runs/${entry.name}`, CrewRunRecordSchema);
      if (record && (!latest || record.updatedAt > latest.updatedAt || (record.updatedAt === latest.updatedAt && record.runId > latest.runId))) latest = record;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnings.push("crew-runs: unreadable"); }
  return botDashboardSchema.parse({ generatedAt: new Date().toISOString(), live,
    config: config ? { engine: config.engine ?? null, model: maybe(config.model, 200), effort: config.effort ?? null, approvalMode: config.approvalMode ?? null, permissionLabel: permissionOptions(config.engine ?? "codex", config.codexRuntime).find(option => option.id === currentPermission(config.engine ?? "codex", config))!.label, budgetUsd: config.budgetUsd ?? null } : null,
    sessions: sessions ? new Set(sessions.chats.map((s) => s.codexSessionId)).size : null,
    usage,
    cron,
    crew: latest ? { runId: clean(latest.runId, 200), workflow: latest.workflow, status: latest.status, currentStage: latest.currentStage, coordinator: clean(latest.coordinator, 200), chatId: String(latest.chatId), prompt: clean(latest.originalPrompt), updatedAt: latest.updatedAt, lastError: maybe(latest.lastError),
      stages: (["decomposition", "research", "analysis", "writing", "review"] as const).flatMap((stage) => {
        const record = latest!.stages[stage];
        if (!record || typeof record !== "object" || !("status" in record)) return [];
        return [{ stage, status: record.status, updatedAt: record.updatedAt, detail: maybe(record.detail), verdict: record.verdict ?? null, revisionCount: record.revisionCount ?? null }];
      }) } : null,
    warnings: [...new Set(warnings)].sort(),
  });
}
