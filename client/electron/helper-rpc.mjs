import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { MAX_PENDING, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, VIEW_COMMANDS, MAIN_COMMANDS, isObject } from './contract.mjs';

/** Incremental JSONL decoder. Retains at most one bounded line, including when
 * the child never writes a newline. Does not repeatedly copy an entire buffer. */
export class JsonLines {
  #parts = []; #bytes = 0;
  constructor(onValue, limit = MAX_RESPONSE_BYTES) { this.onValue = onValue; this.limit = limit; }
  push(chunk) {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      this.#bytes += part.length;
      if (this.#bytes > this.limit) throw new Error('native_response_too_large');
      if (part.length) this.#parts.push(part);
      if (end < 0) return;
      const bytes = Buffer.concat(this.#parts, this.#bytes);
      this.#parts = []; this.#bytes = 0;
      let value;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw new Error('invalid_native_response'); }
      this.onValue(value);
      offset = end + 1;
    }
  }
  finish() { if (this.#bytes) throw new Error('truncated_native_response'); }
}

export function helperEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined
    && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'RUST_LOG'].includes(key.toUpperCase())
    && !key.toUpperCase().startsWith('DYLD_')));
}

export function helperArguments(config) {
  for (const key of ['executable', 'stateDir', 'resourcesDir', 'hostStateDir']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key]) || config[key].includes('\0')) throw new Error('invalid_helper_configuration');
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.keyringService)) throw new Error('invalid_helper_configuration');
  return ['--state-dir', config.stateDir, '--keyring-service', config.keyringService,
    '--resources-dir', config.resourcesDir, '--host-state-dir', config.hostStateDir];
}

export class NativeHelper {
  #child; #pending = new Map(); #late = new Set(); #sequence = 0; #closed = false; #killTimer; #terminated = false; #hostDraining = false; #exited = false;
  constructor(config, { spawnProcess = spawn, onEvent = () => {}, onClosed = () => {}, timeoutMs, shutdownMs = 2000,
    hostShutdownMs = 190000, killGroup = process.platform !== 'win32' ? pid => process.kill(-pid, 'SIGKILL') : undefined } = {}) {
    this.onEvent = onEvent; this.onClosed = onClosed; this.timeoutMs = timeoutMs; this.shutdownMs = shutdownMs;
    this.hostShutdownMs = hostShutdownMs; this.killGroup = killGroup;
    this.#child = spawnProcess(config.executable, helperArguments(config), {
      shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment(),
    });
    const decoder = new JsonLines(value => this.#receive(value));
    this.#child.stdout.on('data', chunk => {
      if (this.#closed) return;
      try { decoder.push(chunk); } catch (error) { this.close(error.message); }
    });
    this.#child.stdout.on('end', () => {
      if (this.#closed) return;
      try { decoder.finish(); } catch (error) { this.close(error.message); return; }
      this.close('native_helper_exited');
    });
    // Drain stderr without retaining or forwarding credentials, paths or Host
    // output. Public diagnostics come exclusively from typed protocol errors.
    this.#child.stderr.resume();
    this.#child.on('error', () => this.close('native_helper_unavailable'));
    this.#child.stdin.on('error', () => this.close('native_helper_unavailable'));
    this.#child.stdout.on('error', () => this.close('native_helper_unavailable'));
    this.#child.stderr.on('error', () => this.close('native_helper_unavailable'));
    this.#child.on('close', () => {
      this.#exited = true;
      this.close('native_helper_exited');
      // A control CLI can be restoring the Host in its finally block. Helper
      // death must not kill that recovery; retain the bounded mutation grace.
      if (this.#hostDraining) return;
      clearTimeout(this.#killTimer);
      // If the helper crashed, kill only its remaining control-command group.
      // A real Host service is launched detached by the existing Host CLI.
      this.#terminateGroup();
    });
  }

  get closed() { return this.#closed; }
  async ready() {
    const info = await this.call('helper_info', {}, 5000);
    if (!isObject(info) || info.protocol !== 1) { this.close('native_protocol_mismatch'); throw new Error('native_protocol_mismatch'); }
  }

  call(command, args = {}, timeoutMs = this.timeoutMs ?? (command === 'desktop_host' ? 370000 : command.startsWith('net_http_') ? 310000 : 130000)) {
    if (this.#closed) return Promise.reject(new Error('native_helper_unavailable'));
    if (![...VIEW_COMMANDS, ...MAIN_COMMANDS].includes(command) || !isObject(args)) return Promise.reject(new Error('invalid_native_request'));
    if (this.#pending.size >= MAX_PENDING || command !== 'net_cancel' && this.#pending.size + this.#late.size >= MAX_PENDING) return Promise.reject(new Error('native_helper_busy'));
    const id = ++this.#sequence;
    let data;
    try { data = Buffer.from(JSON.stringify({ id, command, args }) + '\n'); }
    catch { return Promise.reject(new Error('invalid_native_request')); }
    if (data.length - 1 > MAX_REQUEST_BYTES) return Promise.reject(new Error('native_request_too_large'));
    // A blocked pipe must not make the Electron main process accumulate up to
    // 256 full upload bodies. Reject before accepting another queued write.
    if (this.#child.stdin.writableLength + data.length > 2 * MAX_REQUEST_BYTES) return Promise.reject(new Error('native_helper_busy'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#timeout(id, command, args), timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, command, hostMutation: command === 'desktop_host' && args.action !== 'status' });
      try {
        this.#child.stdin.write(data, error => { if (error) this.close('native_helper_unavailable'); });
      } catch { this.close('native_helper_unavailable'); }
    });
  }

  #receive(value) {
    if (!isObject(value)) throw new Error('invalid_native_response');
    if (value.event === 'transport') {
      if (Object.keys(value).some(key => !['event', 'document', 'channel', 'payload'].includes(key))
        || typeof value.document !== 'string' || value.document.length > 128
        || typeof value.channel !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.channel)
        || !isObject(value.payload)) throw new Error('invalid_native_response');
      this.onEvent(value);
      return;
    }
    if (Object.keys(value).some(key => !['id', 'result', 'error'].includes(key))
      || !Number.isSafeInteger(value.id) || !this.#pending.has(value.id) && !this.#late.has(value.id)
      || Object.hasOwn(value, 'result') === Object.hasOwn(value, 'error')) throw new Error('invalid_native_response');
    if (Object.hasOwn(value, 'error') && (!isObject(value.error) || typeof value.error.code !== 'string'
      || value.error.code.length > 8192 || typeof value.error.message !== 'string')) throw new Error('invalid_native_response');
    if (this.#late.delete(value.id)) return;
    const pending = this.#pending.get(value.id);
    this.#pending.delete(value.id); clearTimeout(pending.timer);
    if (value.error) pending.reject(new Error(value.error.code)); else pending.resolve(value.result);
  }

  #timeout(id, command, args) {
    const pending = this.#pending.get(id);
    if (!pending || this.#closed) return;
    // A slow Hub/upload is not evidence that the native process is dead. Reject
    // and cancel this slot; keep unrelated hosts and sockets alive. Late replies
    // are consumed without exposing data to the caller that has already failed.
    this.#pending.delete(id); this.#late.add(id);
    pending.reject(new Error('native_request_timeout'));
    if (this.#late.size > MAX_PENDING || ['helper_info', 'net_cancel', 'net_document', 'net_allocate'].includes(command)) {
      this.close('native_helper_timeout'); return;
    }
    if (command.startsWith('net_') && typeof args.id === 'string') {
      void this.call('net_cancel', { id: args.id }, 5000).catch(() => this.close('native_helper_timeout'));
    }
  }

  close(reason = 'native_document_retired') {
    if (this.#closed) return;
    this.#closed = true;
    const hostPending = [...this.#pending.values()].some(pending => pending.hostMutation);
    this.#hostDraining = hostPending;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
    this.#pending.clear();
    this.#late.clear();
    // Retire authority before asking the child to drain. Kill is bounded even
    // when native keychain/UI/HTTP work refuses to finish after EOF.
    try { this.#child.stdin.end(); } catch { /* already closed */ }
    this.#killTimer = setTimeout(() => this.#terminateGroup(), hostPending ? this.hostShutdownMs : this.shutdownMs);
    this.#killTimer.unref?.();
    this.onClosed(reason);
  }

  #terminateGroup() {
    if (this.#terminated) return;
    this.#terminated = true;
    if (this.killGroup && Number.isSafeInteger(this.#child.pid)) {
      // After reaping our helper, an occupied leader PID belongs to a newer
      // process. Never signal a recycled group when the grace timer expires.
      if (this.#exited) { try { process.kill(this.#child.pid, 0); return; } catch (error) { if (error.code !== 'ESRCH') return; } }
      try { this.killGroup(this.#child.pid); } catch { /* group already gone */ }
    } else { try { this.#child.kill('SIGKILL'); } catch { /* gone */ } }
  }
}
