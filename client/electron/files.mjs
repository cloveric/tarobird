import { open, lstat, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const token = z.string().uuid();
const executable = /\.(?:exe|com|bat|cmd|msi|msp|scr|pif|ps1|vbs|vbe|js|jse|wsf|wsh|hta|lnk|url|reg|cpl|jar|command|terminal|sh)$/i;
const schemas = {
  desktop_save_begin: z.object({ name: z.string().min(1).max(240).refine(value => !/[\\/\x00-\x1f]/.test(value)), size: z.number().int().min(0).max(2 ** 40) }).strict(),
  desktop_save_write: z.object({ token, data: z.string().max(1398104) }).strict(),
  desktop_save_commit: z.object({ token }).strict(), desktop_save_cancel: z.object({ token }).strict(),
  open_saved_file: z.object({ path: z.string().max(32768), english: z.boolean().optional() }).strict(), reveal_saved_file: z.object({ path: z.string().max(32768) }).strict(),
};
export const FILE_COMMANDS = Object.freeze(Object.keys(schemas));
export const executableName = file => executable.test(file.trim());
const exists = async file => { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const sameFile = (a, b) => !a && !b || a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

async function unavailableQuarantine() { throw new Error('saved_file_quarantine_unavailable'); }

/** A save dialog grants one destination. Untrusted bytes go to an exclusive,
 * quarantined sibling; the old destination is preserved until complete commit.
 * Neither arbitrary paths nor fs handles can be supplied by a renderer. */
export class DesktopFiles {
  #pending = new Map(); #grants = new Map(); #choosing = false;
  constructor(window, { dialog, shell }, { platform = process.platform, mark = unavailableQuarantine } = {}) {
    this.window = window; this.dialog = dialog; this.shell = shell; this.platform = platform; this.mark = mark;
  }
  async request(command, input, active) {
    const checked = schemas[command]?.safeParse(input);
    if (!checked?.success) throw new Error('invalid_desktop_file_args');
    if (!active()) throw new Error('native_document_retired');
    const args = checked.data;
    if (command === 'desktop_save_begin') {
      if (this.#choosing || this.#pending.size >= 8) throw new Error('saved_file_busy');
      this.#choosing = true;
      try {
        const result = await this.dialog.showSaveDialog(this.window, { defaultPath: args.name, properties: ['showOverwriteConfirmation', 'createDirectory'] });
        if (!active()) throw new Error('native_document_retired');
        if (result.canceled || !result.filePath) return null;
        if (!path.isAbsolute(result.filePath)) throw new Error('saved_file_not_granted');
        const parent = await realpath(path.dirname(result.filePath)), target = path.join(parent, path.basename(result.filePath));
        const before = await exists(target);
        if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('saved_file_not_granted');
        const id = randomUUID(), temporary = path.join(parent, `.tarobot-save-${id}`);
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await this.mark(temporary, this.platform);
          if (!active()) throw new Error('native_document_retired');
          this.#pending.set(id, { handle, temporary, target, before, size: args.size, written: 0, busy: false });
          return { token: id };
        } catch (error) { await handle.close(); await unlink(temporary).catch(() => {}); throw error; }
      } finally { this.#choosing = false; }
    }
    if (command === 'open_saved_file' || command === 'reveal_saved_file') {
      // As Tauri's fs scope: the save dialog grants this path for the process,
      // and the user may edit the file afterwards. A link, directory or other
      // non-file at the path, or one reached through a link, never qualifies.
      const qualifies = async () => { const current = await exists(args.path); return !!current?.isFile() && !current.isSymbolicLink() && await realpath(args.path) === args.path; };
      if (!this.#grants.has(args.path) || !await qualifies()) throw new Error('saved_file_not_granted');
      if (command === 'reveal_saved_file') { this.shell.showItemInFolder(args.path); return null; }
      if (executable.test(args.path.trim())) {
        const english = args.english === true;
        const result = await this.dialog.showMessageBox(this.window, { type: 'warning', title: 'TaroBird',
          message: english ? 'This file can run programs or change your system. Open only if you trust its source.' : '这个附件可能运行程序或修改系统。请仅在确认来源可信时打开。',
          buttons: english ? ['Cancel', 'Open'] : ['取消', '打开'], defaultId: 0, cancelId: 0, noLink: true });
        if (result.response !== 1) return null;
      }
      if (!active() || !await qualifies()) throw new Error('saved_file_not_granted');
      const error = await this.shell.openPath(args.path); if (error) throw new Error('saved_file_open_failed'); return null;
    }
    const entry = this.#pending.get(args.token);
    if (!entry || entry.busy) throw new Error('saved_file_not_granted');
    entry.busy = true;
    try {
      if (command === 'desktop_save_write') {
        const bytes = Buffer.from(args.data, 'base64');
        if (bytes.toString('base64') !== args.data || !bytes.length || bytes.length > 1024 * 1024 || entry.written + bytes.length > entry.size) throw new Error('saved_file_invalid_chunk');
        for (let offset = 0; offset < bytes.length;) {
          if (!active()) throw new Error('native_document_retired');
          const { bytesWritten } = await entry.handle.write(bytes, offset, bytes.length - offset, entry.written);
          if (bytesWritten <= 0) throw new Error('saved_file_write_failed');
          offset += bytesWritten; entry.written += bytesWritten;
        }
        return { written: bytes.length };
      }
      if (command === 'desktop_save_cancel') { await this.#discard(args.token, entry); return null; }
      if (entry.written !== entry.size) throw new Error('saved_file_incomplete');
      // Atomic replacement preserves the existing user's access mode. New
      // downloads retain the private default until explicitly shared.
      if (entry.before && this.platform !== 'win32') await entry.handle.chmod(entry.before.mode & 0o777);
      await entry.handle.sync(); await entry.handle.close();
      if (!active() || !sameFile(entry.before, await exists(entry.target))) throw new Error('saved_file_destination_changed');
      await rename(entry.temporary, entry.target);
      const saved = await lstat(entry.target);
      this.#pending.delete(args.token); this.#grants.delete(entry.target); this.#grants.set(entry.target, true);
      // Keep a bounded set of the most recent user-selected save capabilities.
      if (this.#grants.size > 512) this.#grants.delete(this.#grants.keys().next().value);
      return { path: entry.target, size: saved.size };
    } catch (error) { await this.#discard(args.token, entry); throw error; }
    finally { entry.busy = false; if (!active()) await this.#discard(args.token, entry); }
  }
  async #discard(id, entry) {
    this.#pending.delete(id);
    await entry.handle.close().catch(() => {}); await unlink(entry.temporary).catch(() => {});
  }
  retire() { for (const [id, entry] of this.#pending) if (!entry.busy) void this.#discard(id, entry); }
}
