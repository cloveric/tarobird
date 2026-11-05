import { constants } from "node:fs";
import { access, lstat, realpath, stat, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { withFileMutex } from "../state/file-mutex.js";
import { readHostVoicePolicy, voicePolicyFile, legacyVoiceMode, VoicePolicyReadError, type HostVoicePolicy } from "../runtime/voice-policy.js";
import { parseIntegrationEnvironment } from "../runtime/integration-environment.js";
import { voiceSettingsUpdateSchema, type VoiceSettingsState, type VoiceSettingsUpdate } from "../client-protocol/voice-settings.js";

export class VoiceSettingsError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const safeFile = async (file: string) => { try { const s = await lstat(file); await access(file, constants.R_OK); return s.isFile() && !s.isSymbolicLink() && s.size > 0; } catch { return false; } };
const insideWorkspace = (directory: string) => /\/(?:bots|\.cctb)\/[^/]+\/workspace(?:\/|$)/.test(directory.replaceAll("\\", "/"));

/** Stores non-secret, host-scoped routing only. Credentials remain exclusively
 * in the existing adapter; this class never opens its .env.local. */
export class HubVoiceSettings {
  constructor(readonly hostDir: string, readonly home = os.homedir(), readonly env: NodeJS.ProcessEnv = process.env) {}
  private async legacyEnvironment(): Promise<NodeJS.ProcessEnv> {
    let file;
    try {
      file = await open(path.join(this.home, ".tarobot", "integrations.env"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await file.stat();
      if (!info.isFile() || info.size > 131072) throw new Error("invalid_file");
      const buffer = Buffer.alloc(131073);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 131072) throw new Error("invalid_file");
      return { ...parseIntegrationEnvironment(buffer.subarray(0, bytesRead).toString("utf8")), ...this.env };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...this.env };
      throw new VoiceSettingsError("voice_settings_unavailable", 503);
    } finally { await file?.close(); }
  }
  private async adapter(directory: string, source: VoiceSettingsState["adapters"][number]["source"]): Promise<VoiceSettingsState["adapters"][number]> {
    let privateDirectory = false, script = false, python = false, credentials = false;
    try {
      const canonical = await realpath(directory), info = await stat(directory);
      privateDirectory = path.isAbsolute(directory) && !insideWorkspace(directory) && !insideWorkspace(canonical)
        && info.isDirectory() && (process.platform === "win32" || (info.uid === process.getuid?.() && !(info.mode & 0o077)));
      script = await safeFile(path.join(directory, "tingwu_transcribe.py"));
      const executable = path.join(directory, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      // A venv normally links its Python executable. It is not a credential file.
      try { python = (await stat(executable)).isFile(); await access(executable, process.platform === "win32" ? constants.R_OK : constants.X_OK); } catch { python = false; }
      const credential = path.join(directory, ".env.local");
      credentials = await safeFile(credential);
      if (credentials && process.platform !== "win32") { const s = await lstat(credential); credentials = s.uid === process.getuid?.() && !(s.mode & 0o077); }
    } catch { /* Missing/inaccessible is not ready. No file contents are read. */ }
    return { id: digest(directory), directory, source, script, python, credentials, private: privateDirectory, permissionsVerified: process.platform !== "win32", ready: privateDirectory && script && python && credentials };
  }
  private readPolicy(): HostVoicePolicy | undefined {
    try { return readHostVoicePolicy(this.hostDir); }
    catch (error) { throw new VoiceSettingsError(error instanceof VoicePolicyReadError ? error.message : "voice_settings_unavailable", 503); }
  }
  async status(requestId?: string): Promise<VoiceSettingsState> {
    const policy = this.readPolicy();
    // A damaged legacy env file must not prevent disabling a managed policy.
    const env = await this.legacyEnvironment().catch(error => { if (policy) return { ...this.env }; throw error; });
    const configured = env.TINGWU_ASR_DIR?.trim() ?? "";
    const candidates: [string, VoiceSettingsState["adapters"][number]["source"]][] = [
      ...(policy?.directory ? [[policy.directory, "saved"] as [string, "saved"]] : []),
      ...(configured ? [[configured, "configured"] as [string, "configured"]] : []),
      [path.join(this.home, ".tarobot", "integrations", "tingwu-asr"), "standard"],
      [path.join(this.home, ".tarocub-secrets", "tingwu_asr"), "legacy"],
    ];
    const adapters = await Promise.all(candidates.filter(([dir], index) => candidates.findIndex(([other]) => other === dir) === index).map(([dir, source]) => this.adapter(dir, source)));
    const threshold = Number(env.ASR_CLOUD_THRESHOLD_SECONDS);
    const thresholdSeconds = policy?.thresholdSeconds ?? (Number.isFinite(threshold) && threshold > 0 ? threshold : 900);
    const mode = policy?.mode ?? legacyVoiceMode(env.ASR_CLOUD_MODE, configured);
    const selected = policy?.directory || configured || adapters.find(a => a.ready)?.directory || adapters[0]!.directory;
    const receipt = requestId ? policy?.receipts.find(value => value.requestId === requestId) : policy?.receipts.at(-1);
    return { revision: policy?.revision ?? `legacy-${digest(JSON.stringify([configured, thresholdSeconds, mode]))}`, managed: !!policy,
      mode, adapterId: digest(selected), thresholdSeconds, adapters, receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null,
      workersNeedingUpdate: [], cloudVerified: false, legacyModeInvalid: !policy && !!configured && !!env.ASR_CLOUD_MODE?.trim() && mode === "local" && env.ASR_CLOUD_MODE.trim().toLowerCase() !== "local" };
  }
  async update(raw: VoiceSettingsUpdate, actor: string, authorize: () => Promise<void>, commit: (operation: () => Promise<void>) => Promise<void> = async operation => { await authorize(); await operation(); }): Promise<VoiceSettingsState> {
    const command = voiceSettingsUpdateSchema.parse(raw), commandDigest = digest(JSON.stringify(command));
    const file = voicePolicyFile(this.hostDir);
    return withFileMutex(file, async () => {
      await authorize();
      // Snapshot before the awaited adapter scan. An external operator can
      // replace the file without using our writer mutex during that scan.
      const policy = this.readPolicy();
      const before = await this.status(command.requestId);
      if (JSON.stringify(this.readPolicy()) !== JSON.stringify(policy)) throw new VoiceSettingsError("voice_revision_conflict");
      const receipt = policy?.receipts.find(value => value.requestId === command.requestId);
      if (receipt) {
        if (receipt.digest !== commandDigest) throw new VoiceSettingsError("voice_request_conflict");
        return before;
      }
      if (before.revision !== command.revision) throw new VoiceSettingsError("voice_revision_conflict");
      const adapter = before.adapters.find(value => value.id === command.adapterId);
      if (!adapter) throw new VoiceSettingsError("voice_adapter_unknown");
      if (command.mode !== "local" && !command.cloudConsent) throw new VoiceSettingsError("voice_consent_required", 400);
      if (command.mode !== "local" && !adapter.ready) throw new VoiceSettingsError("voice_adapter_not_ready");
      const revision = randomUUID();
      const next: HostVoicePolicy = { format: 2, revision, mode: command.mode, directory: adapter.directory, thresholdSeconds: command.thresholdSeconds,
        receipts: [...(policy?.receipts ?? []), { requestId: command.requestId, digest: commandDigest, revision, at: Date.now(), actor }].slice(-32) };
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
        await commit(async () => {
          // Never inspect adapter trees while occupying the Hub DB queue.
          // The mutex serializes supported writers; catch manual policy edits too.
          const current = this.readPolicy();
          if (JSON.stringify(current) !== JSON.stringify(policy)) throw new VoiceSettingsError("voice_revision_conflict");
          await rename(temporary, file);
        });
      } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
      return this.status(command.requestId);
    }, { waitTimeoutMs: 10_000 });
  }
}
