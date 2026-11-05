import { readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import type { ServerOptions } from "node:https";
import { z } from "zod";

const certificateFiles = z.object({ cert: z.string().min(1), key: z.string().min(1) }).strict();
export const tlsFilesSchema = certificateFiles.extend({ sni: z.record(z.string().regex(/^[a-z0-9.-]+$/i), certificateFiles).optional() }).strict();
export async function loadHubTls(files: z.infer<typeof tlsFilesSchema>): Promise<ServerOptions> {
  const read = async (f: z.infer<typeof certificateFiles>) => ({ cert: await readFile(f.cert), key: await readFile(f.key) });
  const base = await read(files); const names = new Map<string, ReturnType<typeof createSecureContext>>();
  for (const [name, pair] of Object.entries(files.sni ?? {})) names.set(name.toLowerCase(), createSecureContext({ ...await read(pair), minVersion: "TLSv1.2" }));
  return { ...base, minVersion: "TLSv1.2", ...(names.size ? { SNICallback: (name, done) => { const context = names.get(name.toLowerCase()); if (!context) done(new Error("unknown_server_name")); else done(null, context); } } : {}) };
}
