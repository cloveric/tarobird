import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { DESKTOP_EVENT, isObject } from './contract.mjs';
import { JsonLines, helperEnvironment } from './helper-rpc.mjs';

/** Renderer commands keep the Tauri names, so the shared login controller and
 * update UI run unchanged. Payloads are the Tauri payloads. */
export const UPDATE_COMMANDS = Object.freeze([
  'github_update_info', 'github_update_login_start', 'github_update_login_poll', 'github_update_login_cancel',
  'github_update_logout', 'github_update_check', 'github_update_install', 'github_update_close', 'restart_client',
]);
/** Desktop event carrying `{ offerId, event }` (a Tauri `DownloadEvent`). */
export const UPDATE_EVENT = 'github-update-progress';

const opaque = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const empty = z.object({}).strict();
const schemas = {
  github_update_info: empty, github_update_login_start: empty, github_update_logout: empty, github_update_check: empty,
  github_update_login_poll: z.object({ flowId: opaque }).strict(), github_update_login_cancel: z.object({ flowId: opaque }).strict(),
  github_update_install: z.object({ offerId: opaque }).strict(), github_update_close: z.object({ offerId: opaque }).strict(),
  restart_client: empty,
};
const methods = {
  github_update_info: 'info', github_update_login_start: 'login_start', github_update_login_poll: 'login_poll',
  github_update_login_cancel: 'login_cancel', github_update_logout: 'logout', github_update_check: 'check',
  github_update_install: 'install', github_update_close: 'close',
};
const EVENTS = new Set(['Started', 'Progress', 'Finished', 'WaitingForHost', 'Installing', 'RestartingHost']);
const MAX_LINE_BYTES = 256 * 1024;

export function updaterArguments(config) {
  for (const key of ['executable', 'configFile', 'appBundle', 'resourcesDir', 'hostStateDir', 'workDir']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key]) || config[key].includes('\0')) throw new Error('invalid_updater_configuration');
  }
  if (typeof config.appVersion !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(config.appVersion)) throw new Error('invalid_updater_configuration');
  return ['--config', config.configFile, '--app-version', config.appVersion, '--app-bundle', config.appBundle,
    '--resources-dir', config.resourcesDir, '--host-state-dir', config.hostStateDir, '--work-dir', config.workDir];
}

function downloadEvent(value) {
  if (!isObject(value) || !EVENTS.has(value.event)) return false;
  if (value.event === 'Started') return Object.keys(value).every(key => ['event', 'data'].includes(key)) && isObject(value.data)
    && Object.keys(value.data).every(key => key === 'contentLength') && (value.data.contentLength === undefined || Number.isSafeInteger(value.data.contentLength));
  if (value.event === 'Progress') return Object.keys(value).length === 2 && isObject(value.data) && Object.keys(value.data).length === 1
    && Number.isSafeInteger(value.data.chunkLength) && value.data.chunkLength > 0;
  return Object.keys(value).length === 1;
}

// Same discipline as the native helper: bounded queue, bounded pipe, and
// timeouts that never kill. Native allows 16 requests in flight.
const MAX_PENDING_CALLS = 16, MAX_LATE_REPLIES = 16, MAX_STDIN_BYTES = 64 * 1024;
// Native bounds: 45 s per GitHub request, keychain prompts, and the lifecycle
// lock held for at most one replacement (read-back + 95 s Host restart).
// `install` has no main-side timeout: only the native updater may end it, with
// an explicit result or cancellation.
const TIMEOUTS = { hello: 5000, info: 180000, login_start: 60000, login_poll: 120000, login_cancel: 60000, logout: 60000, check: 180000, close: 180000 };

/** One native updater per App. It owns the GitHub credential, offers, the
 * download and the bundle replacement. It is started on first use, in its own
 * process group, and is never killed: closing stdin lets it cancel what is
 * still cancellable and finish a replacement already in progress. After a
 * protocol failure no new updater starts until the old one has exited. */
export class UpdaterProcess {
  #child; #retiring; #retiringInstall = false; #pending = new Map(); #late = new Set(); #sequence = 0; #listeners = new Map(); #installs = new Set(); #handoff = false; #restartRequired = false; #recoveryRequired = false;
  constructor(config, { spawnProcess = spawn, exists = existsSync, timeouts = TIMEOUTS } = {}) {
    this.config = config; this.spawnProcess = spawnProcess; this.timeouts = timeouts;
    // Development builds carry no signed update configuration or binary.
    this.available = Boolean(config) && exists(config.executable) && exists(config.configFile);
    if (this.available) this.args = updaterArguments(config);
  }
  /** True while a bundle replacement may be running, including in a retiring process. */
  get installing() { return this.#installs.size > 0 || this.#retiringInstall; }
  /** Windows: a verified installer waits for this App to exit. */
  get handoff() { return this.#handoff; }
  get restartRequired() { return this.#restartRequired; }
  /** Bundle validity is unknown. Exiting is safe; spawning from it is not. */
  get recoveryRequired() { return this.#recoveryRequired; }
  guardRuntime(restart) {
    if (this.#recoveryRequired) throw new Error('github_update_recovery');
    if (this.installing || this.#handoff) throw new Error('github_update_busy');
    if (this.#restartRequired) { restart?.(); throw new Error('desktop_restart_required'); }
  }

  #start() {
    if (this.#child) return this.#child;
    // Detached on every platform: a quitting App (or a signal to its process
    // group) must not take the updater down mid-replacement, and on Windows
    // it must outlive Electron (libuv's kill-on-close job) to start the
    // installer after the App has exited.
    const child = this.spawnProcess(this.config.executable, this.args, {
      shell: false, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'ignore'], env: helperEnvironment(),
    });
    this.#child = child;
    const decoder = new JsonLines(value => this.#receive(value), MAX_LINE_BYTES);
    const fail = () => this.#retire(child, 'github_update_failed');
    child.stdout.on('data', chunk => {
      if (this.#child !== child) return;
      try { decoder.push(chunk); } catch { fail(); }
    });
    child.stdout.on('error', fail);
    child.stdout.on('end', fail);
    child.stdin.on('error', fail);
    child.on('error', () => { if (child.pid === undefined) this.#exited(child); else fail(); });
    child.on('close', () => this.#exited(child));
    return child;
  }

  #reject(reason) {
    // Loss of an install reply is not proof that native restored the old App.
    // Even the progress event may have been lost with the pipe. Keep this
    // fence after process exit; only an explicit native result is conclusive.
    if ([...this.#pending.values()].some(pending => pending.method === 'install')) { this.#recoveryRequired = true; reason = 'github_update_recovery'; }
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.#pending.clear(); this.#late.clear(); this.#listeners.clear(); this.#installs.clear();
  }

  /** Untrusted or unreachable: stop reading, hand over via stdin EOF, and
   * keep refusing new work until the OS reports the process gone. */
  #retire(child, reason) {
    if (this.#child !== child) return;
    this.#child = undefined; this.#retiring = child;
    this.#retiringInstall = [...this.#pending.values()].some(pending => pending.method === 'install');
    this.#reject(reason);
    try { child.stdin.end(); } catch { /* gone */ }
  }

  #exited(child) {
    if (this.#child === child) { this.#child = undefined; this.#reject('github_update_failed'); }
    if (this.#retiring === child) { this.#retiring = undefined; this.#retiringInstall = false; }
  }

  #receive(value) {
    if (!isObject(value)) throw new Error('invalid_updater_response');
    if (value.event === 'progress') {
      if (Object.keys(value).some(key => !['event', 'offerId', 'data'].includes(key)) || !opaque.safeParse(value.offerId).success || !downloadEvent(value.data)) {
        throw new Error('invalid_updater_response');
      }
      this.#listeners.get(value.offerId)?.(value.data);
      return;
    }
    if (Object.keys(value).some(key => !['id', 'result', 'error'].includes(key)) || !Number.isSafeInteger(value.id)
      || !this.#pending.has(value.id) && !this.#late.has(value.id)
      || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw new Error('invalid_updater_response');
    // An invalid error payload is not a conclusive native installation result.
    // Retire with the install still pending so the unknown-outcome fence sticks.
    if (Object.hasOwn(value, 'error') && (typeof value.error !== 'string' || !/^[a-z_]{1,64}$/.test(value.error))) throw new Error('invalid_updater_response');
    // A reply to a timed-out call is consumed without reaching anyone.
    if (this.#late.delete(value.id)) return;
    const pending = this.#pending.get(value.id); this.#pending.delete(value.id); clearTimeout(pending.timer);
    if (Object.hasOwn(value, 'error')) {
      pending.reject(new Error(value.error));
    } else pending.resolve(value.result);
  }

  call(method, params = {}) {
    if (!this.available) return Promise.reject(new Error('github_update_configuration'));
    if (this.#recoveryRequired) return Promise.reject(new Error('github_update_recovery'));
    if (this.#restartRequired || this.#handoff || this.#retiring || this.#pending.size >= MAX_PENDING_CALLS) return Promise.reject(new Error('github_update_busy'));
    // Keep the offer's cancellation path available; a second operation must
    // not change credentials, offers or install state while native owns it.
    if (method !== 'close' && [...this.#pending.values()].some(pending => pending.method === 'install')) return Promise.reject(new Error('github_update_busy'));
    const child = this.#start();
    const id = ++this.#sequence;
    const data = `${JSON.stringify({ id, method, params })}\n`;
    // A stalled pipe must not accumulate requests in the main process.
    if (child.stdin.writableLength + data.length > MAX_STDIN_BYTES) return Promise.reject(new Error('github_update_busy'));
    return new Promise((resolve, reject) => {
      const timeout = method === 'install' ? undefined : this.timeouts[method];
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id); this.#late.add(id);
        reject(new Error('github_update_failed'));
        if (this.#late.size > MAX_LATE_REPLIES) this.#retire(child, 'github_update_failed');
      }, timeout);
      timer?.unref?.();
      this.#pending.set(id, { resolve, reject, timer, method });
      try { child.stdin.write(data); }
      catch { this.#retire(child, 'github_update_failed'); }
    });
  }

  /** Progress for one offer goes only to the document that started it. */
  async install(offerId, receive) {
    if (this.#listeners.has(offerId)) throw new Error('github_update_busy');
    this.#listeners.set(offerId, receive); this.#installs.add(offerId);
    try {
      const result = await this.call('install', { offerId });
      if (result === null) { this.#restartRequired = true; return null; }
      // The installer runs from the updater after its stdin closes (App quit).
      if (isObject(result) && result.quit === true && Object.keys(result).length === 1) { this.#handoff = true; return result; }
      this.#recoveryRequired = true;
      throw new Error('github_update_recovery');
    } catch (error) {
      if (error?.message === 'github_update_recovery') this.#recoveryRequired = true;
      // Bundle read-back succeeded, but Host recovery did not. The old main
      // must not start helpers from the new bundle; let the UI offer restart.
      if (error?.message === 'github_update_installed_host_failed') this.#restartRequired = true;
      throw error;
    } finally { if (this.#listeners.get(offerId) === receive) { this.#listeners.delete(offerId); this.#installs.delete(offerId); } }
  }

  /** App quit: hand over to the native process; no kill, no wait. */
  shutdown() {
    const child = this.#child;
    if (child) this.#retire(child, 'github_update_cancelled');
  }
}

/** Per-window front for the shared updater. Update state is App-wide, as in
 * the Tauri App: navigation does not cancel an install, it only stops this
 * document from receiving that install's progress. */
export class DesktopUpdates {
  constructor(window, updater, { relaunch, quit, version, beforeInstall = () => {}, afterInstall = () => {} }) {
    this.window = window; this.updater = updater; this.relaunch = relaunch; this.quit = quit; this.version = version; this.beforeInstall = beforeInstall; this.afterInstall = afterInstall;
    this.preparing = false;
  }
  emit(payload) {
    if (!this.window.isDestroyed()) this.window.webContents.send(DESKTOP_EVENT, { name: UPDATE_EVENT, payload });
  }
  async request(command, input, active = () => true) {
    const checked = schemas[command]?.safeParse(input);
    if (!checked?.success) throw new Error('invalid_update_request');
    if (!active()) throw new Error('native_document_retired');
    const args = checked.data;
    if (this.preparing && command !== 'github_update_close') throw new Error('github_update_busy');
    if (this.preparing && args.offerId === this.preparingOffer) this.preparingCancelled = true;
    if (command === 'restart_client') {
      if (this.updater.recoveryRequired) throw new Error('github_update_recovery');
      // Relaunching while the bundle is being replaced would start a partial App.
      if (this.updater.installing) throw new Error('github_update_busy');
      // Windows: the installer (`/R`) restarts the App; a relaunch would race it.
      if (this.updater.handoff) this.quitForInstaller(); else this.relaunch();
      return null;
    }
    if (command === 'github_update_info' && !this.updater.available) {
      return { configured: false, version: this.version, provider: 'default', authenticated: false };
    }
    if (command === 'github_update_install') {
      this.preparing = true; this.preparingOffer = args.offerId; this.preparingCancelled = false;
      let installed = false;
      try {
        await this.beforeInstall();
        if (!active()) throw new Error('native_document_retired');
        if (this.preparingCancelled) throw new Error('github_update_cancelled');
        const result = await this.updater.install(args.offerId, event => { if (active()) this.emit({ offerId: args.offerId, event }); });
        installed = true;
        // As the Tauri updater did after launching NSIS: leave right away. The
        // renderer still receives its (Tauri-shaped) `null` reply first.
        if (result?.quit) setImmediate(() => this.quitForInstaller());
        else setImmediate(() => this.relaunch());
        return null;
      } finally {
        this.preparing = false; this.preparingOffer = undefined;
        await this.afterInstall(installed);
      }
    }
    return this.updater.call(methods[command], args);
  }
  quitForInstaller() {
    if (typeof this.quit !== 'function') throw new Error('github_update_install');
    this.quit();
  }
  retire() {}
}
