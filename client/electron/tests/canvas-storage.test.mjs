import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemCanvasCredentialVault } from '../../src/canvas-credential-vault.ts';
import { createCanvasDataStore, handleCanvasDataRequest, OFFICIAL_CANVAS_PLUGIN_ID } from '../../src/canvas-data-store.ts';

const scopeId = 'fixture-scope';
const pluginId = OFFICIAL_CANVAS_PLUGIN_ID;

test('canvas data dispatch requires the bundled canvas, explicit storage grant, and a real scope', async () => {
  const requests = [];
  const store = {
    put: async (...args) => { requests.push(args); return true; },
    keys: async () => ['fixture-key'],
  };
  const context = { scopeId, pluginId, officialBundledCanvas: true, storageGranted: true, store };
  const value = Uint8Array.of(0, 255, 13);
  const request = { method: 'canvas.data.put', key: 'fixture-key', value };
  for (const untrusted of [{ pluginId: 'ordinary.plugin' }, { officialBundledCanvas: false }, { storageGranted: false }]) {
    await assert.rejects(handleCanvasDataRequest(request, { ...context, ...untrusted }), /capability_denied/);
  }
  await assert.rejects(handleCanvasDataRequest(request, { ...context, scopeId: 'default' }), /canvas_data_scope_invalid/);
  assert.equal(requests.length, 0);
  assert.equal(await handleCanvasDataRequest(request, context), true);
  assert.deepEqual(requests, [[scopeId, pluginId, 'fixture-key', value]]);
  assert.deepEqual(await handleCanvasDataRequest({ method: 'canvas.data.keys' }, context), ['fixture-key']);
});

test('canvas storage RPC normalizes underlying errors without leaking their detail', async () => {
  const context = { scopeId, pluginId, officialBundledCanvas: true, storageGranted: true };
  const request = { method: 'canvas.data.keys' };
  await assert.rejects(handleCanvasDataRequest(request, {
    ...context, store: { keys: async () => { throw new Error('private detail'); } },
  }), { message: 'canvas_data_unavailable' });
  await assert.rejects(handleCanvasDataRequest(request, {
    ...context, store: { keys: async () => { throw new DOMException('private detail', 'QuotaExceededError'); } },
  }), { message: 'canvas_data_quota_exceeded' });
});

test('canvas data refuses invalid handles and values before opening a database', async () => {
  const data = createCanvasDataStore();
  await assert.rejects(data.get(scopeId, 'ordinary.plugin', 'x'), /canvas_data_scope_invalid/);
  await assert.rejects(data.get(scopeId, pluginId, 'x'.repeat(257)), /canvas_data_key_invalid/);
  await assert.rejects(data.put(scopeId, pluginId, 'x', 'secret'), /canvas_data_value_invalid/);
  await assert.rejects(data.put(scopeId, pluginId, 'x', new Uint8Array(32 * 1024 * 1024 + 1)), /canvas_data_value_invalid/);
  await assert.rejects(data.keys(scopeId, pluginId), /canvas_data_unavailable/);
});

test('the canvas vault sends scoped requests only to its native adapter', async () => {
  const requests = [];
  const vault = createSystemCanvasCredentialVault(async request => {
    requests.push(request);
    return request.action === 'get' ? 'fixture' : true;
  });
  await assert.rejects(vault.getSecret(scopeId, 'ordinary.plugin', 'x'), /capability_denied/);
  await assert.rejects(vault.getSecret('default', pluginId, 'x'), /capability_denied/);
  assert.equal(requests.length, 0);
  await vault.setSecret(scopeId, pluginId, 'x', 'fixture');
  assert.equal(await vault.getSecret(scopeId, pluginId, 'x'), 'fixture');
  await vault.removeSecret(scopeId, pluginId, 'x');
  await vault.clearPluginSecrets(scopeId, pluginId);
  assert.deepEqual(requests, [
    { scopeId, action: 'set', key: 'x', value: 'fixture' },
    { scopeId, action: 'get', key: 'x' },
    { scopeId, action: 'remove', key: 'x' },
    { scopeId, action: 'clear' },
  ]);
  await assert.rejects(createSystemCanvasCredentialVault().getSecret(scopeId, pluginId, 'x'), /credentials_unavailable/);
});
