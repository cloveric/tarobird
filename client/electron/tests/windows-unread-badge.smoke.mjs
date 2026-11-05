// Real Electron image decoding only; does not show a native Windows taskbar.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error('explicit isolated Electron binary and output required');
if (!(await realpath(binary)).split(path.sep).some(part => part.endsWith('.noindex'))) throw new Error('physical_noindex_binary_required');
const root = await isolatedRoot(output);
await mkdir(path.join(root, 'profile'), { recursive: true });
const atlas = new URL('../windows-unread-badges.png', import.meta.url);
const sourceSha256 = createHash('sha256').update(await readFile(atlas)).digest('hex');
const receipt = path.join(root, 'verification.json');
await writeFile(path.join(root, 'main.mjs'), `
import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { windowsUnreadBadge } from ${JSON.stringify(new URL('../windows-unread-badge.mjs', import.meta.url).href)};
app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
app.setPath('crashDumps', ${JSON.stringify(path.join(root, 'crashes'))});
async function main() { try {
  await app.whenReady(); app.dock?.hide();
  const atlas = nativeImage.createFromPath(fileURLToPath(${JSON.stringify(atlas.href)}));
  assert.equal(atlas.isEmpty(), false); assert.deepEqual(atlas.getSize(), { width: 640, height: 640 });
  const badge = windowsUnreadBadge(nativeImage), scales = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4], checks = [];
  assert.equal(badge(0), null);
  for (const count of [1, 99, 100]) {
    const image = badge(count); assert.equal(image.isEmpty(), false);
    assert.deepEqual(image.getSize(), { width: 16, height: 16 });
    assert.deepEqual(image.getScaleFactors(), scales);
    const representations = scales.map(scaleFactor => {
      const png = image.toPNG({ scaleFactor });
      assert.equal(png.readUInt32BE(16), 16 * scaleFactor); assert.equal(png.readUInt32BE(20), 16 * scaleFactor);
      assert.equal(nativeImage.createFromBuffer(png).isEmpty(), false);
      return { scaleFactor, pixels: 16 * scaleFactor, sha256: createHash('sha256').update(png).digest('hex') };
    });
    checks.push({ count, representations }); assert.equal(badge(count), image);
  }
  assert.equal(new Set(checks.map(check => check.representations[0].sha256)).size, 3);
  assert.equal(badge(1000), badge(100)); assert.equal(badge(0), null);
  await writeFile(${JSON.stringify(receipt)}, JSON.stringify({ verified: true, electron: process.versions.electron,
    platform: process.platform, atlasSize: atlas.getSize(), atlasSha256: ${JSON.stringify(sourceSha256)}, checks,
    zeroRemovesImage: true, largeCountsShareLastTile: true, nativeWindowsTaskbarVerified: false }, null, 2));
  app.exit(0);
} catch (error) { console.error(error); app.exit(1); } }
void main();
`);
const env = helperEnvironment(); delete env.ELECTRON_RUN_AS_NODE;
await promisify(execFile)(binary, [path.join(root, 'main.mjs')], { env, timeout: 30_000 });
const result = JSON.parse(await readFile(receipt, 'utf8'));
assert.equal(result.verified, true); assert.equal(result.atlasSha256, sourceSha256);
console.log(JSON.stringify(result));
