import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  botWorkspaceErrorSchema,
  botWorkspacePatchSchema,
  type BotWorkspaceResult,
  type BotWorkspaceSettings,
} from "../client-protocol/saved-workspaces.js";
import { ConfigFileSchema, type ConfigFile } from "../state/config-file-schema.js";
import { withFileMutex } from "../state/file-mutex.js";

async function readConfig(file: string): Promise<ConfigFile> {
  try {
    return ConfigFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    throw new Error("workspace_config_unreadable");
  }
}

function snapshot(config: ConfigFile, stateDir: string, activeTurns: number): BotWorkspaceSettings {
  const defaultWorkspacePath = path.resolve(path.join(stateDir, "workspace"));
  const raw = config.workspacePath?.trim();
  const workspacePath = raw ? path.resolve(raw) : defaultWorkspacePath;
  const nonce = typeof (config as Record<string, unknown>)._clientWorkspaceRevision === "string"
    ? (config as Record<string, unknown>)._clientWorkspaceRevision as string
    : null;
  const revision = createHash("sha256").update(JSON.stringify([workspacePath, nonce])).digest("hex");
  return { scope: "bot", revision, workspacePath, defaultWorkspacePath, activeTurns };
}

/** Read or update a Bot's default workspace in config.json without interrupting
 * active turns or altering existing conversations' pinned folders. */
export async function workspaceSettings(
  stateDir: string,
  activeTurns: number | (() => number),
  patch?: unknown,
): Promise<BotWorkspaceResult> {
  const activeCount = () => typeof activeTurns === "function" ? activeTurns() : activeTurns;
  try {
    const file = path.join(stateDir, "config.json");
    const settings = await withFileMutex(file, async () => {
      const config = await readConfig(file);
      const before = snapshot(config, stateDir, activeCount());
      if (patch === undefined) return before;
      const update = botWorkspacePatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("workspace_conflict");
      const requested = update.workspacePath.trim();
      let nextPath: string;
      if (!requested) {
        nextPath = before.defaultWorkspacePath;
        await mkdir(nextPath, { recursive: true, mode: 0o700 });
      } else {
        if (!path.isAbsolute(requested)) throw new Error("workspace_unavailable");
        const resolved = path.resolve(requested);
        const isDir = await stat(resolved).then(s => s.isDirectory(), () => false);
        if (!isDir) throw new Error("workspace_unavailable");
        nextPath = resolved;
      }
      if (nextPath === before.workspacePath) return before;
      config.workspacePath = nextPath;
      (config as Record<string, unknown>)._clientWorkspaceRevision = randomUUID();
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
        const handle = await open(temporary, "r+");
        try { await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, file);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      return snapshot(await readConfig(file), stateDir, activeCount());
    });
    return { ok: true, settings };
  } catch (error) {
    const code = botWorkspaceErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!code.success) throw error;
    return { ok: false, error: code.data };
  }
}
