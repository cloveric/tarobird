import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { withFileMutex } from "./file-mutex.js";

/** Stable admission lock outside the directory a legacy restore replaces.
 * Startup holds it until its lifetime instance lock is established. Restore
 * holds it through the live-owner check and the complete directory swap. */
export async function withServiceDirectoryGate<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const parent = path.dirname(path.resolve(directory));
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  return withFileMutex(path.join(canonicalParent, `.${path.basename(directory)}.service-admission`), task);
}
