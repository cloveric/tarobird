// Execute with the target package's Node: verifies actual packaged code/addons,
// control IPC, engine launch, authenticated HTTP/WS and supervised worker restore.
// Synthetic CLI only; no model account, credentials or existing user state.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(process.argv[2] || 'client/src-tauri/host');
const load = file => import(pathToFileURL(path.join(root, 'dist/src', file)).href);
const { desktopHost } = await load('hub/desktop.js');
const { hubServiceCommand } = await load('hub/service.js');
const { deviceProof } = await load('hub/auth.js');
const { desktopControllerChallengeSchema, desktopControllerProofText } = await load('hub/local-controller.js');
const { spawnEngine } = await load('runtime/engine-process.js');
const { HubStore } = await load('hub/store.js');
const { blocksText } = await load('client-protocol/index.js');
const { WebSocket } = createRequire(path.join(root, 'package.json'))('ws');
const temporary = await mkdtemp(path.join(process.env.TAROBOT_ACCEPTANCE_TMPDIR || (process.platform === 'darwin' ? '/tmp' : os.tmpdir()), 'tb-host-'));
const directory = path.join(temporary, '主机 with spaces'), bin = path.join(temporary, 'cli with spaces');
await mkdir(bin); const entry = path.join(root, 'dist/src/index.js');
const fixture = `import { Socket } from 'node:net';
if (process.argv.includes('--arguments')) { console.log(JSON.stringify(process.argv.slice(3))); }
else if (process.argv.includes('--pipes')) { const input = new Socket({fd:3,readable:true,writable:false}); const output = new Socket({fd:4,readable:false,writable:true}); input.once('data', data => { output.end(data); input.destroy(); }); }
else { for await (const chunk of process.stdin) {} console.log(JSON.stringify({type:'thread.started',thread_id:'windows_fixture'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'WINDOWS_HOST_REPLY_OK'}})); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})); }
`;
await writeFile(path.join(bin, 'fixture.mjs'), fixture);
const command = path.join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
await writeFile(command, process.platform === 'win32' ? '@ECHO OFF\r\nnode "%dp0%\\fixture.mjs" %*\r\n' : '#!/usr/bin/env node\n' + fixture);
await chmod(command, 0o700);
// Only this synthetic child process tree sees these overrides.
process.env.CODEX_EXECUTABLE = command;
process.env.PATH = [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter);
process.env.CODEX_HOME = path.join(temporary, 'codex');
const until = async check => { const deadline = Date.now() + 20000; while (!await check()) { if (Date.now() > deadline) throw new Error('host_smoke_timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };
let socket, store;
try {
  const args = ['two words', 'foo&bar', '%PATH%', '中文', 'quote"inside'];
  const child = spawnEngine(command, ['--arguments', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => output += value); const [code] = await once(child, 'close'); assert.equal(code, 0); assert.deepEqual(JSON.parse(output), args);
  const pipes = spawnEngine(command, ['--pipes'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const pipeResult = once(pipes.stdio[4], 'data'), pipesClosed = once(pipes, 'close'); pipes.stdio[3].write('PRIVATE_PIPE_OK');
  assert.equal(String((await pipeResult)[0]), 'PRIVATE_PIPE_OK'); await pipesClosed;
  const initial = await desktopHost('resume', directory, entry);
  assert.equal(typeof initial.hostName, 'string'); assert.ok(initial.hostName.trim());
  assert.deepEqual(initial, { available: true, running: false, hostName: initial.hostName });
  const hostName = 'Package host 主机';
  let host = await desktopHost('start', directory, entry, { hostName }); assert.equal(host.running, true); assert.equal(host.hostName, hostName);
  assert.equal((await (await fetch(host.url + '/health')).json()).publicKey, host.publicKey);
  assert.match(await (await fetch(host.url)).text(), /<html/);
  const keys = generateKeyPairSync('ed25519'), deviceId = 'device_windows_smoke';
  const device = { deviceId, name: 'Windows smoke', platform: process.platform === 'win32' ? 'windows' : 'macos', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  const challengeResponse = await desktopHost('pair-challenge', directory, entry, device);
  const challenge = desktopControllerChallengeSchema.parse(challengeResponse.desktopControllerChallenge);
  assert.equal(challenge.hubPublicKey, host.publicKey);
  const nativeProof = { challenge, signature: sign(null, Buffer.from(desktopControllerProofText(challenge)), keys.privateKey).toString('base64') };
  await desktopHost('pair', directory, entry, { ...device, nativeProof });
  async function connect() {
    socket = new WebSocket(host.url.replace(/^http/, 'ws') + '/ws'); const frames = [];
    socket.on('message', data => { const frame = JSON.parse(data); frames.push(frame); if (frame.type === 'snapshot.message') socket.send(JSON.stringify({ v: 1, type: 'snapshot.ack', id: frame.id, count: frame.index + 1 })); });
    await once(socket, 'open');
    const nonce = randomBytes(32).toString('base64url');
    socket.send(JSON.stringify({ v: 1, type: 'hello', deviceId, nonce, protocolVersions: [1], capabilities: ['cards.v1'], cursors: {} }));
    await until(() => frames.some(frame => frame.type === 'challenge')); const challenge = frames.find(frame => frame.type === 'challenge');
    socket.send(JSON.stringify({ v: 1, type: 'auth', signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), keys.privateKey).toString('base64') }));
    await until(() => frames.some(frame => frame.type === 'sync.complete'));
    return frames.find(frame => frame.type === 'ready').sessionToken;
  }
  const token = await connect();
  const request = async (route, body) => { const response = await fetch(host.url + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(response.ok, `${route}: ${response.status}`); return response.json(); };
  assert.equal((await request('/api/bots/catalog')).engines.find(engine => engine.id === 'codex').available, true);
  const bot = await request('/api/bots', { requestId: 'windows_fixture_bot', name: 'Windows fixture', engine: 'codex', model: '', effort: '', workspace: '' });
  const conversation = await request('/api/conversations', { v: 1, type: 'conversation.create', clientActionId: 'windows_chat', botIds: [bot.id], title: 'Windows fixture' });
  socket.terminate(); socket = undefined;
  await hubServiceCommand('stop', directory, entry);
  const config = path.join(directory, 'bots', bot.id, 'config.json');
  await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(config, 'utf8')), codexRuntime: 'process' }));
  // Resume must retain the host identity, device, Bot and conversation.
  const previousKey = host.publicKey; host = await desktopHost('resume', directory, entry); assert.equal(host.publicKey, previousKey); assert.equal(host.hostName, hostName);
  await connect(); store = await HubStore.open(directory);
  await until(async () => (await store.bots('owner')).find(value => value.id === bot.id)?.online === 1);
  socket.send(JSON.stringify({ v: 1, type: 'message.send', clientMsgId: 'windows_message', conversationId: conversation.id, text: 'Fixture request', attachments: [] }));
  await until(async () => (await store.snapshot('owner', conversation.id)).messages.some(message => message.authorType === 'bot' && blocksText(message.blocks).includes('WINDOWS_HOST_REPLY_OK')));
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, package: root, engineArgumentRoundtrip: true, privatePipes: true, authenticatedPairing: true, botCreation: true, fixtureReply: true, hostRestore: true, hostNameRetained: true }));
} finally {
  socket?.terminate(); await store?.db.close();
  await desktopHost('stop', directory, entry).catch(() => undefined);
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
