import { HostDirectoryError, guardHostDirectory, assertHostStateIntegrity, assertWindowsRuntimeAdmission } from "../host-cli/windows-state-admission.js";
import { readHubLogTail } from "./log-rotation.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import { pairingSchema } from "../client-protocol/index.js";
import { desktopControllerChallengeSchema, desktopControllerProofSchema, type DesktopControllerChallenge } from "./local-controller.js";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { drainBlockerSchema } from "../gateway/control.js";
import { hostProcessEnvironment } from "../host-cli/environment.js";

const screenTicketSchema = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int().positive() }).strict();
const statusSchema = z.object({ running: z.literal(true), pid: z.number().int().positive(), url: z.string(), publicKey: z.string(), instanceUrl: z.string().optional(), version: z.string().optional(), runtimeId: z.string().optional(), supervisor: z.string().optional(), controlCapabilities: z.array(z.string()).optional(), draining: z.boolean().optional(), drained: z.boolean().optional(), drainId: z.string().optional(), drainLeaseExpiresAt: z.number().optional(), drainBlockers: z.array(drainBlockerSchema).max(128).optional(), controlError: z.string().optional(), desktopControllerChallenge: desktopControllerChallengeSchema.optional(), screenServiceTicket: screenTicketSchema.optional(), instancePort: z.number().int().min(1).max(65535).optional(), relay: z.object({ configured: z.boolean(), online: z.boolean(), allOnline: z.boolean().optional(), servers: z.array(z.object({ id: z.string(), label: z.string().optional(), online: z.boolean() })).optional() }).optional() });
export type HubServiceStatus = z.infer<typeof statusSchema>;
export const drainedStopGuardSchema = z.object({ drainId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), pid: z.number().int().positive(), publicKey: z.string().min(1) }).strict();
export type DrainedStopGuard = z.infer<typeof drainedStopGuardSchema>;
export function controlPath(directory: string, platform = process.platform): string {
  if (platform === "win32") {
    // Resolve junctions the same way for native desktop paths and CLI paths.
    if (process.platform === "win32") { try { directory = realpathSync.native(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    return `\\\\.\\pipe\\tarobot-hub-${createHash("sha256").update(path.win32.resolve(directory).toLowerCase()).digest("hex")}`;
  }
  const socket = path.join(directory, "hub-control.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("Hub state directory is too long for a local control socket");
  return socket;
}
/** Local control is protected by the 0700 state directory and 0600 socket.
 * Stop never signals a PID from a stale file or risks killing a reused PID. */
type ControlOptions = { desktopId?: string; screenServiceTicket?: (desktopId: string) => { ticket: string; expiresAt: number }; authenticate?: boolean; drain?: (id?: string) => Promise<void>; cancelDrain?: (id?: string) => Promise<void>; renewDrain?: (id?: string) => Promise<void>; stopDrained?: (id?: string) => Promise<void>; drainId?: string; enrollController?: (controller: unknown) => Promise<void>; desktopControllerChallenge?: (controller: unknown) => DesktopControllerChallenge; enrollDesktopController?: (enrollment: unknown) => Promise<void>; nativeProof?: unknown; controller?: unknown; expectedPublicKey?: string; expectedPid?: number };
async function controlToken(directory: string, create = false): Promise<string> {
  const file = path.join(directory, "hub-control.key");
  if (create) {
    try { await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error("unsafe_hub_control_key");
  const token = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_hub_control_key");
  return token;
}
export async function startHubControl(directory: string, status: HubServiceStatus | (() => HubServiceStatus), shutdown: () => void, options: ControlOptions = {}): Promise<() => Promise<void>> {
  const windows = process.platform === "win32", file = controlPath(directory);
  const token = await controlToken(directory, true);
  if (!windows) await rm(file, { force: true });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy()); let data = "";
    let handled = false;
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (handled) return;
      data += chunk.toString(); if (data.length > 4096) { socket.destroy(); return; }
      if (!data.includes("\n")) return;
      handled = true;
      try {
        const request = z.object({ command: z.enum(["status", "stop", "drain", "drain-cancel", "drain-renew", "drained-stop", "enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket"]), token: z.string().optional(), drainId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), controller: pairingSchema.optional(), nativeProof: desktopControllerProofSchema.optional(), expectedPublicKey: z.string().optional(), expectedPid: z.number().int().positive().optional(), desktopId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() }).strict().parse(JSON.parse(data.trim()));
        if ((windows || options.authenticate || ["enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket", "drain", "drain-cancel", "drain-renew", "drained-stop"].includes(request.command)) && (!request.token || Buffer.byteLength(request.token) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(request.token)))) { socket.destroy(); return; }
        if (["enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket"].includes(request.command) && request.expectedPublicKey !== (typeof status === "function" ? status() : status).publicKey) { socket.destroy(); return; }
        const target = typeof status === "function" ? status() : status;
        const targetChanged = request.command === "drained-stop" && (request.expectedPid !== target.pid || request.expectedPublicKey !== target.publicKey);
        let desktopControllerChallenge: DesktopControllerChallenge | undefined;
        let screenServiceTicket: z.infer<typeof screenTicketSchema> | undefined;
        const action = request.command === "screen-service-ticket" && options.screenServiceTicket && request.desktopId ? () => { screenServiceTicket = options.screenServiceTicket!(request.desktopId!); } : request.command === "drained-stop" && options.stopDrained ? () => { if (targetChanged) throw new Error("host_drain_target_changed"); return options.stopDrained!(request.drainId); } : request.command === "drain" && options.drain ? () => options.drain!(request.drainId) : request.command === "drain-renew" && options.renewDrain ? () => options.renewDrain!(request.drainId) : request.command === "drain-cancel" && options.cancelDrain ? () => options.cancelDrain!(request.drainId) : request.command === "enroll-controller" && options.enrollController && request.controller ? () => options.enrollController!(request.controller) : request.command === "desktop-controller-challenge" && options.desktopControllerChallenge && request.controller ? () => { desktopControllerChallenge = options.desktopControllerChallenge!(request.controller); } : request.command === "enroll-desktop-controller" && options.enrollDesktopController && request.controller && request.nativeProof ? () => options.enrollDesktopController!({ controller: request.controller, proof: request.nativeProof }) : undefined;
        const stopTargetChanged = request.command === "stop" && (request.expectedPid !== undefined || request.expectedPublicKey !== undefined) && (request.expectedPid !== target.pid || request.expectedPublicKey !== target.publicKey);
        const work = stopTargetChanged ? Promise.reject(new Error("host_stop_target_changed")) : ["drain", "drain-cancel", "drain-renew", "drained-stop", "enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket"].includes(request.command) && !action ? Promise.reject(new Error("host_control_operation_unsupported")) : Promise.resolve().then(() => action?.());
        void work.then(() => undefined, (error: unknown) => error instanceof Error ? error.message : "host_control_failed").then(controlError => {
          try { socket.end(JSON.stringify({ ...(typeof status === "function" ? status() : status), controlCapabilities: ["target-stop", ...(options.screenServiceTicket ? ["screen-service-ticket", "screen-quality-v1"] : []), ...(options.enrollController ? ["enroll-controller"] : []), ...(options.desktopControllerChallenge && options.enrollDesktopController ? ["desktop-controller-challenge", "enroll-desktop-controller"] : []), ...(options.drain ? ["drain"] : []), ...(options.cancelDrain ? ["drain-cancel"] : []), ...(options.renewDrain ? ["drain-renew"] : []), ...(options.stopDrained ? ["drained-stop"] : [])], ...(desktopControllerChallenge ? { desktopControllerChallenge } : {}), ...(screenServiceTicket ? { screenServiceTicket, instancePort: Number(new URL(target.instanceUrl!).port) } : {}), ...(controlError ? { controlError } : {}) }) + "\n"); }
          finally { if (!controlError && ["stop", "drained-stop"].includes(request.command)) shutdown(); }
        }).catch(() => socket.destroy());
      } catch { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, () => { server.off("error", reject); resolve(); }); });
  if (!windows) await chmod(file, 0o600);
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); if (!windows) await rm(file, { force: true }); };
}
export async function inspectHubService(directory: string, command: "status" | "stop" | "drain" | "drain-cancel" | "drain-renew" | "drained-stop" | "enroll-controller" | "desktop-controller-challenge" | "enroll-desktop-controller" | "screen-service-ticket" = "status", options: ControlOptions = {}): Promise<HubServiceStatus | { running: false }> {
  let token: string | undefined;
  const controller = ["enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller"].includes(command) ? pairingSchema.parse(options.controller) : undefined;
  const nativeProof = command === "enroll-desktop-controller" ? desktopControllerProofSchema.parse(options.nativeProof) : undefined;
  if (process.platform === "win32" || options.authenticate || ["enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket", "drain", "drain-cancel", "drain-renew", "drained-stop"].includes(command)) {
    try { token = await controlToken(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (process.platform === "win32") await assertNoForeignControlPipe(controlPath(directory));
      return { running: false };
    } throw error; }
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(controlPath(directory)); let data = ""; let settled = false;
    const finish = (value: HubServiceStatus | { running: false }) => { settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(["drain", "drain-cancel", "drain-renew", "drained-stop", "enroll-controller", "desktop-controller-challenge", "enroll-desktop-controller", "screen-service-ticket"].includes(command) ? 10_000 : 2000, () => { socket.destroy(); reject(new Error("hub_control_timeout")); });
    socket.on("connect", () => socket.write(JSON.stringify({ command, token, ...(command === "screen-service-ticket" ? { desktopId: options.desktopId, expectedPublicKey: options.expectedPublicKey } : {}), ...(options.drainId ? { drainId: options.drainId } : {}), ...(["stop", "drained-stop"].includes(command) ? { expectedPid: options.expectedPid, expectedPublicKey: options.expectedPublicKey } : {}), ...(controller ? { controller, expectedPublicKey: options.expectedPublicKey, ...(nativeProof ? { nativeProof } : {}) } : {}) }) + "\n"));
    socket.on("data", (chunk) => { data += chunk.toString(); if (data.length > 4096) { socket.destroy(); reject(new Error("invalid_hub_control")); return; } if (data.includes("\n")) { try { finish(statusSchema.parse(JSON.parse(data.trim()))); } catch { socket.destroy(); reject(new Error("invalid_hub_control")); } } });
    socket.on("error", (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish({ running: false }); else reject(error); });
    socket.on("close", () => { if (!settled) reject(new Error("hub_control_closed")); });
  });
}
/** Atomically commit only the drained process we observed. Explicit rejection
 * means no termination happened; transport failure is deliberately ambiguous. */
export async function stopDrainedHub(directory: string, guard: DrainedStopGuard, request?: () => ReturnType<typeof inspectHubService>): Promise<HubServiceStatus> {
  try {
  drainedStopGuardSchema.parse(guard);
  const result = await (request ? request() : inspectHubService(directory, "drained-stop", { drainId: guard.drainId, expectedPid: guard.pid, expectedPublicKey: guard.publicKey }));
  if (!result.running || result.controlError) throw Object.assign(new Error(result.running ? result.controlError : "host_drain_target_changed"), { stopRejected: !!result.running });
  if (result.pid !== guard.pid || result.publicKey !== guard.publicKey || !result.controlCapabilities?.includes("drained-stop")) throw new Error("host_drain_stop_unconfirmed");
  return result;
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { drainedStopFailure: true }); }
}
/** A missing local token does not mean a kernel pipe is absent in another file view. */
export async function assertNoForeignControlPipe(address: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(address);
    const fail = () => { socket.destroy(); reject(new HostDirectoryError("foreign_runtime")); };
    socket.once("connect", fail); socket.setTimeout(1000, fail);
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(); else reject(new HostDirectoryError("foreign_runtime"));
    });
  });
}
export async function hubServiceCommand(command: string, directory: string, entrypoint: string, options: { drainedStop?: DrainedStopGuard; requireDrained?: boolean; force?: boolean } = {}): Promise<unknown> {
  if (["start", "restart"].includes(command)) { await guardHostDirectory(directory); await assertHostStateIntegrity(directory); }
  if (command === "installer-stop") {
    // Managed runtimes live outside the App installation. Updating the desktop
    // must neither stop them nor clear the user's background-service intent.
    const manager = await (await import("../host-cli/service-manager.js")).managedServiceStatus(directory);
    if (manager.configured) return { ...await inspectHubService(directory), retainedForDesktopUpdate: true };
    return hubServiceCommand("stop", directory, entrypoint);
  }
  if (command === "status") return inspectHubService(directory);
  if (command === "logs") return readHubLogTail(directory);
  if (!["start", "stop", "restart"].includes(command)) throw new Error("Unknown hub service command");
  // An installed manager owns the process even while it is stopped or broken.
  // Never race launchd/systemd/Task Scheduler with a second detached Hub.
  const { managedServiceStatus, managedServiceCommand } = await import("../host-cli/service-manager.js");
  if ((await managedServiceStatus(directory)).configured) return managedServiceCommand(command as "start" | "stop" | "restart", directory, entrypoint, options);
  if ((command === "stop" || command === "restart") && options.requireDrained && !options.drainedStop) {
    const lock = await acquireInstanceLock(directory).catch(error => { throw Object.assign(new Error("host_safe_stop_starting_or_unconfirmed: wait for Hub startup and retry", { cause: error }), { stopRejected: true, drainedStopFailure: true }); });
    try {
      if ((await inspectHubService(directory)).running) throw Object.assign(new Error("host_safe_stop_unexpected_live_hub"), { stopRejected: true, drainedStopFailure: true });
      // Holding ownership excludes even a start that has not opened its socket.
      if (command === "stop") return { running: false };
    } finally { await lock.release(); }
    // Explicit restart may start the host only after releasing offline ownership.
    return hubServiceCommand("start", directory, entrypoint);
  }
  let status = await inspectHubService(directory);
  if ((command === "stop" || command === "restart") && options.drainedStop) await stopDrainedHub(directory, options.drainedStop);
  if ((command === "stop" || command === "restart") && status.running) {
    const stoppedPid = status.pid;
    if (!options.drainedStop) await inspectHubService(directory, "stop");
    const deadline = Date.now() + 15_000;
    do {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { status = await inspectHubService(directory); }
      catch (error) {
        // Stop was acknowledged above. Shutdown can close a status socket
        // between accept and reply; keep polling until absence is confirmed.
        // Never turn a lost stop acknowledgement into successful termination.
        if (!(error instanceof Error) || error.message !== "hub_control_closed") throw error;
      }
    } while (status.running && Date.now() < deadline);
    if (status.running) throw new Error("hub_stop_timed_out");
    // Windows keeps node.exe/addon files locked until the process has exited,
    // even after its pipe closes. Installers must not overwrite them early.
    if (process.platform === "win32") {
      const alive = () => { try { process.kill(stoppedPid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; } };
      while (alive()) { if (Date.now() >= deadline) throw new Error("hub_stop_timed_out"); await new Promise(resolve => setTimeout(resolve, 50)); }
    }
  }
  if (command === "stop" || status.running) return status;
  const { resolveHostRuntime } = await import("../host-cli/update.js");
  const runtime = await resolveHostRuntime(directory, entrypoint);
  entrypoint = runtime.entrypoint;
  await assertWindowsRuntimeAdmission(entrypoint);
  await (await import("../host-cli/setup.js")).requireInitialized(directory);
  await stat(entrypoint).catch(() => { throw new Error("Build TaroBird before starting its Hub service: npm run build"); });
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const log = await open(path.join(directory, "hub.log"), "a", 0o600); await log.chmod(0o600);
  try {
    const child = spawn(runtime.executable, [entrypoint, "hub", "run", "--state-dir", directory], { detached: true, windowsHide: true, stdio: ["ignore", log.fd, log.fd], cwd: path.dirname(entrypoint), env: hostProcessEnvironment({ executable: runtime.executable }) });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
  } finally { await log.close(); }
  const deadline = Date.now() + 15_000;
  do { await new Promise((resolve) => setTimeout(resolve, 100)); status = await inspectHubService(directory); } while (!status.running && Date.now() < deadline);
  if (!status.running) throw new Error("Hub did not become ready. Inspect hub service logs.");
  return status;
}
