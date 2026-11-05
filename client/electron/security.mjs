import { APP_ORIGIN, isEntryURL } from './contract.mjs';
import { isDesignDocumentURL } from './design-document.mjs';

export function internalResource(raw) {
  try {
    const url = new URL(raw);
    return !url.username && !url.password && !url.port && (
      url.protocol === 'tarobot:' && url.hostname === 'app'
      || url.protocol === 'tarobot-widget:' && url.hostname === 'sandbox' && ['/widget-sandbox.html', '/design-loader.html'].includes(url.pathname)
      || ['blob:', 'data:', 'about:'].includes(url.protocol));
  } catch { return false; }
}

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
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !internalResource(details.url) }));
}

export function secureContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('will-navigate', (event, url) => { if (!isEntryURL(url ?? event.url)) event.preventDefault(); });
  contents.on('will-frame-navigate', event => {
    if (event.isMainFrame ? !isEntryURL(event.url)
      : !['tarobot-widget://sandbox/widget-sandbox.html', 'tarobot-widget://sandbox/design-loader.html', 'about:blank', 'about:srcdoc'].includes(event.url) && !event.url.startsWith('data:text/html;charset=utf-8,')) event.preventDefault();
  });
}

export function secureWebPreferences(preload, session) {
  return { preload, session, contextIsolation: true, sandbox: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, backgroundThrottling: false };
}

export { APP_ORIGIN };
