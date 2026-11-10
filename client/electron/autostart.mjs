import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { helperEnvironment } from './helper-rpc.mjs';
const exec = promisify(execFile);
const escape = text => text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
const versionParts = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.split('.').map(BigInt) : undefined;
const older = (left, right) => {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
};

/** Keep the login items the Tauri autostart plugin (auto-launch 0.6.0) made:
 * Mac `~/Library/LaunchAgents/TaroBot.plist` (Label `TaroBot`, canonical
 * executable path), Windows `HKCU\...\Run\TaroBot` through the native addon's
 * identical auto-launch backend. The packaged executables keep their legacy
 * names, so an entry enabled before the upgrade is this App's entry: it is
 * reported, can be turned off, and is rewritten rather than duplicated.
 * Development/acceptance Apps never register login items. */
export class DesktopAutostart {
  constructor(app, { production = false, platform = process.platform, executable = process.execPath, home = app.getPath('home'), addon,
    installationRoots = ['/Applications', path.join(home, 'Applications')] } = {}) {
    this.app = app; this.production = production; this.platform = platform; this.executable = executable; this.addon = addon;
    this.file = path.join(home, 'Library', 'LaunchAgents', 'TaroBot.plist');
    this.installationRoots = installationRoots; this.mutations = Promise.resolve();
  }
  #mutate(work) { const result = this.mutations.then(work); this.mutations = result.catch(() => {}); return result; }
  /** Tauri wrote `current_exe().canonicalize()`. */
  async #program() { return realpath(this.executable).catch(() => this.executable); }
  /** Our agent (Label TaroBot), possibly stale. Links, other files or another
   * label at this path are never read through, replaced or removed. */
  async #agent() {
    let stat;
    try { stat = await lstat(this.file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('autostart_configuration_conflict');
    const content = await readFile(this.file);
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', this.file], { env: helperEnvironment(), maxBuffer: 32768, timeout: 5000 });
    const value = JSON.parse(stdout);
    if (value?.Label !== 'TaroBot') throw new Error('autostart_configuration_conflict');
    if (!(await readFile(this.file)).equals(content)) throw new Error('autostart_configuration_changed');
    return { value, content };
  }
  #windows() {
    if (typeof this.addon?.autostartEnabled !== 'function' || typeof this.addon?.setAutostart !== 'function') throw new Error('autostart_unavailable');
    return this.addon;
  }
  async get() {
    if (!this.production) return false;
    if (this.platform === 'win32') return this.#windows().autostartEnabled();
    if (this.platform !== 'darwin') return false;
    await this.mutations;
    const agent = (await this.#agent())?.value;
    // A stale agent (moved or replaced App) does not start this App.
    return agent?.RunAtLoad === true && Array.isArray(agent.ProgramArguments) && agent.ProgramArguments[0] === await this.#program();
  }
  set(enabled) { return this.#mutate(() => this.#set(enabled)); }
  async #set(enabled) {
    if (!this.production) throw new Error('autostart_requires_installed_app');
    if (this.platform === 'win32') { this.#windows().setAutostart(enabled); return; }
    if (this.platform !== 'darwin') throw new Error('autostart_unavailable');
    const old = await this.#agent();
    if (!enabled) { if (old) await unlink(this.file); return; }
    await mkdir(path.dirname(this.file), { recursive: true });
    const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>TaroBot</string><key>AssociatedBundleIdentifiers</key><array><string>com.tarobot.client</string></array><key>ProgramArguments</key><array><string>${escape(await this.#program())}</string></array><key>RunAtLoad</key><true/></dict></plist>`;
    const temp = `${this.file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, this.file);
  }
  /** Repair only an enabled older copy of this product after a manual DMG
   * installation. Disk-only: never launch/stop a job or change the preference. */
  repairLegacy() { return this.#mutate(() => this.#repairLegacy()); }
  async #repairLegacy() {
    if (!this.production || this.platform !== 'darwin') return false;
    const program = await this.#program();
    const bundle = path.resolve(path.dirname(program), '../..');
    // Restrict automatic repair to installed bundles, never mounted DMGs,
    // AppTranslocation or development/acceptance directories.
    if (!this.installationRoots.includes(path.dirname(bundle))) return false;
    const old = await this.#agent(), agent = old?.value;
    if (agent?.RunAtLoad !== true || agent.Disabled === true || agent.Program || !Array.isArray(agent.ProgramArguments)
      || agent.ProgramArguments.length !== 1 || typeof agent.ProgramArguments[0] !== 'string') return false;
    const previous = await realpath(agent.ProgramArguments[0]).catch(() => undefined);
    if (!previous || previous === program) return false;
    const metadata = async executable => {
      const root = path.resolve(path.dirname(executable), '../..');
      if (!root.endsWith('.app')) return undefined;
      const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')],
        { env: helperEnvironment(), maxBuffer: 32768, timeout: 5000 });
      const value = JSON.parse(stdout);
      return value.CFBundleIdentifier === 'com.tarobot.client' && typeof value.CFBundleExecutable === 'string'
        && path.basename(value.CFBundleExecutable) === value.CFBundleExecutable
        && path.join(root, 'Contents/MacOS', value.CFBundleExecutable) === executable ? value : undefined;
    };
    const current = await metadata(program), legacy = await metadata(previous);
    if (!current || !legacy || current.CFBundleShortVersionString !== this.app.getVersion()
      || !older(legacy.CFBundleShortVersionString, current.CFBundleShortVersionString)) return false;
    // Preserve every other field, including the user's RunAtLoad choice and
    // scheduling options. The normal set(true) deliberately writes a new entry.
    const temp = `${this.file}.${randomUUID()}.tmp`, handle = await open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(old.content); await handle.sync(); } finally { await handle.close(); }
      // Edit the native plist, not a JSON round-trip: unrelated 64-bit integers
      // must not lose precision in JavaScript.
      await exec('/usr/bin/plutil', ['-replace', 'ProgramArguments', '-json', JSON.stringify([program]), temp],
        { env: helperEnvironment(), maxBuffer: 32768, timeout: 5000 });
      const written = await open(temp, 'r');
      try { await written.sync(); } finally { await written.close(); }
      const latest = await this.#agent();
      if (!latest?.content.equals(old.content)) return false;
      await rename(temp, this.file);
      return true;
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
