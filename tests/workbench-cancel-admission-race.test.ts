import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { HubServer } from '../src/hub/server.js';
import { deviceProof, hashSecret } from '../src/hub/auth.js';
import { nodeFrameReader } from '../src/client-protocol/fragments-node.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import { WORKBENCH_CAPABILITY, type WorkbenchCommandFrame, type WorkbenchReceipt, type WorkbenchRegistration } from '../src/client-protocol/workbench.js';

// A Bot abort sends workbench.cancel right after its command. The cancel must
// win wherever the command is: still authenticating, resolving its target,
// waiting on another identical flight, or pending before dispatch. It may only
// cancel the same user, conversation and source turn, and leaves no permanent
// tombstone: a cancelled command is recorded like any other outcome.
describe('a Bot cancel is not lost before the command is dispatched', () => {
  let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, otherConversationId: string;
  let commands: WorkbenchCommandFrame[], peer: WorkbenchPeer, peerGate: ((call: number) => Promise<void> | undefined) | undefined, peerCalls: number;
  const target = { deviceId: 'device', windowId: 'window', tabId: 'design-a' };
  const files = { files: { 'project/Main.dc.html': { content: '<x-dc>edit</x-dc>', contentType: 'text/html' as const } } };
  const publish = (requestId: string) => ({ requestId, operation: 'design.publish' as const, target, expectedRevision: 0, payload: files, contextMessageId: 'msg_turn' });
  const registration = (conversation: string): WorkbenchRegistration => ({ windowId: 'window', generation: 'gen', conversationId: conversation, capabilities: ['design.v1'], tabs: [{ id: 'design-a', kind: 'design', title: 'A', revision: 0 }], activeTabId: 'design-a', visible: true });
  // The Hub builds a separate actor for the command and for its cancel.
  const turn = (overrides: Partial<WorkbenchActor> = {}): WorkbenchActor => ({ sourceMessageId: 'msg_turn', userId: 'owner', conversationId, validate: async () => {}, ...overrides });
  const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
  // Well before the broker timeout, a cancelled command has already settled.
  const promptly = <T>(promise: Promise<T>) => Promise.race([promise, new Promise(r => setTimeout(() => r('still pending'), 200))]);
  async function applied(frame: WorkbenchCommandFrame) {
    await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, { requestId: frame.request.requestId, target: frame.target, status: 'applied', saved: true, revision: 1 });
  }
  const notDispatched = (receipt: WorkbenchReceipt) => { expect(receipt).toMatchObject({ status: 'not_executed', error: 'workbench_cancelled' }); expect(commands).toEqual([]); };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-cancel-race-'));
    store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 400);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    conversationId = (await store.createConversation('owner', ['bot'], 'Design', 'cancel-race')).id;
    otherConversationId = (await store.createConversation('owner', ['bot'], 'Other', 'cancel-race-other')).id;
    commands = []; peerGate = undefined; peerCalls = 0;
    peer = { key: {}, userId: 'owner', deviceId: 'device', active: () => true,
      validate: async () => { const gate = peerGate?.(++peerCalls); if (gate) await gate; },
      send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } };
    await broker.register(peer, registration(conversationId)); peerCalls = 0;
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it('a cancel that arrives while the Hub is still authenticating the command prevents dispatch', async () => {
    // The Hub may finish authenticating the cancel before the command reaches the broker.
    await broker.cancelRequest(turn(), 'early');
    notDispatched(await broker.request(turn(), publish('early')));
    // The outcome is recorded: the same-turn retry is refused, not executed.
    notDispatched(await broker.request(turn(), publish('early')));
  });

  it('a cancel during the command’s own initial validation prevents dispatch', async () => {
    const gate = deferred(); let first = true;
    const command = broker.request(turn({ validate: async () => { if (first) { first = false; await gate.promise; } } }), publish('validating'));
    await broker.cancelRequest(turn(), 'validating');
    gate.release();
    notDispatched(await command);
  });

  it('a cancel while the command resolves its target also settles an identical waiting flight', async () => {
    const gate = deferred(); peerGate = call => call === 1 ? gate.promise : undefined;
    const command = broker.request(turn(), publish('resolving'));
    for (let n = 0; n < 100 && peerCalls < 1; n++) await new Promise(r => setTimeout(r, 2));
    expect(peerCalls).toBe(1);
    const duplicate = broker.request(turn(), publish('resolving'));
    await broker.cancelRequest(turn(), 'resolving');
    gate.release();
    notDispatched(await command); notDispatched(await duplicate);
  });

  it('a cancel while pending before dispatch is recorded, so a retry cannot report an unknown outcome', async () => {
    // peer.validate: once while listing targets, once while validating the pending command.
    const gate = deferred(); peerGate = call => call === 2 ? gate.promise : undefined;
    const command = broker.request(turn(), publish('pending'));
    for (let n = 0; n < 100 && peerCalls < 2; n++) await new Promise(r => setTimeout(r, 2));
    expect(peerCalls).toBe(2);
    await broker.cancelRequest(turn(), 'pending');
    gate.release();
    notDispatched(await command);
    notDispatched(await broker.request(turn(), publish('pending')));
  });

  it('cannot cancel another turn, conversation or user', async () => {
    await broker.cancelRequest(turn({ sourceMessageId: 'msg_other_turn' }), 'isolated');
    await broker.cancelRequest(turn({ conversationId: otherConversationId }), 'isolated');
    await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
    await store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','guest')", [conversationId]);
    await broker.cancelRequest(turn({ userId: 'guest' }), 'isolated');
    const command = broker.request(turn(), publish('isolated'));
    for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 2));
    expect(commands).toHaveLength(1); await applied(commands[0]!);
    expect(await command).toMatchObject({ status: 'applied', saved: true });
  });

  it('a late cancel never rewrites a recorded outcome', async () => {
    const command = broker.request(turn(), publish('done'));
    for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 2));
    await applied(commands.shift()!); expect(await command).toMatchObject({ status: 'applied' });
    await broker.cancelRequest(turn(), 'done');
    expect(await broker.request(turn(), publish('done'))).toMatchObject({ status: 'applied', saved: true });
    expect(commands).toEqual([]);
  });

  it('keeps no permanent cancel tombstone: an unmatched cancel expires and the set stays bounded', async () => {
    await broker.cancelRequest(turn(), 'never-sent');
    await new Promise(r => setTimeout(r, 450));
    const command = broker.request(turn(), publish('never-sent'));
    for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 2));
    expect(commands).toHaveLength(1); await applied(commands.shift()!);
    expect(await command).toMatchObject({ status: 'applied' });
    for (let n = 0; n < 2000; n++) await broker.cancelRequest(turn(), `flood_${n}`);
    expect((broker as unknown as { cancels?: Map<string, number> }).cancels?.size ?? 0).toBeLessThanOrEqual(256);
    expect(await promptly(broker.request(turn(), publish('flood_1999')))).toMatchObject({ status: 'not_executed', error: 'workbench_cancelled' });
    expect(commands).toEqual([]);
  });

  // One other user is limited to its own share. Many users together can still
  // reach the global bound and evict across users (only before broker intake).
  it('a single other user flooding cancels cannot evict a cancel that is waiting for its command', async () => {
    await broker.cancelRequest(turn(), 'awaited');
    for (let n = 0; n < 2000; n++) await broker.cancelRequest(turn({ userId: 'flooder' }), `flood_${n}`);
    notDispatched(await broker.request(turn(), publish('awaited')));
  });

  it('releases every received request record once its command settles', async () => {
    const command = broker.request(turn(), publish('released')), duplicate = broker.request(turn(), publish('released'));
    for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 2));
    await applied(commands.shift()!); await Promise.all([command, duplicate]);
    await broker.request(turn(), publish('released')).catch(() => undefined);
    expect((broker as unknown as { intakes?: Map<string, unknown> }).intakes?.size ?? 0).toBe(0);
  });

  it('closing the broker drops early cancels but never revives a cancelled in-flight request', async () => {
    await broker.cancelRequest(turn(), 'unmatched-before-close');
    const gate = deferred(); peerGate = call => call === 1 ? gate.promise : undefined;
    const command = broker.request(turn(), publish('closing'));
    for (let n = 0; n < 100 && peerCalls < 1; n++) await new Promise(r => setTimeout(r, 2));
    await broker.cancelRequest(turn(), 'closing');
    broker.close();
    expect((broker as unknown as { cancels?: Map<string, number> }).cancels?.size ?? 0).toBe(0);
    gate.release();
    const outcome = await command.then(receipt => receipt.error, (error: unknown) => (error as { code?: string }).code);
    expect(['workbench_host_stopping', 'workbench_cancelled']).toContain(outcome);
    expect(commands).toEqual([]);
    expect((broker as unknown as { intakes?: Map<string, unknown> }).intakes?.size ?? 0).toBe(0);
  });

  // Each received request holds a small cancel record until it settles. The
  // count itself is bounded (duplicates of one ID included), so requests still
  // authenticating cannot bypass the in-flight limits, and nothing outlives close.
  describe('received-request admission', () => {
    const count = () => (broker as unknown as { intakeCount?: number }).intakeCount ?? 0;
    const outcome = (promise: Promise<WorkbenchReceipt>) => promise.then(receipt => receipt.error ?? receipt.status, (error: { code?: string }) => error.code ?? String(error));

    it('caps one user’s received requests, counting duplicates of one ID, and releases them on every outcome', async () => {
      const gate = deferred(), held = turn({ validate: () => gate.promise });
      const duplicates = Array.from({ length: 40 }, () => outcome(broker.request(held, publish('same-id'))));
      for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r));
      expect(count()).toBe(32);
      gate.release();
      for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 2));
      await applied(commands.shift()!);
      const results = await Promise.all(duplicates);
      expect(results.filter(code => code === 'workbench_busy')).toHaveLength(8);
      expect(results.filter(code => code === 'applied')).toHaveLength(32);
      expect(count()).toBe(0);
    });

    it('caps received requests across users and frees every rejected one', async () => {
      const gate = deferred();
      const all = Array.from({ length: 5 }, (_, user) => Array.from({ length: 30 }, (_, n) => outcome(broker.request(turn({ userId: `stranger_${user}`, validate: () => gate.promise }), publish(`u${user}_${n}`))))).flat();
      for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r));
      expect(count()).toBe(128);
      gate.release();
      const results = await Promise.all(all);
      expect(results.filter(code => code === 'workbench_busy')).toHaveLength(22);
      expect(commands).toEqual([]);
      expect(count()).toBe(0);
    });

    it('after close nothing resumes into a dispatch or a registration', async () => {
      const gate = deferred();
      const waiting = outcome(broker.request(turn({ validate: () => gate.promise }), publish('closing-validate')));
      for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r));
      broker.close(); gate.release();
      expect(await waiting).toBe('workbench_host_stopping');
      expect(await outcome(broker.request(turn(), publish('after-close')))).toBe('workbench_host_stopping');
      await expect(broker.register(peer, registration(conversationId))).rejects.toMatchObject({ code: 'workbench_host_stopping' });
      expect(commands).toEqual([]); expect(count()).toBe(0);
    });

    it('close releases received-request records at once, even when their validation never returns', async () => {
      const gate = deferred(), held = turn({ validate: () => gate.promise });
      const waiting = Array.from({ length: 10 }, (_, n) => outcome(broker.request(held, publish(`hung_${n}`))));
      for (let n = 0; n < 5; n++) await new Promise(r => setImmediate(r));
      expect(count()).toBe(10);
      broker.close();
      expect(count()).toBe(0);
      expect((broker as unknown as { intakes?: Map<string, unknown> }).intakes?.size ?? 0).toBe(0);
      // Settling later neither dispatches nor drives the released count negative.
      gate.release();
      expect(new Set(await Promise.all(waiting))).toEqual(new Set(['workbench_host_stopping']));
      expect(count()).toBe(0); expect(commands).toEqual([]);
    });

    it('a window removed while its target is being resolved is refused cleanly, never dispatched', async () => {
      const gate = deferred(); peerGate = call => call === 1 ? gate.promise : undefined;
      const resolving = outcome(broker.request(turn(), publish('window-gone')));
      for (let n = 0; n < 100 && peerCalls < 1; n++) await new Promise(r => setTimeout(r, 2));
      broker.unregister(peer, 'window'); gate.release();
      expect(await resolving).toBe('workbench_app_unavailable');
      expect(commands).toEqual([]); expect(count()).toBe(0);
    });
  });
});

class Peer {
  frames: any[] = [];
  constructor(readonly ws: WebSocket) { const reader = nodeFrameReader(); ws.on('message', raw => { const frame = reader.read(raw.toString()); if (frame) this.frames.push(frame); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((resolve, reject) => { peer.ws.once('open', resolve); peer.ws.once('error', reject); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(predicate: (frame: any) => boolean, ms = 4000) { const end = Date.now() + ms; for (;;) { const i = this.frames.findIndex(predicate); if (i >= 0) return this.frames.splice(i, 1)[0]; if (Date.now() > end) throw new Error('timed_out'); await new Promise(r => setTimeout(r, 2)); } }
}

describe('a gateway abort sends cancel right behind its command over the real Bot socket', () => {
  let dir: string, hub: HubServer; const peers: Peer[] = []; const secret = 'cancel-race-fixture-' + 'c'.repeat(40);
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-cancel-socket-')); hub = await HubServer.start({ stateDir: dir }); await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Bot',?,'codex')", [hashSecret(secret)]); });
  afterEach(async () => { for (const p of peers.splice(0)) p.ws.terminate(); await hub.close(); await rm(dir, { recursive: true, force: true }); });

  it('the App can never admit a command whose cancel the Hub acknowledged', async () => {
    const conversationId = (await hub.store.createConversation('owner', ['bot'], 'Design', 'socket-cancel')).id;
    const keys = generateKeyPairSync('ed25519');
    const pair = await hub.auth.pair({ deviceId: 'desktop', name: 'desktop', platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
    await hub.auth.approve(pair.code, 'local-owner');
    const app = await Peer.connect(hub.url.replace(/^http/, 'ws') + '/ws'); peers.push(app);
    const nonce = randomBytes(32).toString('base64url');
    app.send({ type: 'hello', deviceId: 'desktop', nonce, protocolVersions: [1], capabilities: [WORKBENCH_CAPABILITY], cursors: {} });
    const challenge = await app.next(f => f.type === 'challenge');
    app.send({ type: 'auth', signature: sign(null, deviceProof('desktop', challenge.nonce, nonce), keys.privateKey).toString('base64') });
    const token = (await app.next(f => f.type === 'ready')).sessionToken as string; await app.next(f => f.type === 'sync.complete');
    const admit = (dispatchId: string) => fetch(hub.url + '/api/workbench/admit', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ dispatchId }) });
    const tabs = (n: number) => [{ id: `design-${n}`, kind: 'design', title: 'Design', revision: 0 }];
    const worker = await Peer.connect(hub.instanceUrl.replace(/^http/, 'ws') + '/instance'); peers.push(worker);
    worker.send({ type: 'instance.hello', botId: 'bot', secret, engine: 'codex', model: '', effort: '', capabilities: [] }); await worker.next(f => f.type === 'instance.ready');
    for (let round = 0; round < 4; round++) {
      app.send({ type: 'workbench.register', registration: { windowId: 'w', generation: 'g', conversationId, capabilities: ['design.v1'], tabs: tabs(round), activeTabId: `design-${round}`, visible: true } });
      const target = { deviceId: 'desktop', windowId: 'w', tabId: `design-${round}` };
      await new Promise(r => setTimeout(r, 50));
      app.send({ type: 'message.send', conversationId, clientMsgId: `turn-${round}`, text: 'Edit', attachments: [], workbench: { target, kind: 'design', revision: 0 } });
      await app.next(f => f.type === 'message.ack');
      const message = (await worker.next(f => f.type === 'instance.message')).message;
      const params = { conversationId, contextMessageId: message.id };
      const requestId = `abort-${round}`;
      // Exactly what GatewayChannel.workbench does on abort: the cancel follows at once.
      worker.send({ type: 'instance.request', id: `live_cmd_${round}`, method: 'workbench.command', params: { ...params, request: { requestId, operation: 'design.publish', target, expectedRevision: 0, payload: files(), contextMessageId: message.id } } });
      worker.send({ type: 'instance.request', id: `live_cancel_${round}`, method: 'workbench.cancel', params: { ...params, requestId } });
      expect((await worker.next(f => f.type === 'instance.result' && f.id === `live_cancel_${round}`)).error).toBeUndefined();
      // Any command frame that still reached the App must be refused at admission.
      await new Promise(r => setTimeout(r, 100));
      for (const frame of app.frames.filter(f => f.type === 'workbench.command')) expect((await admit(frame.dispatchId)).status).not.toBe(200);
      app.frames = app.frames.filter(f => f.type !== 'workbench.command');
      const result = await worker.next(f => f.type === 'instance.result' && f.id === `live_cmd_${round}`);
      expect(result.result).toMatchObject({ requestId, status: 'not_executed', error: 'workbench_cancelled' });
      worker.send({ type: 'instance.request', id: `live_ack_${round}`, method: 'ack', params: { messageId: message.id } });
      await worker.next(f => f.type === 'instance.result' && f.id === `live_ack_${round}`);
    }
  });
  const files = () => ({ files: { 'project/Main.dc.html': { content: '<x-dc>v</x-dc>', contentType: 'text/html' } } });
});
