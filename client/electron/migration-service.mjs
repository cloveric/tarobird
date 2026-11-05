import { lstat, readFile, open, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MigrationStore } from './migration.mjs';
import { legacySourceFingerprint, legacySourceSnapshot, legacyDataWritten, stableLegacySnapshot } from './migration-source.mjs';

const exportId = z.string().uuid();
const schemas = {
  desktop_migration_inspect: z.object({ committedExportId: exportId.optional() }).strict(),
  desktop_migration_prepare: z.object({}).strict(),
  desktop_migration_read: z.object({ exportId, kind: z.enum(['part', 'blob']), index: z.number().int().min(0).max(4095).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), offset: z.number().int().min(0).max(128 * 1024 * 1024) }).strict(),
  desktop_migration_complete: z.object({ exportId: exportId.optional(), acknowledgeSourceChange: z.boolean().optional() }).strict(),
};
export const MIGRATION_COMMANDS = Object.freeze(Object.keys(schemas));
const absent = async file => { try { await lstat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };

/** This check runs before the helper can create an installation marker. Native
 * state stays in the Tauri location; only Chromium's profile has a new folder. */
export async function legacyDesktopPresent(stateDir, webviewDirs = []) {
  for (const name of ['tarobot-client-installation-v1', 'WebKit', 'EBWebView']) if (!await absent(path.join(stateDir, name))) return true;
  // On macOS WKWebView lives in Library/WebKit/<bundle-id>, not app_data_dir.
  // An unpaired old installation can have preferences but no native marker.
  for (const directory of webviewDirs) if (!await absent(directory)) return true;
  return false;
}

export class DesktopMigration {
  #manifest; #cached; #pending; #established; #ready = false; #previous; #replaces; #rebind;
  constructor({ stateDir, profile, legacyRequired, reader, legacyWebviewDirs = [], sourceFingerprint, store = new MigrationStore(stateDir) }) {
    this.profile = profile; this.required = legacyRequired; this.store = store;
    this.reader = reader;
    this.marker = path.join(profile, 'tarobot-desktop-profile-v1.json');
    this.sourceMarker = path.join(profile, 'tarobot-legacy-source-v1.json');
    this.fingerprint = sourceFingerprint ?? (legacyWebviewDirs.length ? () => legacySourceFingerprint(legacyWebviewDirs) : undefined);
    this.snapshot = legacyWebviewDirs.length ? () => legacySourceSnapshot(legacyWebviewDirs) : undefined;
  }
  async sourceSnapshot() { return this.snapshot ? this.snapshot() : { fingerprint: await this.fingerprint() }; }
  async sourceBinding() {
    if (await absent(this.sourceMarker)) return undefined;
    const stat = await lstat(this.sourceMarker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('migration_profile_invalid');
    const binding = JSON.parse(await readFile(this.sourceMarker, 'utf8'));
    if (binding.version !== 1 || !exportId.safeParse(binding.exportId).success || !/^[a-f0-9]{64}$/.test(binding.fingerprint)
      || binding.replacesExportId !== undefined && !exportId.safeParse(binding.replacesExportId).success) throw new Error('migration_profile_invalid');
    for (const files of [binding.files, binding.acknowledged]) if (files !== undefined && (!Array.isArray(files) || files.length > 200000
      || files.some(entry => !Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== 'string' || entry[0].length > 32768
        || !/^\d+$/.test(entry[1]) || !/^\d+$/.test(entry[2])))) throw new Error('migration_profile_invalid');
    return binding;
  }
  async writeSourceBinding(binding) {
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    const temporary = `${this.sourceMarker}.${randomUUID()}.tmp`, handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(binding)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.sourceMarker);
  }
  get ready() { return this.#ready; }
  /** The renderer's registry already committed this export, but its receipt or
   * profile marker never landed. Finish that import instead of exporting and
   * importing a newer snapshot over committed data. Full re-verification. */
  async #committedImport(id, active) {
    const manifest = await this.store.verify(id);
    if (!active()) throw new Error('native_document_retired');
    let sourceChanged = false;
    if (this.snapshot) {
      try {
        let binding;
        try { binding = await this.sourceBinding(); } catch { /* Unknown baseline. */ }
        const current = await this.snapshot();
        // A binding for another export means an earlier build re-exported a
        // changed source. Without this import's baseline, keep the notice.
        const own = binding?.exportId === id;
        sourceChanged = legacyDataWritten(own ? binding.acknowledged ?? binding.files : [], current.files);
        if (!own) this.#rebind = { exportId: id, fingerprint: current.fingerprint };
      } catch { /* The old source is optional after a committed migration. */ }
    }
    this.#manifest = manifest; this.#cached = undefined;
    return { state: 'committed', manifest, ...(sourceChanged ? { sourceChanged: true } : {}) };
  }
  async request(command, input, active = () => true) {
    const checked = schemas[command]?.safeParse(input);
    if (!checked?.success) throw new Error('invalid_migration_request');
    if (!active()) throw new Error('native_document_retired');
    const args = checked.data;
    if (command === 'desktop_migration_prepare') {
      const current = await this.request('desktop_migration_inspect', {}, active);
      if (current.state !== 'transition_required' && !(current.state === 'invalid' && this.required)) return current;
      if (!this.reader) throw new Error('migration_reader_unavailable');
      const id = await this.reader.run();
      // A successful process exit cannot substitute for a complete, signed,
      // installation-bound snapshot. Main validates every part and blob.
      const manifest = await this.store.verify(id);
      if (!active()) throw new Error('native_document_retired');
      this.#replaces = this.#previous?.exportId;
      if (this.fingerprint) {
        const snapshot = await stableLegacySnapshot(() => this.sourceSnapshot());
        await this.reader.assertSourceIdle?.();
        if (!active()) throw new Error('native_document_retired');
        await this.writeSourceBinding({ version: 1, exportId: id, ...snapshot,
          ...(this.#replaces ? { replacesExportId: this.#replaces } : {}) });
      }
      this.#manifest = manifest;
      this.#cached = undefined;
      return { state: 'ready', manifest, ...(this.#replaces ? { replacesExportId: this.#replaces } : {}) };
    }
    if (command === 'desktop_migration_inspect') {
      this.#rebind = undefined;
      // An established Chromium profile must not import a newly created export
      // over live data. Its registry is checked by the renderer before mount.
      if (!await absent(this.marker)) {
        const stat = await lstat(this.marker);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('migration_profile_invalid');
        const marker = JSON.parse(await readFile(this.marker, 'utf8'));
        if (marker.version !== 1 || !['fresh', 'imported'].includes(marker.mode) || marker.mode === 'imported' && !z.string().uuid().safeParse(marker.exportId).success) throw new Error('migration_profile_invalid');
        let sourceChanged = false;
        if (marker.mode === 'imported' && this.snapshot) {
          // The current Chromium profile remains authoritative. Deleting or
          // losing access to the old source must not prevent normal startup.
          try { const binding = await this.sourceBinding();
            sourceChanged = binding?.exportId === marker.exportId && legacyDataWritten(binding.acknowledged ?? binding.files, (await this.snapshot()).files);
          } catch { /* The old source is optional after a committed migration. */ }
        }
        this.#established = marker;
        return { state: 'profile', ...marker, ...(sourceChanged ? { sourceChanged: true } : {}) };
      }
      if (args.committedExportId) return this.#committedImport(args.committedExportId, active);
      const status = await this.store.inspect();
      if (status.manifest) {
        if (this.fingerprint && this.reader) {
          let binding;
          try { binding = await this.sourceBinding(); } catch { /* Invalid reuse metadata requires a fresh verified export. */ }
          const current = await this.sourceSnapshot();
          // If the source was removed, retain its last verified export. Access
          // failure is different: it may conceal newer data, so keep retryable.
          if (!binding || binding.exportId !== status.manifest.exportId || !current.missing && binding.fingerprint !== current.fingerprint) {
            this.#previous = status.manifest; this.#manifest = undefined; this.#cached = undefined;
            return { state: 'transition_required' };
          }
          this.#replaces = binding.replacesExportId;
        }
        this.#manifest = status.manifest;
        return { state: 'ready', manifest: status.manifest, ...(this.#replaces ? { replacesExportId: this.#replaces } : {}) };
      }
      return { state: status.state === 'invalid' ? 'invalid' : this.required ? 'transition_required' : 'fresh' };
    }
    if (command === 'desktop_migration_read') {
      const manifest = this.#manifest;
      if (!manifest || args.exportId !== manifest.exportId) throw new Error('migration_export_not_verified');
      const key = args.kind === 'part' ? `part:${args.index}` : `blob:${args.sha256}`;
      // Serialize readers; only one verified part/blob is resident at a time.
      if (this.#pending) throw new Error('migration_read_busy');
      this.#pending = true;
      try {
        if (this.#cached?.key !== key) {
          const bytes = args.kind === 'part' ? Buffer.from(await this.store.readPart(args.exportId, args.index, manifest)) : await this.store.readBlob(args.exportId, args.sha256, manifest);
          this.#cached = { key, bytes };
        }
        const bytes = this.#cached.bytes;
        if (args.offset > bytes.length) throw new Error('migration_read_offset_invalid');
        const end = Math.min(bytes.length, args.offset + 1024 * 1024);
        return { data: new Uint8Array(bytes.subarray(args.offset, end)), next: end, done: end === bytes.length };
      } finally { this.#pending = false; }
    }
    if (this.#established) {
      if (args.exportId !== this.#established.exportId) throw new Error('migration_profile_invalid');
      if (args.acknowledgeSourceChange && this.snapshot) {
        const binding = await this.sourceBinding();
        if (binding?.exportId === args.exportId) await this.writeSourceBinding({ ...binding, acknowledged: (await this.snapshot()).files });
      }
      this.#ready = true; return null;
    }
    const manifest = this.#manifest;
    if (args.exportId ? !manifest || args.exportId !== manifest.exportId : this.required || manifest) throw new Error('migration_export_not_verified');
    const marker = { version: 1, mode: args.exportId ? 'imported' : 'fresh', ...(args.exportId ? { exportId: args.exportId } : {}) };
    if (args.exportId) {
      // A receipt comes only after the renderer's atomic registry commit and
      // localStorage retry. It contains no renderer-selected paths or totals.
      const receipt = { version: 1, exportId: manifest.exportId, installation: manifest.installation, records: manifest.totals.records, target: 'electron' };
      await this.store.writeReceipt(manifest.exportId, receipt);
      // Before the marker: an interruption here repeats the committed path.
      if (this.#rebind?.exportId === manifest.exportId) await this.writeSourceBinding({ version: 1, ...this.#rebind, files: [] });
    }
    if (!active()) throw new Error('native_document_retired');
    await mkdir(this.profile, { recursive: true, mode: 0o700 });
    const temporary = `${this.marker}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(marker)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.marker);
    // Same as a later startup's profile state: the notice can be acknowledged.
    this.#established = marker;
    this.#ready = true; this.#cached = undefined; this.#rebind = undefined;
    return null;
  }
  retire() { this.#cached = undefined; this.#ready = false; this.#established = undefined; this.#rebind = undefined; }
}
