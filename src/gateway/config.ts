import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const gatewayConfigSchema = z.object({ enabled: z.boolean().default(false), hubUrl: z.string().url().default("ws://127.0.0.1:8788/instance"), secretPath: z.string().min(1).optional(), alertChatId: z.string().regex(/^oc_[A-Za-z0-9_-]+$/).optional() });
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
/** Read the additive gateway section without changing existing channel config. */
export async function readGatewayConfig(stateDir: string): Promise<GatewayConfig> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return gatewayConfigSchema.parse({}); throw error; }
  return z.object({ gateway: gatewayConfigSchema.optional() }).parse(raw).gateway ?? gatewayConfigSchema.parse({});
}
