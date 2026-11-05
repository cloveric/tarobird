import { guardHostDirectory, assertHostStateIntegrity, acquireHostAdmission } from "./windows-state-admission.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";
import { HubDatabase } from "../hub/database.js";
import { HostProfile, HOST_PROFILE_KEY } from "../hub/host-profile.js";
import { hostNameSchema, hostProfileSchema } from "../client-protocol/host-profile.js";
import { HubStore } from "../hub/store.js";
import { HubAuth } from "../hub/auth.js";
import { inspectHubService } from "../hub/service.js";
import { exists } from "./paths.js";
import { acquireInstanceLock } from "../state/instance-lock.js";
import { assertOfflineHostCompatible, assertHostRuntimeCompatible, requireExistingHostState } from "./schema-guard.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

export async function readHostProfile(directory: string) {
  if (!await exists(path.join(directory, "hub.sqlite"))) return undefined;
  const db = await HubDatabase.snapshot(path.join(directory, "hub.sqlite"));
  try { const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [HOST_PROFILE_KEY]); return row ? hostProfileSchema.parse(JSON.parse(row.value)) : undefined; }
  finally { await db.close(); }
}

/** Explicit first setup only. No service, network, login or membership side effects. */
export async function initializeHost(directory: string, name: string) {
  const requested = hostNameSchema.parse(name);
  await guardHostDirectory(directory);
  // Idempotent init of an already-running host is a read, not a second writer.
  if (await exists(path.join(directory, "identity.json")) && await exists(path.join(directory, "hub.sqlite"))) {
    const existing = await readHostProfile(directory);
    if (existing && await exists(path.join(directory, "config.json"))) {
      await requireInitialized(directory);
      if (existing.name !== requested) throw new Error(`这台主机已经叫“${existing.name}”。请用 host name 修改，初始化不会覆盖已有主机名称。`);
      const identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
      return { directory, name: existing.name, publicKey: String(identity.publicKey), created: false };
    }
  }
  const releaseAdmission = await acquireHostAdmission(directory);
  try {
  await assertHostStateIntegrity(directory);
  await inspectHubService(directory);
  // An existing DB without a profile is legacy state, not a new host. Validate
  // before mkdir/chmod/config generation or HubStore.open can change it.
  if (await exists(path.join(directory, "hub.sqlite")) && await exists(path.join(directory, "config.json")) && !await readHostProfile(directory)) await assertOfflineHostCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)));
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  return await withFileMutex(path.join(directory, "desktop-start"), async () => {
    const existing = await readHostProfile(directory);
    if (existing && existing.name !== requested) throw new Error(`这台主机已经叫“${existing.name}”。请用 host name 修改，初始化不会覆盖已有主机名称。`);
    if (existing && await exists(path.join(directory, "config.json"))) {
      await requireInitialized(directory);
      const identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
      return { directory, name: existing.name, publicKey: String(identity.publicKey), created: false };
    }
    if ((await inspectHubService(directory)).running) throw new Error("主机正在运行，请通过 host name 设置名称，不会在线迁移数据库。");
    if (await exists(path.join(directory, "hub.sqlite")) && !await exists(path.join(directory, "identity.json"))) throw new Error("已有主机数据库但身份文件缺失。请恢复原身份，不会为原主机创建新身份。");
    const lock = await acquireInstanceLock(directory);
    try {
    const existingDatabase = await exists(path.join(directory, "hub.sqlite"));
    const configFile = path.join(directory, "config.json");
    if (!await exists(configFile)) {
      // Repair only the absent configuration. Reading an older supported schema
      // is safe here: this branch never opens HubStore or migrates the database.
      // Explicit service install/update remains responsible for migration.
      if (existingDatabase) {
        await requireExistingHostState(directory);
        const compatibility = await assertHostRuntimeCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)), { allowMigration: true });
        await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port: 8788, instancePort: 8789 }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        if (existing || compatibility.schema !== compatibility.writeHubSchema) {
          await requireInitialized(directory);
          const identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
          return { directory, ...(existing ? { name: existing.name } : { requestedName: requested, profileNamePending: true }), publicKey: String(identity.publicKey), created: false, configurationRestored: true };
        }
      } else {
        const port = await freePort(); let instancePort = await freePort(); while (port === instancePort) instancePort = await freePort();
        await writeFile(configFile, JSON.stringify({ host: "127.0.0.1", port, instancePort }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      }
    }
    if (existingDatabase) await assertOfflineHostCompatible(directory, fileURLToPath(new URL("../index.js", import.meta.url)));
    const store = await HubStore.open(directory);
    try {
      const profile = await new HostProfile(store.db, requested).read();
      const auth = await HubAuth.open(store, directory);
      // The native desktop resume path already owns this flag.
      if (!await exists(path.join(directory, "desktop-enabled.json"))) await writeFile(path.join(directory, "desktop-enabled.json"), "false\n", { mode: 0o600 });
      return { directory, name: profile.name, publicKey: auth.publicKey, created: !existing };
    } finally { await store.db.close(); }
    } finally { await lock.release(); }
  });
  } finally { await releaseAdmission(); }
}

export async function requireInitialized(directory: string): Promise<void> {
  if (!await exists(path.join(directory, "config.json")) || !await exists(path.join(directory, "hub.sqlite")) || !await exists(path.join(directory, "identity.json"))) throw new Error("主机尚未初始化。请先执行 tarobot init --name 主机名称（原主机请指定原来的 --state-dir）。");
  // Malformed state is an error, never permission to create a replacement identity.
  JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
}
