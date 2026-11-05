// One-use, same-origin downloads of bytes already authenticated and verified by
// the client. No Hub token, attachment lookup, response cache or public endpoint.
const attachmentDownloads = new Map();
self.addEventListener('message', event => {
  const data = event.data, port = event.ports[0];
  if (data?.type === 'attachment.download.capabilities' && port) { port.postMessage({ type: 'attachment.download.supported' }); port.close(); return; }
  if (data?.type !== 'attachment.download.prepare' || !port) return;
  if (!/^[0-9a-f-]{36}$/.test(data.id) || !(data.blob instanceof Blob) || typeof data.name !== 'string' || data.name.length > 200 || !event.source?.id
    || data.fileLock !== undefined && !/^tarocub-download-tmp-v1:[0-9a-f-]{36}$/.test(data.fileLock)
    || data.fileLock && !self.navigator.locks) { port.postMessage({ type: 'unsupported' }); port.close(); return; }
  let settle;
  const completed = new Promise(resolve => { settle = resolve; });
  const name = Array.from(data.name, character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff ? '_' : character).join('');
  const disposition = "attachment; filename*=UTF-8''" + encodeURIComponent(name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16));
  const entry = { blob: data.blob, disposition, clientId: event.source.id, port, started: false, finished: false, received: 0, lastProgress: 0, lastTouch: 0, controller: undefined, timer: undefined, finish: undefined };
  entry.finish = (type) => {
    if (entry.finished) return; entry.finished = true; clearTimeout(entry.timer); if (attachmentDownloads.get(data.id) === entry) attachmentDownloads.delete(data.id);
    if (type !== 'done') { try { entry.controller?.error(new Error('download_cancelled')); } catch {} }
    try { port.postMessage({ type }); } finally { port.close(); settle(); }
  };
  const touch = () => { const now = Date.now(); if (entry.timer && now - entry.lastTouch < 1000) return; entry.lastTouch = now; clearTimeout(entry.timer); entry.timer = setTimeout(() => entry.finish('error'), 120000); };
  port.onmessage = message => { if (message.data?.type === 'cancel') entry.finish('cancelled'); }; port.start();
  const register = async () => {
    if (entry.finished) return;
    if (attachmentDownloads.has(data.id)) { entry.finish('error'); return; }
    entry.touch = touch; attachmentDownloads.set(data.id, entry); touch(); port.postMessage({ type: 'ready' }); await completed;
  };
  // Shared with the page's source lease, exclusive against orphan cleanup. The
  // worker keeps the backing file alive even if the originating tab is closed.
  event.waitUntil((data.fileLock ? self.navigator.locks.request(data.fileLock, { mode: 'shared' }, register) : register()).catch(() => entry.finish('error')));
});
function serveAttachmentDownload(event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__tarocub_download/')) return false;
  const id = url.pathname.slice('/__tarocub_download/'.length), entry = attachmentDownloads.get(id);
  // Download navigations can have an empty clientId. Their unguessable, one-use
  // token is still mandatory; requests identifying another client are refused.
  if (event.request.method !== 'GET' || !entry || entry.started || event.clientId && event.clientId !== entry.clientId) {
    event.respondWith(new Response(event.request.mode === 'navigate' ? null : 'Download unavailable', { status: event.request.mode === 'navigate' ? 204 : 404, headers: { 'Cache-Control': 'no-store' } })); return true;
  }
  entry.started = true; entry.touch();
  const body = new ReadableStream({
    start(controller) { entry.controller = controller; },
    async pull(controller) {
      try {
        // Read a bounded slice in either browser engine. WebKit's Blob.stream
        // failed this download-navigation path in the regression tests.
        const next = new Uint8Array(await entry.blob.slice(entry.received, entry.received + 1024 * 1024).arrayBuffer());
        if (entry.finished) return;
        entry.touch();
        if (!next.byteLength) { if (entry.received === entry.blob.size) { controller.close(); entry.finish('done'); } else entry.finish('error'); }
        else {
          entry.received += next.byteLength; controller.enqueue(next);
          if (entry.received === entry.blob.size) { controller.close(); entry.finish('done'); }
          else if (Date.now() - entry.lastProgress >= 1000) { entry.lastProgress = Date.now(); entry.port.postMessage({ type: 'progress' }); }
        }
      } catch { entry.finish('error'); }
    },
    cancel() { entry.finish('cancelled'); },
  });
  event.respondWith(new Response(body, { headers: {
    'Content-Type': 'application/octet-stream', 'Content-Length': String(entry.blob.size), 'Cache-Control': 'no-store',
    'Content-Disposition': entry.disposition,
    'X-Content-Type-Options': 'nosniff',
  } })); return true;
}
