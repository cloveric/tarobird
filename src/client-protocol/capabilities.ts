import { z } from "zod";

export const botCapabilitiesSchema = z.object({
  generatedAt: z.iso.datetime(),
  engine: z.enum(["codex", "claude", "kimi", "deepseek", "antigravity"]).nullable(),
  workspace: z.string().nullable(),
  runtime: z.literal("unverified"),
  coverage: z.literal("partial"),
  entries: z.array(z.object({
    id: z.string(), kind: z.enum(["skill", "mcp"]), name: z.string(), description: z.string(),
    scope: z.enum(["user", "workspace", "plugin", "bridge", "system", "bot"]),
    source: z.string(), status: z.enum(["discovered", "configured", "disabled"]),
    transport: z.enum(["stdio", "http", "sse", "ws", "sdk", "unknown"]).optional(),
  })).max(1000),
  sources: z.array(z.object({ source: z.string(), kind: z.enum(["skill", "mcp", "config"]), status: z.enum(["read", "missing", "unreadable", "limited"]) })).max(200),
  warnings: z.array(z.enum(["runtime_unverified", "partial_catalog", "offline_workspace_only", "config_unreadable", "workspace_unknown", "scan_limited", "deepseek_dynamic_config"])),
});
export type BotCapabilities = z.infer<typeof botCapabilitiesSchema>;
export type BotCapability = BotCapabilities["entries"][number];
