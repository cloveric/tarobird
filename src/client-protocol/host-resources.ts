import { z } from "zod";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);

export const HOST_RESOURCES_CAPABILITY = "host.resources.v1" as const;
export const HOST_RESOURCES_PATH = "/api/host-resources" as const;
export const HOST_RESOURCES_STOP_PATH = "/api/host-resources/stop" as const;

export const resourceSparklinePointSchema = z.object({
  at: z.number().int().nonnegative(),
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
}).strict();
export type ResourceSparklinePoint = z.infer<typeof resourceSparklinePointSchema>;

export const resourceProcessKindSchema = z.enum(["host", "app", "gateway", "engine", "unattributed"]);
export type ResourceProcessKind = z.infer<typeof resourceProcessKindSchema>;

export const resourceProcessSchema = z.object({
  id: z.string().min(1).max(200),
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative().optional(),
  name: z.string().min(1).max(160),
  kind: resourceProcessKindSchema,
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  botId: idSchema.optional(),
  botName: z.string().max(120).optional(),
  engine: z.string().max(48).optional(),
  conversationId: idSchema.optional(),
  conversationTitle: z.string().max(256).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  stoppable: z.boolean(),
}).strict();
export type ResourceProcess = z.infer<typeof resourceProcessSchema>;

export const resourceConversationGroupSchema = z.object({
  conversationId: idSchema,
  title: z.string().max(256),
  active: z.boolean(),
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  stoppable: z.boolean(),
  processes: z.array(resourceProcessSchema).max(64),
}).strict();
export type ResourceConversationGroup = z.infer<typeof resourceConversationGroupSchema>;

export const resourceBotGroupSchema = z.object({
  botId: idSchema,
  botName: z.string().max(120),
  engine: z.string().max(48),
  online: z.boolean(),
  gatewayPid: z.number().int().positive().optional(),
  cpuPercent: z.number().nonnegative(),
  memoryBytes: z.number().nonnegative(),
  activeTurns: z.number().int().nonnegative(),
  conversations: z.array(resourceConversationGroupSchema).max(64),
  unattributed: z.array(resourceProcessSchema).max(64),
}).strict();
export type ResourceBotGroup = z.infer<typeof resourceBotGroupSchema>;

export const hostResourcesSummarySchema = z.object({
  totalCpuPercent: z.number().nonnegative(),
  totalMemoryBytes: z.number().nonnegative(),
  hostCpuPercent: z.number().nonnegative(),
  hostMemoryBytes: z.number().nonnegative(),
  appCpuPercent: z.number().nonnegative(),
  appMemoryBytes: z.number().nonnegative(),
  engineCpuPercent: z.number().nonnegative(),
  engineMemoryBytes: z.number().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
}).strict();
export type HostResourcesSummary = z.infer<typeof hostResourcesSummarySchema>;

export const hostResourcesSnapshotSchema = z.object({
  v: z.literal(1),
  sampledAt: z.number().int().nonnegative(),
  platform: z.string().min(1).max(32),
  canStop: z.boolean(),
  summary: hostResourcesSummarySchema,
  history: z.array(resourceSparklinePointSchema).max(32),
  selfProcesses: z.array(resourceProcessSchema).max(32),
  bots: z.array(resourceBotGroupSchema).max(128),
  unattributed: z.array(resourceProcessSchema).max(64),
}).strict();
export type HostResourcesSnapshot = z.infer<typeof hostResourcesSnapshotSchema>;

export const hostResourceStopRequestSchema = z.object({
  botId: idSchema,
  conversationId: idSchema.optional(),
  pid: z.number().int().positive().optional(),
}).strict().refine((value) => Boolean(value.conversationId || value.pid), "Either conversationId or pid is required");
export type HostResourceStopRequest = z.infer<typeof hostResourceStopRequestSchema>;

export const hostResourceStopResultSchema = z.object({
  ok: z.literal(true),
  stopped: z.boolean(),
  method: z.enum(["turn_stop", "process_tree"]),
}).strict();
export type HostResourceStopResult = z.infer<typeof hostResourceStopResultSchema>;

export type ResourceSortKey = "memory" | "cpu" | "name";

export function sortResourceBots(bots: readonly ResourceBotGroup[], sort: ResourceSortKey): ResourceBotGroup[] {
  return [...bots].sort((a, b) => {
    if (sort === "cpu") return b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes || a.botName.localeCompare(b.botName);
    if (sort === "name") return a.botName.localeCompare(b.botName) || b.memoryBytes - a.memoryBytes;
    return b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.botName.localeCompare(b.botName);
  });
}

export function sortResourceConversations(conversations: readonly ResourceConversationGroup[], sort: ResourceSortKey): ResourceConversationGroup[] {
  return [...conversations].sort((a, b) => {
    if (sort === "cpu") return b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes || a.title.localeCompare(b.title);
    if (sort === "name") return a.title.localeCompare(b.title) || b.memoryBytes - a.memoryBytes;
    return b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.title.localeCompare(b.title);
  });
}

export function formatMemoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GB`;
  if (mib >= 100) return `${Math.round(mib)} MB`;
  if (mib >= 10) return `${mib.toFixed(1)} MB`;
  return `${Math.max(0.1, mib).toFixed(1)} MB`;
}

export function formatCpuPercent(cpu: number): string {
  if (!Number.isFinite(cpu) || cpu <= 0) return "0%";
  if (cpu >= 100) return `${Math.round(cpu)}%`;
  return `${cpu.toFixed(1)}%`;
}
