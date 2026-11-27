import { APP_ORIGIN, isEntryURL } from './contract.mjs';
import { isDesignDocumentURL } from './design-document.mjs';

export function internalResource(raw) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && !url.port && (
      url.protocol === 'tarobot:' && url.hostname === 'app'
      || url.protocol === 'tarobot-widget:' && url.hostname === 'sandbox' && ['/widget-sandbox.html', '/plugin-sandbox.html', '/design-loader.html'].includes(url.pathname)
      || ['blob:', 'data:', 'about:'].includes(url.protocol));
  } catch { return false; }
}

// Widget network access (the widget frame's CSP allows https/wss only):
// https/wss only, without URL credentials or hosts written as loopback,
// private, link-local or local names. The App document itself stays offline.
const WIDGET_RELAY = 'tarobot-widget://sandbox/widget-sandbox.html';
const PLUGIN_RELAY = 'tarobot-widget://sandbox/plugin-sandbox.html';
export function localHost(name) {
  const host = String(name).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || /\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host) || !host.includes('.') && !host.includes(':')) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) { const a = Number(v4[1]), b = Number(v4[2]); return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a >= 224; }
  return host.includes(':') && (host === '::1' || host === '::' || /^f[cd]|^fe[89ab]|^::ffff:/.test(host));
}
export function widgetNetworkURL(raw) {
  try { const url = new URL(raw); return ['https:', 'wss:'].includes(url.protocol) && !url.username && !url.password && !localHost(url.hostname); } catch { return false; }
}
/** A widget guest is an about:srcdoc frame under the fixed widget relay; its
 * Workers' requests carry that frame too (Electron 45). Frameless requests, such
 * as App SharedWorkers or main-process fetches, are never widget traffic. */
export function widgetNetworkRequest(details) {
  if (!widgetNetworkURL(details?.url)) return false;
  if (['mainFrame', 'subFrame'].includes(details.resourceType)) return false;
  let frame = details.frame;
  if (!frame) return false;
  try { for (; frame; frame = frame.parent) { if (frame.url === WIDGET_RELAY) return true; if (frame.url !== 'about:srcdoc') return false; } } catch { /* A detached frame is not trusted. */ }
  return false;
}
const withoutHeaders = (headers, pattern) => Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !pattern.test(name)));

/** Only the owned App's main document can ask for microphone/camera access.
 * Widgets, browser content and workers never inherit those grants. The system
 * owns the final media permission; unknown native capabilities remain denied. */
export function secureSession(session, { owns = () => false, systemPreferences, platform = process.platform } = {}) {
  const ownedEntry = contents => !!contents && owns(contents) && !contents.isDestroyed() && isEntryURL(contents.getURL());
  const trusted = (contents, details) => ownedEntry(contents)
    && details?.isMainFrame === true && isEntryURL(details.requestingUrl);
  const designFullscreen = (contents, details) => {
    if (!ownedEntry(contents) || details?.isMainFrame !== false || !isDesignDocumentURL(details.requestingUrl)) return false;
    try {
      const main = contents.mainFrame;
      if (main.detached || !isEntryURL(main.url)) return false;
      // Electron supplies a URL, not a frame ID. Match exactly one live frame
      // in the entire tree; a nested copy cannot borrow a direct editor's URL.
      const matches = main.framesInSubtree.filter(frame => !frame.detached && frame.url === details.requestingUrl);
      return matches.length === 1 && matches[0].parent === main;
    } catch { return false; } // A frame may have detached before the callback.
  };
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write']);
  const permitted = (contents, permission, details) => allowed.has(permission)
    && (trusted(contents, details) || permission === 'fullscreen' && designFullscreen(contents, details));
  session.setPermissionCheckHandler((contents, permission, _origin, details) => permitted(contents, permission, details));
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!permitted(contents, permission, details)) { callback(false); return; }
    if (permission !== 'media' || platform !== 'darwin') { callback(true); return; }
    const types = details.mediaTypes;
    if (!systemPreferences || !Array.isArray(types) || !types.length || types.some(type => !['audio', 'video'].includes(type))) { callback(false); return; }
    void (async () => {
      for (const type of types) {
        const media = type === 'audio' ? 'microphone' : 'camera';
        const status = systemPreferences.getMediaAccessStatus(media);
        if (status === 'granted') continue;
        if (status !== 'not-determined' || !await systemPreferences.askForMediaAccess(media)) return false;
      }
      return trusted(contents, details);
    })().then(callback, () => callback(false));
  });
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  // Widgets have no network (1.5.1 policy, restored 2026-11-23): every request that is not one of the App's own
  // resources is cancelled here, outside the page. widgetNetworkRequest above is kept, unused, for a later design.
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !internalResource(details.url) }));
  // Widget requests never carry or receive cookies or HTTP credentials. Every
  // allowed external request is a widget request, but its frame can detach
  // after onBeforeRequest (details.frame becomes null), so strip by URL alone.
  session.webRequest.onBeforeSendHeaders((details, callback) => callback(!internalResource(details.url) ? { requestHeaders: withoutHeaders(details.requestHeaders, /^(?:cookie|authorization|proxy-authorization)$/i) } : {}));
  session.webRequest.onHeadersReceived((details, callback) => callback(!internalResource(details.url) ? { responseHeaders: withoutHeaders(details.responseHeaders, /^set-cookie2?$/i) } : {}));
}

export function secureContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => { if (!isEntryURL(url ?? event.url)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => {
    if (!event.isMainFrame && event.frame) {
      try {
        // The App may open the fixed relay. Only that relay may initialize its
        // one opaque srcdoc, and no renderer may navigate further descendants.
        const parent = event.frame.parent;
        if (event.url === PLUGIN_RELAY && !isEntryURL(parent?.url)) { event.preventDefault(); return; }
        for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
          if (ancestor.url !== PLUGIN_RELAY) continue;
          if (ancestor !== parent || event.url !== 'about:srcdoc' || event.initiator?.url !== PLUGIN_RELAY) event.preventDefault();
          return;
        }
      } catch { event.preventDefault(); return; }
    }
    if (event.isMainFrame ? !isEntryURL(event.url)
      : ![WIDGET_RELAY, PLUGIN_RELAY, 'tarobot-widget://sandbox/design-loader.html', 'about:blank', 'about:srcdoc'].includes(event.url) && !event.url.startsWith('data:text/html;charset=utf-8,')) event.preventDefault();
  });
}

export function secureWebPreferences(preload, session) {
  return { preload, session, contextIsolation: true, sandbox: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, backgroundThrottling: false };
}

export { APP_ORIGIN };
