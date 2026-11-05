import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { scopeKey } from './browser-policy.mjs';

// Per-device, per-conversation browsing history and browser settings for the
// person's page tools. Only main reads or writes these files; Bots never see
// them. One store per profile directory serves every App window, so all
// windows share one cache and one serialized writer.
export const HISTORY_LIMIT = 500;
// Saved, unused histories kept loaded; each is up to HISTORY_LIMIT entries.
// Unsaved or in-use ones are never released, so they may exceed this.
export const IDLE_HISTORIES = 16;
export const SEARCH_ENGINES = Object.freeze(['google', 'bing', 'duckduckgo', 'baidu']);
export const DEFAULT_SETTINGS = Object.freeze({ searchEngine: 'google', defaultZoom: 1, recordHistory: true });
export const BROWSER_SETTINGS = z.object({ searchEngine: z.enum(SEARCH_ENGINES), defaultZoom: z.number().finite().min(0.25).max(3), recordHistory: z.boolean() }).strict();
const ENTRY = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), url: z.string().max(2048), title: z.string().max(512), visitedAt: z.number().finite() }).strict();
const HISTORY_FILE = z.object({ version: z.literal(1), entries: z.array(ENTRY).max(HISTORY_LIMIT) }).strict();
const SETTINGS_FILE = z.object({ version: z.literal(1), settings: BROWSER_SETTINGS }).strict();
// Directory per Host, so a Host removal deletes exactly its own metadata.
const hostDirectory = host => createHash('sha256').update(`tarobot-browser-user-v1\0${host}`).digest('hex').slice(0, 32);
const clip = value => String(value ?? '').slice(0, 512);

const stores = new Map();
/** Shared store for a profile directory; without one (tests), a private in-memory store. */
export function userStoreFor(root, options) {
  if (!root) return new BrowserUserStore(undefined, options);
  let store = stores.get(root);
  if (!store) stores.set(root, store = new BrowserUserStore(root, options));
  return store;
}

export class BrowserUserStore {
  #root; #now; #delay; #remove; #idle; #queue = Promise.resolve(); #history = new Map(); #settings = new Map(); #recording = new Set(); #used = 0;
  // Bumped by a Host reset: work that started before it cannot write afterwards.
  #epochs = new Map();
  // A Host's queued removal. Reads that start meanwhile wait for it, or they
  // would load (and cache) the files it is about to delete. Never rejects.
  #purges = new Map();
  #afterPurge(host) { return this.#purges.get(host) ?? Promise.resolve(); }
  // `remove` deletes a Host's directory; tests substitute controlled I/O.
  constructor(root, { now = Date.now, debounceMs = 1000, idleHistories = IDLE_HISTORIES, remove = directory => rm(directory, { recursive: true, force: true }) } = {}) { this.#root = root; this.#now = now; this.#delay = debounceMs; this.#idle = idleHistories; this.#remove = remove; }
  #file(scope, kind) { return this.#root ? path.join(this.#root, 'v1', hostDirectory(scope.host), `${scopeKey(scope)}.${kind}.json`) : undefined; }
  #serial(fn) { const next = this.#queue.then(fn); this.#queue = next.catch(() => undefined); return next; }
  async #write(file, value) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, file); }
    catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
  }
  #epoch(host) { return this.#epochs.get(host) ?? 0; }
  /** Missing (ENOENT) = default. Anything else that prevents reading throws and
   * the file is left in place: an unreadable file, or a path component that is
   * not a directory (ENOTDIR: corrupted layout, never created by this store).
   * Malformed content is a default for history but throws when `strict`. */
  async #read(file, schema, strict = false) {
    if (!file) return undefined;
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
    let checked;
    try { checked = schema.safeParse(JSON.parse(text)); } catch { checked = { success: false }; }
    if (checked.success) return checked.data;
    if (strict) throw new Error('settings_malformed');
    return undefined;
  }

  // A history entry object is also the recording ticket: clearing or a Host
  // reset replaces it, so a late navigation or title event cannot revive it.
  // Releasing an idle, saved list from memory keeps this small object (and so
  // every ticket) valid; the next use reads the list back from its file.
  #entry(scope) {
    const key = scopeKey(scope);
    let entry = this.#history.get(key);
    // An unreadable history is read again next time instead of staying failed.
    if (entry?.failed) { this.#history.delete(key); entry = undefined; }
    if (!entry) {
      entry = { key, scope: { ...scope }, file: this.#file(scope, 'history'), entries: [], dirty: false, users: 0, used: ++this.#used };
      this.#load(entry);
      this.#history.set(key, entry);
    }
    return entry;
  }
  #load(entry) {
    const load = entry.load = {};
    entry.loading = true;
    entry.ready = this.#afterPurge(entry.scope.host).then(() => this.#read(entry.file, HISTORY_FILE))
      .then(value => { if (entry.load === load) entry.entries = value ? value.entries : []; }, () => { if (entry.load === load) entry.failed = true; })
      .finally(() => { if (entry.load === load) entry.loading = false; });
  }
  /** Holds a history for one operation (synchronously, before any await) and
   * reads a released one back. A retired ticket is never read back. */
  #use(entry) {
    entry.users++; entry.used = ++this.#used;
    if (!entry.entries && !entry.loading && this.#current(entry)) this.#load(entry);
    return entry.ready ?? Promise.resolve();
  }
  #done(entry) { entry.users--; this.#release(); }
  /** Releases the least recently used lists beyond the bound that are saved,
   * idle and readable: never one with unsaved changes, a pending write, a read
   * in progress or an operation holding it. Files are never touched. */
  #release() {
    const idle = [...this.#history.values()].filter(entry => entry.entries && entry.file && !entry.users && !entry.dirty && !entry.timer && !entry.loading && !entry.failed);
    if (idle.length <= this.#idle) return;
    idle.sort((a, b) => a.used - b.used);
    for (const entry of idle.slice(0, idle.length - this.#idle)) { entry.entries = undefined; entry.ready = undefined; entry.load = undefined; }
  }
  #current(entry) { return this.#history.get(entry.key) === entry; }
  ticket(scope) { return this.#entry(scope); }
  /** Record a visit unless history is off for this scope. Resolves to the entry id. */
  record(ticket, visit) {
    // Tracked until it has marked the list dirty, so a flush before quit includes it.
    const work = this.#record(ticket, visit);
    this.#recording.add(work); void work.finally(() => this.#recording.delete(work)).catch(() => {});
    return work;
  }
  async #record(ticket, { url, title }) {
    const ready = this.#use(ticket);
    try {
      await ready;
      if (!this.#current(ticket) || ticket.failed) return undefined;
      // Unknown settings (unreadable or malformed) may hide "recording off": do not record.
      const settings = await this.settings(ticket.scope).catch(() => undefined);
      if (!settings?.recordHistory || !this.#current(ticket)) return undefined;
      const item = { id: randomUUID().replace(/-/g, '').slice(0, 24), url, title: clip(title), visitedAt: this.#now() };
      ticket.entries = [item, ...ticket.entries.filter(entry => entry.url !== url)].slice(0, HISTORY_LIMIT);
      this.#dirty(ticket);
      return item.id;
    } finally { this.#done(ticket); }
  }
  async retitle(ticket, id, title) {
    const ready = this.#use(ticket);
    try {
      await ready;
      if (!this.#current(ticket) || ticket.failed) return;
      const item = ticket.entries.find(entry => entry.id === id), value = clip(title);
      if (item && value && item.title !== value) { item.title = value; this.#dirty(ticket); }
    } finally { this.#done(ticket); }
  }
  async list(scope, { query = '', limit = 100 } = {}) {
    const entry = this.#entry(scope), ready = this.#use(entry);
    try {
      await ready;
      if (entry.failed) throw new Error('history_unavailable');
      const needle = query.trim().toLocaleLowerCase();
      const items = needle ? entry.entries.filter(item => `${item.title}\n${item.url}`.toLocaleLowerCase().includes(needle)) : entry.entries;
      return items.slice(0, limit).map(item => ({ ...item }));
    } finally { this.#done(entry); }
  }
  /** Delete this scope's history only. Pending writes of the old list are dropped. */
  async clear(scope) {
    const old = this.#entry(scope), ready = this.#use(old);
    let removed;
    try { await ready; removed = old.entries?.length ?? 0; } finally { old.users--; }
    clearTimeout(old.timer); old.timer = undefined; old.dirty = false;
    this.#history.set(old.key, { key: old.key, scope: old.scope, file: old.file, entries: [], dirty: false, ready: Promise.resolve(), users: 0, used: ++this.#used });
    if (old.file) await this.#serial(() => rm(old.file, { force: true }));
    return removed;
  }
  #dirty(entry) {
    if (!entry.file) return;
    entry.dirty = true;
    if (entry.timer) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.#persist(entry).catch(() => {}); }, this.#delay);
    entry.timer.unref?.();
  }
  #persist(entry) {
    return this.#serial(async () => {
      if (!entry.dirty || !this.#current(entry)) return;
      entry.dirty = false; entry.users++;
      try { await this.#write(entry.file, { version: 1, entries: entry.entries }); } catch (error) { entry.dirty = true; throw error; }
      finally { this.#done(entry); }
    });
  }
  /** Write every pending history change (before quit). */
  async flush() {
    await Promise.allSettled([...this.#recording]);
    const pending = [...this.#history.values()].filter(entry => entry.dirty);
    for (const entry of pending) { clearTimeout(entry.timer); entry.timer = undefined; }
    await Promise.allSettled(pending.map(entry => this.#persist(entry)));
    await this.#queue;
  }

  /** Rejects with `settings_unavailable` when a settings file exists but cannot
   * be read or parsed; it is read again next time (a later save repairs it). */
  settings(scope) {
    const key = scopeKey(scope);
    let entry = this.#settings.get(key);
    if (!entry) {
      entry = { key, host: scope.host, file: this.#file(scope, 'settings'), value: { ...DEFAULT_SETTINGS } };
      entry.ready = this.#afterPurge(scope.host).then(() => this.#read(entry.file, SETTINGS_FILE, true)).then(value => { if (value) entry.value = value.settings; }, () => { entry.failed = true; });
      this.#settings.set(key, entry);
    }
    return entry.ready.then(() => {
      if (!entry.failed) return { ...entry.value };
      if (this.#settings.get(key) === entry) this.#settings.delete(key);
      throw new Error('settings_unavailable');
    });
  }
  /** Complete, validated settings; persisted through the shared writer. A
   * save started before a Host reset fails instead of restoring its settings. */
  async setSettings(scope, value) {
    const checked = BROWSER_SETTINGS.safeParse(value);
    if (!checked.success) throw new Error('invalid_browser_args');
    const key = scopeKey(scope), epoch = this.#epoch(scope.host), next = { ...checked.data }, file = this.#file(scope, 'settings');
    // Unreadable/malformed settings are replaced by this complete value.
    await this.settings(scope).catch(() => undefined);
    const current = () => { if (this.#epoch(scope.host) !== epoch) throw new Error('scope_reset'); };
    current();
    // The cache changes only after the file does, so a failed write changes nothing.
    if (file) await this.#serial(async () => { current(); await this.#write(file, { version: 1, settings: next }); });
    current();
    this.#settings.set(key, { key, host: scope.host, file, value: next, ready: Promise.resolve() });
    return { ...next };
  }

  /** Host removal / local reset: forget and delete this Host's history and settings. */
  async purgeHost(host) {
    this.#epochs.set(host, this.#epoch(host) + 1);
    for (const [key, entry] of this.#history) if (entry.scope.host === host) { clearTimeout(entry.timer); entry.dirty = false; this.#history.delete(key); }
    for (const [key, entry] of this.#settings) if (entry.host === host) this.#settings.delete(key);
    if (!this.#root) return;
    // A failed removal is reported to the caller; later reads are not held.
    const removal = this.#serial(() => this.#remove(path.join(this.#root, 'v1', hostDirectory(host))));
    const barrier = removal.then(() => undefined, () => undefined);
    this.#purges.set(host, barrier);
    void barrier.then(() => { if (this.#purges.get(host) === barrier) this.#purges.delete(host); });
    await removal;
  }
}
