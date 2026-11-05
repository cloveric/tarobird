import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { JsonLines, helperEnvironment } from './helper-rpc.mjs';
const exec = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Never read a mutable WebKit profile while the old desktop window is alive.
 * The Host's node process is deliberately excluded and continues running. */
export async function oldDesktopRunning({ platform = process.platform, pid = process.pid, uid = process.getuid?.(), execute = exec } = {}) {
  if (platform !== 'darwin') return false; // Windows exporter checks process ownership natively before opening WebView2.
  const { stdout } = await execute('/bin/ps', ['-axo', 'uid=,pid=,comm='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+\.app\/Contents\/MacOS\/tarocub-client)$/);
    if (!match || Number(match[1]) !== uid || Number(match[2]) === pid) continue;
    const plist = path.resolve(match[3], '../../Info.plist');
    try {
      const result = await execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { timeout: 3000, maxBuffer: 4096 });
      if (result.stdout.trim() === 'com.tarobot.client') return true;
    } catch { throw new Error('migration_old_app_check_failed'); }
  }
  return false;
}

export class LegacyReader {
  #work; #cancel; #closed = false;
  constructor(executable, { spawnProcess = spawn, checkOldDesktop = oldDesktopRunning, idleMs = 120000, graceMs = 5000, checkIntervalMs = 500, environment = helperEnvironment } = {}) {
    if (!path.isAbsolute(executable) || executable.includes('\0')) throw new Error('migration_reader_path_invalid');
    Object.assign(this, { executable, spawnProcess, checkOldDesktop, idleMs, graceMs, checkIntervalMs, environment });
  }
  run() {
    if (this.#closed) return Promise.reject(new Error('migration_cancelled'));
    if (this.#work) return this.#work;
    this.#work = this.#run().finally(() => { this.#work = undefined; this.#cancel = undefined; });
    return this.#work;
  }
  async assertSourceIdle() {
    if (this.#closed) throw new Error('migration_cancelled');
    if (await this.checkOldDesktop()) throw new Error('migration_close_old_app');
    if (this.#closed) throw new Error('migration_cancelled');
  }
  async #run() {
    await this.assertSourceIdle();
    let checking = Promise.resolve(), monitor, watching = true, sourceError;
    const watch = () => {
      checking = this.assertSourceIdle().catch(error => {
        sourceError = error?.message === 'migration_close_old_app' || error?.message === 'migration_cancelled'
          ? error.message : 'migration_old_app_check_failed';
        this.#cancel?.(sourceError);
      }).finally(() => {
        if (watching && !sourceError) { monitor = setTimeout(watch, this.checkIntervalMs); monitor.unref?.(); }
      });
    };
    const work = new Promise((resolve, reject) => {
      let child, idle, kill, deadline, error, result, closed = false;
      const finish = code => {
        if (closed) return; closed = true; clearTimeout(idle); clearTimeout(kill); clearTimeout(deadline);
        if (error) reject(new Error(error));
        else if (code === 0 && result) resolve(result);
        else reject(new Error('migration_reader_failed'));
      };
      const cancel = reason => {
        if (closed || error) return; error = reason; clearTimeout(idle);
        child?.stdin.end();
        kill = setTimeout(() => {
          child?.kill();
          deadline = setTimeout(() => { child?.kill('SIGKILL'); finish(1); }, this.graceMs);
          deadline.unref?.();
        }, this.graceMs); kill.unref?.();
      };
      const progress = () => { clearTimeout(idle); idle = setTimeout(() => cancel('migration_reader_timeout'), this.idleMs); idle.unref?.(); };
      const decoder = new JsonLines(value => {
        if (!value || typeof value !== 'object' || result) throw new Error('migration_reader_protocol');
        if (value.type === 'progress' && Object.keys(value).length === 1) { progress(); return; }
        if (value.type === 'complete' && Object.keys(value).length === 2 && uuid.test(value.exportId)) { result = value.exportId; progress(); return; }
        if (value.type === 'failed' && Object.keys(value).length === 2 && typeof value.error === 'string' && /^(migration|legacy_source)_[a-z_]{1,100}$/.test(value.error)) { cancel(value.error === 'legacy_source_in_use' ? 'migration_close_old_app' : value.error); return; }
        throw new Error('migration_reader_protocol');
      }, 4096);
      try {
        const env = Object.fromEntries(Object.entries(this.environment()).filter(([key]) => !/^(ELECTRON_|WEBVIEW2_|TAURI_)/i.test(key)));
        child = this.spawnProcess(this.executable, ['--export-only'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch { finish(1); return; }
      this.#cancel = cancel; progress();
      child.stdout.on('data', chunk => { if (error || closed) return; try { decoder.push(chunk); } catch { cancel('migration_reader_protocol'); } });
      child.stdout.on('end', () => { try { decoder.finish(); } catch { cancel('migration_reader_protocol'); } });
      child.stderr.resume(); // Never expose old data or arbitrary native errors.
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => cancel('migration_reader_io_failed'));
      child.on('error', () => { error = 'migration_reader_unavailable'; });
      child.on('close', finish);
      // The signed exporter verifies the kernel-reported sender of this
      // handshake. Keep stdin open afterward as the cancellation lifeline.
      child.stdin.write('{"type":"start"}\n');
      if (this.#closed) cancel('migration_cancelled');
    });
    monitor = setTimeout(watch, this.checkIntervalMs); monitor.unref?.();
    try {
      const result = await work;
      watching = false; clearTimeout(monitor);
      await checking;
      if (sourceError) throw new Error(sourceError);
      // A process that began after the initial check invalidates this export.
      // Polling covers observed transient instances; this final check also
      // covers a short export that finished before its first polling tick.
      await this.assertSourceIdle();
      return result;
    } finally { watching = false; clearTimeout(monitor); await checking; }
  }
  shutdown() { this.#closed = true; this.#cancel?.('migration_cancelled'); }
}
