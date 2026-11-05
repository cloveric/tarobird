import { createPrivateKey, createPublicKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { HubDatabase } from "../hub/database.js";
import { CURRENT_SCHEMA_VERSION } from "../state/schema-version.js";

export type HostSchemaCompatibility = { schema?: number; minHubSchema: number; maxHubSchema: number; writeHubSchema: number };
const plainFile = async (file: string) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("host_state_regular_file_required");
  return info;
};

/** Read-only: never opens HubStore, creates directories, or migrates a database. */
export async function readHostSchema(directory: string): Promise<number> {
  const file = path.join(directory, "hub.sqlite"); await plainFile(file);
  const db = await HubDatabase.snapshot(file);
  try {
    const raw = (await db.get<{ value: string }>("SELECT value FROM meta WHERE key='schema_version'"))?.value;
    if (!raw || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error("host_schema_invalid");
    return Number(raw);
  } finally { await db.close(); }
}

export async function requireExistingHostState(directory: string): Promise<void> {
  try { await plainFile(path.join(directory, "hub.sqlite")); await plainFile(path.join(directory, "identity.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("host_not_initialized_run_tarobot_init_or_select_original_state_dir"); throw error; }
  const identityFile = path.join(directory, "identity.json");
  if ((await lstat(identityFile)).size > 16 * 1024) throw new Error("invalid_hub_identity");
  const identity = JSON.parse(await readFile(identityFile, "utf8"));
  if (typeof identity?.schemaVersion === "number" && identity.schemaVersion > CURRENT_SCHEMA_VERSION) throw new Error("host_identity_schema_update_required");
  const key = createPrivateKey(identity.privateKey);
  if (key.asymmetricKeyType !== "ed25519" || createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") !== identity.publicKey) throw new Error("invalid_hub_identity");
}

/** The target package, not this CLI's version, declares its supported schema. */
export async function assertHostRuntimeCompatible(directory: string, entrypoint: string, options: { allowMissing?: boolean; allowMigration?: boolean } = {}): Promise<HostSchemaCompatibility> {
  let root = path.dirname(path.resolve(entrypoint));
  let metadata: unknown;
  for (;;) {
    const file = path.join(root, "package.json");
    try { if ((await plainFile(file)).size > 1024 * 1024) throw new Error("host_runtime_metadata_invalid"); metadata = JSON.parse(await readFile(file, "utf8")); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(root); if (parent === root) throw new Error("host_runtime_metadata_missing"); root = parent;
  }
  const range = (metadata as { tarobotHostUpdate?: { format?: number; minHubSchema?: number; maxHubSchema?: number } })?.tarobotHostUpdate;
  if (!range || range.format !== 1 || !Number.isSafeInteger(range.minHubSchema) || !Number.isSafeInteger(range.maxHubSchema) || range.minHubSchema! < 1 || range.maxHubSchema! < range.minHubSchema!) throw new Error("host_runtime_compatibility_missing_update_required");
  const { minHubSchema, maxHubSchema } = range as { minHubSchema: number; maxHubSchema: number };
  // Old packages declare only their readable range. Conservatively treat its
  // upper bound as the schema written by open(); newer packages may be explicit.
  const writeHubSchema = (metadata as { tarobotHubSchema?: number }).tarobotHubSchema ?? maxHubSchema;
  if (!Number.isSafeInteger(writeHubSchema) || writeHubSchema < minHubSchema || writeHubSchema > maxHubSchema) throw new Error("host_runtime_compatibility_invalid");
  let schema: number;
  try { schema = await readHostSchema(directory); }
  catch (error) { if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return { minHubSchema, maxHubSchema, writeHubSchema }; throw error; }
  if (schema < minHubSchema || schema > maxHubSchema) throw new Error(`host_schema_incompatible:${schema}:runtime_${minHubSchema}-${maxHubSchema}`);
  if (!options.allowMigration && schema !== writeHubSchema) throw new Error(`host_schema_migration_requires_update:${schema}:${writeHubSchema}。请通过 service install 或 update stage/apply 先制作恢复副本，再切换运行时。`);
  return { schema, minHubSchema, maxHubSchema, writeHubSchema };
}

/** Maintenance cannot silently upgrade state beyond a selected frozen runtime. */
export async function assertOfflineHostCompatible(directory: string, entrypoint: string): Promise<HostSchemaCompatibility> {
  await requireExistingHostState(directory);
  const current = await assertHostRuntimeCompatible(directory, entrypoint);
  const runtime = await (await import("./update.js")).resolveHostRuntime(directory, entrypoint);
  await assertHostRuntimeCompatible(directory, runtime.entrypoint, { allowMigration: true });
  return current;
}
