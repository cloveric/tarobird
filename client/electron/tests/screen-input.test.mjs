import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenGeometry, encodeSize, toGlobalPoint } from '../screen-geometry.mjs';
import { ScreenInput } from '../screen-input.mjs';
import { SCREEN_MAC_KEYCODES, screenControllerCode, screenShortcutEvents, screenWheelToMac } from '../../../src/client-protocol/screen-keys.ts';

const lease = 'L'.repeat(43);
function display(overrides = {}) { return { id: 'D1', nativeId: '1', name: 'Main', revision: 1, x: 0, y: 0, width: 1512, height: 982, scale: 2, rotation: 0, ...overrides }; }
function lab({ blocked, displays = [display()] } = {}) {
  const calls = [], clock = { wall: 1_800_000_000_000, mono: 1000 };
  const native = {
    mouse: (...args) => calls.push(['mouse', ...args]), scroll: (...args) => calls.push(['scroll', ...args]),
    key: (...args) => calls.push(['key', ...args]), text: text => calls.push(['text', text]),
    location: () => ({ x: 5, y: 6 }), releaseAll: () => calls.push(['releaseAll']),
  };
  const frames = new Map([[7, { captureMs: clock.wall - 100, receivedMono: clock.mono - 90, displayId: 'D1', geometryRevision: 1, streamGeneration: 2 }]]);
  const released = [];
  const input = new ScreenInput({ native, geometry: { find: id => displays.find(d => d.id === id) },
    frames: (_session, sequence) => frames.get(sequence), ready: () => blocked?.(),
    wall: () => clock.wall, monotonic: () => clock.mono, onReleased: (l, reason) => released.push(reason) });
  const grant = () => input.grant({ sessionId: 's1', generation: 'g1', leaseId: lease, expiresAt: clock.wall + 6000, frameSequence: 7, streamGeneration: 2 });
  let sequence = 0;
  const send = (event, extra = {}) => input.apply({ type: 'input', sessionId: 's1', desktopId: 'd', generation: 'g1', displayId: 'D1', displayRevision: 1,
    leaseId: lease, sequence: ++sequence, frameSequence: 7, expiresAt: frames.get(7).captureMs + 2000, event, ...extra });
  return { input, calls, clock, frames, released, grant, send, displays };
}

test('key map covers the shared code schema with distinct Mac virtual keys', () => {
  const codes = ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'ArrowUp', 'ShiftLeft', 'MetaRight', 'Enter', 'Tab', 'Escape', 'Space', 'Backspace', 'Delete',
    'Home', 'End', 'PageUp', 'PageDown', 'CapsLock', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash'];
  for (const code of codes) assert.ok(Number.isInteger(SCREEN_MAC_KEYCODES[code]), code);
  const values = Object.values(SCREEN_MAC_KEYCODES);
  assert.equal(new Set(values).size, values.length);
  assert.equal(SCREEN_MAC_KEYCODES.KeyA, 0x00); assert.equal(SCREEN_MAC_KEYCODES.MetaLeft, 0x37); assert.equal(SCREEN_MAC_KEYCODES.Backspace, 0x33); assert.equal(SCREEN_MAC_KEYCODES.Delete, 0x75);
});

test('Windows controllers map Ctrl to Command by default and can keep physical modifiers', () => {
  assert.equal(screenControllerCode('ControlLeft', 'windows'), 'MetaLeft');
  assert.equal(screenControllerCode('MetaLeft', 'windows'), 'ControlLeft');
  assert.equal(screenControllerCode('AltLeft', 'windows'), 'AltLeft');
  assert.equal(screenControllerCode('ControlLeft', 'windows', 'physical'), 'ControlLeft');
  assert.equal(screenControllerCode('ControlLeft', 'mac'), 'ControlLeft');
  assert.deepEqual(screenShortcutEvents(['MetaLeft', 'Tab']), [{ code: 'MetaLeft', down: true }, { code: 'Tab', down: true }, { code: 'Tab', down: false }, { code: 'MetaLeft', down: false }]);
  assert.throws(() => screenShortcutEvents(['MetaLeft', 'Nope']), /screen_shortcut_invalid/);
  assert.deepEqual(screenWheelToMac(3.4, 120), { wheel1: -120, wheel2: -3 });
});

test('encoded size respects 1920 long edge and 1080p area, preserves aspect, is even, never upscales', () => {
  assert.deepEqual(encodeSize(display()), { width: 1786, height: 1160 }); // 3024x1964 Retina: area-bound, H.264 L4 macroblock limit holds
  assert.deepEqual(encodeSize(display({ width: 2560, height: 1440, scale: 1 })), { width: 1920, height: 1080 });
  assert.deepEqual(encodeSize(display({ width: 1280, height: 720, scale: 1 })), { width: 1280, height: 720 });
  const tall = encodeSize(display({ width: 1080, height: 1920, scale: 1, rotation: 90 }));
  assert.ok(tall.height <= 1920 && tall.width * tall.height <= 1920 * 1080 && tall.width % 2 === 0 && tall.height % 2 === 0);
});

test('normalized points map into the display, including negative origins, and 1 stays on this display', () => {
  const left = display({ x: -1920, y: -200, width: 1920, height: 1080, scale: 1 });
  assert.deepEqual(toGlobalPoint(left, 0, 0), { x: -1920, y: -200 });
  assert.deepEqual(toGlobalPoint(left, 1, 1), { x: -1, y: 879 });
  assert.deepEqual(toGlobalPoint(display(), 1, 0.5), { x: 1511.5, y: 491 });
  assert.throws(() => toGlobalPoint(left, 1.01, 0), /screen_point_out_of_bounds/);
  assert.throws(() => toGlobalPoint(left, Number.NaN, 0), /screen_point_out_of_bounds/);
});

test('geometry revision changes only when mapping-relevant fields change; UUID is the stable id', () => {
  let displays = [{ id: 69733632, bounds: { x: 0, y: 0, width: 1512, height: 982 }, scaleFactor: 2, rotation: 0, label: 'Built-in' }];
  const geometry = new ScreenGeometry({ screen: { getAllDisplays: () => displays }, uuidOf: id => id === 69733632 ? '37D8832A-2D66-02CA-B9F7-8F30A301B230' : null });
  const first = geometry.displays()[0];
  assert.equal(first.id, '37D8832A-2D66-02CA-B9F7-8F30A301B230'); assert.equal(first.nativeId, '69733632');
  assert.equal(geometry.displays()[0].revision, first.revision);
  displays = [{ ...displays[0], scaleFactor: 1 }];
  assert.ok(geometry.displays()[0].revision > first.revision);
  displays = [{ id: 5, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1, rotation: 0, label: '' }];
  assert.deepEqual([geometry.displays()[0].id, geometry.displays()[0].name], ['cg-5', 'Display 1']);
});

test('lease requires a fresh confirmed frame and a ready target', () => {
  const blocked = lab({ blocked: () => 'screen_input_denied' });
  assert.deepEqual(blocked.grant(), { ok: false, reason: 'screen_input_denied' });
  const stale = lab(); stale.clock.wall += 2500; stale.clock.mono += 2500;
  assert.deepEqual(stale.grant(), { ok: false, reason: 'screen_frame_stale' });
  const moved = lab({ displays: [display({ revision: 2 })] });
  assert.deepEqual(moved.grant(), { ok: false, reason: 'screen_geometry_changed' });
  const late = lab(); assert.deepEqual(late.input.grant({ sessionId: 's1', generation: 'g1', leaseId: lease, expiresAt: late.clock.wall, frameSequence: 7, streamGeneration: 2 }), { ok: false, reason: 'screen_lease_invalid' });
  const ok = lab(); assert.deepEqual(ok.grant(), { ok: true });
});

test('input is refused without lease, on replay, stale frame, wrong expiry or changed geometry', () => {
  const t = lab();
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }), 'screen_lease_mismatch');
  t.grant();
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }), null);
  assert.equal(t.input.apply({ type: 'input', sessionId: 's1', desktopId: 'd', generation: 'g1', displayId: 'D1', displayRevision: 1, leaseId: lease, sequence: 1, frameSequence: 7, expiresAt: t.frames.get(7).captureMs + 2000, event: { kind: 'move', x: 0, y: 0 } }), 'screen_input_replayed');
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }, { expiresAt: t.frames.get(7).captureMs + 2001 }), 'screen_frame_stale');
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }, { frameSequence: 8 }), 'screen_frame_stale');
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }, { displayRevision: 2 }), 'screen_geometry_changed');
  t.clock.mono += 1950; // wall unchanged: monotonic guard alone must reject
  assert.equal(t.send({ kind: 'move', x: 0.5, y: 0.5 }), 'screen_frame_stale');
  assert.deepEqual(t.calls.filter(c => c[0] === 'mouse').length, 1);
});

test('drag keeps button state, uses drag events and releases even after the frame goes stale', () => {
  const t = lab(); t.grant();
  assert.equal(t.send({ kind: 'button', x: 0.1, y: 0.1, button: 0, down: true, clicks: 1 }), null);
  assert.equal(t.send({ kind: 'move', x: 0.2, y: 0.2 }), null);
  t.clock.wall += 1950; t.clock.mono += 1950;
  assert.equal(t.send({ kind: 'move', x: 0.3, y: 0.3 }), 'screen_frame_stale');
  assert.equal(t.send({ kind: 'button', x: 0.3, y: 0.3, button: 0, down: false, clicks: 1 }), null);
  const mouse = t.calls.filter(c => c[0] === 'mouse').map(c => [c[1], c[2]]);
  assert.deepEqual(mouse, [['down', 'left'], ['drag', 'left'], ['up', 'left']]);
});

test('modifiers produce flags and flags-changed events; text with shortcut modifiers is refused', () => {
  const t = lab(); t.grant();
  t.send({ kind: 'key', code: 'MetaLeft', down: true });
  t.send({ kind: 'key', code: 'KeyS', down: true });
  t.send({ kind: 'key', code: 'KeyS', down: true }); // autorepeat
  t.send({ kind: 'key', code: 'KeyS', down: false });
  assert.equal(t.send({ kind: 'text', text: '中文' }), 'screen_input_denied');
  const keys = t.calls.filter(c => c[0] === 'key');
  assert.deepEqual(keys[0], ['key', 0x37, true, 0x100008, { modifier: true, repeat: false }]);
  assert.deepEqual(keys[1], ['key', 0x01, true, 0x100008, { modifier: false, repeat: false }]);
  assert.deepEqual(keys[2], ['key', 0x01, true, 0x100008, { modifier: false, repeat: true }]);
  assert.deepEqual(keys[3], ['key', 0x01, false, 0x100008, { modifier: false, repeat: false }]);
  // The failed text released the lease (and Command) instead of leaving it held.
  assert.deepEqual(keys[4], ['key', 0x37, false, 0, { modifier: true, repeat: false }]);
  assert.equal(t.input.lease, undefined);
});

test('arrow keys carry the hardware numeric-pad and fn flags', () => {
  const t = lab(); t.grant();
  t.send({ kind: 'key', code: 'ArrowLeft', down: true });
  assert.equal(t.calls.at(-1)[3], 0x00a00000);
});

test('release() lets go of everything without the controller, and expiry triggers it', async () => {
  const t = lab(); t.grant();
  t.send({ kind: 'key', code: 'ShiftLeft', down: true }); t.send({ kind: 'key', code: 'KeyA', down: true });
  t.send({ kind: 'button', x: 0.5, y: 0.5, button: 2, down: true, clicks: 1 });
  t.calls.length = 0;
  t.input.release('screen_local_takeover');
  assert.deepEqual(t.calls.map(c => c.slice(0, 3)), [['key', 0x00, false], ['key', 0x38, false], ['mouse', 'up', 'right'], ['releaseAll']]);
  assert.deepEqual(t.released, ['screen_local_takeover']);
  assert.equal(t.send({ kind: 'key', code: 'KeyA', down: false }), 'screen_lease_mismatch');
  const expiring = lab(); expiring.grant(); expiring.clock.mono += 6001;
  assert.equal(expiring.send({ kind: 'move', x: 0, y: 0 }), 'screen_lease_invalid');
  assert.deepEqual(expiring.released, ['screen_lease_invalid']);
});

test('renewal of the same lease keeps sequence and pressed keys; a different lease releases first', () => {
  const t = lab(); t.grant();
  t.send({ kind: 'key', code: 'ShiftLeft', down: true });
  assert.equal(t.grant().ok, true);
  assert.equal(t.send({ kind: 'key', code: 'ShiftLeft', down: false }), null);
  t.send({ kind: 'key', code: 'AltLeft', down: true });
  t.input.grant({ sessionId: 's1', generation: 'g1', leaseId: 'M'.repeat(43), expiresAt: t.clock.wall + 6000, frameSequence: 7, streamGeneration: 2 });
  assert.deepEqual(t.released, ['screen_lease_invalid']);
});

test('an up for an own-held key needs the same live lease and sequence; it cannot revive a revoked lease', () => {
  const t = lab(); t.grant();
  t.send({ kind: 'key', code: 'ShiftLeft', down: true });
  t.input.release('screen_local_takeover');
  t.calls.length = 0;
  assert.equal(t.send({ kind: 'key', code: 'ShiftLeft', down: false }), 'screen_lease_mismatch');
  assert.deepEqual(t.calls, []);
});

test('a native failure releases the lease instead of throwing into the service', () => {
  const t = lab(); t.grant();
  t.input.native.mouse = () => { throw new Error('boom'); };
  assert.equal(t.send({ kind: 'button', x: 0.5, y: 0.5, button: 0, down: true, clicks: 2 }), 'screen_input_denied');
  assert.deepEqual(t.released, ['screen_input_denied']);
});
