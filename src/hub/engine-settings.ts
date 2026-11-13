import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";
import { resolveEngineExecutable } from "../runtime/engine-process.js";
import { EngineSettingsReadError, ENGINE_COMMANDS, ENGINE_ENV_KEYS, engineSettingsFile, hostEngineEnvironment, readHostEngineSettings, type StoredEngineSettings } from "../runtime/host-engine-settings.js";
import { engineSettingsUpdateSchema, hostEngineSchema, type EngineSettingsState, type EngineSettingsUpdate } from "../client-protocol/engine-settings.js";
import { HubError } from "./store.js";

export class HubEngineSettings {
  constructor(readonly directory: string, readonly base: () => NodeJS.ProcessEnv) {}
  private read(): StoredEngineSettings {
    try { return readHostEngineSettings(this.directory); }
    catch (error) { if (error instanceof EngineSettingsReadError) throw new HubError(error.message, 503); throw error; }
  }
  status(requestId?: string): EngineSettingsState {
    const settings = this.read(), base = this.base(), env = hostEngineEnvironment(this.directory, base, settings);
    const receipt = requestId ? settings.receipts.find(item => item.requestId === requestId) : settings.receipts.at(-1);
    return { revision: settings.revision, platform: process.platform, searchPaths: (env.PATH ?? "").split(path.delimiter).filter(Boolean),
      receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      engines: hostEngineSchema.options.map(id => {
        const command = env[ENGINE_ENV_KEYS[id]] || ENGINE_COMMANDS[id], executable = resolveEngineExecutable(command, env) ?? null;
        return { id, override: settings.paths[id] ?? null, source: settings.paths[id] ? "setting" : base[ENGINE_ENV_KEYS[id]] ? "environment" : "auto", command, executable, available: !!executable };
      }),
    };
  }
  async update(raw: EngineSettingsUpdate, commit: (apply: () => Promise<void>) => Promise<void>): Promise<EngineSettingsState> {
    const command = engineSettingsUpdateSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify(command)).digest("hex"), file = engineSettingsFile(this.directory);
    if (command.path !== null && (command.path !== command.path.trim() || !path.isAbsolute(command.path))) throw new HubError("engine_path_absolute_required");
    return withFileMutex(file, async () => {
      const before = this.read(), receipt = before.receipts.find(item => item.requestId === command.requestId);
      if (receipt) { if (receipt.digest !== digest) throw new HubError("engine_request_conflict", 409); return this.status(command.requestId); }
      if (before.revision !== command.revision) throw new HubError("engine_revision_conflict", 409);
      // Presence check only: selecting a program never executes it as a probe.
      const check = () => { if (command.path !== null && !resolveEngineExecutable(command.path, this.base())) throw new HubError("engine_path_unavailable"); };
      check();
      const paths = { ...before.paths }; if (command.path === null) delete paths[command.engine]; else paths[command.engine] = command.path;
      const revision = randomUUID(), next: StoredEngineSettings = { format: 1, revision, paths, receipts: [...before.receipts, { requestId: command.requestId, digest, revision }].slice(-32) };
      const temporary = `${file}.${randomUUID()}.tmp`; let handle;
      try {
        handle = await open(temporary, "wx", 0o600); await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
        await commit(async () => {
          if (this.read().revision !== before.revision) throw new HubError("engine_revision_conflict", 409);
          check(); await rename(temporary, file);
        });
      } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
      return this.status(command.requestId);
    }, { waitTimeoutMs: 10_000 });
  }
}
