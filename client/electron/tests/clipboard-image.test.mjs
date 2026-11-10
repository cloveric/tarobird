import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopServices } from '../desktop-services.mjs';
import { validateViewRequest } from '../contract.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jI1EAAAAASUVORK5CYII=', 'base64');
const item = entries => ({ types: Object.keys(entries), getType: async type => new Blob([entries[type]], { type }) });
function fixture(read) {
  const window = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, isFocused: () => true, webContents: { send() {} } });
  const service = new DesktopServices(window, { clipboard: { read } });
  return { window, service, request: (args = { text: '[图片]' }, active = () => true) => service.request('desktop_clipboard_image', args, active) };
}
test('a native clipboard image with a text placeholder becomes a bounded image result', async () => {
  const f = fixture(async () => [item({ 'text/plain': '[图片]', 'image/png': png })]);
  try {
    assert.deepEqual(await f.request(), { type: 'image/png', data: png.toString('base64') });
    assert.doesNotThrow(() => validateViewRequest({ command: 'desktop_clipboard_image', args: { text: '' } }, { controller: true }));
    assert.throws(() => validateViewRequest({ command: 'desktop_clipboard_image', args: { text: '' } }), /controller_required/);
  } finally { f.service.dispose(); }
});
test('unknown/private clipboard payloads and HTML URLs are never fetched or returned', async () => {
  const f = fixture(async () => [item({ 'text/plain': '[图片]', 'text/html': '<img src="file:///private/example.png">', 'electron application/osclipboard;format="DingTalk"': 'private bytes' })]);
  try { assert.equal(await f.request(), null); } finally { f.service.dispose(); }
});
test('Windows CRLF and browser LF captions describe the same clipboard image', async () => {
  const f = fixture(async () => [item({ 'text/plain': 'caption\r\n说明', 'image/png': png })]);
  try { assert.deepEqual(await f.request({ text: 'caption\n说明' }), { type: 'image/png', data: png.toString('base64') }); }
  finally { f.service.dispose(); }
});
test('changed clipboard, unfocused window and retired document cannot deliver an image', async () => {
  const f = fixture(async () => [item({ 'text/plain': 'different', 'image/png': png })]);
  try {
    await assert.rejects(f.request(), /clipboard_changed/);
    f.window.isFocused = () => false;
    await assert.rejects(f.request(), /clipboard_inactive/);
    f.window.isFocused = () => true;
    let active = true;
    f.service.electron.clipboard.read = async () => { active = false; return [item({ 'text/plain': '[图片]', 'image/png': png })]; };
    await assert.rejects(f.request(undefined, () => active), /native_document_retired/);
  } finally { f.service.dispose(); }
});
test('clipboard rejects unknown fields and oversized or invalid image bytes', async () => {
  const f = fixture(async () => [item({ 'text/plain': '[图片]', 'image/png': 'not an image' })]);
  try {
    await assert.rejects(f.request({ text: '[图片]', path: 'anything' }));
    await assert.rejects(f.request(), /clipboard_image_invalid/);
    f.service.electron.clipboard.read = async () => [item({ 'text/plain': '[图片]', 'image/png': Buffer.alloc(32 * 1024 * 1024 + 1) })];
    await assert.rejects(f.request(), /clipboard_image_too_large/);
  } finally { f.service.dispose(); }
});
