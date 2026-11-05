import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, opendir, readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { z } from "zod";

const exec = promisify(execFile);
const absolute = z.string().min(1).max(32768).refine(value => path.win32.isAbsolute(value));
const probeSchema = z.object({ protocol: z.literal("TAROBOT_WINDOWS_STATE_PROBE_V1"), version: z.literal(1), packageFamily: z.string().max(4096).nullable(), helperPackageFamily: z.string().max(4096).nullable(),
  roaming: absolute, local: absolute, profile: absolute, requestedDirectory: absolute, directory: absolute,
  identity: absolute.nullable(), database: absolute.nullable(), config: absolute.nullable() }).strict();
export type WindowsStateProbe = z.infer<typeof probeSchema>;
export type DirectoryIssue = "redirected" | "shadow_only" | "conflict" | "incomplete" | "probe_failed" | "foreign_runtime" | "runtime_update_required";
export class HostDirectoryError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(readonly issue: DirectoryIssue) {
    super(`host_directory_${issue}`); this.code = `HOST_DIRECTORY_${issue.toUpperCase()}`;
    this.exitCode = issue === "probe_failed" ? 1 : 78;
  }
}
export const windowsPathKey = (value: string) => path.win32.normalize(value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "").toLowerCase();
function inside(root: string, file: string) { const a = windowsPathKey(root), b = windowsPathKey(file); return b === a || b.startsWith(a + "\\"); }

/** Probe the actual Node PID. A helper's own context alone cannot establish the
 * caller's view. Missing/old helpers fail closed; no shell or PATH fallback. */
export async function probeWindowsState(directory?: string): Promise<WindowsStateProbe> {
  try {
    const helper = fileURLToPath(new URL("../../../bin/tarobot-host-launcher.exe", import.meta.url));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH"].includes(key.toUpperCase()) || key.toUpperCase().startsWith("DYLD_")) delete env[key];
    const { stdout } = await exec(helper, ["--inspect-host-directory", String(process.pid), ...(directory ? [path.resolve(directory)] : [])], { shell: false, windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024, env });
    return probeSchema.parse(JSON.parse(stdout));
  } catch (error) {
    // Only the packaged helper's explicit refusal protocol is trusted. Unknown
    // stderr, launch errors and killed/time-limited probes remain generic.
    const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
    const reason = typeof failure?.stderr === "string" ? failure.stderr.trim() : "";
    if (failure?.code === 78 && !failure.killed) {
      if (reason === "host_directory_conflict") throw new HostDirectoryError("conflict");
      if (reason === "host_directory_redirected") throw new HostDirectoryError("redirected");
    }
    throw new HostDirectoryError("probe_failed");
  }
}

/** Package identity is the decision, handle paths are corroboration only:
 * Windows can return a nominal name even when the file view is virtualized. */
export function validateWindowsProbe(probe: WindowsStateProbe): string {
  if (probe.packageFamily || probe.helperPackageFamily) throw new HostDirectoryError("redirected");
  const directory = probe.directory;
  if (inside(path.win32.join(probe.local, "Packages"), directory)) throw new HostDirectoryError("redirected");
  for (const [key, name] of [["identity", "identity.json"], ["database", "hub.sqlite"], ["config", "config.json"]] as const) {
    if (probe[key] && windowsPathKey(probe[key]) !== windowsPathKey(path.win32.join(directory, name))) throw new HostDirectoryError("redirected");
  }
  return directory.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

async function present(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
export async function hostDirectoryState(directory: string): Promise<"missing" | "empty" | "ready" | "incomplete"> {
  if (!await present(directory)) return "missing";
  const [identity, database, bots, enabled] = await Promise.all(["identity.json", "hub.sqlite", "bots", "desktop-enabled.json"].map(name => present(path.join(directory, name))));
  if (identity && database) {
    for (const name of ["identity.json", "hub.sqlite"]) if (!(await lstat(path.join(directory, name))).isFile()) return "incomplete";
    return "ready";
  }
  // A lone config can precede explicit first setup, but never authorizes
  // minting a replacement identity for a database or Bot directory.
  return identity || database || bots || enabled ? "incomplete" : "empty";
}
export async function assertHostStateIntegrity(directory: string): Promise<void> {
  if (await hostDirectoryState(directory) === "incomplete") throw new HostDirectoryError("incomplete");
}

/** Only exact active host locations, never renamed backups. No recursive scan
 * of package contents. Unknown permissions and bounded-scan exhaustion block. */
export async function findShadowHosts(packages: string, relative: string, area: "Roaming" | "Local", limits = { packages: 2048, milliseconds: 3000 }, workspaces: string[] = []): Promise<string[]> {
  const result: string[] = []; const deadline = Date.now() + limits.milliseconds;
  let entries: Awaited<ReturnType<typeof opendir>>;
  try { entries = await opendir(packages); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new HostDirectoryError("probe_failed"); }
  let count = 0;
  try {
    for await (const entry of entries) {
      if (++count > limits.packages || Date.now() > deadline) throw new HostDirectoryError("probe_failed");
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.join(packages, entry.name, "LocalCache", area, relative);
      if (!await present(candidate)) continue;
      // Do not traverse a junction masquerading as a legacy state tree.
      if (entry.isSymbolicLink() || !(await lstat(candidate)).isDirectory() || path.resolve(await realpath(candidate)).toLowerCase() !== path.resolve(candidate).toLowerCase()) throw new HostDirectoryError("probe_failed");
      const markers = ["identity.json", "hub.sqlite", "hub.sqlite-wal", "hub.sqlite-shm", "config.json", "desktop-enabled.json", "host-service.json", "hub-control.key"];
      if ((await Promise.all(markers.map(name => present(path.join(candidate, name))))).some(Boolean)) result.push(candidate);
      else if (await present(path.join(candidate, "bots"))) workspaces.push(candidate);
    }
  } catch (error) { if (error instanceof HostDirectoryError) throw error; throw new HostDirectoryError("probe_failed"); }
  return result;
}

export async function inspectWindowsDirectory(directory?: string, probe: (directory?: string) => Promise<WindowsStateProbe> = probeWindowsState) {
  const observation = await probe(directory);
  // Diagnostic command may report a packaged context, but never reads SQLite.
  let selected: string;
  try { selected = validateWindowsProbe(observation); }
  catch (error) { if (error instanceof HostDirectoryError) return { directory: observation.requestedDirectory, state: error.issue, shadows: [] as string[], observation }; throw error; }
  const state = await hostDirectoryState(selected);
  const mappings: [string, "Roaming" | "Local"][] = [[observation.roaming, "Roaming"], [observation.local, "Local"]];
  const mapping = mappings.find(([root]) => inside(root, observation.requestedDirectory));
  const shadowWorkspaces: string[] = [];
  const relative = mapping ? path.win32.relative(mapping[0], observation.requestedDirectory).replace(/[\\/]/g, path.sep) : undefined;
  // A new package ID must not hide state virtualized under the old ID. Explicit
  // directory choices retain their existing scoped admission semantics.
  const relatives = relative ? [...new Set([relative, ...(directory === undefined ? [path.join("com.tarobot.client", "host"), path.join("com.tarocub.client", "host")] : [])])] : [];
  const shadows: string[] = [];
  if (mapping) for (const candidate of relatives) shadows.push(...await findShadowHosts(path.join(observation.local, "Packages"), candidate, mapping[1], undefined, shadowWorkspaces));
  return { directory: selected, state: shadows.length ? state === "ready" ? "conflict" as const : "shadow_only" as const : state !== "ready" && shadowWorkspaces.length ? "shadow_only" as const : state, shadows, shadowWorkspaces, observation };
}

export async function admitWindowsDirectory(directory?: string, probe = probeWindowsState): Promise<string> {
  const report = await inspectWindowsDirectory(directory, probe);
  if (!["ready", "empty", "missing"].includes(report.state)) throw new HostDirectoryError(report.state as DirectoryIssue);
  // Check the Node view as well as the native helper view, including junctions.
  if (report.state !== "missing") {
    const [native, node] = await Promise.all([stat(report.directory, { bigint: true }), stat(report.observation.requestedDirectory, { bigint: true })]);
    if (native.dev !== node.dev || native.ino !== node.ino) throw new HostDirectoryError("redirected");
  }
  // Keep the desktop's nominal Known Folder spelling for persisted TLS paths.
  return report.observation.requestedDirectory;
}
/** Stop/inspection still require an unpackaged, verified view, but must remain
 * available when a shadow or partial host needs to be taken offline. */
export async function inspectableWindowsDirectory(directory?: string): Promise<string> {
  const observation = await probeWindowsState(directory); validateWindowsProbe(observation);
  return observation.requestedDirectory;
}
export async function guardHostDirectory(directory: string, inspection = false): Promise<void> {
  if (process.platform === "win32") await (inspection ? inspectableWindowsDirectory(directory) : admitWindowsDirectory(directory));
}

/** Kernel pipe leases cannot fork with AppData file virtualization. No payload,
 * authentication or remote access: a collision simply denies a second writer. */
export function hostAdmissionPipe(kind: "directory" | "identity", key: string): string {
  return `\\\\.\\pipe\\tarobot-host-${kind}-${createHash("sha256").update(kind === "directory" ? windowsPathKey(key) : key).digest("hex")}`;
}
export async function acquireAdmissionPipe(address: string): Promise<() => Promise<void>> {
  const server = net.createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(address, () => { server.removeListener("error", reject); resolve(); });
  }).catch(() => { throw new HostDirectoryError("foreign_runtime"); });
  server.unref(); // An unconfirmed shutdown retains ownership until process exit.
  let closed = false;
  return async () => { if (closed) return; closed = true; await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); };
}
export async function acquireHostAdmission(directory: string): Promise<() => Promise<void>> {
  return process.platform === "win32" ? acquireAdmissionPipe(hostAdmissionPipe("directory", directory)) : async () => {};
}
export async function acquireHostIdentityAdmission(publicKey: string): Promise<() => Promise<void>> {
  return process.platform === "win32" ? acquireAdmissionPipe(hostAdmissionPipe("identity", publicKey)) : async () => {};
}
/** Existing identities must be leased before SQLite migration/recovery writes,
 * not only before listening. A copied directory can carry the same identity. */
export async function acquireExistingHostIdentityAdmission(directory: string): Promise<{ publicKey: string; release: () => Promise<void> } | undefined> {
  if (process.platform !== "win32") return;
  let file: Awaited<ReturnType<typeof open>>;
  try { file = await open(path.join(directory, "identity.json"), "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new HostDirectoryError("incomplete"); }
  let publicKey: string;
  try {
    if (!(await file.stat()).isFile()) throw new Error("invalid identity");
    const bytes = Buffer.alloc(65537), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error("oversized identity");
    const identity = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (typeof identity.publicKey !== "string" || !identity.publicKey || identity.publicKey.length > 16384) throw new Error("invalid identity");
    publicKey = identity.publicKey;
  } catch { throw new HostDirectoryError("incomplete"); }
  finally { await file.close(); }
  return { publicKey, release: await acquireHostIdentityAdmission(publicKey) };
}
export async function assertWindowsRuntimeAdmission(entrypoint: string): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const pkg = JSON.parse(await readFile(path.resolve(path.dirname(entrypoint), "../../package.json"), "utf8"));
    if (!Array.isArray(pkg.tarobotHostCapabilities) || !pkg.tarobotHostCapabilities.includes("windows-state-admission-v1")) throw new Error("old runtime");
  } catch { throw new HostDirectoryError("runtime_update_required"); }
}
