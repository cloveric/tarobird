import { createHash } from 'node:crypto';

// Policy for workbench web sessions. These sessions never receive the App's
// protocols, preload, permission grants or network policy (`secureSession`).
const EXTERNAL = new Set(['mailto:', 'tel:', 'sms:']);
/** Google account/authorization pages must use the system browser, not an
 * application-controlled Electron page. Match the origin, never a substring. */
export function isGoogleSignInURL(raw) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://accounts.google.com' && !url.username && !url.password;
  } catch { return false; }
}
const AUTOMATIC = new Set(['fullscreen', 'clipboard-sanitized-write']);
const PROMPTED = new Set(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'idle-detection', 'storage-access', 'top-level-storage-access']);
const LOOPBACK_FILTER = ['*://localhost/*', '*://*.localhost/*', '*://127.0.0.1/*', '*://[::1]/*', '*://0.0.0.0/*'];
// beforeunload probe target. Its request is held, never answered, so the probe
// navigation can be stopped before anything (including an error page) commits.
export const UNLOAD_PROBE = 'https://tarobot-unload-probe.invalid/';

export function scopeKey(scope) {
  return createHash('sha256').update(`tarobot-browser-v1\0${scope.host}\0${scope.user}\0${scope.conversation}`).digest('hex').slice(0, 32);
}
/** Derived only in main from the trusted App's scope; never a renderer path. */
export const partitionFor = scope => `persist:tarobot-browser-v1-${scopeKey(scope)}`;

/** `web` stays in the managed page; `external` needs a native confirmation;
 * everything else (file, App, script, browser-internal, custom schemes) is blocked. */
export function classifyURL(raw) {
  let url;
  try { url = new URL(raw); } catch { return { kind: 'blocked', reason: 'invalid_url' }; }
  if (url.username || url.password) return { kind: 'blocked', reason: 'credentials_in_url' };
  if (['http:', 'https:'].includes(url.protocol)) return { kind: 'web', url: url.href };
  if (url.href === 'about:blank') return { kind: 'web', url: url.href };
  if (url.protocol === 'blob:') {
    try { const inner = new URL(url.pathname); if (['http:', 'https:'].includes(inner.protocol)) return { kind: 'web', url: url.href }; } catch { /* opaque */ }
  }
  if (EXTERNAL.has(url.protocol)) return { kind: 'external', url: url.href };
  return { kind: 'blocked', reason: 'unsupported_scheme' };
}

/** Address bar input after the React layer has turned free text into a URL.
 * A bare host gets https; only http(s) and about:blank are opened. */
export function navigationURL(raw) {
  const value = raw.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  const result = classifyURL(candidate);
  if (result.kind !== 'web') throw new Error(result.kind === 'external' ? 'unsupported_scheme' : result.reason === 'invalid_url' ? 'invalid_url' : 'navigation_blocked');
  return result.url;
}

export function privateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '::') return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 127 || a === 10 || a === 0 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168; }
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(host) && host.includes(':') || host.startsWith('::ffff:127.');
}

export function permissionLabel(permission, details = {}, english = false) {
  if (permission === 'media') {
    const types = details.mediaTypes ?? [];
    const audio = types.includes('audio'), video = types.includes('video');
    return english ? (audio && video ? 'camera and microphone' : video ? 'camera' : 'microphone') : (audio && video ? '摄像头和麦克风' : video ? '摄像头' : '麦克风');
  }
  const labels = { geolocation: ['location', '位置'], notifications: ['notifications', '通知'], 'clipboard-read': ['clipboard contents', '剪贴板内容'],
    midi: ['MIDI devices', 'MIDI 设备'], 'idle-detection': ['idle detection', '空闲检测'], 'storage-access': ['storage access', '跨站存储'],
    'top-level-storage-access': ['storage access', '跨站存储'] };
  return (labels[permission] ?? [permission, permission])[english ? 0 : 1];
}

/** User-Agent without Electron/App tokens for website compatibility.
 * `engine` keeps the Electron token and removes only the App's. */
const PRODUCTS = new Set(['Mozilla', 'AppleWebKit', 'Chrome', 'Safari', 'Version', 'Mobile']);
export function browserUserAgent(agent, engine = false) {
  // Electron inserts the App name (spaces removed) and Electron/x tokens.
  return agent.replace(/ ([A-Za-z][\w.-]*)\/\S+/g, (token, product) => PRODUCTS.has(product) || engine && product === 'Electron' ? token : '').replace(/\s{2,}/g, ' ');
}
// YouTube's integrity-token service can return an unusable caption token when
// the real Electron engine is omitted: CC stays on but timedtext returns an
// empty HTTP 200. Retain the session's actual engine version only here. Never
// invent a Chrome version or disclose the App token; page UA stays unchanged.
const ATTESTATION = ['https://www.youtube.com/api/jnn/*'];
// Session → that User-Agent (only when it differs from the stripped one).
const engineAgents = new WeakMap();

/** Install session-wide policy once. `route(contents)` resolves the managed
 * tab owning a webContents; unknown contents (workers, stale pages) are denied. */
export function secureBrowserSession(session, { route }) {
  const own = session.getUserAgent(), stripped = browserUserAgent(own), engine = browserUserAgent(own, true);
  if (engine !== stripped) engineAgents.set(session, engine);
  session.setUserAgent(stripped);
  session.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (AUTOMATIC.has(permission)) return !!route(contents);
    const owner = route(contents);
    return !!owner && PROMPTED.has(permission) && owner.manager.permissionGranted(owner.tab, permission, origin ?? details?.requestingUrl) === true;
  });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const owner = route(contents);
    if (!owner) { callback(false); return; }
    if (AUTOMATIC.has(permission)) { callback(true); return; }
    if (permission === 'openExternal') { owner.manager.openExternal(owner.tab, details?.externalURL).then(callback, () => callback(false)); return; }
    if (!PROMPTED.has(permission)) { owner.manager.blocked(owner.tab, 'permission', permission); callback(false); return; }
    owner.manager.requestPermission(owner.tab, permission, details).then(callback, () => callback(false));
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  session.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(''); });
  session.on('select-serial-port', (event, _ports, _contents, callback) => { event.preventDefault(); callback(''); });
  session.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  session.on('will-download', (event, item, contents) => {
    const owner = route(contents);
    if (!owner) { event.preventDefault(); return; }
    owner.manager.download(owner.tab, item, event);
  });
  installRequestFilter(session);
}

// Extension compatibility mode (opt-in per page scope). Electron gives a session
// `webRequest` listener precedence over every extension's webRequest and
// declarativeNetRequest handling, so a compatible session runs without the
// filter below. A private policy extension (browser-extensions.mjs) then blocks
// page requests to loopback with declarativeNetRequest; it reports readiness
// through this filter, so the filter is removed only after its rules exist.
export const POLICY_READY = 'https://tarobot-policy-ready.invalid/';
// Unload probe for compatible sessions: a private scheme whose response is held
// (then 204 No Content), so the probe navigation never commits a page.
export const PROBE_SCHEME = 'tarobot-unload-probe';
export const COMPAT_PROBE = `${PROBE_SCHEME}://hold/`;
const readiness = new WeakMap();
/** Resolves true when this session's policy extension sends `token`, false on timeout. */
export function policyReady(session, token, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { if (readiness.get(session)?.token === token) readiness.delete(session); resolve(false); }, ms);
    readiness.set(session, { token, done: () => { clearTimeout(timer); readiness.delete(session); resolve(true); } });
  });
}

/** A public page cannot reach loopback services (including the local Host)
 * through subresources, fetch or WebSockets. Typed top-level visits remain. */
export function installRequestFilter(session) {
  session.webRequest.onBeforeRequest({ urls: [...LOOPBACK_FILTER, `${UNLOAD_PROBE}*`, `${POLICY_READY}*`] }, (details, callback) => {
    if (details.url.startsWith(UNLOAD_PROBE)) { setTimeout(() => callback({ cancel: true }), 10000).unref?.(); return; }
    if (details.url.startsWith(POLICY_READY)) {
      // Only the current token, which only main and the policy extension know.
      const waiting = readiness.get(session);
      if (waiting && details.url === `${POLICY_READY}${waiting.token}`) waiting.done();
      callback({ cancel: true }); return;
    }
    if (details.resourceType === 'mainFrame') { callback({}); return; }
    let initiator = '';
    try { initiator = details.frame?.origin ?? ''; } catch { /* frame gone */ }
    if (!initiator || initiator === 'null') try { initiator = details.referrer ? new URL(details.referrer).origin : ''; } catch { initiator = ''; }
    let local = false;
    try { local = !!initiator && privateHost(new URL(initiator).hostname); } catch { local = false; }
    callback({ cancel: !local });
  });
  // Part of the same filter: a session listener of any kind would keep taking
  // precedence over extensions, so compatibility mode removes this one too.
  const engine = engineAgents.get(session);
  if (engine) session.webRequest.onBeforeSendHeaders({ urls: ATTESTATION }, (details, callback) => {
    let url;
    try { url = new URL(details.url); } catch { callback({}); return; }
    if (url.origin !== 'https://www.youtube.com' || url.username || url.password || !url.pathname.startsWith('/api/jnn/')) { callback({}); return; }
    const requestHeaders = {};
    for (const [name, value] of Object.entries(details.requestHeaders ?? {})) if (name.toLowerCase() !== 'user-agent') requestHeaders[name] = value;
    requestHeaders['User-Agent'] = engine;
    callback({ requestHeaders });
  });
}
export function removeRequestFilter(session) {
  session.webRequest.onBeforeRequest(null);
  if (engineAgents.has(session)) session.webRequest.onBeforeSendHeaders(null);
}
// Sessions whose probe scheme main registered (tracked here: the Electron query is asynchronous).
const probes = new WeakSet();
export function holdProbe(session) {
  if (probes.has(session)) return;
  session.protocol.handle(PROBE_SCHEME, () => new Promise(resolve => { setTimeout(() => resolve(new Response(null, { status: 204 })), 10000).unref?.(); }));
  probes.add(session);
}
export function releaseProbe(session) {
  if (!probes.delete(session)) return;
  try { session.protocol.unhandle(PROBE_SCHEME); } catch { /* already gone */ }
}

/** Declarative rules of the private policy extension: the same loopback
 * boundary as `installRequestFilter`, for every request type but main frames. */
export function policyRules() {
  const local = ['localhost', '127.0.0.1', '0.0.0.0'];
  return [
    { id: 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: local, excludedResourceTypes: ['main_frame'], excludedInitiatorDomains: local } },
    { id: 2, priority: 1, action: { type: 'block' }, condition: { regexFilter: '^[a-z]+://\\[::1\\]', excludedResourceTypes: ['main_frame'], excludedInitiatorDomains: local } },
  ];
}
