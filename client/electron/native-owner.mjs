import { randomUUID } from 'node:crypto';
import { NativeHelper } from './helper-rpc.mjs';
import { NATIVE_REQUEST, NATIVE_BOOTSTRAP, NATIVE_EVENT, DESKTOP_EVENT, DESKTOP_COMMANDS, isEntryURL, trustedSender, validateViewRequest } from './contract.mjs';

/** One trusted WebContents, one current main-frame document, one native helper.
 * Reload/navigation/crash retires ALL native authority, not just subscriptions. */
export class NativeOwner {
  #generation = 0; #helper; #ready; #document; #documentPending = false;
  #slots = new Map(); #channels = new Map(); #failed = false; #destroyed = false;
  #token;
  #navigationToken;
  #recovering; #serviceGeneration = 0; #lastRecovery = 0;
  constructor(contents, config, { controller = false, services, beforeNativeStart = () => {}, helperFactory = (config, hooks) => new NativeHelper(config, hooks) } = {}) {
    this.contents = contents; this.config = config; this.controller = controller; this.helperFactory = helperFactory;
    this.services = services;
    this.beforeNativeStart = beforeNativeStart;
    this.onNavigation = (details, _url, inPlace, mainFrame) => {
      if ((details.isMainFrame ?? mainFrame) && !(details.isSameDocument ?? inPlace)) {
        const previous = this.#token ?? this.#navigationToken;
        this.retire(false); this.#navigationToken = previous;
      }
    };
    this.onGone = () => this.retire();
    this.onDestroyed = () => this.dispose();
    this.onCommit = () => { if (!this.#destroyed) {
      // A cancelled navigation keeps the same service document and pending save.
      // Only a committed replacement retires its notification/file authority.
      ++this.#serviceGeneration; this.services?.retire();
      this.#token = randomUUID(); this.#navigationToken = undefined;
    } };
    this.onStopped = () => {
      // A cancelled navigation keeps the original document and preload. Restore
      // only its nonce after loading has stopped; never reuse it after a commit.
      if (this.#destroyed || !this.#navigationToken || this.#token || this.contents.isLoadingMainFrame?.()
        || !isEntryURL(this.contents.mainFrame?.url)) return;
      this.#token = this.#navigationToken; this.#navigationToken = undefined;
      this.#failed = true; this.#state();
    };
    contents.on('did-start-navigation', this.onNavigation);
    contents.on('render-process-gone', this.onGone);
    contents.on('destroyed', this.onDestroyed);
    contents.on('did-navigate', this.onCommit);
    contents.on('did-stop-loading', this.onStopped);
  }

  bootstrap(event) {
    if (!trustedSender(event, this.contents)) throw new Error('untrusted_native_sender');
    if (!this.#token || this.#destroyed) throw new Error('native_document_not_committed');
    return this.#token;
  }

  #send(subscription, payload) {
    if (this.#destroyed || this.contents.isDestroyed()) return;
    this.contents.send(NATIVE_EVENT, { subscription, payload });
  }
  #event(generation, value) {
    if (generation !== this.#generation || value.document !== this.#document || this.#failed) return;
    const slot = this.#channels.get(value.channel);
    if (!slot || slot.document !== value.document) return;
    if (value.payload.kind === 'close') { this.#channels.delete(value.channel); this.#slots.delete(slot.id); }
    this.#send(slot.subscription, value.payload);
  }
  #closed(generation) {
    if (generation !== this.#generation || this.#destroyed || this.#failed) return;
    this.#failed = true; this.services?.retireScreen?.();
    for (const slot of this.#channels.values()) this.#send(slot.subscription, { kind: 'close', code: 1006, reason: 'native_helper_unavailable', clean: false });
    this.#channels.clear(); this.#slots.clear(); this.#document = undefined;
    this.#state();
  }
  #state() {
    if (!this.#destroyed && !this.contents.isDestroyed()) this.contents.send(DESKTOP_EVENT, { name: 'native-state', payload: { failed: this.#failed } });
  }
  async #recover() {
    if (this.#recovering) return this.#recovering;
    if (!this.#failed) return null;
    if (Date.now() - this.#lastRecovery < 1000) throw new Error('native_recovery_busy');
    this.#lastRecovery = Date.now();
    const token = this.#token;
    this.retire(false); this.#token = token;
    const generation = this.#generation;
    const recovery = this.#native(generation).then(() => { this.#state(); return null; });
    this.#recovering = recovery;
    try { return await recovery; } finally { if (this.#recovering === recovery) this.#recovering = undefined; }
  }
  async #native(generation) {
    if (this.#destroyed || this.#failed || generation !== this.#generation) throw new Error('native_document_retired');
    if (!this.#helper) {
      this.beforeNativeStart('helper');
      const helper = this.helperFactory(this.config, {
        onEvent: value => this.#event(generation, value), onClosed: () => this.#closed(generation),
      });
      this.#helper = helper;
      this.#ready = helper.ready();
    }
    await this.#ready;
    if (this.#destroyed || this.#failed || generation !== this.#generation) throw new Error('native_document_retired');
    return this.#helper;
  }

  async request(event, request) {
    if (!trustedSender(event, this.contents)) throw new Error('untrusted_native_sender');
    validateViewRequest(request, { controller: this.controller });
    if (!this.#token || request.token !== this.#token) throw new Error('native_document_retired');
    const generation = this.#generation;
    if (DESKTOP_COMMANDS.includes(request.command)) {
      if (request.command === 'desktop_native_state' || request.command === 'desktop_recover') {
        if (Object.keys(request.args).length) throw new Error('invalid_desktop_args');
        return request.command === 'desktop_native_state' ? { failed: this.#failed } : this.#recover();
      }
      if (!this.services) throw new Error('desktop_service_unavailable');
      const serviceGeneration = this.#serviceGeneration;
      const active = () => serviceGeneration === this.#serviceGeneration && !this.#destroyed;
      const result = await this.services.request(request.command, request.args, active);
      if (!active()) throw new Error('native_document_retired');
      return result;
    }
    if (this.services?.migration && !this.services.migration.ready && (request.command.startsWith('device_') || request.command === 'desktop_host')) throw new Error('migration_not_complete');
    // An existing helper can spawn Host CLI processes too; apply the same
    // bundle fence before every Host-control call, not just helper creation.
    if (request.command === 'desktop_host') this.beforeNativeStart('host-command');
    const helper = await this.#native(generation);
    const { command, args } = request;
    if (command === 'net_document') {
      if (this.#documentPending) throw new Error('native_document_busy');
      this.#documentPending = true;
      this.#document = undefined; this.#slots.clear(); this.#channels.clear();
      try {
        const lease = await helper.call(command, args);
        if (generation !== this.#generation) throw new Error('native_document_retired');
        if (typeof lease !== 'string' || !lease || lease.length > 128) throw new Error('invalid_native_document');
        this.#document = lease;
        return lease;
      } finally { if (generation === this.#generation) this.#documentPending = false; }
    }
    if (command === 'net_allocate') {
      if (!this.#document || args.document !== this.#document || this.#documentPending) throw new Error('native_document_retired');
      const document = this.#document;
      const id = await helper.call(command, args);
      if (generation !== this.#generation || document !== this.#document) throw new Error('native_document_retired');
      if (typeof id !== 'string' || !id || id.length > 128 || this.#slots.has(id)) throw new Error('invalid_native_slot');
      this.#slots.set(id, { id, document, kind: args.kind });
      return id;
    }
    let forwarded = args;
    let subscription;
    if (command === 'net_socket_open') {
      const slot = this.#slots.get(args.id);
      if (!slot || slot.kind !== 'socket' || slot.channel || slot.document !== this.#document) throw new Error('native_request_cancelled');
      if ([...this.#channels.values()].some(slot => slot.subscription === request.subscription)) throw new Error('invalid_native_subscription');
      subscription = { ...slot, channel: randomUUID(), subscription: request.subscription };
      this.#slots.set(slot.id, subscription);
      this.#channels.set(subscription.channel, subscription);
      forwarded = { ...args, channel: subscription.channel };
    }
    if (command === 'net_cancel') {
      const slot = this.#slots.get(args.id);
      if (slot?.channel) this.#channels.delete(slot.channel);
      this.#slots.delete(args.id);
    }
    try {
      const result = await helper.call(command, forwarded);
      if (generation !== this.#generation || this.#failed) throw new Error('native_document_retired');
      if (command === 'net_http_read' && result?.data === '') this.#slots.delete(args.id);
      return result;
    } catch (error) {
      if (generation === this.#generation && ['net_http_open', 'net_http_read'].includes(command)) this.#slots.delete(args.id);
      if (subscription && generation === this.#generation) {
        this.#channels.delete(subscription.channel);
        this.#slots.delete(subscription.id);
      }
      throw error;
    }
  }

  retire(retireServices = true) {
    this.services?.retireScreen?.();
    ++this.#generation;
    this.#token = undefined;
    this.#navigationToken = undefined;
    if (retireServices) { ++this.#serviceGeneration; this.services?.retire(); }
    for (const slot of this.#channels.values()) this.#send(slot.subscription, { kind: 'close', code: 1006, reason: 'native_document_retired', clean: false });
    const helper = this.#helper;
    this.#helper = undefined; this.#ready = undefined; this.#failed = false;
    this.#document = undefined; this.#documentPending = false; this.#slots.clear(); this.#channels.clear();
    helper?.close('native_document_retired');
  }
  dispose() {
    if (this.#destroyed) return;
    this.#destroyed = true; this.retire();
    this.contents.removeListener('did-start-navigation', this.onNavigation);
    this.contents.removeListener('render-process-gone', this.onGone);
    this.contents.removeListener('destroyed', this.onDestroyed);
    this.contents.removeListener('did-navigate', this.onCommit);
    this.contents.removeListener('did-stop-loading', this.onStopped);
    this.services?.dispose();
  }
}

export function installNativeIPC(ipcMain, owners) {
  ipcMain.handle(NATIVE_BOOTSTRAP, event => {
    const owner = owners.get(event.sender.id);
    if (!owner) throw new Error('untrusted_native_sender');
    return owner.bootstrap(event);
  });
  ipcMain.handle(NATIVE_REQUEST, async (event, request) => {
    const owner = owners.get(event.sender.id);
    if (!owner) return { ok: false, error: 'untrusted_native_sender' };
    try { return { ok: true, result: await owner.request(event, request) }; }
    catch (error) {
      // Electron invoke errors add a framework prefix. Send the exact bounded
      // native code so existing transport and local-controller classifiers work.
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 8192) : 'native_request_failed' };
    }
  });
  return () => { ipcMain.removeHandler(NATIVE_REQUEST); ipcMain.removeHandler(NATIVE_BOOTSTRAP); };
}
