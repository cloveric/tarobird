import { z } from "zod";

const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const publicKeySchema = z.string().min(32).max(256);

export const HOST_TERMINAL_CAPABILITY = "host.terminal.v1" as const;
export const HOST_TERMINAL_STATUS_PATH = "/api/terminals/status" as const;
export const HOST_TERMINAL_CONFIGURE_PATH = "/api/terminals/configure" as const;
export const HOST_TERMINALS_PATH = "/api/terminals" as const;

export const terminalGrantSchema = z.object({
  deviceId: idSchema,
  publicKey: publicKeySchema,
}).strict();
export type TerminalGrant = z.infer<typeof terminalGrantSchema>;

export const terminalPolicySchema = z.object({
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  grants: z.array(terminalGrantSchema).max(64),
}).strict()
  .refine((value) => new Set(value.grants.map((g) => g.deviceId)).size === value.grants.length, "duplicate_terminal_device");
export type TerminalPolicy = z.infer<typeof terminalPolicySchema>;

export const terminalConfigureSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  grants: z.array(terminalGrantSchema).max(64),
  requestId: idSchema,
}).strict()
  .refine((value) => new Set(value.grants.map((g) => g.deviceId)).size === value.grants.length, "duplicate_terminal_device");
export type TerminalConfigure = z.infer<typeof terminalConfigureSchema>;

/** Domain-separated canonical text signed by the local owner controller when updating terminal grants. */
export function terminalConfigureText(command: TerminalConfigure): string {
  const parsed = terminalConfigureSchema.parse(command);
  const grants = [...parsed.grants]
    .sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0))
    .map((g) => [g.deviceId, g.publicKey]);
  return JSON.stringify(["tarobot/terminal-policy/v1", parsed.expectedRevision, parsed.enabled, grants, parsed.requestId]);
}

export const terminalSessionInfoSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  title: z.string().min(1).max(120),
  cwd: z.string().min(1).max(1024),
  shell: z.string().min(1).max(120),
  backend: z.enum(["node-pty", "pty-script", "pipe"]),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  cols: z.number().int().min(10).max(400),
  rows: z.number().int().min(4).max(200),
}).strict();
export type TerminalSessionInfo = z.infer<typeof terminalSessionInfoSchema>;

export const terminalStatusSchema = z.object({
  supported: z.boolean(),
  enabled: z.boolean(),
  allowed: z.boolean(),
  canManage: z.boolean(),
  policy: terminalPolicySchema.optional(),
  devices: z.array(z.object({
    id: idSchema,
    name: z.string(),
    platform: z.string(),
    publicKey: publicKeySchema,
  }).strict()).max(256).optional(),
  sessions: z.array(terminalSessionInfoSchema).max(64),
}).strict();
export type TerminalStatus = z.infer<typeof terminalStatusSchema>;

export const terminalCreateSchema = z.object({
  conversationId: idSchema,
  cols: z.number().int().min(20).max(320).default(100),
  rows: z.number().int().min(6).max(120).default(28),
  title: z.string().trim().min(1).max(80).optional(),
}).strict();
export type TerminalCreate = z.infer<typeof terminalCreateSchema>;

export const terminalInputSchema = z.object({
  data: z.string().min(1).max(65536),
}).strict();

export const terminalResizeSchema = z.object({
  cols: z.number().int().min(20).max(320),
  rows: z.number().int().min(6).max(120),
}).strict();

export const terminalOutputChunkSchema = z.object({
  seq: z.number().int().positive(),
  data: z.string(),
}).strict();

export const terminalOutputSchema = z.object({
  id: idSchema,
  seq: z.number().int().nonnegative(),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  chunks: z.array(terminalOutputChunkSchema),
}).strict();
export type TerminalOutput = z.infer<typeof terminalOutputSchema>;
