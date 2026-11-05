import { compactOfflineDatabase, databaseSpace } from "./storage-space.js";
import { assignNewBotAvatar } from "./bot-avatar-default.js";
import { guardHostDirectory, acquireHostAdmission } from "../host-cli/windows-state-admission.js";
import { requireInitialized } from "../host-cli/setup.js";
import { monitorServiceCrashes } from "../runtime/service-lifecycle-log.js";
import { refreshDesktopHostNetworks } from "./desktop.js";
import { RouteMonitor } from "./route-monitor.js";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { idSchema } from "../client-protocol/index.js";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { HubAuth, hashSecret } from "./auth.js";
import { defaultHubDirectory, readHubConfig } from "./config.js";
import { HubMaintenance } from "./maintenance.js";
import { startHubLogRotation } from "./log-rotation.js";
import { HubServer } from "./server.js";
import { HubStore } from "./store.js";
import { hubServiceCommand, inspectHubService, startHubControl } from "./service.js";
import { RelayTunnels } from "../relay/tunnels.js";
import { RelaySources } from "../relay/sources.js";
import { loadHubTls } from "./tls.js";
import { openGoogleDocs } from "../gdocs/cli.js";
import { backupHubState, restoreHubState, type HubStateBackup } from "./state-backup.js";
import { closeHubRuntime } from "./shutdown.js";
import { assertHostRuntimeCompatible, assertOfflineHostCompatible } from "../host-cli/schema-guard.js";
import { hostProcessEnvironment } from "../host-cli/environment.js";

function backupSummary(manifest: HubStateBackup) {
  return { files: manifest.entries.filter((entry) => entry.type === "file").length, excluded: manifest.excluded.length, externalPaths: manifest.externalPaths, unmanagedBots: manifest.unmanagedBots, engineStateIsExternal: manifest.engineStateIsExternal, restoreDirectory: manifest.sourceDirectory };
}

export interface HubMaintenanceSchedule { backupKey?: string; cleanupDay?: string }

export async function runHubMaintenanceTick(maintenance: HubMaintenance, schedule: HubMaintenanceSchedule, now: number): Promise<void> {
  // Reclaiming replay history is best-effort. Its reader/space failure must
  // not suppress a due backup or unrelated cleanup; the history tick retries.
  await maintenance.pruneEventHistory(now).catch(() => console.error(`[${new Date().toISOString()}] Hub: event_history_maintenance_failed`));
  const day = new Date(now).toISOString().slice(0, 10), cleanupDue = schedule.cleanupDay !== day;
  // Retention is independent of the backup policy, including policies written
  // by a newer Host. Keep trimming before snapshots and collecting after them.
  if (cleanupDue) {
    await maintenance.pruneAudit(now); await maintenance.pruneRunDetails(now); await maintenance.pruneDeliveryHistory(now);
  }
  try {
    const key = await maintenance.backupScheduleKey(now);
    if (key !== schedule.backupKey) { await maintenance.dailyBackup(now); schedule.backupKey = key; }
  } finally {
    // A failed backup stays due for retry without blocking or repeating the
    // completed daily cleanup on every minute's tick.
    if (cleanupDue) { await maintenance.collectOrphans(); schedule.cleanupDay = day; }
  }
}

export async function runHubCli(argv: string[]): Promise<void> {
  if (argv[0] === "relay" && (argv[1] === "deploy" || argv[1] === "status" && argv.some((arg) => arg === "--host" || arg.startsWith("--host=")))) { const { runRelayDeploymentCli } = await import("../relay/deploy-cli.js"); await runRelayDeploymentCli(argv.slice(1)); return; }
  const args = parseArgs({ args: argv, allowPositionals: true, options: { "state-dir": { type: "string" }, port: { type: "string" }, host: { type: "string" }, "key-file": { type: "string" }, name: { type: "string" }, full: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  const [command, subcommand, argument] = args.positionals; const directory = path.resolve(args.values["state-dir"] ?? defaultHubDirectory());
  if (command && !args.values.help) await guardHostDirectory(directory, command === "service" && ["stop", "installer-stop", "status", "logs"].includes(subcommand ?? "") || command === "relay" && subcommand === "status");
  if (command === "relay" && subcommand === "status") { const { inspectHubService } = await import("./service.js"); const status = await inspectHubService(directory); console.log(JSON.stringify(status.running ? status.relay ?? { configured: false, online: false } : { running: false }, null, 2)); return; }
  if (command === "service" && subcommand) { const result = await hubServiceCommand(subcommand, directory, fileURLToPath(new URL("../index.js", import.meta.url))); console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2)); return; }
  if (args.values.help || !command) { console.log("TaroBird Hub\n  hub run [--state-dir <dir>] [--port <port>]\n  hub service start | stop | restart | status | logs\n  hub devices list | approve <code> | revoke <deviceId>\n  hub bots register <id> --key-file <path> [--name <displayName>]\n  hub export <directory>\n  hub backup <database-path>\n  hub backup <new-directory> --full (Hub and managed Bots must be stopped)\n  hub restore <backup-directory> --state-dir <original-directory> (must not exist)\n  hub gc\n  hub storage (read-only space diagnostics)\n  hub compact (explicit offline conversion to incremental reclamation)\n\nOffline maintenance requires --state-dir <existing-host-directory>; it never initializes a host.\nDefault bind: 127.0.0.1:8788. Remote listeners require TLS. Public HTTPS requires exposure: public in config.json."); return; }
  if (args.values.full && command !== "backup") throw new Error("--full is only supported with hub backup");
  if (!["run", "service", "relay"].includes(command) && !args.values["state-dir"]?.trim()) throw new Error("Offline hub maintenance requires explicit --state-dir; use tarobot init to create a host.");
  if (command === "restore") {
    if (!subcommand || !args.values["state-dir"]) throw new Error("hub restore requires a backup directory and explicit --state-dir");
    console.log(JSON.stringify(backupSummary(await restoreHubState(subcommand, directory)), null, 2)); return;
  }
  if (command === "backup" && args.values.full) {
    if (!subcommand) throw new Error("hub backup --full requires a new destination directory");
    console.log(JSON.stringify(backupSummary(await backupHubState(directory, subcommand)), null, 2)); return;
  }
  if (command === "run") {
    const releaseAdmission = await acquireHostAdmission(directory);
    let retainAdmission = false;
    try {
    await requireInitialized(directory);
    await assertHostRuntimeCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)), { allowMissing: false, allowMigration: true });
    await (await import("../host-cli/service-manager.js")).assertHostSupervisor(directory);
    // Only the OS-launched Hub owns the supervisor claim. Bot/engine children
    // must not inherit a token that could bypass the single-supervisor fence.
    const supervisor = process.env.TAROBOT_HOST_SUPERVISOR;
    delete process.env.TAROBOT_HOST_SUPERVISOR;
    const config = await readHubConfig(directory);
    const relaySources = new RelaySources();
    const relay = await RelayTunnels.load({ ...config, host: args.values.host ?? config.host, port: args.values.port ? z.coerce.number().int().min(1).max(65535).parse(args.values.port) : config.port }, (code) => console.error(`[${new Date().toISOString()}] Hub relay: ${code}`), relaySources);
    const lock = await acquireInstanceLock(directory).catch(error => { if (error instanceof Error && error.message.startsWith("Instance lock already held")) Object.assign(error, { exitCode: 78 }); throw error; });
    let packageRoot = path.dirname(fileURLToPath(import.meta.url));
    while (!await stat(path.join(packageRoot, "package.json")).then(() => true, () => false)) { const parent = path.dirname(packageRoot); if (parent === packageRoot) throw new Error("TaroBird package root not found"); packageRoot = parent; }
    const hub = await HubServer.start({ relaySources, managedBots: { entrypoint: fileURLToPath(new URL("../index.js", import.meta.url)), env: hostProcessEnvironment() }, stateDir: directory, exposure: config.exposure, host: args.values.host ?? config.host, port: args.values.port ? z.coerce.number().int().min(1).max(65535).parse(args.values.port) : config.port, origins: config.origins, maxFileBytes: config.maxFileBytes, push: config.push, instancePort: config.instancePort, tlsListeners: await Promise.all(config.tlsListeners.map(async (listener) => ({ ...listener, managed: listener.tls.cert === path.join(directory, "desktop-tls/server.pem"), tls: await loadHubTls(listener.tls) }))), googleDocs: () => openGoogleDocs(directory), clientDir: config.clientDir ?? path.join(packageRoot, "client", "dist"), ...(config.tls ? { tls: await loadHubTls(config.tls) } : {}), onWarning: (code) => console.error(`[${new Date().toISOString()}] Hub: ${code}`) }).catch(async (error: unknown) => { await lock.release(); throw error; });
    retainAdmission = true;
    const stopCrashMonitor = monitorServiceCrashes(directory, "hub", "hub");
    let networkRefresh: Promise<void> | undefined, refreshingStopped = false;
    // Route observation/publication is database-only and runs after the
    // desktop mutex is released, so a UI start/stop never waits on it.
    const refreshRoutes = () => refreshingStopped ? undefined : hub.refreshHostRoutes().catch(() => console.error(`[${new Date().toISOString()}] Hub: host_routes_refresh_failed`));
    const refreshNetworks = () => {
      if (refreshingStopped || networkRefresh) return;
      networkRefresh = refreshDesktopHostNetworks(directory, async listeners => {
        await hub.refreshTlsListeners(await Promise.all(listeners.map(async listener => ({ ...listener, tls: await loadHubTls(listener.tls) }))));
      }, () => refreshingStopped).catch(() => console.error(`[${new Date().toISOString()}] Hub: network_listener_refresh_failed`)).then(refreshRoutes).finally(() => { networkRefresh = undefined; });
    };
    networkRefresh = Promise.resolve(refreshRoutes()).finally(() => { networkRefresh = undefined; });
    const networkTimer = setInterval(refreshNetworks, 30_000); networkTimer.unref();
    relay?.start();
    const routeMonitor = config.routeMonitor ? new RouteMonitor(hub.store, config.routeMonitor, hub.auth.publicKey, (botId, alert) => hub.notifyRouteAlert(botId, alert), undefined, undefined, (code) => console.error(`[${new Date().toISOString()}] Hub: ${code}`)) : undefined;
    routeMonitor?.start();
    console.log(`[${new Date().toISOString()}] TaroBird Hub listening at ${hub.urls.join(", ")}; instances: ${hub.instanceUrl}`);
    const maintenance = new HubMaintenance(hub.store, directory, config.eventHistory), maintenanceSchedule: HubMaintenanceSchedule = {}; let maintenanceTask: Promise<void> | undefined;
    const tick = setInterval(() => {
      const now = Date.now();
      if (maintenanceTask) return;
      maintenanceTask = runHubMaintenanceTick(maintenance, maintenanceSchedule, now)
        .catch(() => console.error(`[${new Date().toISOString()}] Hub: backup_or_gc_failed`)).finally(() => { maintenanceTask = undefined; });
    }, 60_000); tick.unref();
    let eventHistoryTask: Promise<unknown> | undefined;
    // Byte/row pressure is checked once per second independently of slow backup
    // readers; the collector yields between bounded writer transactions.
    const historyTick = setInterval(() => {
      if (!eventHistoryTask) eventHistoryTask = maintenance.pruneEventHistory().catch(() => console.error(`[${new Date().toISOString()}] Hub: event_history_maintenance_failed`)).finally(() => { eventHistoryTask = undefined; });
    }, 1000); historyTick.unref();
    const stopLogRotation = startHubLogRotation(directory, () => console.error(`[${new Date().toISOString()}] Hub: log_rotation_failed`));
    let stopControl: (() => Promise<void>) | undefined; let stop: (() => void) | undefined;
    try {
      const shutdown = new Promise<void>((resolve) => {
        stop = () => { hub.beginShutdown(); resolve(); };
        process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGHUP", stop);
      });
      const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
      const runtimeId = await (await import("../host-cli/update.js")).identifyHostRuntime(directory, fileURLToPath(new URL("../index.js", import.meta.url)));
      stopControl = await startHubControl(directory, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey, relay: relay.status, version: String(manifest.version), ...(runtimeId ? { runtimeId } : {}), ...(supervisor ? { supervisor } : {}), ...hub.hostDrainStatus() }), () => stop?.(), { screenServiceTicket: desktopId => hub.remoteScreen.serviceTicket(desktopId), drain: id => hub.drainHost(id), cancelDrain: id => hub.cancelHostDrain(id), renewDrain: id => hub.renewHostDrain(id), stopDrained: id => hub.stopDrainedHost(id), enrollController: controller => hub.enrollLocalController(controller), desktopControllerChallenge: controller => hub.prepareLocalDesktopController(controller), enrollDesktopController: enrollment => hub.enrollLocalDesktopController(enrollment) });
      await shutdown;
    } finally {
      try {
        refreshingStopped = true; clearInterval(networkTimer);
        await networkRefresh; stopCrashMonitor();
        clearInterval(tick); clearInterval(historyTick);
        await closeHubRuntime({ hub, stopRelay: () => relay?.stop(), stopRoutes: () => routeMonitor?.stop() ?? Promise.resolve(),
          finishMaintenance: () => Promise.all([maintenanceTask, eventHistoryTask, stopLogRotation()]), stopControl, releaseLock: async () => { await lock.release(); await releaseAdmission(); retainAdmission = false; } });
      } finally {
        // A failed flush still closes resources. If actual closure is unconfirmed,
        // retain signal handling and ownership until the process really exits.
        if (stop && hub.shutdownComplete) { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGHUP", stop); }
      }
    } return;
    } finally { if (!retainAdmission) await releaseAdmission(); }
  }
  const validMaintenance = command === "devices" && (subcommand === "list" && !argument || ["approve", "revoke"].includes(subcommand ?? "") && !!argument)
    || command === "bots" && subcommand === "register" && !!argument && !!args.values["key-file"]
    || ["export", "backup"].includes(command) && !!subcommand && !argument || ["gc", "storage", "compact"].includes(command) && !subcommand;
  if (!validMaintenance || args.positionals.length > 3) throw new Error("Unknown hub command. Run hub --help.");
  if (command === "storage") {
    // Diagnostics must not open through HubStore (which owns schema migration).
    // The read-only helper is also usable while the real Host is running.
    const database = await (await import("./database.js")).HubDatabase.snapshot(path.join(directory,"hub.sqlite"));
    try {
      const hasHistory=await database.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_history_state'");
      console.log(JSON.stringify({space:await databaseSpace(database),history:hasHistory?await database.get("SELECT * FROM event_history_state WHERE id=1"):null},null,2));
    } finally {await database.close();}
    return;
  }
  await assertOfflineHostCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)));
  // Legacy maintenance stays available offline. Never migrate or mutate the
  // live host from a second process; normal CLI management uses signed WS.
  if ((await inspectHubService(directory)).running) throw new Error("host_running_use_tarobot_management_commands_or_stop_first");
  const maintenanceLock = await acquireInstanceLock(directory);
  const store = await (async () => {
    await assertOfflineHostCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)));
    return HubStore.open(directory);
  })().catch(async error => { await maintenanceLock.release(); throw error; });
  try {
    const auth = await HubAuth.open(store, directory);
    if (command === "devices" && subcommand === "list") { console.log(JSON.stringify(await store.devices("owner"), null, 2)); return; }
    if (command === "devices" && subcommand === "approve" && argument) { console.log(`Approved device ${await auth.approve(argument, "local-owner")}`); return; }
    if (command === "devices" && subcommand === "revoke" && argument) { await auth.revoke(argument, "local-owner"); console.log(`Revoked device ${argument}`); return; }
    if (command === "bots" && subcommand === "register" && argument && args.values["key-file"]) {
      const id = idSchema.parse(argument); const keyFile = path.resolve(args.values["key-file"]); const secret = randomBytes(32).toString("base64url");
      await mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 }); await writeFile(keyFile, secret + "\n", { mode: 0o600, flag: "wx" });
      try { await store.db.transaction(async () => {
        await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,?)", [id, args.values.name ?? id, hashSecret(secret)]);
        await assignNewBotAvatar(store.db, id);
      }); }
      catch (error) { await rm(keyFile, { force: true }); throw error; }
      await store.audit("bot.registered", "local-owner", { botId: id }); console.log(`Registered ${id}. The key was saved with owner-only permissions.`); return;
    }
    const maintenance = new HubMaintenance(store, directory);
    if (command === "export" && subcommand) { console.log(JSON.stringify(await maintenance.export(path.resolve(subcommand)))); return; }
    if (command === "backup" && subcommand) { await maintenance.backup(path.resolve(subcommand)); console.log("Backup completed."); return; }
    if (command === "compact") { console.log(JSON.stringify(await compactOfflineDatabase(store.db),null,2)); return; }
    if (command === "gc") { console.log(`Removed ${await maintenance.collectOrphans()} orphan attachments.`); return; }
    throw new Error("Unknown hub command. Run hub --help.");
  } finally { await store.db.close(); await maintenanceLock.release(); }
}
