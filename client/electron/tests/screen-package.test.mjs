import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { desktopMainBundleOptions } from '../../scripts/electron-package.mjs';

test('production ESM bundle can load the screen service and viewer CommonJS dependencies', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'screen-bundle-'));
  try {
    const output = path.join(directory, 'screen.mjs');
    await build({ ...desktopMainBundleOptions, outfile: output, stdin: {
      resolveDir: fileURLToPath(new URL('..', import.meta.url)), sourcefile: 'screen-package-probe.mjs',
      contents: "import { ScreenService } from './screen-service.mjs'; import { ScreenViewers } from './screen-viewer.mjs'; console.log(typeof ScreenService, typeof ScreenViewers);",
    } });
    // No instances, Electron window, capture, addon or OS input are created.
    const result = await promisify(execFile)(process.execPath, [output], { timeout: 10000 });
    assert.equal(result.stdout.trim(), 'function function');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
