import { guardHostDirectory, assertWindowsRuntimeAdmission } from "./windows-state-admission.js";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { controlPath, inspectHubService, stopDrainedHub, type DrainedStopGuard, type HubServiceStatus } from "../hub/service.js";
import { withFileMutex as withStateFileMutex } from "../state/file-mutex.js";
import { buildHostEnvironment, HOST_CONFIG_DIRECTORY_KEYS, HOST_ENGINE_EXECUTABLE_KEYS, HOST_PROXY_KEYS, HOST_PRESERVED_ENVIRONMENT_KEYS, validateHostEnvironmentExecutables } from "./environment.js";
import { acquireInstanceLock, isInstanceLockOwnerAlive, type InstanceLockHandle } from "../state/instance-lock.js";
const withFileMutex = <T>(file: string, operation: () => Promise<T>) => withStateFileMutex(file, operation, { waitTimeoutMs: 45_000 });

type Platform = "darwin" | "linux" | "win32";
type HubStatus = HubServiceStatus | { running: false };
export type ManagedServiceCommand = "start" | "stop" | "restart";
export type ServiceCommandResult = { code: number; stdout: string; stderr: string };
export type ServiceCommandRunner = (executable: string, args: string[]) => Promise<ServiceCommandResult>;
/** All overrides are for isolated tests / embedders, never remote renderer input. */
export interface ManagedServiceOptions {
  platform?: NodeJS.Platform;
  home?: string;
  executable?: string;
  uid?: number;
  windowsUserSid?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ServiceCommandRunner;
  inspect?: (directory: string, command?: "status" | "stop" | "drained-stop", guard?: DrainedStopGuard) => Promise<HubStatus>;
  drainedStop?: DrainedStopGuard;
  requireDrained?: boolean;
  /** Explicit user opt-in only; never combined with a drain-guarded stop. */
  force?: boolean;
  processAlive?: (pid: number) => boolean;
  resolveRuntime?: (directory: string, fallbackEntrypoint: string) => Promise<{ entrypoint: string; executable: string; revisionId?: string }>;
  timeoutMs?: number;
}
export interface ManagedServiceStatus {
  configured: boolean;
  registered: boolean;
  enabled: boolean;
  /** Raw OS login-trigger state, independent of persisted user intent. */
  osEnabled?: boolean;
  running: boolean;
  supervisorRunning?: boolean;
  supervisorPid?: number;
  directory: string;
  manager?: "launchd" | "systemd-user" | "windows-task";
  label?: string;
  executable?: string;
  entrypoint?: string;
  revisionId?: string;
  hub?: HubServiceStatus;
  limitations: string[];
  error?: string;
}

const cleanString = z.string().min(1).refine(value => !/[\x00-\x1f\x7f]/.test(value), "control characters are not allowed");
const manifestSchema = z.object({
  version: z.literal(1), platform: z.enum(["darwin", "linux", "win32"]), directory: cleanString,
  home: cleanString, executable: cleanString, entrypoint: cleanString, revisionId: cleanString, label: cleanString,
  uid: z.number().int().nonnegative().optional(), windowsUserSid: z.string().regex(/^S-1-\d+(?:-\d+)+$/).optional(),
  environment: z.object({ PATH: cleanString, HOME: cleanString, USERPROFILE: cleanString.optional(), APPDATA: cleanString.optional(), LOCALAPPDATA: cleanString.optional(), PATHEXT: cleanString.optional(), ...Object.fromEntries(HOST_ENGINE_EXECUTABLE_KEYS.map(key => [key, cleanString.optional()])) }).strict(),
  extraEnvironment: z.object(Object.fromEntries([...HOST_CONFIG_DIRECTORY_KEYS, ...HOST_PROXY_KEYS].map(key => [key, cleanString.optional()]))).strict().optional(),
  artifactTemplateVersion: z.number().int().positive().optional(),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  runtimeHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  enabled: z.boolean(), installedAt: z.string(),
});
type Manifest = z.infer<typeof manifestSchema>;
const serviceEnvironment = (manifest: Manifest) => ({ ...manifest.environment, ...manifest.extraEnvironment });
export const SERVICE_EXTRA_ENVIRONMENT_CAPABILITY = "service-extra-environment-v1";
const refreshSchema = z.object({ before: manifestSchema, after: manifestSchema });
const manifestFile = (directory: string) => path.join(directory, "host-service.json");
const refreshFile = (directory: string) => path.join(directory, "host-service-refresh.json");
// OS ownership is a separate versioned format. Generic state schema upgrades
// must not make a previous frozen runtime unable to read its service receipt.
async function readServiceJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
const store = (directory: string) => ({
  read: async (_fallback: null) => manifestSchema.nullable().parse(await readServiceJson(manifestFile(directory))),
  write: async (manifest: Manifest) => writeAtomic(manifestFile(directory), JSON.stringify(manifestSchema.parse(manifest), null, 2) + "\n", true),
});
const exec = promisify(execFile);
const defaultRunner: ServiceCommandRunner = async (executable, args) => {
  try {
    const value = await exec(executable, args, { timeout: 75_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" });
    return { code: 0, stdout: value.stdout, stderr: value.stderr };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (typeof value.code !== "number" || value.killed) throw error;
    return { code: value.code, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
  }
};
const manager = (platform: Platform) => platform === "darwin" ? "launchd" : platform === "linux" ? "systemd-user" : "windows-task";
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; if ((error as NodeJS.ErrnoException).code === "EPERM") return true; throw error; }
}
const limitations = (platform: Platform) => platform === "darwin"
  ? ["Runs as the current macOS user after login; it does not run while the computer is asleep or powered off."]
  : platform === "linux"
    ? ["Uses the current user's systemd manager. Running before login / after logout requires administrator-configured user lingering; this command does not enable it."]
    : ["Runs as the current Windows user after login, without elevation. Logging out ends availability; sleep and shutdown also stop the host."];
function supportedPlatform(options: ManagedServiceOptions): Platform {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") throw new Error(`host_service_unsupported_platform: ${platform}`);
  return platform;
}
async function canonicalDirectory(directory: string): Promise<string> {
  let current = path.resolve(cleanString.parse(directory)); const tail: string[] = [];
  for (;;) {
    try { return path.join(await realpath(current), ...tail.reverse()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(current) === current) throw error; tail.push(path.basename(current)); current = path.dirname(current); }
  }
}
function labelFor(directory: string, platform: Platform): string {
  const key = platform === "win32" ? directory.toLowerCase() : directory;
  return `com.tarocub.host.${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}
function artifact(manifest: Manifest): string {
  if (manifest.platform === "darwin") return path.join(manifest.home, "Library", "LaunchAgents", `${manifest.label}.plist`);
  if (manifest.platform === "linux") return path.join(manifest.home, ".config", "systemd", "user", `${manifest.label}.service`);
  return path.join(manifest.directory, "host-service", "task.xml");
}
const runtimeFile = (manifest: Manifest) => path.join(manifest.directory, "host-service", "launcher.json");
const windowsLauncher = (manifest: Pick<Manifest, "entrypoint">) => path.resolve(path.dirname(manifest.entrypoint), "../../bin/tarobot-host-launcher.exe");
// Clear loader injection inherited from a user manager as well as the caller.
const clearedLoaderEnvironment = Object.fromEntries(["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_FALLBACK_FRAMEWORK_PATH", "DYLD_VERSIONED_LIBRARY_PATH", "DYLD_VERSIONED_FRAMEWORK_PATH", "DYLD_ROOT_PATH"].map(key => [key, ""]));
const unit = (manifest: Manifest) => `${manifest.label}.service`;
const domain = (manifest: Manifest) => `gui/${manifest.uid}`;
const taskName = (manifest: Manifest) => `\\TaroBot-${manifest.label}`;
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// systemd performs specifier and (for ExecStart) environment expansion even in
// quoted words. Escape both; never interpolate these arguments into a shell.
const systemdWord = (value: string, command = false) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, command ? "$$$$" : "$")}"`;
// These scalar path fields do not perform word/unquote parsing. A literal
// quote would be part of WorkingDirectory and hide the append: output prefix.
const systemdPath = (value: string) => value.replace(/%/g, "%%");
export function quoteWindowsServiceArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/\\+$/, "$&$&")}"`;
}

/** Pure template construction is exported for cross-platform contract tests. */
export function renderManagedServiceArtifact(manifest: Manifest): string {
  const args = [manifest.executable, manifest.entrypoint, "host", "run", "--state-dir", manifest.directory];
  if (manifest.platform === "darwin") return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(manifest.label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries({ ...serviceEnvironment(manifest), ...clearedLoaderEnvironment, TAROBOT_HOST_SUPERVISOR: manifest.label }).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>WorkingDirectory</key><string>${xml(manifest.home)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>45</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(manifest.directory, "hub.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(manifest.directory, "hub.log"))}</string>
</dict></plist>\n`;
  if (manifest.platform === "linux") return `[Unit]
Description=TaroBird host (${manifest.label})
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
${Object.entries({ ...serviceEnvironment(manifest), TAROBOT_HOST_SUPERVISOR: manifest.label }).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `Environment=${systemdWord(`${key}=${value}`)}`).join("\n")}
UnsetEnvironment=${Object.keys(clearedLoaderEnvironment).join(" ")}
WorkingDirectory=${systemdPath(`${manifest.home}/.`)}
ExecStart=${args.map(value => systemdWord(value, true)).join(" ")}
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=10
TimeoutStopSec=45
KillMode=mixed
UMask=0077
StandardOutput=append:${systemdPath(path.join(manifest.directory, "hub.log"))}
StandardError=append:${systemdPath(path.join(manifest.directory, "hub.log"))}

[Install]
WantedBy=default.target
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>TaroBird host for this user; preserves the existing host identity and Bots.</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(manifest.windowsUserSid!)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="TaroBotUser"><UserId>${xml(manifest.windowsUserSid!)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>false</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="TaroBotUser"><Exec><Command>${xml(windowsLauncher(manifest))}</Command><Arguments>${xml(`--config ${quoteWindowsServiceArgument(runtimeFile(manifest))}`)}</Arguments><WorkingDirectory>${xml(manifest.home)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
}

// The GUI-subsystem helper starts Node suspended, assigns its entire tree to a
// kill-on-close Job Object, then resumes it. No console window or script host.
function windowsRuntime(manifest: Manifest): string {
  return JSON.stringify({ version: 1, executable: manifest.executable, entrypoint: manifest.entrypoint, directory: manifest.directory, home: manifest.home, supervisor: manifest.label, control_pipe: controlPath(manifest.directory, "win32"), environment: { ...serviceEnvironment(manifest), TAROBOT_HOST_SUPERVISOR: manifest.label } }, null, 2) + "\n";
}

const artifactHash = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
function recordArtifactHashes(manifest: Manifest): void {
  manifest.artifactTemplateVersion = 1;
  manifest.artifactHash = artifactHash(renderManagedServiceArtifact(manifest));
  if (manifest.platform === "win32") manifest.runtimeHash = artifactHash(windowsRuntime(manifest));
}
// Older receipts have no digest: keep their original conservative template
// check. New receipts verify the bytes installed by that release, independent
// of the template in the CLI currently managing this service.
function artifactMatches(manifest: Manifest, content: string | Buffer, runtime = false): boolean {
  const hash = runtime ? manifest.runtimeHash : manifest.artifactHash;
  return hash ? artifactHash(content) === hash : Buffer.from(content).equals(Buffer.from(runtime ? windowsRuntime(manifest) : renderManagedServiceArtifact(manifest)));
}

/** Read-only source-package check, usable before staging or selecting a runtime. */
export async function assertWindowsHostLauncher(entrypoint: string): Promise<void> {
  const file = windowsLauncher({ entrypoint });
  if (!await assertRegularOrAbsent(file)) throw new Error("host_service_windows_launcher_missing: build a Windows standalone package with its native host launcher");
  const bytes = await readFile(file), pe = bytes.length > 64 ? bytes.readUInt32LE(60) : 0;
  if (!pe || pe + 94 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0" || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b || bytes.readUInt16LE(pe + 92) !== 2) throw new Error("host_service_windows_launcher_invalid: expected the packaged Windows x64 GUI launcher");
}
const verifyWindowsLauncher = (manifest: Manifest) => assertWindowsHostLauncher(manifest.entrypoint);

async function assertRegularOrAbsent(file: string): Promise<boolean> {
  try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`host_service_unsafe_file: ${file}`); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function writeAtomic(file: string, content: string, durable = false): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertRegularOrAbsent(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    if (durable) { const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); } }
    await rename(temporary, file);
    if (durable) {
      try { const handle = await open(path.dirname(file), "r"); try { await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if (!["EPERM", "EINVAL", "ENOTSUP", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
  }
  finally { await rm(temporary, { force: true }); }
}
async function assertArtifactParents(manifest: Manifest): Promise<void> {
  const base = manifest.platform === "win32" ? manifest.directory : manifest.home;
  const parts = manifest.platform === "win32" ? ["host-service"] : manifest.platform === "darwin" ? ["Library", "LaunchAgents"] : [".config", "systemd", "user"];
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`host_service_unsafe_directory: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function readManifest(directory: string, options: ManagedServiceOptions): Promise<Manifest | null> {
  await assertRegularOrAbsent(manifestFile(directory));
  const manifest = await store(directory).read(null);
  if (!manifest) return null;
  const platform = supportedPlatform(options), home = path.resolve(options.home ?? os.homedir());
  if (manifest.directory !== directory || manifest.platform !== platform || manifest.home !== home || manifest.label !== labelFor(directory, platform)) throw new Error("host_service_owner_mismatch");
  if (platform === "darwin" && manifest.uid !== (options.uid ?? process.getuid?.())) throw new Error("host_service_user_mismatch");
  if (platform === "win32" && options.windowsUserSid && manifest.windowsUserSid !== options.windowsUserSid) throw new Error("host_service_user_mismatch");
  return manifest;
}
/** Never return environment values: a proxy URL may embed credentials. */
export async function managedServiceEnvironmentDifferences(directory: string, env: NodeJS.ProcessEnv = process.env, options: ManagedServiceOptions = {}): Promise<string[]> {
  directory = await canonicalDirectory(directory);
  const manifest = await readManifest(directory, options);
  if (!manifest) return [];
  const expected = buildHostEnvironment({ platform: manifest.platform, home: manifest.home, executable: manifest.executable, env });
  return HOST_PRESERVED_ENVIRONMENT_KEYS.filter(key => expected[key] !== (serviceEnvironment(manifest) as Record<string, string | undefined>)[key]);
}
async function assertEnvironmentRuntime(entrypoint: string, extraEnvironment?: Record<string, string | undefined>): Promise<void> {
  const names = Object.keys(extraEnvironment ?? {}).filter(key => extraEnvironment?.[key] !== undefined);
  if (!names.length) return;
  const packageFile = path.resolve(path.dirname(entrypoint), "../../package.json");
  type RuntimeMetadata = { tarobotHostCapabilities?: unknown };
  let metadata: RuntimeMetadata | null = null;
  try {
    if (!(await lstat(packageFile)).isFile() || (await stat(packageFile)).size > 1024 * 1024) throw new Error("invalid_package");
    metadata = JSON.parse(await readFile(packageFile, "utf8")) as RuntimeMetadata;
  } catch { /* Missing/unknown capability is incompatible, never guessed by version. */ }
  const capabilities = metadata?.tarobotHostCapabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes(SERVICE_EXTRA_ENVIRONMENT_CAPABILITY)) throw new Error(`host_service_runtime_environment_incompatible: selected runtime cannot preserve ${names.sort().join(", ")}`);
}
/** Read-only capability fence; callers may already hold the service mutex. */
export async function assertManagedServiceRuntimeCompatible(directory: string, runtime: { entrypoint: string }, options: ManagedServiceOptions = {}): Promise<void> {
  directory = await canonicalDirectory(directory);
  const manifest = await readManifest(directory, options);
  if (manifest) await assertEnvironmentRuntime(runtime.entrypoint, manifest.extraEnvironment);
  if (manifest?.platform === "win32") await assertWindowsHostLauncher(runtime.entrypoint);
}
export const HOST_SUPERVISOR_EXIT_CODE = 78;
/** Runtime fence in addition to caller-side routing. It rejects stale OS jobs
 * after uninstall and direct foreground starts over an installed OS owner. */
export async function assertHostSupervisor(directory: string, options: ManagedServiceOptions = {}): Promise<void> {
  directory = await canonicalDirectory(directory);
  const manifest = await readManifest(directory, options), token = (options.env ?? process.env).TAROBOT_HOST_SUPERVISOR;
  if (manifest ? token !== manifest.label : token !== undefined) {
    const error = new Error("host_service_supervisor_required: use host start/stop for this state directory") as Error & { exitCode: number };
    error.exitCode = HOST_SUPERVISOR_EXIT_CODE; throw error;
  }
  if (manifest) {
    const enabled = await readFile(path.join(directory, "desktop-enabled.json"), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "false"; throw error; });
    if (!manifest.enabled || enabled.trim() !== "true") {
      const error = new Error("host_service_desired_stopped") as Error & { exitCode: number };
      error.exitCode = HOST_SUPERVISOR_EXIT_CODE; throw error;
    }
  }
}
async function saveIntent(manifest: Manifest, enabled: boolean, deferDesktop = false): Promise<void> {
  // Called only under host-service.json mutex. Never acquire desktop-start here:
  // desktop owns the outer lock before dispatching into this manager.
  manifest.enabled = enabled;
  if (deferDesktop) { await store(manifest.directory).write(manifest); return; }
  // Ownership must exist before enabling desktop resume; on stop, disable
  // resume before changing the manager receipt so another opener stays stopped.
  if (enabled) await store(manifest.directory).write(manifest);
  await writeAtomic(path.join(manifest.directory, "desktop-enabled.json"), `${enabled}\n`);
  if (!enabled) await store(manifest.directory).write(manifest);
}
async function selectedRuntime(directory: string, fallbackEntrypoint: string, options: ManagedServiceOptions) {
  const resolve = options.resolveRuntime ?? (await import("./update.js")).resolveHostRuntime;
  const selected = await resolve(directory, fallbackEntrypoint);
  if (!selected.revisionId) throw new Error("host_service_staged_runtime_required: stage and activate a standalone host package before installing the OS service");
  return selected as typeof selected & { revisionId: string };
}
async function command(manifest: Manifest, args: string[], options: ManagedServiceOptions, allowFailure = false): Promise<ServiceCommandResult> {
  const executable = manifest.platform === "darwin" ? "/bin/launchctl" : manifest.platform === "linux" ? "systemctl" : "schtasks.exe";
  const result = await (options.runner ?? defaultRunner)(executable, args);
  if (result.code !== 0 && !allowFailure) throw new Error(`host_service_${path.basename(executable)}_failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  return result;
}
type OsServiceStatus = { registered: boolean; enabled: boolean; supervisorRunning: boolean; supervisorPid?: number; error?: string };
function ownsHub(manifest: Manifest, state: OsServiceStatus, hub: HubServiceStatus): boolean {
  // Windows supervises Node through a GUI helper, so its task PID differs.
  // The runtime fence's reported owner token closes that identity gap.
  return state.supervisorRunning && hub.supervisor === manifest.label && (state.supervisorPid === undefined || state.supervisorPid === hub.pid);
}
function launchdEnabled(output: string, label: string): { enabled: boolean; error?: string } {
  const lines = output.split("\n").filter(value => value.includes(`"${label}"`));
  const value = lines.length === 1 ? lines[0]!.trim().slice(`"${label}"`.length).match(/^\s*=>\s*(true|false|enabled|disabled)\s*[,;]?$/)?.[1] : undefined;
  const validContainer = /^\s*disabled services\s*=\s*\{[\s\S]*\}\s*$/.test(output);
  // No override means launchd's default enabled state. An explicit unknown
  // value is not evidence of a stopped supervisor and must fail closed.
  if (!validContainer || lines.length > 1 || lines.length === 1 && !value) return { enabled: true, error: `Could not parse launchd disabled state for ${label}; refusing to assume the service is stopped.` };
  return { enabled: value !== "true" && value !== "disabled" };
}
async function osStatus(manifest: Manifest, options: ManagedServiceOptions): Promise<OsServiceStatus> {
  if (manifest.platform === "darwin") {
    const [result, disabled] = await Promise.all([
      command(manifest, ["print", `${domain(manifest)}/${manifest.label}`], options, true),
      command(manifest, ["print-disabled", domain(manifest)], options, true),
    ]);
    const enabled = launchdEnabled(disabled.stdout, manifest.label);
    const pid = Number(result.stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
    return { registered: result.code === 0, ...enabled, supervisorRunning: pid > 0, ...(pid > 0 ? { supervisorPid: pid } : {}), ...(disabled.code || result.code && !/could not find service|no such process|not found/i.test(result.stderr + result.stdout) ? { enabled: true, error: "Could not query launchd; verify this user's graphical login session is available." } : {}) };
  }
  if (manifest.platform === "linux") {
    const result = await command(manifest, ["--user", "show", unit(manifest), "--property=LoadState,UnitFileState,MainPID"], options, true);
    if (result.code !== 0) return { registered: false, enabled: false, supervisorRunning: false, error: "Could not query the systemd user manager; check the user session / lingering configuration." };
    const values = Object.fromEntries(result.stdout.trim().split("\n").map(line => line.split("=")));
    const pid = Number(values.MainPID);
    return { registered: values.LoadState === "loaded", enabled: values.UnitFileState === "enabled" || values.UnitFileState === "enabled-runtime", supervisorRunning: pid > 0, ...(pid > 0 ? { supervisorPid: pid } : {}) };
  }
  // Query the native Task Scheduler API rather than parsing localized schtasks
  // status/error strings. EncodedCommand contains only this deterministic label.
  const script = `$ErrorActionPreference='Stop';$scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();try{$task=$scheduler.GetFolder('\\').GetTask('${taskName(manifest)}');$result=@{registered=$true;enabled=[bool]$task.Enabled;supervisorRunning=([int]$task.State -eq 4)}}catch{$cause=$_.Exception;while($cause.InnerException){$cause=$cause.InnerException};if($cause.HResult -ne -2147024894){throw};$result=@{registered=$false;enabled=$false;supervisorRunning=$false}};[Console]::Write(($result|ConvertTo-Json -Compress))`;
  const result = await (options.runner ?? defaultRunner)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  if (result.code !== 0) return { registered: false, enabled: false, supervisorRunning: false, error: "Could not query the Windows task under this user account." };
  return z.object({ registered: z.boolean(), enabled: z.boolean(), supervisorRunning: z.boolean() }).parse(JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()));
}
/** Identity for exact OS lookup only; never saved or used to launch a process. */
function registrationProbe(directory: string, options: ManagedServiceOptions): Manifest {
  const platform = supportedPlatform(options), home = path.resolve(options.home ?? os.homedir());
  return { version: 1, platform, directory, home, label: labelFor(directory, platform), uid: options.uid ?? process.getuid?.(), windowsUserSid: options.windowsUserSid,
    executable: process.execPath, entrypoint: process.execPath, revisionId: "registration-probe", environment: { HOME: home, PATH: "/unused" }, enabled: false, installedAt: new Date(0).toISOString() };
}
/** Used before restore mkdir: a vanished state directory must not hide a still
 * registered login job which could create/write the directory mid-restore. */
export async function assertNoManagedServiceRegistration(directory: string, options: ManagedServiceOptions = {}): Promise<void> {
  directory = await canonicalDirectory(directory);
  const probe = registrationProbe(directory, options);
  await assertArtifactParents(probe);
  if (await assertRegularOrAbsent(artifact(probe))) throw new Error(`host_service_registration_exists: uninstall the service for ${directory} before restoring this host`);
  const state = await osStatus(probe, options);
  if (state.error) throw new Error(`host_service_registration_unverified: ${state.error}`);
  if (state.registered || state.supervisorRunning) throw new Error(`host_service_registration_exists: uninstall the service for ${directory} before restoring this host`);
}
async function uninstallOrphanRegistration(directory: string, options: ManagedServiceOptions): Promise<void> {
  const probe = registrationProbe(directory, options); await assertArtifactParents(probe);
  const definition = await assertRegularOrAbsent(artifact(probe)), state = await osStatus(probe, options);
  if (state.error) throw new Error(`host_service_registration_unverified: ${state.error}`);
  if (!definition && !state.registered) return;
  if ((await (options.inspect ?? inspectHubService)(directory)).running) throw new Error("host_service_handoff_required: explicitly stop the running Hub before removing its orphan registration");
  await assertNoLiveInstanceLock(directory, options);
  if (probe.platform === "darwin") {
    await command(probe, ["disable", `${domain(probe)}/${probe.label}`], options);
    if (state.registered) await command(probe, ["bootout", `${domain(probe)}/${probe.label}`], options);
  } else if (probe.platform === "linux") {
    if (definition) await command(probe, ["--user", "disable", unit(probe)], options);
    if (state.registered) await command(probe, ["--user", "stop", unit(probe)], options);
  } else if (state.registered) {
    await command(probe, ["/Change", "/TN", taskName(probe), "/Disable"], options);
    if (state.supervisorRunning) await command(probe, ["/End", "/TN", taskName(probe)], options);
    await command(probe, ["/Delete", "/TN", taskName(probe), "/F"], options);
  }
  if (definition) await rm(artifact(probe));
  if (probe.platform === "linux") await command(probe, ["--user", "daemon-reload"], options);
  await assertNoManagedServiceRegistration(directory, options);
}
export async function managedServiceStatus(directory: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  directory = await canonicalDirectory(directory);
  const manifest = await readManifest(directory, options);
  if (!manifest) return { configured: false, registered: false, enabled: false, running: false, directory, limitations: [] };
  const [state, hub] = await Promise.all([osStatus(manifest, options), (options.inspect ?? inspectHubService)(directory)]);
  const mismatched = hub.running && !ownsHub(manifest, state, hub);
  return { configured: true, ...state, osEnabled: state.enabled, enabled: manifest.enabled && state.enabled, ...(mismatched ? { error: "The Hub is running outside its configured OS service. Stop it explicitly before handing control to the service." } : {}), running: hub.running, directory, manager: manager(manifest.platform), label: manifest.label, executable: manifest.executable, entrypoint: manifest.entrypoint, revisionId: manifest.revisionId, ...(hub.running ? { hub } : {}), limitations: limitations(manifest.platform) };
}
async function verifyArtifacts(manifest: Manifest, runtimeRequired = true): Promise<void> {
  if (runtimeRequired) await assertWindowsRuntimeAdmission(manifest.entrypoint);
  await assertArtifactParents(manifest);
  if (!await assertRegularOrAbsent(artifact(manifest)) || !artifactMatches(manifest, await readFile(artifact(manifest)))) throw new Error("host_service_artifact_changed: restore the original service definition before retrying; an edited or unowned definition cannot be started, replaced or removed automatically");
  if (manifest.platform === "win32" && (!await assertRegularOrAbsent(runtimeFile(manifest)) || !artifactMatches(manifest, await readFile(runtimeFile(manifest)), true))) throw new Error("host_service_runtime_changed");
  if (runtimeRequired) for (const file of [manifest.executable, manifest.entrypoint]) if (!(await stat(file)).isFile()) throw new Error(`host_service_runtime_missing: ${file}`);
  if (runtimeRequired && manifest.platform === "win32") await verifyWindowsLauncher(manifest);
}

async function assertNoLiveInstanceLock(directory: string, options: ManagedServiceOptions): Promise<void> {
  // Control can be unavailable during startup or late shutdown while the Hub
  // still owns state. Never take over or terminate that instance implicitly.
  try {
    const lock = JSON.parse(await readFile(path.join(directory, "instance.lock.json"), "utf8")) as { pid?: unknown; bootId?: string; processBirth?: string };
    if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid) && lock.pid > 0 && await isInstanceLockOwnerAlive({ ...lock, pid: lock.pid }, { processAlive: options.processAlive })) throw new Error("host_service_handoff_required: an existing host still owns this state directory");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function installManagedService(directory: string, entrypoint: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  await guardHostDirectory(directory);
  await assertWindowsRuntimeAdmission(entrypoint);
  directory = await canonicalDirectory(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  directory = await canonicalDirectory(directory);
  return withFileMutex(manifestFile(directory), async () => {
    // A status/PID check is not ownership: another foreground startup can pass
    // its supervisor check before we save the service manifest. Keep the same
    // Hub lock through registration, including epoch-aware stale-lock recovery.
    const ownership = await acquireInstanceLock(directory).catch(error => {
      if (error instanceof Error && error.message.startsWith("Instance lock already held")) throw new Error("host_service_handoff_required: an existing host still owns this state directory", { cause: error });
      throw error;
    });
    try {
    await recoverRuntimeRefresh(directory, options);
    const previous = await readManifest(directory, options);
    const hub = await (options.inspect ?? inspectHubService)(directory);
    if (hub.running) throw new Error("host_service_handoff_required: stop the existing host explicitly before installing or changing its service; Bot data and pairing will be preserved");
    const platform = supportedPlatform(options), selected = await selectedRuntime(directory, entrypoint, options);
    if (path.resolve(entrypoint) !== selected.entrypoint || options.executable !== undefined && path.resolve(options.executable) !== selected.executable) throw new Error("host_service_runtime_pair_mismatch");
    const home = path.resolve(options.home ?? os.homedir());
    const inherited = buildHostEnvironment({ platform, home, executable: selected.executable, env: options.env });
    await validateHostEnvironmentExecutables(inherited, platform);
    // Keep the legacy strict environment shape readable by old frozen hosts.
    const extraKeys = new Set<string>([...HOST_CONFIG_DIRECTORY_KEYS, ...HOST_PROXY_KEYS]);
    const environment = Object.fromEntries(Object.entries(inherited).filter(([key]) => !extraKeys.has(key)));
    const extraEnvironment = Object.fromEntries(Object.entries(inherited).filter(([key]) => extraKeys.has(key)));
    await assertEnvironmentRuntime(selected.entrypoint, extraEnvironment);
    let windowsUserSid = options.windowsUserSid;
    if (platform === "win32" && !windowsUserSid) {
      const who = await (options.runner ?? defaultRunner)("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
      if (who.code !== 0) throw new Error("host_service_windows_identity_unavailable");
      windowsUserSid = who.stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!windowsUserSid) throw new Error("host_service_windows_identity_unavailable");
    }
    const manifest = manifestSchema.parse({ version: 1, platform, directory, home, executable: selected.executable, entrypoint: selected.entrypoint, revisionId: selected.revisionId, label: labelFor(directory, platform), uid: platform === "darwin" ? options.uid ?? process.getuid?.() : undefined, windowsUserSid, environment, ...(Object.keys(extraEnvironment).length ? { extraEnvironment } : {}), enabled: true, installedAt: new Date().toISOString() });
    recordArtifactHashes(manifest);
    await assertArtifactParents(manifest);
    if (!previous) await assertNoManagedServiceRegistration(directory, options);
    if (platform === "darwin" && manifest.uid === undefined) throw new Error("host_service_user_unavailable");
    for (const file of [manifest.executable, manifest.entrypoint]) if (!(await stat(file)).isFile()) throw new Error(`host_service_runtime_missing: ${file}`);
    if (platform === "win32") await verifyWindowsLauncher(manifest);
    // Never replace an unowned OS service or a manually edited definition.
    if (await assertRegularOrAbsent(artifact(manifest))) {
      if (!previous || !artifactMatches(previous, await readFile(artifact(previous)))) throw new Error("host_service_artifact_conflict");
    }
    if (previous) {
      const state = await osStatus(previous, options);
      if (state.error) throw new Error(state.error);
      if (state.supervisorRunning || state.registered && (previous.enabled || state.enabled)) throw new Error("host_service_stop_before_reinstall");
    }
    await writeAtomic(artifact(manifest), renderManagedServiceArtifact(manifest));
    if (platform === "win32") await writeAtomic(runtimeFile(manifest), windowsRuntime(manifest));
    // Record ownership before OS mutation. If registration fails, repair is
    // explicit and desktop must not silently start a second detached host.
    await saveIntent(manifest, true);
    if (platform === "darwin") await command(manifest, ["enable", `${domain(manifest)}/${manifest.label}`], options);
    else if (platform === "linux") { await command(manifest, ["--user", "daemon-reload"], options); await command(manifest, ["--user", "enable", unit(manifest)], options); }
    else {
      await command(manifest, ["/Create", "/TN", taskName(manifest), "/XML", artifact(manifest), ...(previous ? ["/F"] : [])], options);
      await command(manifest, ["/Change", "/TN", taskName(manifest), "/Enable"], options);
    }
    return managedServiceStatus(directory, options);
    } finally { await ownership.release(); }
  });
}

async function inspectTransition(directory: string, options: ManagedServiceOptions, action: "status" | "stop" = "status"): Promise<HubStatus | undefined> {
  try { return await (options.inspect ?? inspectHubService)(directory, action); }
  catch (error) {
    const value = error as NodeJS.ErrnoException;
    // A listener can close an accepted socket during startup/shutdown. That is
    // unknown state, never evidence that the Hub has actually stopped.
    if (["hub_control_closed", "hub_control_timeout"].includes(value.message) || ["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNABORTED", "ENOENT", "ECONNREFUSED"].includes(value.code ?? "")) return undefined;
    throw error;
  }
}
async function waitForHub(directory: string, running: boolean, options: ManagedServiceOptions): Promise<HubStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  do {
    const hub = await inspectTransition(directory, options);
    if (hub?.running === running) return hub;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  } while (true);
  throw new Error(running ? "host_service_start_timed_out: inspect host logs" : "host_service_stop_timed_out");
}
async function stopHubAndWait(directory: string, pids: Set<number>, options: ManagedServiceOptions, guarded = false): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  do {
    const hub = await inspectTransition(directory, options);
    if (hub?.running) {
      if (guarded && (!pids.has(hub.pid) || options.drainedStop && hub.publicKey !== options.drainedStop.publicKey)) throw new Error("host_drain_target_changed");
      pids.add(hub.pid);
      if (!guarded) await inspectTransition(directory, options, "stop");
    } else if (hub && [...pids].every(pid => !(options.processAlive ?? processAlive)(pid))) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  } while (true);
  throw new Error("host_service_stop_timed_out");
}
async function stop(manifest: Manifest, options: ManagedServiceOptions): Promise<void> {
  if (options.force && (options.drainedStop || options.requireDrained)) throw new Error("host_service_force_incompatible_with_drain");
  // Persist desired state first, then disarm supervision before stopping Hub.
  // A failed OS command retains the ownership receipt for safe repair/retry.
  const wasEnabled = manifest.enabled;
  // 0.1.420's Windows helper interprets desktop-enabled=false as an immediate
  // ordinary stop. Keep that compatibility signal unchanged until a guarded
  // shutdown actually exits; persist disabled ownership before committing stop.
  const deferDesktop = manifest.platform === "win32" && Boolean(options.drainedStop || options.requireDrained);
  let preGuardWindows: OsServiceStatus | undefined;
  const rejected = (error: unknown) => Object.assign(error instanceof Error ? error : new Error(String(error)), { stopRejected: true, drainedStopFailure: true });
  if (deferDesktop) {
    try { preGuardWindows = await osStatus(manifest, options); if (preGuardWindows.error) throw new Error(preGuardWindows.error); }
    catch (error) { throw rejected(error); }
  }
  await saveIntent(manifest, false, deferDesktop);
  const restoreRejectedIntent = async () => {
    await saveIntent(manifest, wasEnabled, deferDesktop);
    if (preGuardWindows?.registered && preGuardWindows.enabled) await command(manifest, ["/Change", "/TN", taskName(manifest), "/Enable"], options);
  };
  if (preGuardWindows?.registered) {
    try { await command(manifest, ["/Change", "/TN", taskName(manifest), "/Disable"], options); }
    catch (error) {
      try { await restoreRejectedIntent(); } catch (restoreError) { throw rejected(new AggregateError([error, restoreError], "host_service_stop_rejected_restore_failed")); }
      throw rejected(error);
    }
  }
  let offline: InstanceLockHandle | undefined;
  if (options.requireDrained && !options.drainedStop) {
    // Always manager mutex -> Hub lock, matching offline update activation.
    // A starting Hub without its control socket already owns this lock; it is
    // not evidence of idleness and must not be interrupted by an unguarded stop.
    try { offline = await acquireInstanceLock(manifest.directory); }
    catch (error) { await restoreRejectedIntent(); throw Object.assign(new Error("host_safe_stop_starting_or_unconfirmed: wait for Hub startup and retry", { cause: error }), { stopRejected: true, drainedStopFailure: true }); }
  }
  try {
  let guardedPid: number | undefined;
  if (options.drainedStop) {
    try {
      const guard = options.drainedStop;
      guardedPid = (await stopDrainedHub(manifest.directory, guard, options.inspect ? () => options.inspect!(manifest.directory, "drained-stop", guard) : undefined)).pid;
    } catch (error) {
      // Only a definite Hub rejection proves no stop was committed. A lost
      // response must keep automatic resume disabled until explicitly checked.
      if (error && typeof error === "object" && "stopRejected" in error && error.stopRejected === true) await restoreRejectedIntent();
      throw error;
    }
  }
  let state: OsServiceStatus, linuxManagerError: string | undefined;
  try { state = await osStatus(manifest, options); }
  catch (error) {
    if (manifest.platform !== "linux") throw error;
    state = { registered: false, enabled: true, supervisorRunning: false };
    linuxManagerError = error instanceof Error ? error.message : String(error);
  }
  if (manifest.platform === "linux" && state.error) linuxManagerError = state.error;
  const before = await inspectTransition(manifest.directory, options);
  if (guardedPid && before?.running && (before.pid !== guardedPid || before.publicKey !== options.drainedStop?.publicKey)) throw new Error("host_drain_target_changed");
  if (offline && before?.running) {
    await restoreRejectedIntent();
    throw Object.assign(new Error("host_safe_stop_unexpected_live_hub"), { stopRejected: true, drainedStopFailure: true });
  }
  const pids = new Set<number>(before?.running ? [before.pid] : state.supervisorPid ? [state.supervisorPid] : []);
  if (guardedPid) pids.add(guardedPid);
  if (manifest.platform === "darwin") {
    await command(manifest, ["disable", `${domain(manifest)}/${manifest.label}`], options);
    if (state.registered) await command(manifest, ["bootout", `${domain(manifest)}/${manifest.label}`], options);
  } else if (manifest.platform === "linux") {
    try {
      await command(manifest, ["--user", "disable", unit(manifest)], options);
      if (state.registered) await command(manifest, ["--user", "stop", unit(manifest)], options);
    } catch (error) { linuxManagerError = error instanceof Error ? error.message : String(error); }
    // With no user bus, still honor stop through authenticated local control.
    // Even a requested restart must remain stopped until ownership can be
    // confirmed again. The runtime fence prevents automatic restart meanwhile.
    if (linuxManagerError) await saveIntent(manifest, false);
  } else if (state.registered) await command(manifest, ["/Change", "/TN", taskName(manifest), "/Disable"], options);
  try { await stopHubAndWait(manifest.directory, pids, options, Boolean(options.drainedStop || offline)); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== "host_service_stop_timed_out" || !options.force || manifest.platform !== "win32" || options.drainedStop || offline || !before?.running || !ownsHub(manifest, state, before)) throw error;
    await verifyArtifacts(manifest, false);
    const currentTask = await osStatus(manifest, options), currentHub = await inspectTransition(manifest.directory, options);
    if (currentTask.error || !currentTask.registered || currentTask.enabled || !currentTask.supervisorRunning || currentHub?.running && (currentHub.pid !== before.pid || currentHub.publicKey !== before.publicKey || !ownsHub(manifest, currentTask, currentHub))) throw new Error("host_service_force_owner_unconfirmed");
    await command(manifest, ["/End", "/TN", taskName(manifest)], options);
    // Confirm both Hub/PID and Task Scheduler termination. Never send another
    // ordinary stop while observing the forced shutdown.
    await stopHubAndWait(manifest.directory, pids, options, true);
  }
  if (deferDesktop) await saveIntent(manifest, false);
  if (linuxManagerError) throw new Error(`host_service_stop_degraded: Hub stopped and automatic resume disabled; systemd user registration could not be confirmed: ${linuxManagerError}`);
  // A Windows task can still be starting before its Hub control pipe exists.
  // End that registered instance only after disabling its restart triggers.
  if (manifest.platform === "win32" && state.registered && state.supervisorRunning) {
    if (pids.size === 0) await command(manifest, ["/End", "/TN", taskName(manifest)], options);
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    while ((await osStatus(manifest, options)).supervisorRunning) {
      if (Date.now() >= deadline) throw new Error("host_service_windows_stop_unconfirmed");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  } finally { await offline?.release(); }
}
async function start(manifest: Manifest, options: ManagedServiceOptions): Promise<void> {
  const selected = await selectedRuntime(manifest.directory, manifest.entrypoint, options);
  await assertEnvironmentRuntime(selected.entrypoint, manifest.extraEnvironment);
  if (selected.entrypoint !== manifest.entrypoint || selected.executable !== manifest.executable) manifest = await refreshStoppedRuntime(manifest, selected, options);
  await verifyArtifacts(manifest);
  const state = await osStatus(manifest, options);
  if (state.error) throw new Error(state.error);
  const existing = await (options.inspect ?? inspectHubService)(manifest.directory);
  if (existing.running && !ownsHub(manifest, state, existing)) throw new Error("host_service_handoff_required: the existing Hub is running outside this OS service");
  await saveIntent(manifest, true);
  if (manifest.platform === "darwin") {
    await command(manifest, ["enable", `${domain(manifest)}/${manifest.label}`], options);
    if (!state.registered) await command(manifest, ["bootstrap", domain(manifest), artifact(manifest)], options);
    else await command(manifest, ["kickstart", `${domain(manifest)}/${manifest.label}`], options);
  } else if (manifest.platform === "linux") {
    await command(manifest, ["--user", "daemon-reload"], options);
    await command(manifest, ["--user", "enable", unit(manifest)], options);
    await command(manifest, ["--user", "reset-failed", unit(manifest)], options);
    await command(manifest, ["--user", "start", unit(manifest)], options);
  } else {
    if (!state.registered) throw new Error("host_service_windows_registration_missing: reinstall the service");
    await command(manifest, ["/Change", "/TN", taskName(manifest), "/Enable"], options);
    await command(manifest, ["/Run", "/TN", taskName(manifest)], options);
  }
  const ready = await waitForHub(manifest.directory, true, options);
  const owner = await osStatus(manifest, options);
  if (!ready.running || !ownsHub(manifest, owner, ready)) throw new Error("host_service_start_unconfirmed: Hub is reachable but its OS supervision is not confirmed");
}
async function refreshStoppedRuntime(manifest: Manifest, selected: { entrypoint: string; executable: string; revisionId: string }, options: ManagedServiceOptions): Promise<Manifest> {
  await assertEnvironmentRuntime(selected.entrypoint, manifest.extraEnvironment);
  const state = await osStatus(manifest, options);
  if (state.error) throw new Error(state.error);
  if (manifest.enabled || state.enabled || state.supervisorRunning || (await (options.inspect ?? inspectHubService)(manifest.directory)).running) throw new Error("host_service_stop_before_runtime_change");
  await verifyArtifacts(manifest, false);
  for (const file of [selected.executable, selected.entrypoint]) if (!(await stat(file)).isFile()) throw new Error(`host_service_runtime_missing: ${file}`);
  const separator = manifest.platform === "win32" ? ";" : ":", p = manifest.platform === "win32" ? path.win32 : path;
  const oldNode = p.dirname(manifest.executable), newNode = p.dirname(selected.executable);
  const updated = manifestSchema.parse({ ...manifest, executable: selected.executable, entrypoint: selected.entrypoint, revisionId: selected.revisionId, environment: { ...manifest.environment,
    PATH: [newNode, ...manifest.environment.PATH.split(separator).filter(value => value !== oldNode && value !== newNode)].join(separator) } });
  recordArtifactHashes(updated);
  if (updated.platform === "win32") await verifyWindowsLauncher(updated);
  await writeAtomic(refreshFile(manifest.directory), JSON.stringify({ before: manifest, after: updated }, null, 2) + "\n", true);
  await recoverRuntimeRefresh(manifest.directory, options);
  return updated;
}
/** A crash between the artifact and receipt renames is recoverable without
 * accepting arbitrary edited files. This always leaves the service stopped. */
async function recoverRuntimeRefresh(directory: string, options: ManagedServiceOptions): Promise<void> {
  if (!await assertRegularOrAbsent(refreshFile(directory))) return;
  const pending = refreshSchema.parse(await readServiceJson(refreshFile(directory)));
  const current = await readManifest(directory, options);
  if (!current || pending.before.directory !== directory || pending.after.directory !== directory || pending.before.label !== current.label || pending.after.label !== current.label || pending.before.platform !== current.platform || pending.after.platform !== current.platform || pending.before.home !== current.home || pending.after.home !== current.home || pending.before.enabled || pending.after.enabled || current.enabled) throw new Error("host_service_refresh_receipt_invalid");
  const state = await osStatus(current, options);
  if (state.error) throw new Error(state.error);
  if (state.enabled || state.supervisorRunning || (await (options.inspect ?? inspectHubService)(directory)).running) throw new Error("host_service_stop_before_runtime_change");
  await assertArtifactParents(current);
  const files = [{ file: artifact(current), rendered: renderManagedServiceArtifact(pending.after), runtime: false }];
  if (current.platform === "win32") files.push({ file: runtimeFile(current), rendered: windowsRuntime(pending.after), runtime: true });
  const checked = [];
  // Validate the whole transaction before modifying either Windows artifact.
  // Hashless legacy receipts still require the current renderer's exact bytes.
  for (const item of files) {
    const content = await assertRegularOrAbsent(item.file) ? await readFile(item.file) : undefined;
    const before = content !== undefined && artifactMatches(pending.before, content, item.runtime);
    const after = content !== undefined && artifactMatches(pending.after, content, item.runtime);
    if (content !== undefined && !before && !after) throw new Error("host_service_artifact_conflict");
    checked.push({ ...item, before, after, canRender: artifactMatches(pending.after, item.rendered, item.runtime) });
  }
  if (!checked.every(item => item.after)) {
    if (!checked.every(item => item.canRender)) {
      // No artifact was switched, so retain the original stopped service. Do
      // not roll back a receipt that was already committed to another runtime.
      if (checked.every(item => item.before) && JSON.stringify(current) === JSON.stringify(pending.before)) {
        await rm(refreshFile(directory));
        return;
      }
      // Mixed/missing artifacts need the originating template's bytes. A hash
      // establishes ownership; it cannot reconstruct those bytes for us.
      throw new Error("host_service_refresh_template_changed");
    }
    for (const item of checked) if (!item.after) await writeAtomic(item.file, item.rendered);
  }
  // All after-bytes may already be installed even when this CLI cannot render
  // their historical template. Finish the receipt/OS registration only.
  await store(directory).write(pending.after);
  if (current.platform === "linux") await command(current, ["--user", "daemon-reload"], options);
  else if (current.platform === "win32") await command(current, ["/Create", "/TN", taskName(current), "/XML", artifact(current), "/F"], options);
  await rm(refreshFile(directory));
}
/** Rebind a stopped service to the selected, verified immutable Node+entry pair.
 * Network/identity state is never copied or migrated by this operation. */
export async function refreshManagedServiceRuntime(directory: string, runtime: { entrypoint: string; executable: string }, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  directory = await canonicalDirectory(directory);
  return withFileMutex(manifestFile(directory), async () => {
    await recoverRuntimeRefresh(directory, options);
    const manifest = await readManifest(directory, options);
    if (!manifest) return managedServiceStatus(directory, options);
    const selected = await selectedRuntime(directory, manifest.entrypoint, options);
    await assertEnvironmentRuntime(selected.entrypoint, manifest.extraEnvironment);
    if (runtime.entrypoint !== selected.entrypoint || runtime.executable !== selected.executable) throw new Error("host_service_runtime_pair_mismatch");
    await refreshStoppedRuntime(manifest, selected, options);
    return managedServiceStatus(directory, options);
  });
}
/** Repair disabled intent after a failed stop whose original healthy Hub still
 * belongs to this service. Never start/kickstart or take over a foreign Hub. */
export async function reassertManagedServiceIntent(directory: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  directory = await canonicalDirectory(directory);
  return withFileMutex(manifestFile(directory), async () => {
    const manifest = await readManifest(directory, options);
    if (!manifest) throw new Error("host_service_not_installed");
    const state = await osStatus(manifest, options), hub = await (options.inspect ?? inspectHubService)(directory);
    if (state.error) throw new Error(state.error);
    if (!hub.running || hub.draining || hub.drainId || !ownsHub(manifest, state, hub)) throw new Error("host_service_handoff_required: the original healthy service ownership is not confirmed");
    const selected = await selectedRuntime(directory, manifest.entrypoint, options);
    if (selected.entrypoint !== manifest.entrypoint || selected.executable !== manifest.executable) throw new Error("host_service_runtime_pair_mismatch");
    await verifyArtifacts(manifest);
    await saveIntent(manifest, true);
    if (manifest.platform === "darwin") await command(manifest, ["enable", `${domain(manifest)}/${manifest.label}`], options);
    else if (manifest.platform === "linux") await command(manifest, ["--user", "enable", unit(manifest)], options);
    else await command(manifest, ["/Change", "/TN", taskName(manifest), "/Enable"], options);
    const result = await managedServiceStatus(directory, options);
    if (!result.enabled || result.error) throw new Error("host_service_enable_unconfirmed");
    return result;
  });
}

/** Restore login startup intent after an offline update without starting Hub. */
export async function enableManagedServiceOnLogin(directory: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  directory = await canonicalDirectory(directory);
  return withFileMutex(manifestFile(directory), async () => {
    await recoverRuntimeRefresh(directory, options);
    let manifest = await readManifest(directory, options);
    if (!manifest) throw new Error("host_service_not_installed");
    const state = await osStatus(manifest, options);
    if (state.error) throw new Error(state.error);
    if (state.supervisorRunning || (await (options.inspect ?? inspectHubService)(directory)).running) throw new Error("host_service_enable_requires_stopped");
    const selected = await selectedRuntime(directory, manifest.entrypoint, options);
    await assertEnvironmentRuntime(selected.entrypoint, manifest.extraEnvironment);
    if (selected.entrypoint !== manifest.entrypoint || selected.executable !== manifest.executable) manifest = await refreshStoppedRuntime(manifest, selected, options);
    await verifyArtifacts(manifest);
    await saveIntent(manifest, true);
    if (manifest.platform === "darwin") await command(manifest, ["enable", `${domain(manifest)}/${manifest.label}`], options);
    else if (manifest.platform === "linux") { await command(manifest, ["--user", "daemon-reload"], options); await command(manifest, ["--user", "enable", unit(manifest)], options); }
    else if (state.registered) await command(manifest, ["/Change", "/TN", taskName(manifest), "/Enable"], options);
    else throw new Error("host_service_windows_registration_missing: reinstall the service");
    return managedServiceStatus(directory, options);
  });
}
export async function managedServiceCommand(action: ManagedServiceCommand, directory: string, _entrypoint?: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  if (!["start", "stop", "restart"].includes(action)) throw new Error("unknown_host_service_command");
  directory = await canonicalDirectory(directory);
  return withFileMutex(manifestFile(directory), async () => {
    await recoverRuntimeRefresh(directory, options);
    const manifest = await readManifest(directory, options);
    if (!manifest) throw new Error("host_service_not_installed");
    if (action === "stop" || action === "restart") await stop(manifest, options);
    if (action === "start" || action === "restart") await start(manifest, options);
    return managedServiceStatus(directory, options);
  });
}
export async function uninstallManagedService(directory: string, options: ManagedServiceOptions = {}): Promise<ManagedServiceStatus> {
  directory = await canonicalDirectory(directory);
  // A sibling mutex allows cleaning an orphan registration without recreating
  // the missing host directory that the caller is about to restore.
  const target = await lstat(directory).then(() => manifestFile(directory), (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return `${directory}.service-uninstall`; throw error; });
  return withFileMutex(target, async () => {
    await recoverRuntimeRefresh(directory, options);
    const manifest = await readManifest(directory, options);
    if (!manifest) { await uninstallOrphanRegistration(directory, options); return managedServiceStatus(directory, options); }
    await verifyArtifacts(manifest, false);
    await stop(manifest, options);
    if (manifest.platform === "win32" && (await osStatus(manifest, options)).registered) await command(manifest, ["/Delete", "/TN", taskName(manifest), "/F"], options);
    await rm(artifact(manifest), { force: true });
    if (manifest.platform === "linux") await command(manifest, ["--user", "daemon-reload"], options);
    if (manifest.platform === "win32") await rm(runtimeFile(manifest), { force: true });
    await rm(manifestFile(directory), { force: true });
    // Host identity, pairing, Bots, conversations and workspaces are retained.
    return managedServiceStatus(directory, options);
  });
}
