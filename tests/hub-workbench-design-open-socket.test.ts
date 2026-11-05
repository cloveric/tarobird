import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubServer } from '../src/hub/server.js';
import { deviceProof, hashSecret } from '../src/hub/auth.js';
import { nodeFrameReader } from '../src/client-protocol/fragments-node.js';
import { WORKBENCH_CAPABILITY } from '../src/client-protocol/workbench.js';
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY } from '../src/client-protocol/workbench-design.js';

class Peer {
  frames: any[] = [];
  constructor(readonly ws: WebSocket) { const reader = nodeFrameReader(); ws.on('message', raw => { const frame = reader.read(raw.toString()); if (frame) this.frames.push(frame); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { peer.ws.once('open', r); peer.ws.once('error', j); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string) { return until(() => { const i = this.frames.findIndex(f => f.type === type); return i < 0 ? undefined : this.frames.splice(i, 1)[0]; }); }
}
async function until<T>(fn: () => T | undefined | Promise<T | undefined>) { const deadline = Date.now() + 4000; for (;;) { const value = await fn(); if (value !== undefined) return value; if (Date.now() > deadline) throw Error('timed_out'); await new Promise(r => setTimeout(r, 5)); } }

describe('design.open over the signed App socket and Bot instance API', () => {
  let dir: string, hub: HubServer, conversationId: string, app: Peer, token: string; const peers: Peer[] = [];
  const secret = 'design-open-fixture-' + 'a'.repeat(40), secret2 = 'design-open-legacy-' + 'b'.repeat(40);
  const appCapabilities = [WORKBENCH_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY];
  const opener = { deviceId: 'desktop', windowId: 'opener' }, real = { deviceId: 'desktop', windowId: 'controller', tabId: 'design-a' };
  const openerRegistration = (conversation: string, windowId = 'opener') => ({ windowId, generation: 'opener-gen', conversationId: conversation, capabilities: ['design.open.v1'], tabs: [], visible: true });
  const controllerRegistration = (conversation: string) => ({ windowId: 'controller', generation: 'controller-gen', conversationId: conversation, capabilities: ['whiteboard.v1', 'design.v1'], tabs: [{ id: 'design-a', kind: 'design', title: 'A', revision: 2 }], activeTabId: 'design-a', visible: true });
  async function client(deviceId: string, capabilities = appCapabilities) {
    const keys = generateKeyPairSync('ed25519');
    const pair = await hub.auth.pair({ deviceId, name: deviceId, platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
    await hub.auth.approve(pair.code, 'local-owner');
    const peer = await Peer.connect(hub.url.replace(/^http/, 'ws') + '/ws'); peers.push(peer);
    const nonce = randomBytes(32).toString('base64url');
    peer.send({ type: 'hello', deviceId, nonce, protocolVersions: [1], capabilities, cursors: {} });
    const c = await peer.next('challenge');
    peer.send({ type: 'auth', signature: sign(null, deviceProof(deviceId, c.nonce, nonce), keys.privateKey).toString('base64') });
    const ready = await peer.next('ready'); await peer.next('sync.complete');
    return { peer, token: ready.sessionToken as string, serverCapabilities: ready.serverCapabilities as string[] };
  }
  const api = (url: string, body?: unknown, bearer = token) => fetch(hub.url + url, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const targets = async (conversation: string) => (await (await api(`/api/conversations/${conversation}/workbench/targets`)).json()) as Array<{ windowId: string }>;
  async function worker(botId: string, key: string, capabilities: string[]) {
    const peer = await Peer.connect(hub.instanceUrl.replace(/^http/, 'ws') + '/instance'); peers.push(peer);
    peer.send({ type: 'instance.hello', botId, secret: key, engine: 'codex', model: '', effort: '', capabilities });
    return { peer, ready: await peer.next('instance.ready') };
  }
  async function send(conversation: string, clientMsgId: string, workbench: object, from = app) {
    from.send({ type: 'message.send', conversationId: conversation, clientMsgId, text: 'Use Design for this', attachments: [], workbench });
    return from.next('message.ack');
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'design-open-socket-')); hub = await HubServer.start({ stateDir: dir });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Bot',?,'codex')", [hashSecret(secret)]);
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('legacy','Legacy',?,'codex')", [hashSecret(secret2)]);
    conversationId = (await hub.store.createConversation('owner', ['bot'], 'Design open', 'create')).id;
    const auth = await client('desktop'); app = auth.peer; token = auth.token;
  });
  afterEach(async () => { for (const p of peers.splice(0)) p.ws.terminate(); await hub.close(); await rm(dir, { recursive: true, force: true }); });

  it('advertises the capability to Apps and gateways', async () => {
    const other = await client('capability-check');
    expect(other.serverCapabilities).toContain(WORKBENCH_DESIGN_OPEN_CAPABILITY);
    const { ready } = await worker('bot', secret, []);
    expect(ready.capabilities).toContain(WORKBENCH_DESIGN_OPEN_CAPABILITY);
  });

  it('freezes only the sending device opener and refuses another device, hidden or missing opener', async () => {
    const phone = await client('phone');
    phone.peer.send({ type: 'workbench.register', registration: openerRegistration(conversationId, 'phone-opener') });
    app.send({ type: 'workbench.register', registration: openerRegistration(conversationId) });
    await until(async () => (await targets(conversationId)).length === 2 || undefined);
    const ack = await send(conversationId, 'own-opener', { target: opener, openTarget: opener });
    const meta = await hub.store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`workbench-context:${ack.messageId}`]);
    expect(JSON.parse(meta!.value)).toEqual({ target: opener, openTarget: opener });
    const foreign = { deviceId: 'phone', windowId: 'phone-opener' };
    app.send({ type: 'message.send', conversationId, clientMsgId: 'foreign-opener', text: 'Use Design', attachments: [], workbench: { target: foreign, openTarget: foreign } });
    expect((await app.next('error')).code).toBe('workbench_open_target_unavailable');
    // An own opener that retired during the send is frozen, never a lost message.
    const gone = { deviceId: 'desktop', windowId: 'gone' };
    expect((await send(conversationId, 'missing-opener', { target: gone, openTarget: gone })).messageId).toBeDefined();
    app.send({ type: 'workbench.register', registration: { ...openerRegistration(conversationId), visible: false } });
    await until(async () => (await targets(conversationId)).some(t => t.windowId === 'opener' && !(t as { visible?: boolean }).visible) || undefined);
    expect((await send(conversationId, 'hidden-opener', { target: opener, openTarget: opener })).messageId).toBeDefined();
    // Forged content on an opener address is still refused.
    app.send({ type: 'message.send', conversationId, clientMsgId: 'forged-opener', text: 'Use Design', attachments: [], workbench: { target: opener, openTarget: opener, kind: 'design' } });
    expect((await app.next('error')).code).toBe('invalid_workbench_context');
    expect(app.frames.filter(frame => frame.type === 'error')).toEqual([]);
  });

  it('gives older gateways the context an older App would have frozen', async () => {
    const legacyConversation = (await hub.store.createConversation('owner', ['legacy'], 'Legacy', 'legacy-create')).id;
    for (const id of [conversationId, legacyConversation]) { app.send({ type: 'workbench.register', registration: openerRegistration(id, `opener-${id}`) }); }
    app.send({ type: 'workbench.register', registration: controllerRegistration(legacyConversation) });
    await until(async () => (await targets(legacyConversation)).length === 2 || undefined);
    const current = await worker('bot', secret, [WORKBENCH_DESIGN_OPEN_CAPABILITY]), legacy = await worker('legacy', secret2, []);
    const own = { deviceId: 'desktop', windowId: `opener-${conversationId}` }, old = { deviceId: 'desktop', windowId: `opener-${legacyConversation}` };
    await send(conversationId, 'current-closed', { target: own, openTarget: own });
    expect((await current.peer.next('instance.message')).workbench).toEqual({ target: own, openTarget: own });
    await send(legacyConversation, 'legacy-closed', { target: old, openTarget: old });
    expect((await legacy.peer.next('instance.message'))).not.toHaveProperty('workbench');
    await send(legacyConversation, 'legacy-panel', { target: real, kind: 'design', revision: 2, openTarget: old });
    expect((await legacy.peer.next('instance.message')).workbench).toEqual({ target: real, kind: 'design', revision: 2 });
  });

  it('a Bot opens the sending App, receives the real target registered before the receipt, and continues there', async () => {
    app.send({ type: 'workbench.register', registration: openerRegistration(conversationId) });
    await until(async () => (await targets(conversationId)).length === 1 || undefined);
    const bot = await worker('bot', secret, [WORKBENCH_DESIGN_OPEN_CAPABILITY]);
    await send(conversationId, 'open-turn', { target: opener, openTarget: opener });
    const message = (await bot.peer.next('instance.message')).message;
    const call = (id: string, request: object) => bot.peer.send({ type: 'instance.request', id, method: 'workbench.command', params: { conversationId, contextMessageId: message.id, request: { ...request, contextMessageId: message.id } } });
    const result = (id: string) => until(() => { const i = bot.peer.frames.findIndex(f => f.type === 'instance.result' && f.id === id); return i < 0 ? undefined : bot.peer.frames.splice(i, 1)[0]; });
    call('elsewhere', { requestId: 'open-elsewhere', operation: 'design.open', target: { deviceId: 'phone', windowId: 'opener' }, payload: {} });
    expect((await result('elsewhere')).error).toBe('workbench_open_target_mismatch');
    // Receipt before the real registration: the App may have opened, outcome unknown.
    call('early', { requestId: 'open-early', operation: 'design.open', payload: {} });
    const early = await app.next('workbench.command');
    expect((await api('/api/workbench/admit', { dispatchId: early.dispatchId })).status).toBe(200);
    app.send({ type: 'workbench.receipt', dispatchId: early.dispatchId, receipt: { requestId: 'open-early', target: early.target, status: 'applied', saved: true, revision: 2, result: { target: real, created: false } } });
    expect((await result('early')).result).toMatchObject({ status: 'unknown', error: 'workbench_open_target_unregistered' });
    call('open', { requestId: 'open', operation: 'design.open', payload: {} });
    const frame = await app.next('workbench.command');
    expect(frame).toMatchObject({ conversationId, target: opener, request: { operation: 'design.open', payload: {}, contextMessageId: message.id } });
    expect((await api('/api/workbench/admit', { dispatchId: frame.dispatchId })).status).toBe(200);
    // Same ordered socket: registration first, then the receipt.
    app.send({ type: 'workbench.register', registration: controllerRegistration(conversationId) });
    app.send({ type: 'workbench.receipt', dispatchId: frame.dispatchId, receipt: { requestId: 'open', target: opener, status: 'applied', saved: true, revision: 2, result: { target: real, created: true } } });
    expect((await result('open')).result).toEqual({ requestId: 'open', target: opener, status: 'applied', saved: true, revision: 2, result: { target: real, created: true } });
    call('read', { requestId: 'read', operation: 'design.read', target: real, payload: {} });
    expect(await app.next('workbench.command')).toMatchObject({ target: real, request: { operation: 'design.read' } });
  });
});
