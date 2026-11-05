import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, chmod, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startHubControl } from '../../../src/hub/service.ts';
import { desktopScreenTicket, screenHostDirectory, screenServiceTicket } from '../screen-host-control.mjs';

const publicKey = `${'A'.repeat(59)}=`;
// Unix socket paths are limited to ~100 bytes; macOS os.tmpdir() is too deep
// for `<base>/com.tarocub.client/host/hub-control.sock`.
const shortTmp = () => mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'sc-'));
/** A real Host control socket in `<appData>/<id>/host`, as the desktop Host is laid out. */
async function host(options = {}, { id = 'com.tarobot.client' } = {}) {
  const base = await shortTmp();
  const app = path.join(base, 'com.tarobot.client'), directory = path.join(base, id, 'host');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await mkdir(app, { recursive: true });
  const issued = [];
  const stop = await startHubControl(directory, () => ({ running: true, pid: process.pid, url: 'https://127.0.0.1:1', instanceUrl: 'http://127.0.0.1:45678', publicKey }), () => {},
    { screenServiceTicket: desktopId => { issued.push(desktopId); return { ticket: 'T'.repeat(43), expiresAt: Date.now() + 30000 }; }, ...options });
  return { base, app, directory, issued, close: async () => { await stop(); await rm(base, { recursive: true, force: true }); } };
}

test('the App state directory reaches the canonical Host control socket in its host/ subdirectory', async () => {
  const h = await host();
  try {
    // main.mjs passes the App's state directory, as the Rust core does; the
    // socket lives in `<it>/host`, never in the App directory itself.
    const ticket = await desktopScreenTicket(h.app, 'desktop-1');
    assert.equal(ticket.ticket, 'T'.repeat(43));
    assert.equal(ticket.instancePort, 45678);
    assert.equal(ticket.publicKey, publicKey);
    assert.deepEqual(h.issued, ['desktop-1']);
  } finally { await h.close(); }
});

test('an existing Host in the legacy com.tarocub.client/host directory is used (installed 1.0.122 layout)', async () => {
  const h = await host({}, { id: 'com.tarocub.client' });
  try {
    assert.equal(await screenHostDirectory(h.app), path.join(h.base, 'com.tarocub.client', 'host'));
    const ticket = await desktopScreenTicket(h.app, 'desktop-1');
    assert.equal(ticket.instancePort, 45678);
    assert.deepEqual(h.issued, ['desktop-1']);
  } finally { await h.close(); }
});

test('Host directory resolution mirrors native_identity::for_app_data', async () => {
  const base = await shortTmp();
  try {
    const app = path.join(base, 'com.tarobot.client');
    await mkdir(app);
    // No Host yet: a new install uses the new identity (resolved again on every attempt).
    assert.equal(await screenHostDirectory(app), path.join(app, 'host'));
    await mkdir(path.join(base, 'com.tarocub.client', 'host'), { recursive: true });
    assert.equal(await screenHostDirectory(app), path.join(base, 'com.tarocub.client', 'host'));
    // An empty legacy App directory without host/ is not a Host.
    await rm(path.join(base, 'com.tarocub.client', 'host'), { recursive: true });
    assert.equal(await screenHostDirectory(app), path.join(app, 'host'));
    // Both present is ambiguous: fail closed rather than pick one.
    await mkdir(path.join(base, 'com.tarocub.client', 'host')); await mkdir(path.join(app, 'host'));
    await assert.rejects(screenHostDirectory(app), /^Error: screen_host_directory_conflict$/);
    // A redirected (symlinked) Host directory is refused.
    await rm(path.join(app, 'host'), { recursive: true }); await rm(path.join(base, 'com.tarocub.client', 'host'), { recursive: true });
    await mkdir(path.join(base, 'elsewhere')); await symlink(path.join(base, 'elsewhere'), path.join(app, 'host'));
    await assert.rejects(screenHostDirectory(app), /^Error: screen_host_directory_redirected$/);
    // Isolated development/audit roots never discover sibling real data.
    const isolated = path.join(base, 'app-state');
    await mkdir(path.join(base, 'host'));
    assert.equal(await screenHostDirectory(isolated), path.join(isolated, 'host'));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a Host directory conflict is reported before any socket is contacted', async () => {
  const h = await host({}, { id: 'com.tarocub.client' });
  try {
    await mkdir(path.join(h.app, 'host'));
    await assert.rejects(desktopScreenTicket(h.app, 'desktop-1'), /screen_host_directory_conflict/);
    assert.deepEqual(h.issued, []);
  } finally { await h.close(); }
});

test('an unsafe control key file is refused before any ticket request', async () => {
  const h = await host();
  try {
    await chmod(path.join(h.directory, 'hub-control.key'), 0o644);
    await assert.rejects(desktopScreenTicket(h.app, 'desktop-1'), /unsafe_hub_control_key/);
    assert.deepEqual(h.issued, []);
  } finally { await h.close(); }
});

test('a wrong token gets no ticket', async () => {
  const h = await host();
  try {
    await writeFile(path.join(h.directory, 'hub-control.key'), 'f'.repeat(64), { mode: 0o600 });
    await assert.rejects(desktopScreenTicket(h.app, 'desktop-1'));
    assert.deepEqual(h.issued, []);
  } finally { await h.close(); }
});

test('no Host running is reported as unavailable, with a bounded code and no path', async () => {
  const base = await shortTmp();
  try {
    const app = path.join(base, 'com.tarobot.client');
    await mkdir(path.join(app, 'host'), { recursive: true });
    await assert.rejects(desktopScreenTicket(app, 'desktop-1'), error => error.message === 'screen_host_unavailable');
  } finally { await rm(base, { recursive: true, force: true }); }
});

// ---------------- capabilities on the ticket reply (quality negotiation) ----------------
test('the ticket carries the Host control capabilities from the same reply; existing fields are unchanged', async () => {
  const h = await host();
  try {
    const ticket = await desktopScreenTicket(h.app, 'desktop-1');
    assert.deepEqual(Object.keys(ticket), ['ticket', 'expiresAt', 'instancePort', 'publicKey', 'capabilities']);
    assert.equal(ticket.ticket, 'T'.repeat(43)); assert.equal(ticket.instancePort, 45678); assert.equal(ticket.publicKey, publicKey);
    assert.ok(ticket.capabilities.includes('screen-service-ticket') && ticket.capabilities.includes('screen-quality-v1'));
  } finally { await h.close(); }
});

/** A scripted control socket: answers `status` and `screen-service-ticket` like an (older) Host. */
async function scripted(ticketReply) {
  const base = await shortTmp(), directory = path.join(base, 'host');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'hub-control.key'), 'a'.repeat(64), { mode: 0o600 });
  const { EventEmitter } = await import('node:events');
  const connect = () => {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {},
      write(text) {
        const body = JSON.parse(text);
        const reply = body.command === 'status' ? { running: true, pid: 1, url: 'https://127.0.0.1:1', publicKey } : { running: true, pid: 1, url: 'https://127.0.0.1:1', publicKey, ...ticketReply };
        setImmediate(() => socket.emit('data', Buffer.from(JSON.stringify(reply) + '\n')));
      } });
    setImmediate(() => socket.emit('connect'));
    return socket;
  };
  return { directory, connect, close: () => rm(base, { recursive: true, force: true }) };
}

test('an older Host reply without controlCapabilities still yields a ticket, with no capabilities', async () => {
  const s = await scripted({ screenServiceTicket: { ticket: 'T'.repeat(43), expiresAt: Date.now() + 30000 }, instancePort: 4567 });
  try {
    const ticket = await screenServiceTicket(s.directory, 'desktop-1', { connect: s.connect });
    assert.deepEqual([ticket.ticket, ticket.instancePort, ticket.capabilities], ['T'.repeat(43), 4567, []]);
  } finally { await s.close(); }
});

test('malformed or oversized capability lists are bounded and filtered, never trusted as-is', async () => {
  for (const [controlCapabilities, expected] of [
    ['screen-quality-v1', []], [{ 0: 'screen-quality-v1' }, []],
    [['screen-quality-v1', 7, null, 'UPPER', 'has space', 'x'.repeat(65), 'target-stop'], ['screen-quality-v1', 'target-stop']],
    [[...Array.from({ length: 40 }, (_, i) => `cap-${i}`), 'screen-quality-v1'], Array.from({ length: 32 }, (_, i) => `cap-${i}`)],
  ]) {
    const s = await scripted({ screenServiceTicket: { ticket: 'T'.repeat(43), expiresAt: Date.now() + 30000 }, instancePort: 4567, controlCapabilities });
    try { assert.deepEqual((await screenServiceTicket(s.directory, 'desktop-1', { connect: s.connect })).capabilities, expected); }
    finally { await s.close(); }
  }
});
