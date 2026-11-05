import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ORIGIN } from './contract.mjs';

export const APP_CSP = "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src blob: data: tarobot-widget://sandbox; font-src 'self' data:";
export const WIDGET_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; worker-src blob:; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src about:; base-uri 'none'; form-action 'none'";
export const SCHEMES = [
  { scheme: 'tarobot', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
  { scheme: 'tarobot-widget', privileges: { standard: true, secure: true } },
  // Remote screen capture renderer only (separate in-memory session, no network).
  { scheme: 'tarobot-screen', privileges: { standard: true, secure: true } },
];
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream' };
const inside = (root, value) => { const relative = path.relative(root, value); return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };

/** The root is fixed by main, never by a renderer URL. Realpath confinement
 * also rejects a bundled symlink that leads outside the static asset tree. */
export async function assetPath(root, raw, { widget = false } = {}) {
  const url = new URL(raw);
  if (url.protocol !== (widget ? 'tarobot-widget:' : 'tarobot:') || url.hostname !== (widget ? 'sandbox' : 'app')
    || url.username || url.password || url.port || url.search) throw new Error('invalid_asset_url');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { throw new Error('invalid_asset_url'); }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part === '..' || part.startsWith('.'))
    || widget && !['/widget-sandbox.html', '/design-loader.html'].includes(pathname) || !widget && ['/widget-sandbox.html','/design-loader.html'].includes(pathname.toLowerCase())) throw new Error('invalid_asset_url');
  const physicalRoot = await realpath(root);
  const file = await realpath(path.resolve(physicalRoot, '.' + pathname));
  if (!inside(physicalRoot, file) || !widget && ['widget-sandbox.html','design-loader.html'].includes(path.basename(file).toLowerCase())
    || !(await stat(file)).isFile()) throw new Error('invalid_asset_url');
  return file;
}

export function assetHandler(root, fetchFile, { widget = false } = {}) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    // A remote site cannot fetch private bundled resources through this scheme.
    // Top-level browser navigation has no initiatorOrigin.
    if (request.initiatorOrigin && request.initiatorOrigin !== APP_ORIGIN
      && request.initiatorOrigin !== (widget ? 'tarobot-widget://sandbox' : APP_ORIGIN)) return new Response(null, { status: 403 });
    try {
      const file = await assetPath(root, request.url, { widget });
      const result = await fetchFile(pathToFileURL(file).href);
      if (!result.ok) return new Response(null, { status: 404 });
      const headers = new Headers(result.headers);
      headers.set('Content-Type', mimeTypes[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
      headers.set('Content-Security-Policy', widget ? (path.basename(file) === 'design-loader.html' ? "frame-ancestors tarobot://app" : WIDGET_CSP) : APP_CSP);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Cache-Control', 'no-cache');
      return new Response(request.method === 'HEAD' ? null : result.body, { status: result.status, headers });
    } catch { return new Response(null, { status: 404 }); }
  };
}
