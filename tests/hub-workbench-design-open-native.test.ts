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
import { NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY } from '../src/client-protocol/native-input.js';

class Peer {
  frames: any[] = [];
  constructor(readonly ws: WebSocket) { const reader = nodeFrameReader(); ws.on('message', raw => { const frame = reader.read(raw.toString()); if (frame) this.frames.push(frame); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((r, j) => { peer.ws.once('open', r); peer.ws.once('error', j); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string, match: (frame: any) => boolean = () => true) { return until(() => { const i = this.frames.findIndex(f => f.type === type && match(f)); return i < 0 ? undefined : this.frames.splice(i, 1)[0]; }); }
}
async function until<T>(fn: () => T | undefined | Promise<T | undefined>) { const deadline = Date.now() + 4000; for (;;) { const value = await fn(); if (value !== undefined) return value; if (Date.now() > deadline) throw Error('timed_out'); await new Promise(r => setTimeout(r, 5)); } }

// Native input (POST /steer) is how most Claude sends arrive while a run is
// busy. design.open must follow only the input the model provably adopted,
// never the run's old device, and a review turn only while it is live.
describe('design.open source for native inputs', () => {
  let dir: string, hub: HubServer, conversationId: string, desktop: { peer: Peer; token: string }, phone: { peer: Peer; token: string }, worker: Peer; const peers: Peer[] = [];
  const secret = 'design-native-fixture-' + 'c'.repeat(40);
  const opener = (deviceId: string) => ({ deviceId, windowId: `${deviceId}-opener` }), closed = (deviceId: string) => ({ target: opener(deviceId), openTarget: opener(deviceId) });
  async function client(deviceId: string) {
    const keys = generateKeyPairSync('ed25519');
    const pair = await hub.auth.pair({ deviceId, name: deviceId, platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
    await hub.auth.approve(pair.code, 'local-owner');
    const peer = await Peer.connect(hub.url.replace(/^http/, 'ws') + '/ws'); peers.push(peer);
    const nonce = randomBytes(32).toString('base64url');
    peer.send({ type: 'hello', deviceId, nonce, protocolVersions: [1], capabilities: [WORKBENCH_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY], cursors: {} });
    const c = await peer.next('challenge');
    peer.send({ type: 'auth', signature: sign(null, deviceProof(deviceId, c.nonce, nonce), keys.privateKey).toString('base64') });
    const ready = await peer.next('ready'); await peer.next('sync.complete');
    peer.send({ type: 'workbench.register', registration: { windowId: `${deviceId}-opener`, generation: 'g', conversationId, capabilities: ['design.open.v1'], tabs: [], visible: true } });
    return { peer, token: ready.sessionToken as string };
  }
  const steer = (body: object, token: string) => fetch(`${hub.url}/api/conversations/${conversationId}/steer`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ botId: 'bot', targetId: 'run-token', mode: 'message', text: 'Use Design now', ...body }) });
  let rpc = 0;
  const request = (method: string, params: object) => { const id = `req_${++rpc}`; worker.send({ type: 'instance.request', id, method, params }); return worker.next('instance.result', frame => frame.id === id); };
  const open = (contextMessageId: string, requestId = `open_${++rpc}`) => request('workbench.command', { conversationId, contextMessageId, request: { requestId, operation: 'design.open', payload: {}, contextMessageId } });
  /** Answers the App side so a dispatched command settles; returns its target. */
  async function dispatchedTo(app: Peer) { const frame = await app.next('workbench.command'); app.send({ type: 'workbench.receipt', dispatchId: frame.dispatchId, receipt: { requestId: frame.request.requestId, target: frame.target, status: 'not_executed', error: 'test' } }); return frame.target; }
  async function source() {
    desktop.peer.send({ type: 'message.send', conversationId, clientMsgId: `src_${++rpc}`, text: 'Start the landing page', attachments: [], workbench: closed('desktop') });
    return (await worker.next('instance.message')).message.id as string;
  }
  async function nativeInput(requestId: string, app = phone, result: object | ((call: any) => object) = {}) {
    const reply = steer({ requestId, workbench: closed(app === phone ? 'phone' : 'desktop') }, app.token);
    const call = await worker.next('instance.call', frame => frame.method === 'steer' && frame.params.requestId === requestId);
    return { call, reply, answer: async (value: object = typeof result === 'function' ? result(call) : result) => { worker.send({ type: 'instance.result', id: call.id, result: value }); return (await reply).json(); } };
  }
  const progress = (record: any, state: string) => request('input.progress', { conversationId, userId: 'owner', requestId: record.clientMsgId, targetId: 'run-token', progress: { state } });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'design-open-native-')); hub = await HubServer.start({ stateDir: dir });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Bot',?,'claude')", [hashSecret(secret)]);
    conversationId = (await hub.store.createConversation('owner', ['bot'], 'Native design', 'create')).id;
    desktop = await client('desktop'); phone = await client('phone');
    worker = await Peer.connect(hub.instanceUrl.replace(/^http/, 'ws') + '/instance'); peers.push(worker);
    worker.send({ type: 'instance.hello', botId: 'bot', secret, engine: 'claude', model: '', effort: '', capabilities: [NATIVE_INPUT_CAPABILITY, NATIVE_REVIEW_INPUT_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY] });
    await worker.next('instance.ready');
    await until(async () => (await (await fetch(`${hub.url}/api/conversations/${conversationId}/workbench/targets`, { headers: { Authorization: `Bearer ${desktop.token}` } })).json()).length === 2 || undefined);
  });
  afterEach(async () => { for (const p of peers.splice(0)) p.ws.terminate(); await hub.close(); await rm(dir, { recursive: true, force: true }); });

  it('N1: stores the sender opener before dispatch, never forwards it, and retries without live revalidation', async () => {
    const run = await source();
    const first = await nativeInput('n1-input', phone, { outcome: 'accepted', sourceMessageId: run });
    expect(first.call.params).not.toHaveProperty('workbench');
    const record = await first.answer();
    const meta = await hub.store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`workbench-context:${record.id}`]);
    expect(JSON.parse(meta!.value)).toEqual(closed('phone'));
    expect(JSON.stringify(record.blocks)).not.toContain('sourceMessageId');
    phone.peer.send({ type: 'workbench.unregister', windowId: 'phone-opener' });
    await until(async () => (await (await fetch(`${hub.url}/api/conversations/${conversationId}/workbench/targets`, { headers: { Authorization: `Bearer ${phone.token}` } })).json()).length === 1 || undefined);
    const retry = await steer({ requestId: 'n1-input', workbench: closed('phone') }, phone.token);
    expect(retry.status).toBe(200); expect((await retry.json()).id).toBe(record.id);
    expect((await steer({ requestId: 'n1-input', workbench: closed('desktop') }, phone.token)).status).toBe(409);
    expect((await steer({ requestId: 'n1-input' }, phone.token)).status).toBe(409);
    expect(await (await steer({ requestId: 'n1-panel', workbench: { target: { deviceId: 'desktop', windowId: 'desktop-opener' }, openTarget: opener('desktop'), kind: 'design' } }, desktop.token)).json()).toMatchObject({ error: 'invalid_workbench_context' });
    expect(await (await steer({ requestId: 'n1-foreign', workbench: closed('desktop') }, phone.token)).json()).toMatchObject({ error: 'workbench_open_target_unavailable' });
    // A native send whose own opener just retired is still delivered, with that locator frozen.
    const retired = await nativeInput('n1-retired', phone);
    expect((await retired.answer({ outcome: 'accepted', sourceMessageId: run })).id).toBeDefined();
  });

  it('N2: waits while an input is in flight or unadopted, then follows only the adopted input', async () => {
    const run = await source();
    const input = await nativeInput('n2-input');
    // Deferred binding: the steer call has not returned yet.
    expect((await open(run)).error).toBe('workbench_input_pending');
    const record = await input.answer({ outcome: 'accepted', sourceMessageId: run });
    expect((await open(run)).error).toBe('workbench_input_pending');
    await progress(record, 'queued');
    expect((await open(run)).error).toBe('workbench_input_pending');
    await progress(record, 'received');
    const opened = open(run);
    expect(await dispatchedTo(phone.peer)).toEqual(opener('phone'));
    expect((await opened).result).toMatchObject({ status: 'not_executed' });
    expect(desktop.peer.frames.filter(frame => frame.type === 'workbench.command')).toEqual([]);
    // An adopted input the user removed from their history never falls back.
    await hub.store.db.run('INSERT INTO message_deletions(user_id,message_id,deleted_at) VALUES(?,?,?)', ['owner', record.id, Date.now()]);
    expect((await open(run)).error).toBe('workbench_open_target_unavailable');
  });

  it('N2: a proven non-adoption keeps the original source; an unreported run fails closed', async () => {
    const run = await source();
    const dropped = await (await nativeInput('n2-dropped')).answer({ outcome: 'accepted', sourceMessageId: run });
    await progress(dropped, 'dropped');
    const opened = open(run);
    expect(await dispatchedTo(desktop.peer)).toEqual(opener('desktop'));
    await opened;
    // The Bot could not say which run took it: every live run of this Bot here waits.
    const lost = await nativeInput('n2-lost');
    worker.send({ type: 'instance.result', id: lost.call.id, error: 'gateway_call_failed' });
    expect((await (await lost.reply).json()).blocks.find((block: any) => block.type === 'steering').outcome).toBe('unknown');
    expect((await open(run)).error).toBe('workbench_input_pending');
  });

  it('N3: a review turn may begin once while its own call is in flight; its lease ends with the turn', async () => {
    const input = await nativeInput('n3-review', desktop);
    expect(input.call.params.messageId).toBeDefined();
    const recordId = input.call.params.messageId as string;
    expect((await open(recordId)).error).toBe('workbench_turn_ended');
    const begun = await request('workbench.turn.begin', { conversationId, messageId: recordId });
    expect(begun.result).toEqual({ workbench: closed('desktop') });
    expect((await request('workbench.turn.begin', { conversationId, messageId: recordId })).error).toBe('workbench_turn_unavailable');
    const opened = open(recordId);
    expect(await dispatchedTo(desktop.peer)).toEqual(opener('desktop'));
    await opened;
    await request('workbench.turn.end', { conversationId, messageId: recordId });
    expect((await open(recordId)).error).toBe('workbench_turn_ended');
    // Ended: no second lease while the same call is still returning, nor after it.
    expect((await request('workbench.turn.begin', { conversationId, messageId: recordId })).error).toBe('workbench_turn_unavailable');
    await input.answer({ outcome: 'accepted' });
    expect((await request('workbench.turn.begin', { conversationId, messageId: recordId })).error).toBe('workbench_turn_unavailable');
  });

  it('N3: a historical record never begins, and a closed Bot socket drops its leases', async () => {
    const old = await nativeInput('n3-old', desktop);
    const oldId = old.call.params.messageId as string; await old.answer({ outcome: 'accepted' });
    expect((await request('workbench.turn.begin', { conversationId, messageId: oldId })).error).toBe('workbench_turn_unavailable');
    const live = await nativeInput('n3-live', desktop);
    const liveId = live.call.params.messageId as string;
    expect((await request('workbench.turn.begin', { conversationId, messageId: liveId })).result).toBeTruthy();
    worker.ws.terminate();
    await until(() => (hub as any).nativeTurns.size === 0 || undefined);
    expect((await (await live.reply).json()).blocks.find((block: any) => block.type === 'steering').outcome).toBe('unknown');
  });
});
