import type { LocalReset } from "./storage.js";

export type ResetStep = "shared" | "push" | "browser" | "key" | "cache";
export type ResetBackend = {
  pending: () => Promise<LocalReset | undefined>;
  shared: () => Promise<void>;
  push: () => Promise<void>;
  browser: () => Promise<void>;
  key: (keyRef: string) => Promise<void>;
  finish: () => Promise<void>;
};
/** Each native operation must be idempotent: a crash can occur before the final
 * IndexedDB commit. Never discard the retry record or key reference on failure. */
export async function completeLocalReset(backend: ResetBackend, progress: (step: ResetStep) => void): Promise<void> {
  const pending = await backend.pending();
  if (!pending) return;
  progress("shared"); await backend.shared();
  progress("push"); await backend.push();
  progress("browser"); await backend.browser();
  if (pending.keyRef) { progress("key"); await backend.key(pending.keyRef); }
  progress("cache"); await backend.finish();
}
