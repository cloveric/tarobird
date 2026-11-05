import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { helperEnvironment } from './helper-rpc.mjs';
const exec = promisify(execFile);
const escape = text => text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);

/** Keep the login items the Tauri autostart plugin (auto-launch 0.6.0) made:
 * Mac `~/Library/LaunchAgents/TaroBot.plist` (Label `TaroBot`, canonical
 * executable path), Windows `HKCU\...\Run\TaroBot` through the native addon's
 * identical auto-launch backend. The packaged executables keep their legacy
 * names, so an entry enabled before the upgrade is this App's entry: it is
 * reported, can be turned off, and is rewritten rather than duplicated.
 * Development/acceptance Apps never register login items. */
export class DesktopAutostart {
  constructor(app, { production = false, platform = process.platform, executable = process.execPath, home = app.getPath('home'), addon } = {}) {
    this.app = app; this.production = production; this.platform = platform; this.executable = executable; this.addon = addon;
    this.file = path.join(home, 'Library', 'LaunchAgents', 'TaroBot.plist');
  }
  /** Tauri wrote `current_exe().canonicalize()`. */
  async #program() { return realpath(this.executable).catch(() => this.executable); }
  /** Our agent (Label TaroBot), possibly stale. Links, other files or another
   * label at this path are never read through, replaced or removed. */
  async #agent() {
    let stat;
    try { stat = await lstat(this.file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('autostart_configuration_conflict');
    const { stdout } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', this.file], { env: helperEnvironment(), maxBuffer: 32768, timeout: 5000 });
    const value = JSON.parse(stdout);
    if (value?.Label !== 'TaroBot') throw new Error('autostart_configuration_conflict');
    return value;
  }
  #windows() {
    if (typeof this.addon?.autostartEnabled !== 'function' || typeof this.addon?.setAutostart !== 'function') throw new Error('autostart_unavailable');
    return this.addon;
  }
  async get() {
    if (!this.production) return false;
    if (this.platform === 'win32') return this.#windows().autostartEnabled();
    if (this.platform !== 'darwin') return false;
    const agent = await this.#agent();
    // A stale agent (moved or replaced App) does not start this App.
    return agent?.RunAtLoad === true && Array.isArray(agent.ProgramArguments) && agent.ProgramArguments[0] === await this.#program();
  }
  async set(enabled) {
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
}
