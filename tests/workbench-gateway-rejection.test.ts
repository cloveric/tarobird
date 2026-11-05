import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubStore, HubError } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import type { WorkbenchCommandFrame, WorkbenchRegistration } from '../src/client-protocol/workbench.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';

// The Host rejects some Bot commands before it records or dispatches anything.
// The gateway must say so (not_executed), or a Bot reconciles an operation that
// never existed. Errors that can follow an App execution stay unknown.
describe('Host rejections before dispatch are reported as not executed', () => {
  let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, commands: WorkbenchCommandFrame[];
  const owner = (): WorkbenchActor => ({ userId: 'owner', conversationId, validate: async () => {} });
  const peerFor = (deviceId: string): WorkbenchPeer => ({ key: {}, userId: 'owner', deviceId, active: () => true, validate: async () => {}, send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } });
  const window = (windowId: string, capabilities: WorkbenchRegistration['capabilities'] = ['design.v1']): WorkbenchRegistration =>
    ({ windowId, generation: 'gen', conversationId, capabilities, tabs: [{ id: 'design-a', kind: 'design', title: 'A', revision: 0 }], activeTabId: 'design-a', visible: true });
  const read = (requestId: string, target?: object) => ({ requestId, operation: 'design.read' as const, payload: {}, ...(target ? { target } : {}) });
  const journal = (requestId: string) => store.db.get('SELECT 1 FROM meta WHERE key=?', [`workbench-command:owner:${conversationId}:${requestId}`]);
  async function rejected(request: Promise<unknown>, requestId: string) {
    const code = await request.then(() => 'resolved', (error: unknown) => error instanceof HubError ? error.code : String(error));
    expect(await journal(requestId)).toBeUndefined();
    return code;
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-gateway-rejection-'));
    store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 1000);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    conversationId = (await store.createConversation('owner', ['bot'], 'Design', 'gateway-rejection')).id; commands = [];
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it('the Host throws these codes only before recording or dispatching the command', async () => {
    const peer = peerFor('device'); await broker.register(peer, window('w'));
    expect(await rejected(broker.request(owner(), read('missing-window', { deviceId: 'device', windowId: 'gone', tabId: 'design-a' })), 'missing-window')).toBe('workbench_app_unavailable');
    expect(await rejected(broker.request(owner(), read('closed-tab', { deviceId: 'device', windowId: 'w', tabId: 'design-gone' })), 'closed-tab')).toBe('workbench_target_closed');
    expect(await rejected(broker.request(owner(), { requestId: 'no-cap', operation: 'markdown.create', payload: { title: 'Note' } }), 'no-cap')).toBe('workbench_capability_unsupported');
    await broker.register(peerFor('laptop'), window('w2'));
    expect(await rejected(broker.request(owner(), { requestId: 'two-windows', operation: 'design.create', payload: {} }), 'two-windows')).toBe('workbench_target_ambiguous');
    expect(commands).toEqual([]);
    // Eight held commands fill this user's slots; the ninth is refused unrecorded.
    const held = Array.from({ length: 8 }, (_, n) => broker.request(owner(), read(`held-${n}`, { deviceId: 'device', windowId: 'w', tabId: 'design-a' })));
    for (let n = 0; n < 100 && commands.length < 8; n++) await new Promise(r => setTimeout(r, 2));
    expect(commands).toHaveLength(8);
    expect(await rejected(broker.request(owner(), read('ninth', { deviceId: 'device', windowId: 'w', tabId: 'design-a' })), 'ninth')).toBe('workbench_busy');
    expect(commands).toHaveLength(8);
    broker.close(); await Promise.allSettled(held);
  });

  describe('through the app_workbench tool', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'workbench-gateway-tool-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
    const designRead = { requestId: 'design_read_1', operation: 'design.read', target: { deviceId: 'device', windowId: 'w', tabId: 'design-a' }, payload: {} };
    const designPublish = { requestId: 'design_edit_1', operation: 'design.publish', target: { deviceId: 'device', windowId: 'w', tabId: 'design-a' }, expectedRevision: 0, payload: { files: { 'project/Main.dc.html': { content: '<x-dc>Design</x-dc>', contentType: 'text/html' } } } };
    async function report(code: string, args: object = designRead) {
      const workbench = vi.fn().mockRejectedValue(new Error(code)); const signal = new AbortController();
      const tools = createAppPlatformTools({ channel: { sendArtifact: vi.fn(), sendArtifactBatch: vi.fn(), workbench }, stateDir: dir, conversationId: 'conv', requestOutputDir: path.join(dir, 'out'), workspaceOverride: dir, receipts: new GatewayReceipts(dir), signal: signal.signal } as never);
      const response = await tools.call({ name: 'app_workbench', arguments: args, callId: 'call', sessionId: 'session', abortSignal: signal.signal } as never);
      expect(workbench).toHaveBeenCalledOnce(); expect(response.isError).toBe(true);
      return JSON.parse(response.text) as { status: string; error: string; hint: string };
    }

    it.each(['workbench_busy', 'workbench_target_closed', 'workbench_app_unavailable', 'workbench_target_ambiguous', 'workbench_capability_unsupported'])('%s is not executed and is not sent to reconciliation', async code => {
      const receipt = await report(code);
      expect(receipt).toMatchObject({ requestId: 'design_read_1', status: 'not_executed', error: code });
      expect(receipt.hint).not.toContain('Reconcile');
      expect(receipt.hint).toContain('Nothing was dispatched');
      // A busy Host is retried later with the same ID; target problems are never
      // solved by switching to another target automatically.
      // Busy may be this user's slots or the Host-wide command limits: never attributed to one user.
      if (code === 'workbench_busy') { expect(receipt.hint).toContain('same requestId'); expect(receipt.hint).not.toMatch(/this user|your App/i); }
      else expect(receipt.hint).toContain('Never switch');
    });

    it.each(['connection_closed', 'gateway_disconnected', 'workbench_outcome_unknown', 'workbench_turn_ended', 'workbench_bot_disconnected', 'request_id_conflict'])('%s may follow an App execution or an earlier same-ID operation and stays unknown', async code => {
      const receipt = await report(code, designPublish);
      expect(receipt).toMatchObject({ requestId: 'design_edit_1', status: 'unknown', error: code });
      expect(receipt.hint).toContain('Do not replay with a new requestId. Reconcile');
    });

    // A durable read receipt keeps only a summary: replaying the same ID cannot
    // return content. Reads have no side effects, so fresh content needs a new
    // ID. A write with an unknown outcome is never retried under a new ID.
    it.each([
      ['design.read', designRead],
      ['markdown.read', { requestId: 'note_read_1', operation: 'markdown.read', target: { deviceId: 'device', windowId: 'w', tabId: 'note' } }],
      ['whiteboard.read', { requestId: 'board_read_1', operation: 'whiteboard.read' }],
      ['tabs.list', { requestId: 'tabs_1', operation: 'tabs.list' }],
    ])('an uncertain %s stays unknown but is re-read under a new requestId', async (_operation, args) => {
      for (const code of ['connection_closed', 'workbench_outcome_unknown', 'workbench_bot_disconnected']) {
        const receipt = await report(code, args);
        expect(receipt).toMatchObject({ status: 'unknown', error: code });
        expect(receipt.hint).toContain('new requestId');
        expect(receipt.hint).not.toContain('Do not replay');
        expect(receipt.hint).toContain('not mean the content is empty');
        // Still bound to this turn's authorization and the same exact target.
        expect(receipt.hint).toContain('in this same turn'); expect(receipt.hint).toContain('same exact target'); expect(receipt.hint).toContain('never another');
      }
    });

    it.each([
      ['design.publish', designPublish],
      ['design.create', { requestId: 'design_create_1', operation: 'design.create', target: { deviceId: 'device', windowId: 'w' }, payload: { title: 'Design' } }],
      ['whiteboard.create', { requestId: 'board_create_1', operation: 'whiteboard.create' }],
      // Browser actions are never treated as reads, even capture-like ones.
      ['browser screenshot', { requestId: 'browser_shot_1', operation: 'browser', payload: { action: 'screenshot' } }],
      ['browser navigate', { requestId: 'browser_nav_1', operation: 'browser', payload: { action: 'navigate', url: 'https://example.org/' } }],
    ])('an uncertain %s keeps its requestId and is reconciled, never re-sent under a new ID', async (_operation, args) => {
      const receipt = await report('connection_closed', args);
      expect(receipt).toMatchObject({ status: 'unknown', error: 'connection_closed' });
      expect(receipt.hint).toBe('Do not replay with a new requestId. Reconcile the existing operation.');
    });
  });
});
