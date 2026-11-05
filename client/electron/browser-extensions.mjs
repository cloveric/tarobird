import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { PERSONAL_BROWSER_SCOPE } from '../shared/personal-browser.mjs';
import { POLICY_READY, holdProbe, installRequestFilter, partitionFor, policyReady, policyRules, releaseProbe, removeRequestFilter } from './browser-policy.mjs';
import { verifyCrx3 } from './crx3.mjs';
import { ARCHIVE_LIMITS, stageFolder, stageZip } from './extension-archive.mjs';
import { ExtensionBridge } from './extension-bridge.mjs';
import { OPTIONS_LIMITS, OptionsWindows, optionsPath, optionsURL } from './extension-options.mjs';

// The person's Chrome extensions for workbench pages. Electron loads unpacked
// extensions per session and forgets them on exit, so main keeps its own copies
// and registry and attaches them to page sessions as they are created. Only the
// trusted App UI reaches this (desktop command `workbench_browser_extensions`);
// it is not a browser action, so Bots, the Hub and the CLI cannot call it.
export const EXTENSIONS_COMMAND = 'workbench_browser_extensions';
export const EXTENSION_LIMITS = Object.freeze({ extensions: 50, loadMs: 5000, policyMs: 5000, downloadMs: 120000, optionsWindows: OPTIONS_LIMITS.windows, optionsMs: OPTIONS_LIMITS.loadMs, optionsWorkerMs: OPTIONS_LIMITS.workerMs, optionsCloseMs: OPTIONS_LIMITS.closeMs });
export { packagePath } from './extension-archive.mjs';
const ID = z.string().regex(/^[a-p]{32}$/);
const SCOPE = z.enum(['personal', 'all']);
const printable = max => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/);
const PAGE_SCOPE = z.object({ host: printable(256), user: printable(256), conversation: printable(256) }).strict();
export const EXTENSION_ACTION = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('install'), source: z.enum(['folder', 'file', 'store']), store: z.string().min(1).max(2048).optional(), english: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('set'), id: ID, enabled: z.boolean().optional(), scope: SCOPE.optional(), english: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('reload'), id: ID }).strict(),
  z.object({ action: z.literal('remove'), id: ID }).strict(),
  z.object({ action: z.literal('compat'), scope: PAGE_SCOPE }).strict(),
  z.object({ action: z.literal('compat_set'), scope: PAGE_SCOPE, enabled: z.boolean(), english: z.boolean().optional() }).strict(),
  // The extension's settings page in this exact page scope (never a wider one).
  z.object({ action: z.literal('options'), id: ID, scope: PAGE_SCOPE, english: z.boolean().optional() }).strict(),
]);
const FEATURE = z.object({ code: z.string().max(64), status: z.enum(['supported', 'not_enforced', 'unavailable']) }).strict();
const REPORT = z.object({ manifestVersion: z.union([z.literal(2), z.literal(3)]), description: z.string().max(512), hostAccess: z.enum(['all', 'some', 'none']),
  hosts: z.array(z.string().max(256)).max(8), features: z.array(FEATURE).max(64), verdict: z.enum(['works', 'limited']), warnings: z.array(z.string().max(256)).max(16) }).strict();
// `origin` is a hash of the chosen location, so reinstalling an unsigned folder
// or archive from the same place keeps its generated key (and so its ID and data).
const ENTRY = z.object({ id: ID, name: z.string().max(128), version: z.string().max(32), enabled: z.boolean(), scope: SCOPE, source: z.enum(['folder', 'zip', 'crx', 'store']),
  signature: z.enum(['store', 'developer', 'none']), installedAt: z.number().finite(), report: REPORT, origin: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict();
const PARTITION_NAME = /^persist:tarobot-browser-v1-[0-9a-f]{32}$/;
// `compatible`: page partitions whose person turned on extension compatibility mode.
const REGISTRY = z.object({ version: z.literal(1), extensions: z.array(ENTRY).max(EXTENSION_LIMITS.extensions), compatible: z.array(z.string().regex(PARTITION_NAME)).max(4096).optional() }).strict();
const code = (error, fallback) => /^[a-z_]{3,64}$/.test(error?.message ?? '') ? error.message : fallback;

// Chrome's ID: the first 128 bits of SHA-256(public key DER), as a–p digits.
export function extensionId(publicKey) {
  return [...createHash('sha256').update(publicKey).digest().subarray(0, 16)].map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
}
/** Chrome Web Store address or bare ID → extension ID. */
export function storeExtensionId(raw) {
  const value = String(raw ?? '').trim();
  if (/^[a-p]{32}$/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new Error('store_address_invalid'); }
  const parts = url.pathname.split('/').filter(Boolean);
  const store = url.hostname === 'chromewebstore.google.com' && parts[0] === 'detail' || url.hostname === 'chrome.google.com' && parts[0] === 'webstore' && parts[1] === 'detail';
  const id = parts.find(part => /^[a-p]{32}$/.test(part));
  if (url.protocol !== 'https:' || url.username || url.password || !store || !id) throw new Error('store_address_invalid');
  return id;
}

// Chrome accepts comments and trailing commas in manifest.json. Both are removed
// only outside strings, so string values are never altered.
export function parseJSON(text) {
  const source = text.replace(/^﻿/, '');
  try { return JSON.parse(source); } catch { /* try the relaxed form */ }
  const skip = at => {
    for (;;) {
      while (/\s/.test(source[at] ?? '')) at++;
      if (source[at] === '/' && source[at + 1] === '/') { while (at < source.length && source[at] !== '\n') at++; continue; }
      if (source[at] === '/' && source[at + 1] === '*') { const end = source.indexOf('*/', at + 2); if (end < 0) throw new Error('manifest_invalid'); at = end + 2; continue; }
      return at;
    }
  };
  let out = '', string = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index], next = source[index + 1];
    if (string) { out += char; if (char === '\\') out += source[++index] ?? ''; else if (char === '"') string = false; continue; }
    if (char === '"') { string = true; out += char; continue; }
    if (char === '/' && (next === '/' || next === '*')) { index = skip(index) - 1; out += ' '; continue; }
    if (char === ',' && ['}', ']'].includes(source[skip(index + 1)])) continue;
    out += char;
  }
  try { return JSON.parse(out); } catch { throw new Error('manifest_invalid'); }
}

// Electron 45 implements these (see docs/client/browser-extensions-2026-11-01.md).
// webNavigation and contextMenus are provided by TaroBird's bridge (extension-bridge.mjs).
const SUPPORTED = new Set(['storage', 'unlimitedStorage', 'scripting', 'tabs', 'alarms', 'management', 'idle', 'webNavigation', 'contextMenus']);
// Implemented by Electron, but TaroBird's default request filter (it keeps pages and
// extensions away from local services) takes precedence over them. They work in
// a page scope whose person turned on compatibility mode.
const NETWORK = new Set(['webRequest', 'webRequestBlocking', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback']);
// activeTab is granted by clicking the toolbar button, which TaroBird does not show.
const UNAVAILABLE = { activeTab: 'active_tab', notifications: 'notifications', cookies: 'cookies', downloads: 'downloads', identity: 'identity',
  nativeMessaging: 'native_messaging', debugger: 'debugger', history: 'history', bookmarks: 'bookmarks',
  offscreen: 'offscreen', sidePanel: 'side_panel', tabGroups: 'tab_groups', sessions: 'sessions', topSites: 'top_sites', proxy: 'proxy',
  privacy: 'privacy', browsingData: 'browsing_data', contentSettings: 'content_settings', declarativeContent: 'declarative_content',
  tts: 'tts', ttsEngine: 'tts', pageCapture: 'page_capture', desktopCapture: 'desktop_capture', tabCapture: 'tab_capture', userScripts: 'user_scripts',
  fontSettings: 'font_settings', gcm: 'gcm', power: 'power', search: 'search', webAuthenticationProxy: 'web_authentication_proxy' };

/** What this extension can and cannot do in TaroBird pages, from its manifest.
 * This is a declaration review, not proof of execution. Unknown permissions are
 * reported unavailable; an extension with nothing that can run is refused. */
export function compatibility(manifest, warnings = []) {
  const version = manifest.manifest_version;
  if (version !== 2 && version !== 3) throw new Error('manifest_version_unsupported');
  // Optional permissions are never requested here (no permission prompt UI), so only required ones count.
  const permissions = [...new Set((Array.isArray(manifest.permissions) ? manifest.permissions : []).filter(value => typeof value === 'string'))];
  const hostList = [...(version === 3 ? (Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []) : permissions.filter(value => value.includes('://') || value === '<all_urls>')),
    ...(Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).flatMap(script => Array.isArray(script?.matches) ? script.matches : [])].filter(value => typeof value === 'string');
  const hosts = [...new Set(hostList)];
  const all = hosts.some(value => value === '<all_urls>' || /^(\*|https?):\/\/\*\/\*$/.test(value));
  const features = [], add = (feature, status) => { if (!features.some(item => item.code === feature)) features.push({ code: feature, status }); };
  const scripts = (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []).filter(script => Array.isArray(script?.js) && script.js.length || Array.isArray(script?.css) && script.css.length);
  const background = !!(manifest.background?.service_worker || manifest.background?.scripts?.length || manifest.background?.page);
  if (scripts.length) add('content_scripts', 'supported');
  if (background) add('background', 'supported');
  for (const permission of permissions) {
    if (permission.includes('://') || permission === '<all_urls>') continue;
    if (SUPPORTED.has(permission)) add(permission, 'supported');
    else if (NETWORK.has(permission)) add('network_rules', 'not_enforced');
    else add(UNAVAILABLE[permission] ?? `permission:${permission.slice(0, 48)}`, 'unavailable');
  }
  if (manifest.declarative_net_request) add('network_rules', 'not_enforced');
  if (manifest.action || manifest.browser_action || manifest.page_action) add('toolbar', 'unavailable');
  // Opened from Extensions in its own window (extension-options.mjs); the file itself is checked when listed and opened.
  if (manifest.options_page || manifest.options_ui) add('options_page', optionsPath(manifest) ? 'supported' : 'unavailable');
  if (manifest.chrome_url_overrides) add('page_overrides', 'unavailable');
  if (manifest.commands) add('shortcuts', 'unavailable');
  if (manifest.side_panel) add('side_panel', 'unavailable');
  if (manifest.omnibox) add('omnibox', 'unavailable');
  if (manifest.devtools_page) add('devtools', 'unavailable');
  if (!scripts.length && !background) throw new Error('extension_has_nothing_to_run');
  return { manifestVersion: version, description: String(manifest.description ?? '').slice(0, 512), hostAccess: all ? 'all' : hosts.length ? 'some' : 'none',
    hosts: hosts.slice(0, 8).map(value => value.slice(0, 256)), features: features.slice(0, 64),
    verdict: features.some(item => item.status !== 'supported') ? 'limited' : 'works', warnings: warnings.slice(0, 16).map(value => String(value).slice(0, 256)) };
}

async function localized(staging, manifest, value) {
  const match = /^__MSG_(\w+)__$/.exec(String(value ?? ''));
  if (!match) return String(value ?? '');
  for (const locale of [manifest.default_locale, 'en', 'en_US'].filter(item => typeof item === 'string' && /^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(item))) {
    try {
      const messages = parseJSON(await readFile(path.join(staging, '_locales', locale, 'messages.json'), 'utf8'));
      const entry = Object.entries(messages).find(([key]) => key.toLowerCase() === match[1].toLowerCase());
      if (entry?.[1]?.message) return String(entry[1].message);
    } catch { /* next locale */ }
  }
  return match[1];
}

/** Normalize the staged copy's manifest with a `key`, so the ID is the
 * publisher's (CRX), the manifest's own, a previous local install's, or a fresh
 * local key — never derived from our folder path. Writes it back to the copy:
 * the reviewed manifest is exactly the one that will load. */
export async function prepareStaged(staging, { key } = {}) {
  const manifest = parseJSON(await readFile(path.join(staging, 'manifest.json'), 'utf8').catch(() => { throw new Error('manifest_missing'); }));
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('manifest_invalid');
  if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !/^\d{1,9}(\.\d{1,9}){0,3}$/.test(manifest.version)) throw new Error('manifest_invalid');
  let der = key;
  if (!der && typeof manifest.key === 'string') {
    try { der = Buffer.from(manifest.key, 'base64'); createPublicKey({ key: der, format: 'der', type: 'spki' }); } catch { throw new Error('manifest_key_invalid'); }
  }
  if (!der) der = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
  manifest.key = Buffer.from(der).toString('base64');
  const report = compatibility(manifest);
  const name = (await localized(staging, manifest, manifest.name)).slice(0, 128) || 'Extension';
  await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { id: extensionId(der), name, version: manifest.version, report };
}

const managers = new Map();
/** One manager per profile directory, shared by every App window (sessions are global). */
export function extensionsFor(root, electron, options) {
  if (!root) return undefined;
  let manager = managers.get(root);
  if (!manager) managers.set(root, manager = new BrowserExtensions(root, electron, options));
  return manager;
}

const PERSONAL_PARTITION = partitionFor(PERSONAL_BROWSER_SCOPE);
const withTimeout = (promise, ms) => { let timer; return Promise.race([promise.then(value => ({ value }), error => ({ error })), new Promise(resolve => { timer = setTimeout(resolve, ms, { timeout: true }); })]).finally(() => clearTimeout(timer)); };

export class BrowserExtensions {
  #root; #electron; #changed; #warnings; #limits; #queue = Promise.resolve(); #registry; #sessions = new Map(); #loaded = new Map(); #errors = new Map();
  // Bumped by a full reset: installations prepared before it cannot commit after it.
  // Per partition, also by a Host removal: an open compatibility prompt cannot revive it.
  #generation = 0; #scopeGenerations = new Map();
  // One native load in flight per partition and extension; a late one is reconciled.
  #pending = new Map();
  // Compatibility mode in effect this run (partition → policy extension ID), and failures.
  // A failed partition keeps its filter and is not retried automatically this run:
  // only the person's explicit compat_set (or the next App run) tries again.
  #compatible = new Map(); #compatErrors = new Map(); #compatFailed = new Set(); #policy; #bridge;
  // Partitions whose activation is running now: an earlier timed-out policy
  // load that settles meanwhile leaves the policy to that activation.
  #compatEnabling = new Set();
  // `drain(session, options)` (WorkbenchBrowser.drainForCompat) closes that
  // session's pages before its request filter can go; see #enableCompat.
  // Without one, compatibility mode cannot turn on (fails closed).
  #drain;
  // Open settings pages (partition + extension → window), and each package's
  // validated options page (id, version, install time → page or null).
  #options; #optionPages = new Map();
  // Per App window, bumped when its browser is disposed: an options request
  // still waiting for it never opens a window afterwards.
  #windowGenerations = new Map();
  constructor(root, electron, { changed = () => {}, warnings = process, limits = EXTENSION_LIMITS, openTab = async () => { throw new Error('No TaroBird window can open this page'); },
    drain = async () => ({ ok: false, reason: 'unavailable', release() {} }) } = {}) {
    this.#root = root; this.#electron = electron; this.#changed = changed; this.#warnings = warnings; this.#limits = limits; this.#drain = drain;
    this.#bridge = new ExtensionBridge(root, { extensionAllowed: (session, id) => this.#allowedIn(session, id), openTab });
    this.#options = new OptionsWindows(electron, { openTab, limits: { windows: limits.optionsWindows ?? OPTIONS_LIMITS.windows, loadMs: limits.optionsMs ?? OPTIONS_LIMITS.loadMs,
      closeMs: limits.optionsCloseMs ?? OPTIONS_LIMITS.closeMs } });
  }
  /** Bridge calls: only a registered extension that applies to this exact page session. */
  #allowedIn(session, id) {
    const entry = this.#registry?.extensions.find(item => item.id === id);
    if (!entry) return false;
    for (const [partition, value] of this.#sessions) if (value === session) return this.#applies(entry, partition);
    return false;
  }
  observe(contents, window) { this.#bridge.observe(contents, window); }
  activated(contents, window) { this.#bridge.activated(contents, window); }
  menuItems(session, params, tab) { return this.#bridge.menuItems(session, params, tab); }
  windowClosed(id) {
    this.#bridge.windowClosed(id); this.#windowGenerations.set(id, (this.#windowGenerations.get(id) ?? 0) + 1);
    void this.#options.close(record => record.parentId === id);
  }
  #serial(fn) { const next = this.#queue.then(fn); this.#queue = next.catch(() => undefined); return next; }
  #package(id) { return path.join(this.#root, 'packages', id); }
  #api(partition) { const session = this.#sessions.get(partition); return session?.extensions ?? session; }
  async #read() {
    if (this.#registry) return this.#registry;
    let text;
    try { text = await readFile(path.join(this.#root, 'registry.json'), 'utf8'); }
    catch (error) { if (error?.code === 'ENOENT') return (this.#registry = { version: 1, extensions: [] }); throw new Error('extensions_unreadable'); }
    let checked;
    try { checked = REGISTRY.safeParse(JSON.parse(text)); } catch { checked = { success: false }; }
    // A malformed registry is kept for recovery; nothing loads from it.
    if (!checked.success) throw new Error('extensions_unreadable');
    return (this.#registry = checked.data);
  }
  async #save(registry) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const file = path.join(this.#root, 'registry.json'), temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(registry), { mode: 0o600 }); await rename(temp, file); }
    catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
    this.#registry = registry;
  }
  #applies(entry, partition) { return entry.enabled && (partition === PERSONAL_PARTITION || entry.scope === 'all'); }

  /** A page session was created (or reused), after page policy was installed on
   * it. Only main's own session for that page partition; never the App session. */
  attach(session, scope) {
    const partition = partitionFor(scope), expected = this.#electron.session?.fromPartition?.(partition);
    // A refused session simply gets no extensions; page creation never fails here.
    if (!PARTITION_NAME.test(partition) || expected && session !== expected || session === this.#electron.session?.defaultSession) return Promise.resolve();
    if (!this.#sessions.has(partition)) { this.#sessions.set(partition, session); this.#loaded.set(partition, new Map()); }
    return this.#serial(() => this.#sync(partition)).catch(() => undefined);
  }
  /** Resolves once this scope's extensions are loaded (bounded), before a page loads. */
  ready(session, scope) {
    const pending = this.attach(session, scope);
    return Promise.race([pending, new Promise(resolve => setTimeout(resolve, this.#limits.loadMs + this.#limits.policyMs).unref?.())]);
  }
  /** Whether this session currently runs in compatibility mode (no request filter). */
  compatible(session) { for (const [partition, value] of this.#sessions) if (value === session) return this.#compatible.has(partition); return false; }

  async #sync(partition) {
    // A partition forgotten by a Host removal stays empty until it is attached again.
    if (!this.#sessions.has(partition)) return;
    let registry;
    try { registry = await this.#read(); } catch { return; }
    await this.#applyCompat(partition, registry);
    const loaded = this.#loaded.get(partition), api = this.#api(partition);
    for (const [id, version] of loaded) {
      const entry = registry.extensions.find(item => item.id === id);
      if (!entry || !this.#applies(entry, partition) || entry.version !== version) {
        void this.#options.close(record => record.partition === partition && record.id === id);
        try { api.removeExtension(id); } catch { /* already gone */ } loaded.delete(id); this.#bridge.forgetExtension(this.#sessions.get(partition), id);
      }
    }
    for (const entry of registry.extensions) if (this.#applies(entry, partition) && !loaded.has(entry.id)) await this.#load(partition, entry);
  }
  async #load(partition, entry) {
    const loaded = this.#loaded.get(partition), api = this.#api(partition), key = `${partition}\0${entry.id}`;
    // Still loading (timed out, not settled): keep it the only load of this ID
    // and keep reporting it, also after a reload or a new attach.
    if (this.#pending.has(key)) { this.#errors.set(entry.id, 'extension_load_timeout'); return; }
    try { await this.#bridge.enable(this.#sessions.get(partition)); } catch { this.#errors.set(entry.id, 'extension_load_failed'); return; }
    const attempt = Promise.resolve().then(() => api.loadExtension(this.#package(entry.id), { allowFileAccess: false }));
    const result = await withTimeout(attempt, this.#limits.loadMs);
    if (result.timeout) {
      // No second load of this ID starts meanwhile. When it settles it counts as
      // loaded (with the version it was started for) and the next sync reconciles:
      // an update, disable, removal or reset since then unloads or reloads it.
      this.#errors.set(entry.id, 'extension_load_timeout'); this.#pending.set(key, attempt);
      void attempt.then(extension => {
        if (this.#loaded.get(partition) !== loaded || extension?.id !== entry.id) { try { api.removeExtension(extension?.id); } catch { /* gone */ } return; }
        loaded.set(entry.id, entry.version); this.#errors.delete(entry.id);
      }, () => {}).finally(() => { this.#pending.delete(key); void this.#serial(() => this.#sync(partition)).catch(() => {}); });
      return;
    }
    if (result.error) { this.#errors.set(entry.id, code(result.error, 'extension_load_failed')); return; }
    if (result.value?.id !== entry.id) { try { api.removeExtension(result.value?.id); } catch { /* gone */ } this.#errors.set(entry.id, 'extension_id_mismatch'); return; }
    loaded.set(entry.id, entry.version); this.#errors.delete(entry.id);
  }
  async #syncAll() { for (const partition of this.#sessions.keys()) await this.#sync(partition); }
  #unloadEverywhere(id) {
    void this.#options.close(record => record.id === id);
    for (const [partition, loaded] of this.#loaded) { if (loaded.delete(id)) try { this.#api(partition).removeExtension(id); } catch { /* gone */ } this.#bridge.forgetExtension(this.#sessions.get(partition), id); }
  }

  // Compatibility mode. Turning it on loads the private policy extension with the
  // request filter still in place; the filter goes only after the policy's
  // declarative rules report ready. Turning it off restores the filter first.
  async #policyPackage(token) {
    if (!this.#policy) {
      const keyFile = path.join(this.#root, 'policy-key');
      let key;
      try { key = Buffer.from(await readFile(keyFile, 'utf8'), 'base64'); createPublicKey({ key, format: 'der', type: 'spki' }); }
      catch { key = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }); await mkdir(this.#root, { recursive: true, mode: 0o700 }); await writeFile(keyFile, key.toString('base64'), { mode: 0o600 }); }
      this.#policy = { key, id: extensionId(key), directory: path.join(this.#root, 'policy') };
    }
    if (token) {
      const { key, directory } = this.#policy, rules = policyRules();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'TaroBird page policy', version: '1', key: key.toString('base64'),
        permissions: ['declarativeNetRequest'], background: { service_worker: 'policy.js' } }), { mode: 0o600 });
      await writeFile(path.join(directory, 'policy.js'), `const rules = ${JSON.stringify(rules)};
chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(rule => rule.id), addRules: rules })
  .then(() => fetch(${JSON.stringify(`${POLICY_READY}${token}`)})).catch(() => {});\n`, { mode: 0o600 });
    }
    return this.#policy;
  }
  async #applyCompat(partition, registry) {
    const wanted = (registry.compatible ?? []).includes(partition), active = this.#compatible.has(partition);
    if (wanted && !active && !this.#compatFailed.has(partition)) await this.#enableCompat(partition);
    else if (!wanted && active) this.#disableCompat(partition);
  }
  /** 'active' | 'failed' (filter kept, no automatic retry this run) | 'cancelled'
   * (the person declined reloading pages, or pages changed while asking:
   * nothing changed) | 'stale' (a reset or Host removal happened meanwhile). */
  async #enableCompat(partition, options) {
    this.#compatEnabling.add(partition);
    try { return await this.#enableCompatNow(partition, options); } finally { this.#compatEnabling.delete(partition); }
  }
  async #enableCompatNow(partition, { interactive = false, english = false, window } = {}) {
    const session = this.#sessions.get(partition), api = this.#api(partition), token = randomUUID().replace(/-/g, '');
    const generation = this.#generation, scoped = this.#scopeGenerations.get(partition) ?? 0;
    // Still this run's session of this partition, with no reset or Host removal since.
    const fresh = () => generation === this.#generation && scoped === (this.#scopeGenerations.get(partition) ?? 0) && this.#sessions.get(partition) === session;
    const fail = () => { this.#compatErrors.set(partition, 'compatibility_unavailable'); this.#compatFailed.add(partition); return 'failed'; };
    let policy;
    try { policy = await this.#policyPackage(token); } catch { return fail(); }
    const unload = () => { try { api.removeExtension(policy.id); } catch { /* not loaded */ } };
    const waiting = policyReady(session, token, this.#limits.policyMs);
    unload();
    const loading = Promise.resolve().then(() => api.loadExtension(policy.directory, { allowFileAccess: false }));
    const loaded = await withTimeout(loading, this.#limits.loadMs);
    // A policy load that settles after its timeout never turns anything on later.
    if (loaded.timeout) void loading.then(() => { if (!this.#compatible.has(partition) && !this.#compatEnabling.has(partition)) unload(); }, () => {});
    if (loaded.timeout || loaded.error || loaded.value?.id !== policy.id || !await waiting) { unload(); return fail(); }
    // The policy is ready while the filter still stands. A page document
    // committed under the filter would stay outside the policy once the filter
    // goes, so its pages are closed first (asking about input when the person
    // is deciding) and the filter is removed in the same step that confirms
    // none is left. Any refusal or failure keeps the filter.
    let drain;
    try { drain = await this.#drain(session, { interactive, english, window }); } catch { drain = { ok: false, reason: 'failed' }; }
    if (!drain.ok) { unload(); return drain.reason === 'cancelled' || interactive && drain.reason === 'changed' ? 'cancelled' : fail(); }
    // Settings pages are documents of this session too: gone before the filter
    // can go (none can open meanwhile: opening waits for this queue). One not
    // seen to go keeps the filter.
    if (!await this.#options.close(record => record.partition === partition)) { unload(); drain.release(); return fail(); }
    // A reset or Host removal requested while pages were being asked about or
    // closed (both wait for this queue) voids the switch: no late permission.
    if (!fresh()) { unload(); drain.release(); return 'stale'; }
    let activated = false;
    // Synchronous with the check above: nothing can bump a generation in between.
    // The filter goes only while the policy (and its rules) is still loaded.
    const policyLoaded = () => { try { return !!api.getExtension(policy.id); } catch { return false; } };
    try { activated = policyLoaded() && drain.commit(() => { holdProbe(session); removeRequestFilter(session); }); } catch { activated = false; }
    if (!activated) {
      try { installRequestFilter(session); } catch { /* the session is gone */ }
      releaseProbe(session); unload(); drain.release(); return fail();
    }
    this.#compatible.set(partition, policy.id); this.#compatErrors.delete(partition); this.#compatFailed.delete(partition);
    drain.release();
    return 'active';
  }
  /** Restore the filter first, then restart this session's extensions so no
   * worker (or connection it opened) continues from compatibility mode. */
  #disableCompat(partition) {
    const session = this.#sessions.get(partition), id = this.#compatible.get(partition), api = this.#api(partition), loaded = this.#loaded.get(partition);
    installRequestFilter(session);
    void this.#options.close(record => record.partition === partition);
    this.#compatible.delete(partition); this.#compatErrors.delete(partition);
    for (const extension of loaded.keys()) try { api.removeExtension(extension); } catch { /* gone */ }
    loaded.clear();
    try { api.removeExtension(id); } catch { /* gone */ }
    releaseProbe(session);
  }
  /** After website data was cleared. Its rules stay in effect (native check,
   * Electron 45.1.0); re-arming would put the filter back and then remove it
   * under live pages (C1). If the policy is no longer loaded, fail closed:
   * the filter returns and only the person's retry turns it on again. */
  refreshCompat(scope) {
    const partition = partitionFor(scope);
    return this.#serial(async () => {
      if (!this.#compatible.has(partition)) return;
      let present = false;
      try { present = !!this.#api(partition).getExtension(this.#compatible.get(partition)); } catch { present = false; }
      if (present) return;
      this.#disableCompat(partition); this.#compatErrors.set(partition, 'compatibility_unavailable'); this.#compatFailed.add(partition);
      await this.#sync(partition);
    });
  }
  /** Host removal: these partitions lose compatibility mode and every loaded
   * extension before their data is cleared, and later syncs (toggles, reloads,
   * installs, late loads) skip them until the scope is attached again. */
  forget(partitions) {
    for (const partition of partitions) this.#scopeGenerations.set(partition, (this.#scopeGenerations.get(partition) ?? 0) + 1);
    void this.#options.close(record => partitions.includes(record.partition));
    return this.#serial(async () => {
      for (const partition of partitions) {
        const session = this.#sessions.get(partition), ids = [...this.#loaded.get(partition)?.keys() ?? []];
        if (!session) continue;
        if (this.#compatible.has(partition)) this.#disableCompat(partition);
        for (const id of ids) { try { this.#api(partition).removeExtension(id); } catch { /* gone */ } this.#bridge.forgetExtension(session, id); }
        // A timed-out load that settles later finds its map gone and unloads itself.
        this.#sessions.delete(partition); this.#loaded.delete(partition); this.#compatErrors.delete(partition); this.#compatFailed.delete(partition);
      }
      const registry = await this.#read(), compatible = (registry.compatible ?? []).filter(item => !partitions.includes(item));
      if (compatible.length !== (registry.compatible ?? []).length) await this.#save({ ...registry, compatible });
    });
  }

  /** The installed package's options page (validated, file present), or null. */
  #optionsPage(entry) {
    const key = `${entry.id}\0${entry.version}\0${entry.installedAt}`;
    if (!this.#optionPages.has(key)) {
      if (this.#optionPages.size >= 4 * this.#limits.extensions) this.#optionPages.clear();
      this.#optionPages.set(key, (async () => {
        const directory = this.#package(entry.id), found = optionsPath(parseJSON(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
        if (!found) return null;
        const file = path.join(directory, ...found.parts), status = await lstat(file);
        const [base, real] = await Promise.all([realpath(directory), realpath(file)]);
        return status.isFile() && real.startsWith(base + path.sep) ? found.page : null;
      })().catch(() => null));
    }
    return this.#optionPages.get(key);
  }
  // Older registries recorded options pages as unavailable: the summary reports
  // what the installed package offers now, without rewriting the registry.
  async #summary({ origin: _origin, ...entry }) {
    const sessions = [...this.#loaded.values()].filter(map => map.has(entry.id)).length, optionsAvailable = !!await this.#optionsPage(entry);
    const features = entry.report.features.map(item => item.code === 'options_page' ? { ...item, status: optionsAvailable ? 'supported' : 'unavailable' } : item);
    const report = { ...entry.report, features, verdict: features.some(item => item.status !== 'supported') ? 'limited' : 'works' };
    return { ...entry, report, loaded: sessions, optionsAvailable, ...(this.#errors.has(entry.id) ? { error: this.#errors.get(entry.id) } : {}) };
  }
  async #confirm(window, english, message, detail, action) {
    const { response } = await this.#electron.dialog.showMessageBox(window, { type: 'question', title: 'TaroBird', message, detail,
      buttons: english ? ['Cancel', action] : ['取消', action], defaultId: 0, cancelId: 0, noLink: true });
    return response === 1;
  }

  /** `prepare(scope)` (from WorkbenchBrowser) creates that page session with page policy first. */
  request(input, { window, english = false, prepare = () => {} } = {}) {
    const checked = EXTENSION_ACTION.safeParse(input);
    if (!checked.success) throw new Error('invalid_extension_args');
    const args = checked.data, words = args.english ?? english;
    switch (args.action) {
      case 'list': return this.#serial(async () => ({ status: 'ok', extensions: await Promise.all((await this.#read()).extensions.map(entry => this.#summary(entry))) }));
      case 'install': prepare(PERSONAL_BROWSER_SCOPE); return this.#install(args, window, words);
      case 'set': return this.#serial(async () => {
        const registry = await this.#read(), entry = registry.extensions.find(item => item.id === args.id);
        if (!entry) throw new Error('extension_not_found');
        // Conversation pages are the ones Bots read and operate; say so first.
        if (args.scope === 'all' && entry.scope !== 'all' && !await this.#confirm(window, words, words ? `Also run “${entry.name}” in conversation webpages?` : `也在对话网页中运行“${entry.name}”吗？`,
          words ? 'Bots read and operate those pages. This extension will be able to read and change them too, which can affect what a Bot sees and does there.' : 'Bot 会读取和操作这些网页。此扩展也将能读取和更改它们，可能影响 Bot 在其中看到的内容和操作结果。', words ? 'Allow' : '允许')) return { status: 'cancelled' };
        const next = { ...entry, ...(args.enabled === undefined ? {} : { enabled: args.enabled }), ...(args.scope ? { scope: args.scope } : {}) };
        await this.#save({ ...registry, extensions: registry.extensions.map(item => item.id === entry.id ? next : item) });
        await this.#syncAll(); this.#changed();
        return { status: 'ok', extension: await this.#summary(next) };
      });
      case 'reload': return this.#serial(async () => {
        const registry = await this.#read(), entry = registry.extensions.find(item => item.id === args.id);
        if (!entry) throw new Error('extension_not_found');
        this.#unloadEverywhere(entry.id); this.#errors.delete(entry.id); await this.#syncAll(); this.#changed();
        return { status: 'ok', extension: await this.#summary(entry) };
      });
      case 'remove': return this.#serial(async () => {
        const registry = await this.#read();
        if (!registry.extensions.some(item => item.id === args.id)) throw new Error('extension_not_found');
        await this.#save({ ...registry, extensions: registry.extensions.filter(item => item.id !== args.id) });
        this.#unloadEverywhere(args.id); this.#errors.delete(args.id);
        // Best effort: the extension's own storage in page sessions opened this run.
        for (const session of this.#sessions.values()) await Promise.resolve(session.clearStorageData?.({ origin: `chrome-extension://${args.id}` })).catch(() => {});
        await rm(this.#package(args.id), { recursive: true, force: true }).catch(() => {});
        this.#changed();
        return { status: 'ok' };
      });
      case 'compat': return this.#serial(async () => this.#compatState(partitionFor(args.scope), await this.#read()));
      case 'compat_set': prepare(args.scope); return this.#compatSet(args, window, words);
      case 'options': prepare(args.scope); return this.#openOptions(args, window, words);
    }
    throw new Error('invalid_extension_args');
  }
  #compatState(partition, registry) {
    return { status: 'ok', enabled: (registry.compatible ?? []).includes(partition), active: this.#compatible.has(partition),
      ...(this.#compatErrors.has(partition) ? { error: this.#compatErrors.get(partition) } : {}) };
  }
  async #compatSet(args, window, english) {
    const partition = partitionFor(args.scope), personal = partition === PERSONAL_PARTITION, generation = this.#generation, scoped = this.#scopeGenerations.get(partition) ?? 0;
    if (args.enabled) {
      const where = personal ? (english ? 'the personal browser' : '个人浏览器') : (english ? 'this conversation’s webpages' : '此对话的网页');
      if (!await this.#confirm(window, english, english ? `Turn on extension compatibility mode for ${where}?` : `为${where}开启扩展兼容模式？`, [
        english ? 'Extensions’ ad and request blocking rules can then take effect.' : '开启后，扩展的广告/请求拦截规则可以生效。',
        english ? 'Trade-off: extensions you added (their background scripts and settings pages) will be able to connect to services on this computer and your local network, including the TaroBird Host. Webpages themselves stay blocked from this computer’s local services by TaroBird’s policy rules.'
          : '代价：你添加的扩展（其后台脚本和设置页）将能连接本机和局域网中的服务，包括 TaroBird 主机。网页本身访问本机服务仍会被 TaroBird 的策略规则拦截。',
        english ? `Open pages in ${where} reload when it takes effect; pages that may have unsaved input are listed first.` : `生效时，${where}中已打开的网页会重新加载；可能有未保存内容的网页会先列出。`,
        english ? `Applies only to ${where} on this device. You can turn it off at any time to restore the default protection. Bots cannot change this.` : `只影响此设备上的${where}，可随时关闭以恢复默认保护。Bot 无法更改此设置。`,
      ].join('\n'), english ? 'Turn on' : '开启')) return { status: 'cancelled' };
    }
    return this.#serial(async () => {
      if (generation !== this.#generation || scoped !== (this.#scopeGenerations.get(partition) ?? 0)) return { status: 'cancelled', error: 'extensions_reset' };
      // The person's explicit choice: turning it on (Retry) makes one new attempt;
      // turning it off also drops a previous failure.
      this.#compatFailed.delete(partition); if (!args.enabled) this.#compatErrors.delete(partition);
      const registry = await this.#read();
      // The person is deciding now: pages that may hold input are listed before
      // they reload, and declining saves nothing and keeps the protection.
      if (args.enabled && this.#sessions.has(partition) && !this.#compatible.has(partition)) {
        const outcome = await this.#enableCompat(partition, { interactive: true, english, window });
        if (outcome === 'cancelled') return { status: 'cancelled' };
        if (outcome === 'stale') return { status: 'cancelled', error: 'extensions_reset' };
      }
      // Saved only if no reset or Host removal arrived while this waited.
      if (generation !== this.#generation || scoped !== (this.#scopeGenerations.get(partition) ?? 0)) {
        if (this.#compatible.has(partition)) this.#disableCompat(partition);
        return { status: 'cancelled', error: 'extensions_reset' };
      }
      const current = new Set(registry.compatible ?? []);
      if (args.enabled) current.add(partition); else current.delete(partition);
      const next = { ...registry, compatible: [...current] };
      try { await this.#save(next); }
      catch {
        // An unsaved choice never changes what pages may reach: back to the
        // default protection (filter restored, policy unloaded), error kept,
        // and no automatic retry this run.
        if (this.#compatible.has(partition)) this.#disableCompat(partition);
        this.#compatErrors.set(partition, 'compatibility_unavailable'); this.#compatFailed.add(partition);
        if (this.#sessions.has(partition)) await this.#sync(partition);
        this.#changed();
        throw new Error('extension_write_failed');
      }
      if (this.#sessions.has(partition)) await this.#sync(partition);
      this.#changed();
      return this.#compatState(partition, next);
    });
  }

  /** The person's Settings button: only where the extension already runs (this
   * exact scope, enabled, loaded in that session). Checked in the queue; an MV3
   * background worker is started outside it (bounded), so the page's first
   * messages are answered; then everything is checked again and the window is
   * created in that same queue step. Its page loads outside the queue. */
  async #openOptions(args, window, english) {
    const partition = partitionFor(args.scope), generation = this.#generation, scoped = this.#scopeGenerations.get(partition) ?? 0, key = `${partition}\0${args.id}`;
    const parentGeneration = this.#windowGenerations.get(window?.id) ?? 0;
    let parentClosed = !!window?.isDestroyed?.();
    const onParentClosed = () => { parentClosed = true; };
    window?.once?.('closed', onParentClosed);
    const stale = () => generation !== this.#generation || scoped !== (this.#scopeGenerations.get(partition) ?? 0);
    const gone = () => !!window && (parentClosed || !!window.isDestroyed?.() || (this.#windowGenerations.get(window.id) ?? 0) !== parentGeneration);
    try {
      const first = await this.#serial(() => this.#optionsCheck(args, partition, key, stale));
      if (first.result) return first.result;
      if (first.worker && !await this.#startWorker(first.session, args.id, () => stale() || gone()))
        return stale() ? { status: 'cancelled', error: 'extensions_reset' } : gone() ? { status: 'cancelled', error: 'options_closed' } : { status: 'failed', error: 'extension_background_not_ready' };
      let opening;
      const second = await this.#serial(async () => {
        const again = await this.#optionsCheck(args, partition, key, stale);
        if (again.result) return again.result;
        // Nothing awaits from these checks to the window.
        if (gone()) return { status: 'cancelled', error: 'options_closed' };
        if (this.#options.full) return { status: 'failed', error: 'options_limit' };
        try { opening = this.#options.open({ key, partition, id: args.id, session: again.session, url: again.url, title: `${again.entry.name} — ${english ? 'Settings' : '扩展设置'}`, parent: window }); }
        catch { return { status: 'failed', error: 'options_load_failed' }; }
        return undefined;
      });
      return second ?? await opening;
    } finally { window?.removeListener?.('closed', onParentClosed); }
  }
  /** `{ result }` to answer now, or where the page would open. Runs in the queue. */
  async #optionsCheck(args, partition, key, stale) {
    const failed = error => ({ result: { status: 'failed', error } });
    if (stale()) return { result: { status: 'cancelled', error: 'extensions_reset' } };
    const entry = (await this.#read()).extensions.find(item => item.id === args.id);
    if (!entry) return failed('extension_not_found');
    const page = await this.#optionsPage(entry);
    // Re-checked after every wait.
    if (stale()) return { result: { status: 'cancelled', error: 'extensions_reset' } };
    if (!page) return failed('extension_options_unavailable');
    if (!entry.enabled) return failed('extension_disabled');
    // Never a wider scope: a personal-only extension stays out of conversation pages.
    if (!this.#applies(entry, partition)) return failed('extension_not_in_scope');
    const session = this.#sessions.get(partition), url = optionsURL(entry.id, page);
    let native;
    try { native = this.#api(partition)?.getExtension(entry.id); } catch { native = undefined; }
    if (!session || this.#loaded.get(partition)?.get(entry.id) !== entry.version || native?.id !== entry.id || !url) return failed('extension_not_loaded');
    // The previous window of this extension and scope has not gone yet.
    if (this.#options.closing(key)) return failed('options_closing');
    if (this.#options.focus(key)) return { result: { status: 'ok', existing: true } };
    return { entry, session, url, worker: typeof native.manifest?.background?.service_worker === 'string' };
  }
  /** Start the extension's service worker, retrying while Electron is still
   * registering it after a load (bounded; never a fixed sleep). */
  async #startWorker(session, id, cancelled) {
    const workers = session.serviceWorkers, deadline = Date.now() + (this.#limits.optionsWorkerMs ?? OPTIONS_LIMITS.workerMs);
    if (typeof workers?.startWorkerForScope !== 'function') return true;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0 || cancelled()) return false;
      const started = await withTimeout(Promise.resolve().then(() => workers.startWorkerForScope(`chrome-extension://${id}/`)), left);
      if (cancelled()) return false;
      if (started.value) return true;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
  }

  async #download(id) {
    // An in-memory session with no cookies or page policy, used only for this fetch.
    const store = this.#electron.session.fromPartition('tarobot-extension-store');
    const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(process.versions.chrome ?? '0')}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&uc`)}`;
    const response = await store.fetch(url, { signal: AbortSignal.timeout(this.#limits.downloadMs), credentials: 'omit', cache: 'no-store' }).catch(() => { throw new Error('store_download_failed'); });
    if (response.status === 204 || response.status === 404) throw new Error('store_extension_unavailable');
    if (!response.ok || !response.body) throw new Error('store_download_failed');
    if (Number(response.headers.get('content-length') ?? 0) > ARCHIVE_LIMITS.packageBytes) throw new Error('package_too_large');
    const chunks = []; let total = 0;
    for await (const chunk of response.body) { total += chunk.length; if (total > ARCHIVE_LIMITS.packageBytes) throw new Error('package_too_large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  /** Fetch or pick, verify and stage outside the queue; review the staged copy;
   * commit under the queue only if no reset happened meanwhile. */
  async #install(args, window, english) {
    const generation = this.#generation, staging = path.join(this.#root, 'staging', randomUUID());
    let key, origin, source, signature;
    try {
      await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
      if (args.source === 'store') {
        const id = storeExtensionId(args.store);
        let crx;
        try { crx = verifyCrx3(await this.#download(id), { expectedId: id, requirePublisher: true }); }
        catch (error) { throw new Error(['store_download_failed', 'store_extension_unavailable', 'package_too_large'].includes(error?.message) ? error.message : 'crx_signature_invalid'); }
        await stageZip(crx.archive, staging);
        key = Buffer.from(crx.publicKey, 'base64'); source = 'store'; signature = 'store'; origin = createHash('sha256').update(`tarobot-extension-store-v1\0${id}`).digest('hex');
      } else {
        const { canceled, filePaths } = await this.#electron.dialog.showOpenDialog(window, args.source === 'folder'
          ? { title: english ? 'Choose an unpacked extension folder' : '选择已解压的扩展文件夹', properties: ['openDirectory'] }
          : { title: english ? 'Choose an extension package' : '选择扩展安装包', properties: ['openFile'], filters: [{ name: english ? 'Chrome extension' : 'Chrome 扩展', extensions: ['crx', 'zip'] }] });
        if (canceled || !filePaths?.[0]) return { status: 'cancelled' };
        if (generation !== this.#generation) return { status: 'cancelled', error: 'extensions_reset' };
        const chosen = filePaths[0];
        origin = createHash('sha256').update(`tarobot-extension-origin-v1\0${await realpath(chosen)}`).digest('hex');
        if (args.source === 'folder') { await stageFolder(chosen, staging); source = 'folder'; signature = 'none'; }
        else {
          const status = await lstat(chosen);
          if (!status.isFile()) throw new Error('package_unreadable');
          if (status.size > ARCHIVE_LIMITS.packageBytes) throw new Error('package_too_large');
          const bytes = await readFile(chosen);
          if (bytes.subarray(0, 4).toString('latin1') === 'Cr24') {
            let crx;
            try { crx = verifyCrx3(bytes); } catch { throw new Error('crx_signature_invalid'); }
            await stageZip(crx.archive, staging);
            key = Buffer.from(crx.publicKey, 'base64'); source = 'crx'; signature = crx.publisherVerified ? 'store' : 'developer';
          } else if (bytes[0] === 0x50 && bytes[1] === 0x4b) { await stageZip(bytes, staging); source = 'zip'; signature = 'none'; }
          else throw new Error('package_format_unsupported');
        }
      }
      if (!key) {
        // An unsigned package without its own key, from the same location as an
        // installed one: reuse that key, so this is an update of the same ID.
        const own = typeof parseJSON(await readFile(path.join(staging, 'manifest.json'), 'utf8').catch(() => '{}'))?.key === 'string';
        const previous = !own && (await this.#read()).extensions.find(item => item.origin === origin);
        if (previous) try { key = Buffer.from(parseJSON(await readFile(path.join(this.#package(previous.id), 'manifest.json'), 'utf8')).key, 'base64'); } catch { key = undefined; }
      }
      const prepared = await prepareStaged(staging, { key });
      if (prepared.id === (await this.#policyPackage().catch(() => undefined))?.id) throw new Error('extension_id_reserved');
      if (generation !== this.#generation) return { status: 'cancelled', error: 'extensions_reset' };
      const existing = (await this.#read()).extensions.find(item => item.id === prepared.id), report = prepared.report;
      const unavailable = report.features.filter(item => item.status === 'unavailable').length;
      // An update keeps the installed scope and on/off state (#commit), so the review states them.
      const rank = { none: 0, developer: 1, store: 2 }, downgraded = !!existing && rank[signature] < rank[existing.signature];
      const detail = [
        signature === 'store' ? (english ? 'Signed by the Chrome Web Store (verified).' : '已验证 Chrome 应用商店签名。') : signature === 'developer' ? (english ? 'Signed by its developer (verified); not a Chrome Web Store signature.' : '已验证开发者签名（非 Chrome 应用商店签名）。') : (english ? 'Not signed: install only from a source you trust.' : '未签名：请只安装可信来源的扩展。'),
        report.hostAccess === 'all' ? (english ? 'Can read and change every website in the pages where it runs.' : '可读取和更改它所运行网页中的所有网站。')
          : report.hostAccess === 'some' ? (english ? `Can read and change: ${report.hosts.slice(0, 3).join(', ')}` : `可读取和更改：${report.hosts.slice(0, 3).join('，')}`) : '',
        report.features.some(item => item.status === 'not_enforced') ? (english ? 'Its network blocking does not take effect in TaroBird unless you turn on compatibility mode for a browser; some extensions can still hide page elements.' : '此扩展的网络拦截功能在当前 TaroBird 中不生效（可为某个浏览器开启兼容模式）；部分扩展仍可隐藏页面元素。') : '',
        unavailable ? (english ? `${unavailable} declared feature(s) are not available in TaroBird. Details are listed in Extensions.` : `${unavailable} 项声明的功能在 TaroBird 中不可用，详见扩展列表。`) : '',
        downgraded ? (english ? `This replaces a version whose ${existing.signature === 'store' ? 'Chrome Web Store' : 'developer'} signature was verified.` : `这会替换已验证${existing.signature === 'store' ? ' Chrome 应用商店' : '开发者'}签名的版本。`) : '',
        existing?.scope === 'all'
          ? (english ? 'It runs in the personal browser and in conversation webpages on this device. Bots read and operate those pages; this extension can read and change them too.' : '它将在此设备的个人浏览器和对话网页中运行。Bot 会读取和操作对话网页，此扩展也能读取和更改它们。')
          : (english ? 'It runs in the personal browser on this device.' : '它将在此设备的个人浏览器中运行。'),
        existing && !existing.enabled ? (english ? 'It stays turned off until you enable it.' : '它将保持停用，直到你启用。') : '',
        english ? 'Bots cannot install or manage extensions.' : 'Bot 无法安装或管理扩展。',
      ].filter(Boolean).join('\n');
      const verb = existing ? (english ? 'Update' : '更新') : (english ? 'Add' : '添加');
      if (!await this.#confirm(window, english, english ? `${verb} “${prepared.name}” ${prepared.version}?` : `${verb}“${prepared.name}” ${prepared.version}？`, detail, verb)) return { status: 'cancelled' };
      // Replacing a verified package with a less verified one under the same ID is
      // its own decision: what is lost, what carries over, where it keeps running.
      // Cancelling leaves the installed package, scope and data untouched.
      if (downgraded && !await this.#confirm(window, english,
        english ? `Replace the verified “${existing.name}” with ${signature === 'none' ? 'an unsigned' : 'a developer-signed'} package?` : `用${signature === 'none' ? '未签名' : '开发者签名'}安装包替换已验证的“${existing.name}”吗？`, [
          signature === 'none'
            ? (english ? `Its ${existing.signature === 'store' ? 'Chrome Web Store' : 'developer'} signature will no longer be verified: TaroBird cannot confirm who made the new files.` : `它将不再有已验证的${existing.signature === 'store' ? ' Chrome 应用商店' : '开发者'}签名：TaroBird 无法确认新文件的来源。`)
            : (english ? 'It will no longer be verified by the Chrome Web Store; only its developer signature is verified.' : '它将不再有 Chrome 应用商店验证，只验证开发者签名。'),
          english ? 'The new package keeps this extension’s ID and saved data (its storage in TaroBird pages) and can read and change that data.' : '新安装包沿用此扩展的 ID 和已保存数据（它在 TaroBird 网页中的存储），并可读取和更改这些数据。',
          existing.scope === 'all'
            ? (english ? 'It keeps running in conversation webpages as well as the personal browser. Bots read and operate those pages; it can read and change them too.' : '它将继续在对话网页和个人浏览器中运行。Bot 会读取和操作对话网页，它也能读取和更改这些网页。')
            : (english ? 'It runs in the personal browser only.' : '它只在个人浏览器中运行。'),
          existing.enabled ? '' : (english ? 'It stays turned off until you enable it.' : '它将保持停用，直到你启用。'),
          english ? 'Cancel keeps the current version, its signature, data and where it runs. You can change where it runs in Extensions at any time.' : '取消将保留当前版本、签名、数据和运行范围。运行范围可随时在扩展列表中更改。',
        ].filter(Boolean).join('\n'), english ? 'Replace' : '替换')) return { status: 'cancelled' };
      // What the person reviewed: whether it was installed and in which state.
      const reviewed = existing ? { version: existing.version, signature: existing.signature, scope: existing.scope, enabled: existing.enabled, installedAt: existing.installedAt } : null;
      return await this.#serial(() => this.#commit({ generation, staging, prepared, source, signature, origin, reviewed }));
    } catch (error) {
      return { status: 'failed', error: code(error, 'package_unreadable') };
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }
  async #commit({ generation, staging, prepared, source, signature, origin, reviewed }) {
    if (generation !== this.#generation) return { status: 'cancelled', error: 'extensions_reset' };
    const registry = await this.#read(), existing = registry.extensions.find(item => item.id === prepared.id);
    // The confirmation covered the installed state it described. A change since
    // (another install, a removal, a scope or on/off change) needs a new review:
    // an older answer never replaces a later version or revives a removed one.
    if (!reviewed !== !existing || existing && ['version', 'signature', 'scope', 'enabled', 'installedAt'].some(key => existing[key] !== reviewed[key]))
      return { status: 'cancelled', error: reviewed && !existing ? 'extension_not_found' : 'extension_changed' };
    if (!existing && registry.extensions.length >= this.#limits.extensions) return { status: 'failed', error: 'extension_limit' };
    const target = this.#package(prepared.id), old = path.join(path.dirname(staging), `${randomUUID()}.old`);
    // Unload the old version everywhere before its files move; it reloads on any failure.
    this.#unloadEverywhere(prepared.id);
    let moved = false, placed = false;
    const restore = async () => {
      if (placed) await rm(target, { recursive: true, force: true }).catch(() => {});
      if (moved) await rename(old, target).catch(() => {});
      await this.#syncAll();
    };
    try {
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      try { await rename(target, old); moved = true; } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await rename(staging, target); placed = true;
    } catch { await restore(); return { status: 'failed', error: 'extension_write_failed' }; }
    const entry = { id: prepared.id, name: prepared.name, version: prepared.version, enabled: existing?.enabled ?? true, scope: existing?.scope ?? 'personal',
      source, signature, installedAt: Date.now(), report: prepared.report, origin };
    try { await this.#save({ ...registry, extensions: existing ? registry.extensions.map(item => item.id === entry.id ? entry : item) : [...registry.extensions, entry] }); }
    catch { await restore(); return { status: 'failed', error: 'extension_write_failed' }; }
    if (moved) await rm(old, { recursive: true, force: true }).catch(() => {});
    // Loading collects Electron's own warnings (e.g. "Permission 'x' is unknown").
    const warnings = [], listen = warning => { if (warning?.name === 'ExtensionLoadWarning') warnings.push(...String(warning.message).split('\n').slice(1).map(line => line.trim()).filter(Boolean)); };
    this.#warnings.on?.('warning', listen);
    try { await this.#syncAll(); await new Promise(resolve => setImmediate(resolve)); } finally { this.#warnings.off?.('warning', listen); }
    let result = entry;
    if (warnings.length) {
      result = { ...entry, report: { ...entry.report, warnings: [...new Set(warnings)].slice(0, 16).map(value => value.slice(0, 256)) } };
      const current = await this.#read();
      await this.#save({ ...current, extensions: current.extensions.map(item => item.id === entry.id ? result : item) }).catch(() => {});
    }
    this.#changed();
    return { status: 'ok', extension: await this.#summary(result) };
  }

  /** Full local reset: compatibility mode off everywhere (filters restored), then
   * every installed extension unloaded and deleted. Pending installs are void. */
  clear() {
    this.#generation++;
    void this.#options.close(() => true);
    return this.#serial(async () => {
      for (const partition of [...this.#compatible.keys()]) this.#disableCompat(partition);
      for (const [partition, loaded] of this.#loaded) { for (const id of loaded.keys()) try { this.#api(partition).removeExtension(id); } catch { /* gone */ } loaded.clear(); }
      await rm(path.join(this.#root, 'packages'), { recursive: true, force: true });
      await rm(path.join(this.#root, 'staging'), { recursive: true, force: true });
      await this.#save({ version: 1, extensions: [], compatible: [] }); this.#optionPages.clear(); this.#errors.clear(); this.#compatErrors.clear(); this.#compatFailed.clear(); this.#changed();
    });
  }
}
