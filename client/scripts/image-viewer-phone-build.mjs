// Build only to a caller-owned external directory; no native app is installed.
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const client = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || output.startsWith(client)) throw new Error('External output directory required');
await build({ configFile: false, root: client, base: '/', plugins: [react()], build: { outDir: output, emptyOutDir: false,
  rollupOptions: { input: path.join(client, 'e2e/fixtures/image-viewer-phone.html') } } });
await cp(path.join(output, 'e2e/fixtures/image-viewer-phone.html'), path.join(output, 'index.html'));
