// Synthetic file inventory benchmark. Never scans a user's workspace.
// Run: TMPDIR=/tmp/t node --import tsx scripts/benchmark-file-center.mts [receipt.json]
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { HubFileCenter } from '../src/hub/file-center.ts';
const root = await mkdtemp(path.join(os.tmpdir(), 'file-center-scale-'));
let center: HubFileCenter | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const workspace = path.join(root, 'workspace'), stateDir = path.join(root, 'bot');
  await mkdir(workspace); await mkdir(stateDir);
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({ engine: 'codex', workspacePath: workspace }));
  // Many separate top-level units stress metadata serialization as well as walking.
  for (let first = 0; first < 2000; first += 40) {
    await Promise.all(Array.from({ length: 40 }, async (_, offset) => {
      const directory = path.join(workspace, `project-${first + offset}`); await mkdir(directory);
      await Promise.all(Array.from({ length: 5 }, (_, i) => writeFile(path.join(directory, `${i}.txt`), 'Synthetic inventory file')));
    }));
  }
  center = new HubFileCenter(root, async () => ({ instances: [{ name: 'fixture', stateDir }], warnings: [] }), { home: root });
  let tick = performance.now(), maxGap = 0;
  timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - tick); tick = now; }, 5);
  const start = performance.now(); await center.start();
  while ((await center.status()).scanning) await delay(10);
  const scanMs = performance.now() - start;
  const statusStart = performance.now(), result = await center.status();
  const statusMs = performance.now() - statusStart;
  assert.equal(result.error, null); assert.equal(result.inventory?.unitCount, 2000);
  assert.equal(result.inventory?.units.reduce((sum, unit) => sum + unit.fileCount, 0), 10000);
  const pollStart = performance.now(); assert.deepEqual(await center.poll(result.revision), { unchanged: true });
  const unchangedPollMs = performance.now() - pollStart;
  const cancelledStart = performance.now(); await center.start(); center.cancel();
  while ((await center.status()).scanning) await delay(5);
  const cancelMs = performance.now() - cancelledStart;
  const cancelled = await center.status(); assert.equal(cancelled.error, 'scan_cancelled');
  assert.equal(cancelled.inventory?.generatedAt, result.inventory?.generatedAt);
  await delay(10); clearInterval(timer); timer = undefined;
  const receipt = { files: 10000, units: 2000, scanMs, statusMs, unchangedPollMs, cancelMs, maxEventLoopGapMs: maxGap, previousInventoryPreserved: true };
  console.log(JSON.stringify(receipt));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(receipt, null, 2) + '\n');
} finally { if (timer) clearInterval(timer); await center?.close(); await rm(root, { recursive: true, force: true }); }
