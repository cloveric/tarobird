import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasNodeRegistry } from '../../src/canvas-node-registry.ts';

const scope = 'fixture-device:fixture-host:owner';
const otherScope = 'fixture-device:fixture-other-host:owner';
const url = `https://raw.githubusercontent.com/fixture/nodes/${'1'.repeat(40)}/src/example.js`;
const source = '// inert fixture; do not execute';
const loader = async () => source;

function fixture() {
  const records = new Map();
  const store = {
    async read(scopeId) { return structuredClone(records.get(scopeId)); },
    async mutate(scopeId, work) {
      const { next, result } = work(structuredClone(records.get(scopeId)));
      if (next) records.set(scopeId, structuredClone(next));
      else records.delete(scopeId);
      return result;
    },
  };
  return { registry: createCanvasNodeRegistry(store), records };
}

test('requires explicit opt-in, same-scope prepared review and verified source on readback', async () => {
  const { registry } = fixture();
  assert.deepEqual(await registry.get(scope), { enabled: false, plugins: [] });
  assert.deepEqual(await registry.get(otherScope), { enabled: false, plugins: [] });
  await assert.rejects(registry.prepare(scope, url, () => assert.fail('download with no opt-in')), /disabled/);
  await assert.rejects(registry.get('default'), /scope_invalid/);
  await registry.setEnabled(scope, true);
  await registry.setEnabled(otherScope, true);
  const reviewed = await registry.prepare(scope, url, loader);
  assert.equal(reviewed.source, source);
  assert.equal(reviewed.title, 'example');
  assert.match(reviewed.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(registry.install(otherScope, reviewed), /review_expired/);
  await assert.rejects(registry.install(scope, { ...reviewed }), /review_expired/);
  const installed = await registry.install(scope, reviewed);
  assert.deepEqual(await registry.get(scope), { enabled: true, plugins: [installed] });
  assert.equal('source' in installed, false);
  assert.deepEqual(await registry.source(scope, installed.id), reviewed);
  await assert.rejects(registry.source(otherScope, installed.id), /not_installed/);
  await registry.setEnabled(scope, false);
  assert.deepEqual(await registry.get(scope), { enabled: false, plugins: [installed] });
  await assert.rejects(registry.source(scope, installed.id), /disabled/);
  assert.equal(await registry.remove(scope, installed.id), true);
  assert.deepEqual(await registry.get(scope), { enabled: false, plugins: [] });
});

test('rejects stale review after disable/re-enable, even during download, and after wipe', async () => {
  const { registry } = fixture();
  await registry.setEnabled(scope, true);
  const reviewed = await registry.prepare(scope, url, loader);
  let release, entered;
  const deferred = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const pending = registry.prepare(scope, url, () => { entered(); return deferred; });
  await started;
  await registry.setEnabled(scope, false);
  await registry.setEnabled(scope, true);
  release(source);
  await assert.rejects(pending, /review_expired/);
  await assert.rejects(registry.install(scope, reviewed), /review_expired/);
  const afterEnable = await registry.prepare(scope, url, loader);
  await registry.clear(scope);
  await registry.setEnabled(scope, true);
  await assert.rejects(registry.install(scope, afterEnable), /review_expired/);
});

test('rejects tampered stored bytes, changed source at the same pin and out-of-bounds source', async () => {
  const { registry, records } = fixture();
  await registry.setEnabled(scope, true);
  await assert.rejects(registry.prepare(scope, url, async () => 'é'.repeat(131073)), /source_invalid/);
  await assert.rejects(registry.prepare(scope, url, async () => '\ud800'), /source_invalid/);
  const prepared = await registry.prepare(scope, url, loader);
  await registry.install(scope, prepared);
  const changed = await registry.prepare(scope, url, async () => '// changed inert fixture');
  await assert.rejects(registry.install(scope, changed), /source_changed/);
  records.get(scope).plugins[0] = { ...prepared, source: '// tampered fixture' };
  await assert.rejects(registry.source(scope, prepared.id), /source_invalid/);
});

test('retains source bytes only up to the per-scope quota', async () => {
  const { registry } = fixture();
  await registry.setEnabled(scope, true);
  const large = () => Promise.resolve('x'.repeat(256 * 1024));
  for (let index = 0; index < 8; index++) {
    await registry.install(scope, await registry.prepare(scope, url.replace('example.js', `fixture-${index}.js`), large));
  }
  const over = await registry.prepare(scope, url, loader);
  await assert.rejects(registry.install(scope, over), /quota_exceeded/);
  assert.equal((await registry.get(scope)).plugins.length, 8);
});
