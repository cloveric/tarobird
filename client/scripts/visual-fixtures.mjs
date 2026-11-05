import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, 'client/e2e/fixtures/generated-cards');
await mkdir(directory, { recursive: true });
// Browser suites can prepare this gallery concurrently. Build separately and
// atomically publish the complete index so an existing Vite server never loses it.
const staging = await mkdtemp(path.join(directory, '.build-'));
try {
  const check = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/gateway-cards.test.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, TAROCUB_VISUAL_FIXTURES: staging } });
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error(`Visual fixture generation failed (${check.status ?? check.signal}).`);
  const files = (await readdir(staging)).filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
  const fixtures = await Promise.all(files.map(async (file) => JSON.parse(await readFile(path.join(staging, file), 'utf8'))));
  await writeFile(path.join(staging, 'index.json'), JSON.stringify(fixtures, null, 2) + '\n');
  for (const file of [...files, 'index.json']) {
    const target = path.join(directory, file), source = path.join(staging, file);
    const previous = await readFile(target, 'utf8').catch((error) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    // Avoid needless hot reloads when another suite already published this data.
    if (previous !== await readFile(source, 'utf8')) await rename(source, target);
  }
  console.log(`Prepared ${fixtures.length} client visual fixtures from real constructors.`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
