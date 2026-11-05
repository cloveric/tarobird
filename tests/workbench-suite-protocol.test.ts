import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { HubServer } from '../src/hub/server.js';
import { deviceProof, hashSecret } from '../src/hub/auth.js';
import { nodeFrameReader } from '../src/client-protocol/fragments-node.js';
import { WORKBENCH_CAPABILITY, type WorkbenchRegistration } from '../src/client-protocol/workbench.js';
import { GatewayChannel } from '../src/gateway/channel.js';
import { GatewayTransport } from '../src/gateway/transport.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { runWorkbenchCommand } from '../src/host-cli/workbench.js';
import { LocalHostClient } from '../src/host-cli/client.js';
import * as hubService from '../src/hub/service.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY } from '../src/client-protocol/workbench-design.js';

// Real signed App socket, Host authorization and Gateway transport/tool. The
// renderer here is a wire peer: these tests do not claim editor/IDB acceptance.
class Peer {
  frames: any[] = [];
  constructor(readonly ws: WebSocket) { const reader = nodeFrameReader(); ws.on('message', raw => { const frame = reader.read(raw.toString()); if (frame) this.frames.push(frame); }); }
  static async connect(url: string) { const peer = new Peer(new WebSocket(url)); await new Promise<void>((resolve, reject) => { peer.ws.once('open', resolve); peer.ws.once('error', reject); }); return peer; }
  send(frame: object) { this.ws.send(JSON.stringify({ v: 1, ...frame })); }
  async next(type: string) { return until(() => { const i = this.frames.findIndex(f => f.type === type); return i < 0 ? undefined : this.frames.splice(i, 1)[0]; }); }
}
async function until<T>(fn: () => T | undefined | Promise<T | undefined>) { const deadline = Date.now() + 5000; for (;;) { const value = await fn(); if (value !== undefined) return value; if (Date.now() > deadline) throw Error('timed_out'); await new Promise(r => setTimeout(r, 5)); } }

describe('Baoyu suite authenticated protocol boundary', () => {
  let directory: string, hub: HubServer, conversationId: string, peer: Peer, token: string;
  const peers: Peer[] = [], channels: GatewayChannel[] = [], secret = 'suite-fixture-' + 'a'.repeat(40);
  const target = { deviceId: 'desktop', windowId: 'suite-window', tabId: 'design-a' };
  const full: WorkbenchRegistration['capabilities'] = ['design.v1', 'design.slides.v1', 'design.comments.v1', 'design.history.v1'];
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-suite-protocol-'));
    hub = await HubServer.start({ stateDir: directory });
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Trusted Bot',?,'codex')", [hashSecret(secret)]);
    conversationId = (await hub.store.createConversation('owner', ['bot'], 'Suite', 'create-suite')).id;
    ({ peer, token } = await client('desktop'));
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const channel of channels.splice(0)) await channel.disconnect(); for (const peer of peers.splice(0)) peer.ws.terminate(); await hub.close(); await rm(directory, { recursive: true, force: true }); });
  async function client(deviceId: string) {
    const keys = generateKeyPairSync('ed25519'), pair = await hub.auth.pair({ deviceId, name: deviceId, platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
    await hub.auth.approve(pair.code, 'local-owner'); const peer = await Peer.connect(hub.url.replace(/^http/, 'ws') + '/ws'); peers.push(peer);
    const nonce = randomBytes(32).toString('base64url'); peer.send({ type: 'hello', deviceId, nonce, protocolVersions: [1], capabilities: [WORKBENCH_CAPABILITY], cursors: {} });
    const challenge = await peer.next('challenge'); peer.send({ type: 'auth', signature: sign(null, deviceProof(deviceId, challenge.nonce, nonce), keys.privateKey).toString('base64') });
    const ready = await peer.next('ready'); await peer.next('sync.complete'); return { peer, token: ready.sessionToken as string, capabilities: ready.serverCapabilities as string[] };
  }
  const api = (route: string, body?: unknown, bearer = token) => fetch(hub.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const command = (request: object, conv = conversationId, bearer = token) => api(`/api/conversations/${conv}/workbench/commands`, request, bearer);
  async function register(capabilities = full, conv = conversationId, windowId = target.windowId) {
    peer.send({ type: 'workbench.register', registration: { windowId, generation: 'suite-generation', conversationId: conv, capabilities, tabs: [{ id: target.tabId, kind: 'design', title: 'Design A', revision: 3 }, { id: 'design-b', kind: 'design', title: 'Design B', revision: 3 }], activeTabId: 'design-b', visible: true } });
    await until(async () => { const list = await (await api(`/api/conversations/${conv}/workbench/targets`)).json(); return list.some((item: any) => item.windowId === windowId && JSON.stringify(item.capabilities) === JSON.stringify(capabilities)) || undefined; });
  }
  async function accept(frame: any, applied: boolean, revision = 3) {
    expect((await api('/api/workbench/admit', { dispatchId: frame.dispatchId })).status).toBe(200);
    peer.send({ type: 'workbench.receipt', dispatchId: frame.dispatchId, receipt: { requestId: frame.request.requestId, target: frame.target, status: applied ? 'applied' : 'success', revision, ...(applied ? { saved: true } : { result: {} }) } });
  }

  it.each(['deepseek', 'codex', 'claude', 'kimi', 'antigravity'])('%s negotiates canvas/PPT/comments/history and stamps the authenticated Bot actor', async engine => {
    await register();
    const app = await client('cap-check');
    expect(app.capabilities).toEqual(expect.arrayContaining([WORKBENCH_DESIGN_COMMENTS_CAPABILITY, WORKBENCH_DESIGN_HISTORY_CAPABILITY]));
    expect(app.capabilities).not.toContain('workbench.design.suite.v1');
    const stateDir = path.join(directory, engine), transport = new GatewayTransport({ url: hub.instanceUrl.replace(/^http/, 'ws') + '/instance', botId: 'bot', secret, stateDir, engine });
    const channel = new GatewayChannel(transport); channels.push(channel);
    const responses: any[] = [], failures: unknown[] = [], requests = [
      { requestId: 'comments-read', operation: 'design.comments.read', target, payload: { status: 'all', offset: 20, limit: 20 } },
      { requestId: 'comments-page', operation: 'design.comments.read', target, payload: { threadId: 'c_0123456789', messageOffset: 50, messageLimit: 50 } },
      { requestId: 'comments-reply', operation: 'design.comments.reply', target, payload: { threadId: 'c_0123456789', text: 'Checked' } },
      { requestId: 'comments-resolve', operation: 'design.comments.resolve', target, payload: { threadId: 'c_0123456789', status: 'resolved' } },
      { requestId: 'history-list', operation: 'design.history.list', target, payload: { limit: 5 } },
      { requestId: 'history-diff', operation: 'design.history.diff', target, payload: { version: 1, path: 'project/Main.dc.html' } },
      { requestId: 'history-restore', operation: 'design.restore', target, expectedRevision: 3, payload: { version: 1 } },
      { requestId: 'canvas-create', operation: 'design.create', target: { deviceId: target.deviceId, windowId: target.windowId }, payload: { format: 'canvas', title: 'Canvas' } },
      { requestId: 'slides-create', operation: 'design.create', target: { deviceId: target.deviceId, windowId: target.windowId }, payload: { format: 'slides', title: 'PPT' } },
    ];
    channel.on('error', error => failures.push(error));
    channel.on('message', async () => { try {
      const signal = new AbortController().signal, tools = createAppPlatformTools({ channel, stateDir, conversationId, receipts: new GatewayReceipts(stateDir), signal });
      for (const request of requests) { const response = await tools.call({ name: 'app_workbench', arguments: request, callId: request.requestId, sessionId: 'suite-session', abortSignal: signal }); responses.push(JSON.parse(response.text)); if (response.isError) break; }
    } catch (error) { failures.push(error); } });
    await channel.connect(); await until(() => transport.capabilities.includes(WORKBENCH_DESIGN_HISTORY_CAPABILITY) || undefined);
    peer.send({ type: 'message.send', conversationId, clientMsgId: 'suite-native-turn', text: 'Review this Baoyu design', attachments: [], workbench: { target, kind: 'design', revision: 3 } });
    const sourceMessageId = (await peer.next('message.ack')).messageId;
    for (const request of requests) {
      await until(() => peer.frames.some(frame => frame.type === 'workbench.command') || responses.some(response => response.error) || failures.length > 0 || undefined);
      expect(failures).toEqual([]); expect(responses.find(response => response.error)).toBeUndefined();
      const frame = await peer.next('workbench.command');
      expect(frame).toMatchObject({ actor: { kind: 'bot', id: 'bot', name: 'Trusted Bot' }, conversationId, target: request.target, request: { ...request, contextMessageId: sourceMessageId } });
      await accept(frame, ['design.comments.reply', 'design.comments.resolve', 'design.restore', 'design.create'].includes(request.operation));
    }
    await until(() => responses.length === requests.length || failures.length > 0 || undefined);
    expect(failures).toEqual([]); expect(responses.every(response => ['success', 'applied'].includes(response.status))).toBe(true);
  });

  it('comments-only targets still receive Host-stamped authors without history capability', async () => {
    await register(['design.v1', 'design.comments.v1']);
    const worker = await Peer.connect(hub.instanceUrl.replace(/^http/, 'ws') + '/instance'); peers.push(worker);
    worker.send({ type: 'instance.hello', botId: 'bot', secret, engine: 'claude', model: '', effort: '', capabilities: [] }); await worker.next('instance.ready');
    peer.send({ type: 'message.send', conversationId, clientMsgId: 'comments-only-turn', text: 'Reply to this comment', attachments: [], workbench: { target, kind: 'design', revision: 3 } });
    const sourceMessageId = (await peer.next('message.ack')).messageId; await worker.next('instance.message');
    const pending = fetch(hub.instanceUrl + '/api/instance/workbench', { method: 'POST', headers: { Authorization: `Instance bot:${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'workbench.command', params: { conversationId, contextMessageId: sourceMessageId, request: { requestId: 'comments-only-reply', operation: 'design.comments.reply', target, payload: { threadId: 'c_0123456789', text: 'Reply' } } } }) });
    const frame = await peer.next('workbench.command'); expect(frame.actor).toEqual({ kind: 'bot', id: 'bot', name: 'Trusted Bot' });
    await accept(frame, true); expect(await (await pending).json()).toMatchObject({ status: 'applied', saved: true });
  });

  it('headless Bot CLI preserves source, target and receipt through the actual authenticated Host API', async () => {
    await register();
    const worker = await Peer.connect(hub.instanceUrl.replace(/^http/, 'ws') + '/instance'); peers.push(worker);
    worker.send({ type: 'instance.hello', botId: 'bot', secret, engine: 'deepseek', model: '', effort: '', capabilities: [] }); await worker.next('instance.ready');
    peer.send({ type: 'message.send', conversationId, clientMsgId: 'cli-source', text: 'Reply and restore', attachments: [], workbench: { target, kind: 'design', revision: 3 } });
    const sourceMessageId = (await peer.next('message.ack')).messageId; await worker.next('instance.message');
    const state = path.join(directory, 'bots', 'bot'); await mkdir(state, { recursive: true }); await writeFile(path.join(state, 'gateway.key'), secret, { mode: 0o600 });
    vi.stubEnv('TAROBOT_ACTIVE_INSTANCE', 'bot'); vi.stubEnv('TAROBOT_ACTIVE_STATE_DIR', state); vi.stubEnv('TAROBOT_MESSAGE_ID', sourceMessageId);
    // Discovery only is a fixture; request parsing, credentials and both APIs are real.
    vi.spyOn(hubService, 'inspectHubService').mockResolvedValue({ running: true, instanceUrl: hub.instanceUrl } as any);
    const ownerConnect = vi.spyOn(LocalHostClient, 'connect');
    for (const [operation, payload] of [['design.comments.reply', { threadId: 'c_0123456789', text: 'CLI reply' }], ['design.restore', { version: 1 }]] as const) {
      const file = path.join(directory, 'cli-request.json'), requestId = operation.replaceAll('.', '-');
      await writeFile(file, JSON.stringify({ operation, target, expectedRevision: 3, payload }));
      const pending = runWorkbenchCommand(directory, 'run', conversationId, { from: file, requestId });
      const frame = await peer.next('workbench.command');
      expect(frame).toMatchObject({ actor: { kind: 'bot', id: 'bot', name: 'Trusted Bot' }, target, request: { operation, contextMessageId: sourceMessageId, expectedRevision: 3 } });
      await accept(frame, true, 4); expect(await pending).toMatchObject({ status: 'applied', saved: true, revision: 4 });
    }
    expect(ownerConnect).not.toHaveBeenCalled();
    await hub.store.acknowledgeDelivery('bot', sourceMessageId);
    await expect(runWorkbenchCommand(directory, 'run', conversationId, { from: path.join(directory, 'cli-request.json'), requestId: 'expired' })).rejects.toThrow('workbench_turn_ended');
  });

  it('rejects old target capabilities and does not silently redirect to a newer window', async () => {
    await register(['design.v1']);
    for (const [operation, payload] of [['design.comments.read', {}], ['design.history.list', {}], ['design.restore', { version: 1 }]] as const) {
      const response = await command({ requestId: operation.replaceAll('.', '-'), operation, target, expectedRevision: 3, payload });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'workbench_app_unavailable' });
    }
    await register(full, conversationId, 'new-window');
    expect((await command({ requestId: 'old-slides', operation: 'design.create', target: { deviceId: target.deviceId, windowId: target.windowId }, payload: { format: 'slides' } })).status).toBe(409);
    expect(peer.frames.filter(frame => frame.type === 'workbench.command')).toEqual([]);
  });

  it('refuses removed editor formats before dispatch through valid content and opener targets', async () => {
    await register();
    peer.send({ type: 'workbench.register', registration: { windowId: 'removed-opener', generation: 'opener-gen', conversationId, capabilities: ['design.open.v1', 'design.slides.v1'], tabs: [], visible: true } });
    await until(async () => (await (await api(`/api/conversations/${conversationId}/workbench/targets`)).json()).some((item: any) => item.windowId === 'removed-opener') || undefined);
    for (const format of ['motion', 'dashboard', 'design-system']) for (const operation of ['design.create', 'design.open']) {
      const response = await command({ requestId: `${operation.replaceAll('.', '-')}-${format}`, operation, target: { deviceId: target.deviceId, windowId: operation === 'design.open' ? 'removed-opener' : target.windowId }, payload: { format } });
      expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ status: 'not_executed', error: 'invalid_design_payload' });
    }
    expect(peer.frames.filter(frame => frame.type === 'workbench.command')).toEqual([]);
  });

  it('rejects missing restore revision, forged actor and cross-conversation targets before dispatch', async () => {
    await register();
    const restore = { requestId: 'restore', operation: 'design.restore', target, payload: { version: 1 } };
    expect(await (await command(restore)).json()).toMatchObject({ error: 'workbench_revision_required' });
    expect((await command({ ...restore, requestId: 'spoof', expectedRevision: 3, actor: { kind: 'bot', id: 'someone', name: 'False' } })).status).toBe(400);
    expect((await command({ ...restore, requestId: 'unauth', expectedRevision: 3 }, conversationId, 'invalid')).status).toBe(401);
    const other = (await hub.store.createConversation('owner', ['bot'], 'Other', 'other')).id;
    for (const operation of ['design.comments.read', 'design.comments.resolve', 'design.history.list', 'design.restore']) {
      const payload = operation === 'design.comments.resolve' ? { threadId: 'c_0123456789', status: 'resolved' } : operation === 'design.restore' ? { version: 1 } : {};
      expect(await (await command({ requestId: operation.replaceAll('.', '-'), operation, target, expectedRevision: 3, payload }, other)).json()).toMatchObject({ error: 'workbench_app_unavailable' });
    }
    expect(peer.frames.filter(frame => frame.type === 'workbench.command')).toEqual([]);
  });

  it.each(['design.restore', 'design.comments.reply', 'design.comments.resolve'])('%s requires applied + saved, never a plain success receipt', async operation => {
    await register();
    const payload = operation === 'design.restore' ? { version: 1 } : operation === 'design.comments.reply' ? { threadId: 'c_0123456789', text: 'Reply' } : { threadId: 'c_0123456789', status: 'resolved' };
    const pending = command({ requestId: 'write-receipt', operation, target, expectedRevision: 3, payload });
    const frame = await peer.next('workbench.command');
    expect((await api('/api/workbench/admit', { dispatchId: frame.dispatchId })).status).toBe(200);
    peer.send({ type: 'workbench.receipt', dispatchId: frame.dispatchId, receipt: { requestId: 'write-receipt', target, status: 'success', revision: 3 } });
    const result = await Promise.race([peer.next('error').then(error => ({ kind: 'error', code: error.code })), pending.then(async response => ({ kind: 'accepted', code: (await response.clone().json()).status }))]);
    expect(result).toEqual({ kind: 'error', code: 'workbench_saved_receipt_required' });
    peer.send({ type: 'workbench.receipt', dispatchId: frame.dispatchId, receipt: { requestId: 'write-receipt', target, status: 'applied', saved: true, revision: 4 } });
    expect(await (await pending).json()).toMatchObject({ status: 'applied', saved: true });
  });
});
