import { z } from "zod";

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

export const InstanceLockRecordSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().min(1),
  acquiredAt: z.string().refine(isIsoTimestamp, "must be a valid ISO-8601 timestamp"),
  // An invalid optional identity must not make an otherwise live legacy lock
  // look corrupt and therefore recoverable.
  bootId: z.string().regex(/^(?:linux|darwin):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i).transform(value => value.toLowerCase()).optional().catch(undefined),
  processBirth: z.string().regex(/^(?:win32|linux|darwin):\d{1,20}$/).optional().catch(undefined),
  machineId: z.string().regex(/^win32:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i).transform(value => value.toLowerCase()).optional().catch(undefined),
}).passthrough();
