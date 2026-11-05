import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HubServer } from '../src/hub/server.js';

it('serves bundled PDF workers and WebP portraits with their MIME types and existing CSP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hub-assets-'));
  const clientDir = path.join(root, 'client'); await mkdir(clientDir);
  const assets = [ ['reader.mjs', 'text/javascript', 'export const fixture = true;'], ['decoder.wasm', 'application/wasm', 'synthetic wasm bytes'], ['portrait.webp', 'image/webp', 'synthetic WebP bytes'] ] as const;
  for (const [name, , bytes] of assets) await writeFile(path.join(clientDir, name), bytes);
  const hub = await HubServer.start({ stateDir: path.join(root, 'state'), clientDir });
  try {
    const expired = await fetch(`${hub.url}/__tarocub_download/expired`);
    expect(expired.status).toBe(204); expect(expired.headers.get('cache-control')).toBe('no-store'); expect(await expired.text()).toBe('');
    for (const [name, mime, bytes] of assets) {
      const response = await fetch(`${hub.url}/${name}`);
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe(mime);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(response.headers.get('content-security-policy')).not.toContain("'unsafe-eval'");
      expect(await response.text()).toBe(bytes);
    }
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
