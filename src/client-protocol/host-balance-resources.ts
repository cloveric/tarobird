import { z } from "zod";

/**
 * Capability for lightweight load-balancing resource telemetry (#88).
 * Kept separate from host.resources.v1 (/api/host-resources, per-process Resource Manager #124).
 */
export const HOST_BALANCE_RESOURCES_CAPABILITY = "host.balance-resources.v1";
export const HOST_BALANCE_RESOURCES_PATH = "/api/host-balance-resources";

/**
 * Read-only resource snapshot reported by a Host to authorized devices for load balancing.
 * Intentionally contains only CPU, memory, and active task counts — no hostnames,
 * paths, environment variables, or conversation contents.
 */
export const hostBalanceResourcesSchema = z.object({
  cpuPercent: z.number().min(0).max(100),
  cpuCores: z.number().int().positive().max(1024),
  loadAvg1m: z.number().min(0).max(10_000),
  memoryUsedPercent: z.number().min(0).max(100),
  memoryFreeBytes: z.number().int().nonnegative().safe(),
  memoryTotalBytes: z.number().int().positive().safe(),
  activeTurns: z.number().int().nonnegative().max(10_000),
  activeTickets: z.number().int().nonnegative().max(10_000),
  capturedAt: z.number().int().nonnegative().safe(),
}).strict();

export type HostBalanceResources = z.infer<typeof hostBalanceResourcesSchema>;
