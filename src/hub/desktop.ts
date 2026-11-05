import { HostDirectoryError, guardHostDirectory, assertHostStateIntegrity, hostDirectoryState, assertWindowsRuntimeAdmission } from "../host-cli/windows-state-admission.js";
import { desktopTls, desktopLanAddresses, desktopTailscaleAddresses } from "./desktop-tls.js";
import { readHubConfig, type HubConfig } from "./config.js";
import { isTailscaleAddress } from "./network.js";
import { desktopNetworkFile } from "./host-routes.js";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { freeDesktopPort, verifyNetworkRoute } from "./desktop-network.js";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { pairingSchema } from "../client-protocol/index.js";
import { hubServiceCommand, inspectHubService, drainedStopGuardSchema, type DrainedStopGuard } from "./service.js";
import { withFileMutex, FileMutexTimeoutError } from "../state/file-mutex.js";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { hostNameSchema, hostProfileSchema } from "../client-protocol/host-profile.js";
import { HubDatabase } from "./database.js";
import { defaultHostName, HOST_PROFILE_KEY, HostProfile } from "./host-profile.js";
import { desktopControllerProofSchema } from "./local-controller.js";
import { isCurrentHostRuntime } from "../host-cli/foreground.js";

const actionSchema = z.enum(["status", "start", "resume", "stop", "pair", "pair-challenge", "network", "tailscale"]);
const startSchema = z.object({ hostName: hostNameSchema.optional() }).strict();
async function existingHostName(directory: string): Promise<string> {
  const file = path.join(directory, "hub.sqlite");
  const exists = await stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (!exists) return defaultHostName();
  // Opening the welcome page or resuming a disabled host must not create a
  // database, migrate its schema, or overwrite its saved name.
  const db = await HubDatabase.snapshot(file);
  try {
    const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [HOST_PROFILE_KEY]);
    return row ? hostProfileSchema.parse(JSON.parse(row.value)).name : defaultHostName();
  } finally { await db.close(); }
}
type Networks = { lan: boolean; tailscale: boolean };
async function enabledNetworks(directory: string, config: HubConfig): Promise<Networks> {
  const owned = config.tlsListeners.filter(listener => listener.tls.cert === path.join(directory, "desktop-tls/server.pem"));
  const enabled = async (mode: keyof Networks) => owned.some(listener => isTailscaleAddress(listener.host) === (mode === "tailscale")) || await readFile(desktopNetworkFile(directory, mode), "utf8").then(v => v.trim() === "true", () => false);
  return { lan: await enabled("lan"), tailscale: await enabled("tailscale") };
}
async function saveNetworks(directory: string, modes: Networks) {
  for (const mode of ["lan", "tailscale"] as const) if (modes[mode] && !await readFile(desktopNetworkFile(directory, mode), "utf8").then(value => value.trim() === "true", () => false)) await writeFile(desktopNetworkFile(directory, mode), "true\n", { mode: 0o600 });
}
function networkAddresses(modes: Networks) { return [...new Set([...(modes.lan ? desktopLanAddresses() : []), ...(modes.tailscale ? desktopTailscaleAddresses() : [])])]; }
function listeners(addresses: string[], port: number, tls: { cert: string; key: string }): HubConfig["tlsListeners"] {
  return addresses.map(host => ({ host, exposure: isTailscaleAddress(host) ? "private" : "public", port, tls: { cert: tls.cert, key: tls.key } }));
}
async function networkPort(directory: string, addresses: string[], existing?: number): Promise<number> {
  const file = path.join(directory, "desktop-network-port.json");
  const saved: unknown = await readFile(file, "utf8").then((text) => JSON.parse(text), () => undefined);
  const port = existing ?? (Number.isInteger(saved) && Number(saved) > 0 && Number(saved) < 65536 ? Number(saved) : await freeDesktopPort(addresses));
  if (saved !== port) await writeFile(file, JSON.stringify(port), { mode: 0o600 });
  return port;
}
/** The running host retries opted-in networks after boot/wake and renews leaves
 * under the existing desktop mutex. A UI start/stop holding that mutex wins. */
export async function refreshDesktopHostNetworks(directory: string, apply: (listeners: HubConfig["tlsListeners"]) => Promise<void>, stopped: () => boolean = () => false): Promise<void> {
  try {
    await withFileMutex(path.join(directory, "desktop-start"), async () => {
      if (stopped()) return;
      const config = await readHubConfig(directory), cert = path.join(directory, "desktop-tls/server.pem");
      const owned = config.tlsListeners.filter(listener => listener.tls.cert === cert);
      const modes = await enabledNetworks(directory, config);
      if (!modes.lan && !modes.tailscale) return;
      const addresses = networkAddresses(modes);
      const desired = addresses.length ? listeners(addresses, await networkPort(directory, addresses, owned[0]?.port), await desktopTls(directory, addresses)) : owned;
      if (stopped()) return;
      // Migrate legacy opt-in state before dropping temporarily absent endpoints.
      await saveNetworks(directory, modes);
      await apply(desired);
      if (stopped()) return;
      const updated = [...config.tlsListeners.filter(listener => listener.tls.cert !== cert), ...desired];
      if (JSON.stringify(updated) !== JSON.stringify(config.tlsListeners)) await writeFile(path.join(directory, "config.json"), JSON.stringify({ ...config, tlsListeners: updated }), { mode: 0o600 });
    }, { waitTimeoutMs: 1000 });
  } catch (error) { if (!(error instanceof FileMutexTimeoutError)) throw error; }
}
/** Called by native desktop IPC and the local host CLI. No public HTTP bootstrap or
 * first-device auto-approval: owning the local OS account is the authority. */
export interface DesktopHostNetworkHooks {
  selectAddress?: (addresses: readonly string[]) => string;
  beforeRestart?: () => Promise<DrainedStopGuard | undefined>;
}
export async function desktopHost(action: string, directory: string, entrypoint: string, input?: unknown, networkHooks?: DesktopHostNetworkHooks) {
  const command = actionSchema.parse(action);
  try {
    await guardHostDirectory(directory, command === "stop");
    if (command !== "stop") await assertHostStateIntegrity(directory);
  } catch (error) {
    if ((command === "status" || command === "resume") && error instanceof HostDirectoryError) {
      // A blocked launch is not proof that an already-running host is stopped.
      if (["conflict", "shadow_only", "incomplete"].includes(error.issue)) {
        try { await guardHostDirectory(directory, true); return { available: true, ...await inspectHubService(directory), directoryState: error.issue }; }
        catch { /* No authenticated live status; do not guess an identity. */ }
      }
      return { available: true, running: false as const, directoryState: error.issue };
    }
    throw error;
  }
  const directoryState = await hostDirectoryState(directory);
  const setup = command === "start" ? startSchema.parse(input ?? {}) : undefined;
  const stopOptions = ["stop", "network", "tailscale"].includes(command) ? z.object({ drainedStop: drainedStopGuardSchema.optional(), requireDrained: z.boolean().optional(), force: z.boolean().optional() }).strict().parse(input ?? {}) : {};
  if (stopOptions.force && command !== "stop") throw new Error("host_force_only_explicit_stop");
  const enabledFile = path.join(directory, "desktop-enabled.json");
  if (command === "status") return { available: true, ...(directoryState === "missing" ? { directoryState } : {}), ...await inspectHubService(directory), hostName: await existingHostName(directory) };
  if (command === "resume" && !await readFile(enabledFile).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) return { available: true, running: false as const, directoryState, hostEnabled: false, hostName: await existingHostName(directory) };
  if (command === "stop") {
    if (directoryState === "missing") return { available: true, running: false as const, directoryState };
    return withFileMutex(path.join(directory, "desktop-start"), async () => {
      if ((await (await import("../host-cli/service-manager.js")).managedServiceStatus(directory)).configured) {
        // The manager disarms supervision before issuing the guarded stop. Old
        // Windows launchers interpret an early false flag as an unguarded stop.
        await hubServiceCommand("stop", directory, entrypoint, stopOptions);
        return { available: true, ...await inspectHubService(directory), hostName: await existingHostName(directory) };
      }
      const previousEnabled = await readFile(enabledFile, "utf8").catch(() => "false\n");
      await writeFile(enabledFile, "false\n", { mode: 0o600 });
      try { await hubServiceCommand("stop", directory, entrypoint, stopOptions); }
      catch (error) {
        if (error && typeof error === "object" && "stopRejected" in error && error.stopRejected === true) await writeFile(enabledFile, previousEnabled, { mode: 0o600 });
        throw error;
      }
      return { available: true, ...await inspectHubService(directory), hostName: await existingHostName(directory) };
    });
  }
  if (command === "resume" && (await readFile(enabledFile, "utf8")).trim() !== "true") return { available: true, running: false as const, directoryState, hostEnabled: false, hostName: await existingHostName(directory) };
  if (command === "start" || command === "resume") {
    // Initialize only through the shared, admitted setup path. In particular,
    // never leave a DB for a child Hub to invent an identity for.
    if (command === "start" && directoryState !== "ready") await (await import("../host-cli/setup.js")).initializeHost(directory, setup?.hostName ?? defaultHostName());
    if (process.platform === "darwin" && directoryState === "ready") {
      // A DMG copy does not run the in-App installer handshake. Reuse its guarded
      // lifecycle before pairing; this acquires desktop-start itself, never nest it.
      const { desktopUpdateSession } = await import("./desktop-update.js");
      const recovery = await desktopUpdateSession({ directory, entrypoint, signal: AbortSignal.timeout(60_000),
        ready() {}, finished: Promise.resolve(), timeoutMs: 1000, reconcileInstalled: true })
        .catch(error => ({ runtimeIssue: error instanceof FileMutexTimeoutError || error instanceof Error && /^hub_control_(?:timeout|closed)$/.test(error.message)
          ? "runtime_waiting" as const : "runtime_recovery_failed" as const }));
      if ("runtimeIssue" in recovery) return { available: true, ...await inspectHubService(directory), hostName: await existingHostName(directory), runtimeIssue: recovery.runtimeIssue };
    }
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    return withFileMutex(path.join(directory, "desktop-start"), async () => {
      const manager = await (await import("../host-cli/service-manager.js")).managedServiceStatus(directory);
      const supervised = manager.configured;
      // Stop and resume share this mutex. Recheck intent after waiting; resume
      // never re-enables the host. Installed OS managers own their recovery and
      // must not be rearmed by a UI timer racing a service stop/uninstall.
      if (command === "resume" && (supervised || (await readFile(enabledFile, "utf8").catch(() => "false")).trim() !== "true")) return { available: true, ...await inspectHubService(directory), hostName: await existingHostName(directory) };
      const config = path.join(directory, "config.json");
      if (!await readFile(config).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) {
        const port = await freeDesktopPort(); let instancePort = await freeDesktopPort(); while (instancePort === port) instancePort = await freeDesktopPort();
        await writeFile(config, JSON.stringify({ host: "127.0.0.1", port, instancePort }), { mode: 0o600, flag: "wx" });
      }
      if (!supervised && !(await inspectHubService(directory)).running) {
        const settings = await readHubConfig(directory);
        const managedCert = path.join(directory, "desktop-tls/server.pem");
        const owned = settings.tlsListeners.find((listener) => listener.tls.cert === managedCert);
        const modes = await enabledNetworks(directory, settings);
        if (modes.lan || modes.tailscale) {
          // Retain each opted-in endpoint even if its interface is unavailable.
          const addresses = networkAddresses(modes);
          if (addresses.length) {
            const port = await networkPort(directory, addresses, owned?.port).catch((error: NodeJS.ErrnoException) => {
              // An opted-in interface can disappear between discovery and the
              // first allocation. Keep local startup available; refresh retries.
              if (["EADDRNOTAVAIL", "ENODEV", "ENETUNREACH", "EAFNOSUPPORT", "EACCES", "EADDRINUSE"].includes(error.code ?? "")) return undefined;
              throw error;
            });
            if (port !== undefined) {
              settings.tlsListeners = settings.tlsListeners.filter((listener) => listener.tls.cert !== managedCert);
              const tls = await desktopTls(directory, addresses);
              settings.tlsListeners.push(...listeners(addresses, port, tls));
            }
          }
          // Stale Wi-Fi or VPN addresses must not prevent local desktop startup.
          await saveNetworks(directory, modes);
          await writeFile(config, JSON.stringify(settings), { mode: 0o600 });
        }
      }
      let hostName: string;
      if (await stat(path.join(directory, "hub.sqlite")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) hostName = await existingHostName(directory);
      else {
        const lock = await acquireInstanceLock(directory);
        try {
          const db = await HubDatabase.open(directory);
          try { hostName = (await new HostProfile(db, setup?.hostName).read()).name; }
          finally { await db.close(); }
        } finally { await lock.release(); }
      }
      await hubServiceCommand("start", directory, entrypoint);
      const status = await inspectHubService(directory);
      if (!status.running) throw new Error("desktop_host_start_failed");
      if (command === "start") await writeFile(enabledFile, "true\n", { mode: 0o600 });
      return { available: true, ...status, hostName };
    });
  }
  if (command === "network" || command === "tailscale") {
    return withFileMutex(path.join(directory, "desktop-start"), async () => {
      const config = await readHubConfig(directory);
      const modes = await enabledNetworks(directory, config);
      modes[command === "tailscale" ? "tailscale" : "lan"] = true;
      const addresses = networkAddresses(modes);
      let selected = addresses.filter(host => isTailscaleAddress(host) === (command === "tailscale"));
      if (!selected.length) throw new Error(command === "tailscale" ? "desktop_host_no_tailscale" : "desktop_host_no_lan");
      if (networkHooks?.selectAddress) {
        const address = networkHooks.selectAddress(selected);
        if (!selected.includes(address)) throw new Error("desktop_host_invalid_network_address");
        selected = [address];
      }
      const previousConfig = await readFile(path.join(directory, "config.json"));
      const previousListeners = JSON.stringify(config.tlsListeners);
      const previousCertificate = await readFile(path.join(directory, "desktop-tls/server.pem")).catch(() => undefined);
      const previousKey = await readFile(path.join(directory, "desktop-tls/server-key.pem")).catch(() => undefined);
      const tls = await desktopTls(directory, addresses);
      const owned = config.tlsListeners.find((listener) => listener.tls.cert === tls.cert);
      const port = await networkPort(directory, addresses, owned?.port);
      config.tlsListeners = [...config.tlsListeners.filter((listener) => listener.tls.cert !== tls.cert), ...listeners(addresses, port, tls)];
      if (tls.renewed || JSON.stringify(config.tlsListeners) !== previousListeners) {
        let restartAttempted = false;
        try {
          // CLI callers acquire their drain lease only after the locked
          // listener/certificate comparison proves a restart is necessary.
          const restartOptions = networkHooks?.beforeRestart ? { ...stopOptions, drainedStop: await networkHooks.beforeRestart(), requireDrained: true } : stopOptions;
          await writeFile(path.join(directory, "config.json"), JSON.stringify(config), { mode: 0o600 });
          restartAttempted = true;
          await hubServiceCommand("restart", directory, entrypoint, restartOptions);
        }
        catch (error) {
          // A failed network change must not strand the user's local workbench.
          await writeFile(path.join(directory, "config.json"), previousConfig, { mode: 0o600 });
          if (previousCertificate && previousKey) {
            await writeFile(tls.cert, previousCertificate, { mode: 0o600 });
            await writeFile(tls.key, previousKey, { mode: 0o600 });
          }
          if (restartAttempted && !(error && typeof error === "object" && "drainedStopFailure" in error)) await hubServiceCommand("start", directory, entrypoint);
          throw error;
        }
      } else await hubServiceCommand("start", directory, entrypoint);
      await saveNetworks(directory, modes);
      const status = await inspectHubService(directory);
      if (!status.running) throw new Error("desktop_host_not_running");
      const routes = selected.map((host) => ({ name: command === "tailscale" ? "Tailscale" as const : "Direct" as const, url: `https://${host.includes(":") ? `[${host}]` : host}:${port}`, certificateAuthority: tls.certificateAuthority }));
      // Optional listeners may fail to bind without stopping the local Host.
      // Verify the real endpoint, including the close-to-bind race and old Hosts,
      // before returning an invite; never silently change a previously saved port.
      try { await Promise.all(routes.map(route => verifyNetworkRoute(route.url, route.certificateAuthority, status.publicKey))); }
      catch (cause) { throw new Error(command === "tailscale" ? "desktop_host_tailscale_not_listening" : "desktop_host_lan_not_listening", { cause }); }
      return { available: true, ...status, routes };
    });
  }
  const { nativeProof, ...device } = pairingSchema.extend({ nativeProof: desktopControllerProofSchema.optional() }).parse(input);
  const status = await inspectHubService(directory);
  if (!status.running) throw new Error("desktop_host_not_running");
  if (!status.controlCapabilities?.includes("enroll-desktop-controller")) throw new Error("desktop_host_update_required");
  if (command === "pair-challenge") {
    const challenge = await inspectHubService(directory, "desktop-controller-challenge", { controller: device, expectedPublicKey: status.publicKey });
    if (!challenge.running || challenge.controlError || !challenge.desktopControllerChallenge) throw new Error(challenge.running ? challenge.controlError ?? "desktop_controller_challenge_unavailable" : "desktop_host_not_running");
    return { available: true, ...challenge };
  }
  if (!nativeProof) throw new Error("desktop_controller_proof_required");
  const enrolled = await inspectHubService(directory, "enroll-desktop-controller", { controller: device, nativeProof, expectedPublicKey: status.publicKey });
  if (!enrolled.running || enrolled.controlError) throw new Error(enrolled.running ? enrolled.controlError : "desktop_host_update_required");
  return { available: true, ...enrolled };
}

export async function runDesktopHostCli(args: string[]) {
  const [action, directory, ...extra] = args;
  if (!action || !directory || extra.length || !path.isAbsolute(directory)) throw new Error("invalid_desktop_host_arguments");
  let body = "";
  for await (const chunk of process.stdin) { body += String(chunk); if (body.length > 4096) throw new Error("desktop_host_input_too_large"); }
  // Empty EOF means the owning native helper died before authorizing this call.
  if (!body.trim()) throw new Error("desktop_host_input_missing");
  const input: unknown = JSON.parse(body);
  const entrypoint = fileURLToPath(new URL("../index.js", import.meta.url));
  if (action === "status" || action === "stop") {
    console.log(JSON.stringify(await desktopHost(action, directory, entrypoint))); return;
  }
  try { await guardHostDirectory(directory); }
  catch (error) {
    if (action === "resume" && error instanceof HostDirectoryError) { console.log(JSON.stringify(await desktopHost("status", directory, entrypoint))); return; }
    throw error;
  }
  const selected = await (await import("../host-cli/update.js")).resolveHostRuntime(directory, entrypoint);
  await assertWindowsRuntimeAdmission(selected.entrypoint);
  if (!await isCurrentHostRuntime(selected, entrypoint)) {
    // JavaScript and Node/native-addon ABI are one frozen runtime.
    const child = spawn(selected.executable, [selected.entrypoint, "desktop-host", action, directory], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    const limit = 2 * 1024 * 1024;
    child.stdout.on("data", chunk => { out += String(chunk); if (out.length > limit) child.kill(); });
    child.stderr.on("data", chunk => { err += String(chunk); if (err.length > limit) child.kill(); });
    child.stdin.on("error", () => undefined); child.stdin.end(body);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    if (code !== 0) throw new Error(err.trim() || "desktop_host_selected_runtime_failed");
    console.log(JSON.stringify(JSON.parse(out))); return;
  }
  console.log(JSON.stringify(await desktopHost(action, directory, selected.entrypoint, input)));
}
