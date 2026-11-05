import { designAssets } from "./design-assets.js";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { widgetRuntime } from "./widget-runtime.js";
import { pdfAssets } from "./pdf-assets.js";
import { excalidrawAssets } from "./excalidraw-assets.js";
import { vditorAssets } from "./vditor-assets.js";

export default defineConfig({ plugins: [react(), designAssets(), pdfAssets(), excalidrawAssets(), vditorAssets(), widgetRuntime(), {
  name: "tarocub-offline-shell",
  // Vite removes CSS-only JavaScript chunks after normal user plugins. Capture
  // the final output, or one missing file makes Cache.addAll reject installation.
  enforce: "post",
  generateBundle(_options, bundle) {
    const files = Object.keys(bundle).filter((file) => !file.endsWith(".map"));
    const initial = new Set<string>(), deferred = new Set<string>(), existing = new Set<string>();
    const visit = (name: string, into: Set<string>, dynamic: boolean, stop = new Set<string>()) => {
      if (stop.has(name)) return;
      if (into.has(name)) return; into.add(name);
      const chunk = bundle[name]; if (chunk?.type !== "chunk") return;
      for (const child of [...(chunk.imports ?? []), ...(dynamic ? chunk.dynamicImports ?? [] : []), ...(chunk.referencedFiles ?? [])]) visit(child, into, dynamic, stop);
      const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> } }).viteMetadata;
      for (const asset of [...(metadata?.importedCss ?? []), ...(metadata?.importedAssets ?? [])]) into.add(asset);
    };
    for (const chunk of Object.values(bundle)) if (chunk.type === "chunk" && chunk.isEntry) visit(chunk.fileName, initial, false);
    const workbenchRoots = new Set(Object.values(bundle).filter(chunk => chunk.type === "chunk" && !initial.has(chunk.fileName) && Object.keys(chunk.modules).some(id => /\/src\/(?:WorkbenchCanvas|Workbench)\.tsx$/.test(id))).map(chunk => chunk.fileName));
    for (const name of workbenchRoots) visit(name, deferred, true);
    for (const name of initial) { const chunk = bundle[name]; if (chunk?.type === "chunk") for (const child of chunk.dynamicImports ?? []) visit(child, existing, true, workbenchRoots); }
    const precache = files.filter(file => !file.startsWith("excalidraw/") && !file.startsWith("vditor/") && file !== "design-sandbox.html" && file !== "slides-sandbox.html" && (!deferred.has(file) || initial.has(file) || existing.has(file)));
    const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 16);
    this.emitFile({ type: "asset", fileName: "sw.js", source: `
const CACHE = 'tarocub-shell-${version}';
const FILES = ${JSON.stringify(["/", ...files.map((file) => `/${file}`)])};
const PRECACHE = ${JSON.stringify(["/", ...precache.map((file) => `/${file}`)])};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('tarocub-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('push', event => {
  let payload; try { payload = event.data.json(); } catch { return; }
  if (!payload || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.conversationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.messageId)) return;
  if (payload.hostId !== undefined && !/^hub_[0-9a-f]{64}$/.test(payload.hostId)) return;
  event.waitUntil(webPushNotificationBody(payload).then(body => self.registration.showNotification('TaroBird', { body, tag: (payload.hostId || '') + ':' + payload.id, data: { conversationId: payload.conversationId, messageId: payload.messageId, hostId: payload.hostId } })));
});
self.addEventListener('notificationclick', event => {
  event.notification.close(); const data = event.notification.data;
  if (!data || !/^[A-Za-z0-9_-]{1,128}$/.test(data.conversationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(data.messageId)) return;
  if (data.hostId !== undefined && !/^hub_[0-9a-f]{64}$/.test(data.hostId)) return;
  const url = '/#conversation=' + data.conversationId + '&message=' + data.messageId + (data.hostId ? '&host=' + data.hostId : '');
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => { const client = clients.find(c => new URL(c.url).origin === self.location.origin); if (client) { await client.navigate(url); await client.focus(); } else await self.clients.openWindow(url); }));
});
self.addEventListener('fetch', event => {
  if (serveAttachmentDownload(event)) return;
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/ws' || url.pathname === '/sw.js') return;
  if (url.pathname === '/design-loader.html') { event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request))); return; }
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/')));
  else if (FILES.includes(url.pathname)) event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => { if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); } return response; })));
});
${readFileSync(new URL("./service-worker-downloads.js", import.meta.url), "utf8")}
${readFileSync(new URL("./service-worker-notifications.js", import.meta.url), "utf8")}
` });
  },
}], // Markdown dependencies must select DOM-free exports in both dev and worker builds.
optimizeDeps: { include: ["unified", "remark-parse", "remark-rehype", "remark-gfm", "remark-math", "micromark-core-commonmark", "rehype-katex", "rehype-highlight"] },
worker: { format: "es" },
resolve: { conditions: ["worker", "module", "browser", "development|production"], dedupe: ["react", "react-dom", "zod"] }, // Fetch lazy modules once via import(). A failed WebKit modulepreload can
// poison the following import even across reload; CSS loading is preserved.
build: { modulePreload: false, target: "es2022", chunkSizeWarningLimit: 1200 }, server: { port: 1420, strictPort: true, fs: { allow: [".."] } } });
