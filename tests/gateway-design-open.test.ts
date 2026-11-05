import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayChannel } from '../src/gateway/channel.js';
import type { GatewayTransport } from '../src/gateway/transport.js';
import { GatewayReceipts } from '../src/gateway/receipts.js';
import { createAppPlatformTools } from '../src/gateway/app-tools.js';
import { appCapabilityInstructions } from '../src/gateway/agent-instructions.js';
import { runWorkbenchCommand } from '../src/host-cli/workbench.js';
import { LocalHostClient } from '../src/host-cli/client.js';
import { WORKBENCH_CAPABILITY, type WorkbenchContext } from '../src/client-protocol/workbench.js';
import { WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY, WORKBENCH_SLIDES_CAPABILITY } from '../src/client-protocol/workbench-design.js';
import type { Conversation, Message } from '../src/client-protocol/index.js';

// Digests persisted by native threads created before design.open (4ce0b44).
const V9_DIGEST = '2f6a629786d23f3cc084b41679b97e23057c8a4f2e08f32b507cc3d258e6fd77';
const V9_MINIMAL_DIGEST = 'd23f4ae1d0b0f027eacfedd43c5cee00e9de8d9289f21281392e128aebf3450a';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workbenchEnum = (definitions: Array<{ name: string; inputSchema: Record<string, any> }>) => definitions.find(tool => tool.name === 'app_workbench')!.inputSchema.properties.operation.enum as string[];

describe('Gateway design.open contract', () => {
  let stateDir: string;
  const opener = { deviceId: 'desktop', windowId: 'opener' }, real = { deviceId: 'desktop', windowId: 'controller', tabId: 'design-a' };
  const conversation: Conversation = { id: 'conv', type: 'direct', title: 'Design', ownerId: 'owner', botIds: ['bot'], archived: false, createdAt: 1 };
  const message = (id: string): Message => ({ id, conversationId: 'conv', authorId: 'owner', authorType: 'user', blocks: [{ type: 'text', text: 'Use Design for the landing page' }], status: 'complete', version: 1, createdAt: 1 });
  const tools = (options?: { widgetsEnabled?: boolean }, channel: Parameters<typeof createAppPlatformTools>[0]['channel'] = { sendArtifact: async () => ({}) as never, sendArtifactBatch: async () => ({}) as never }) =>
    createAppPlatformTools({ channel, stateDir, conversationId: 'conv', receipts: new GatewayReceipts(stateDir), signal: new AbortController().signal, ...(options ? { options } : {}) });
  beforeEach(async () => { stateDir = await mkdtemp(path.join(os.tmpdir(), 'gateway-design-open-')); });
  afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

  it('keeps persisted v9/v10 contracts byte-identical and advertises Baoyu formats in v11', async () => {
    for (const [id, digest] of [['v9-thread', V9_DIGEST], ['v9-minimal-thread', V9_MINIMAL_DIGEST]] as const) {
      await mkdir(path.join(stateDir, 'app-tool-threads'), { recursive: true });
      await writeFile(path.join(stateDir, 'app-tool-threads', `${hash(id)}.json`), JSON.stringify({ toolVersion: digest }));
      const resumed = await tools().forSession!(id);
      expect(hash(JSON.stringify(resumed!.definitions))).toBe(digest);
      expect(workbenchEnum(resumed!.definitions)).not.toContain('design.open');
      expect(await tools().isRegistered!(id)).toBe(true);
    }
    for (const [id,digest] of [['v10-thread','fb3ffe57efb26ae5c4c04037d981424a21dc2fafe9c95bdde653d55b57749a33'],['v10-minimal-thread','2387a2bb776955e85aa3f302fbf4519d9f095506f44f1ab62e654b0eed560381']] as const) {
      await writeFile(path.join(stateDir,'app-tool-threads',`${hash(id)}.json`),JSON.stringify({toolVersion:digest}));
      const resumed=await tools().forSession!(id);
      expect(hash(JSON.stringify(resumed!.definitions))).toBe(digest);
      expect(workbenchEnum(resumed!.definitions)).toContain('design.open');
      expect(JSON.stringify(resumed!.definitions)).not.toContain('Baoyu PPT');
      expect(await tools().isRegistered!(id)).toBe(true);
    }
    for (const enabled of [true, false]) {
      const fresh = tools({ widgetsEnabled: enabled });
      expect(workbenchEnum(fresh.definitions)).toContain('design.open');
      const digest = hash(JSON.stringify(fresh.definitions));
      expect([V9_DIGEST, V9_MINIMAL_DIGEST]).not.toContain(digest);
      await fresh.register!(`v11-${enabled}`);
      expect(hash(JSON.stringify((await tools().forSession!(`v11-${enabled}`))!.definitions))).toBe(digest);
    }
  });

  it('the owner CLI needs a Host with design.open and an explicit opener target before contacting it', async () => {
    for (const name of ['TAROBOT_INSTANCE', 'TAROBOT_ACTIVE_INSTANCE', 'TAROBOT_MESSAGE_ID', 'TAROBOT_STATE_DIR', 'TAROBOT_ACTIVE_STATE_DIR']) vi.stubEnv(name, '');
    try {
      const file = path.join(stateDir, 'open.json'), request = vi.fn().mockResolvedValue({ requestId: 'owner-open', status: 'applied', saved: true, target: opener, revision: 1, result: { target: real, created: false } });
      const connect = (caps: string[]) => vi.spyOn(LocalHostClient, 'connect').mockResolvedValue({ request, close: vi.fn(), supports: (capability: string) => caps.includes(capability) } as never);
      await writeFile(file, JSON.stringify({ operation: 'design.open', target: opener, payload: {} }));
      connect([WORKBENCH_DESIGN_CAPABILITY]);
      await expect(runWorkbenchCommand(stateDir, 'run', 'conv', { from: file, requestId: 'owner-open' })).rejects.toThrow('workbench_design_open_host_update_required');
      connect([WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY]);
      await writeFile(file, JSON.stringify({ operation: 'design.open', payload: {} }));
      await expect(runWorkbenchCommand(stateDir, 'run', 'conv', { from: file, requestId: 'owner-open' })).rejects.toThrow('workbench_open_target_required');
      expect(request).not.toHaveBeenCalled();
      await writeFile(file, JSON.stringify({ operation: 'design.open', target: opener, payload: {} }));
      expect(await runWorkbenchCommand(stateDir, 'run', 'conv', { from: file, requestId: 'owner-open' })).toMatchObject({ status: 'applied', result: { target: real } });
      expect(request).toHaveBeenCalledWith('/api/conversations/conv/workbench/commands', 'POST', { requestId: 'owner-open', operation: 'design.open', target: opener, payload: {} });
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  });

  it('guidance requires an explicit Design request and the returned real target', () => {
    const guide = appCapabilityInstructions('widgets', { widgetsEnabled: true });
    expect(guide).toContain("operation:'design.open'");
    expect(guide).toContain("ordinary requests to make PPT, presentations, graphics or designs do not select Baoyu");
    expect(guide).toContain("format:'slides'");
    expect(guide).toMatch(/not a mention, discussion, comparison or question/);
    expect(guide).toMatch(/Use result\.target for later design\.read\/design\.publish/);
    expect(guide).toMatch(/never open another device or window/);
    expect(guide).toMatch(/latest ADOPTED user input/);
    expect(guide).toMatch(/once per explicit adopted user request/i);
    expect(guide).not.toMatch(/Do not call design\.open again in the same turn/);
    expect(appCapabilityInstructions('browser')).toContain('workbench_design_open_host_update_required');
  });

  describe('channel admission', () => {
    let channels: GatewayChannel[] = [];
    afterEach(async () => { for (const channel of channels.splice(0)) await expect.poll(() => (channel as any).tasks.size).toBe(0); });
    function gateway(capabilities: string[], live: (method: string, params: any) => Promise<unknown>) {
      const calls: Array<{ method: string; params: any }> = [];
      const transport = { capabilities, options: { stateDir }, request: async () => null, deliverySettled() {}, refreshStatus: async () => {}, reconnectAfterDeliveryFailure() {}, isBusy: () => false,
        requestLive: async (method: string, params: any) => { calls.push({ method, params }); return live(method, params); } } as unknown as GatewayTransport & { onMessage: (...args: unknown[]) => Promise<void> };
      const channel = new GatewayChannel(transport); channels.push(channel);
      return { channel, transport, calls };
    }
    async function openInTurn(g: ReturnType<typeof gateway>, id: string, workbench?: WorkbenchContext, format?: "slides") {
      const outcome = new Promise<any>((resolve, reject) => g.channel.on('message', async () => {
        try {
          const turnTools = tools(undefined, g.channel);
          const result = await turnTools.call({ name: 'app_workbench', arguments: { requestId: `open-${id}`, operation: 'design.open', payload: format ? {format} : {} }, callId: id, sessionId: 'session', abortSignal: new AbortController().signal });
          resolve({ ...JSON.parse(result.text), isError: !!result.isError });
        } catch (error) { reject(error); }
      }));
      await g.transport.onMessage(message(`msg_${id}`), conversation, undefined, undefined, workbench);
      return outcome;
    }
    const all = [WORKBENCH_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY, WORKBENCH_DESIGN_OPEN_CAPABILITY];
    const appliedReceipt = async (_method: string, params: any) => ({ requestId: params.request.requestId, target: opener, status: 'applied', saved: true, revision: 1, result: { target: real, created: false } });

    it('an older Host dispatches nothing; opener resolution is left to the Host', async () => {
      const oldHost = gateway([WORKBENCH_CAPABILITY, WORKBENCH_DESIGN_CAPABILITY], appliedReceipt);
      expect(await openInTurn(oldHost, 'old-host', { target: opener, openTarget: opener })).toMatchObject({ status: 'not_executed', error: 'workbench_design_open_host_update_required', isError: true });
      expect(oldHost.calls).toEqual([]);
      // A later adopted input may carry the opener, so the Gateway never decides from its own frozen context.
      const noOpener = gateway(all, async () => { throw new Error('workbench_open_target_required'); });
      expect(await openInTurn(noOpener, 'no-context')).toMatchObject({ status: 'not_executed', error: 'workbench_open_target_required' });
      expect(noOpener.calls).toHaveLength(1);
    });

    it('requires the slides capability before dispatching a Baoyu PPT open', async () => {
      const old = gateway(all, appliedReceipt);
      expect(await openInTurn(old, 'old-slides', {target:opener,openTarget:opener}, 'slides')).toMatchObject({status:'not_executed',error:'workbench_slides_host_update_required'});
      expect(old.calls).toHaveLength(0);
      const current = gateway([...all,WORKBENCH_SLIDES_CAPABILITY],appliedReceipt);
      expect(await openInTurn(current,'new-slides',{target:opener,openTarget:opener},'slides')).toMatchObject({status:'applied',saved:true});
      expect(current.calls[0].params.request.payload).toEqual({format:'slides'});
    });

    it('sends the turn-bound request and returns the real target receipt', async () => {
      const g = gateway(all, appliedReceipt);
      expect(await openInTurn(g, 'ok', { target: opener, openTarget: opener })).toMatchObject({ status: 'applied', saved: true, target: opener, result: { target: real, created: false }, isError: false });
      expect(g.calls).toEqual([{ method: 'workbench.command', params: { conversationId: 'conv', contextMessageId: 'msg_ok', request: { requestId: 'open-ok', operation: 'design.open', payload: {}, contextMessageId: 'msg_ok' } } }]);
    });

    it('reports Host opener rejections as not executed, never to be retried elsewhere', async () => {
      const pending = await openInTurn(gateway(all, async () => { throw new Error('workbench_input_pending'); }), 'pending', { target: opener, openTarget: opener });
      expect(pending).toMatchObject({ status: 'not_executed', error: 'workbench_input_pending' });
      expect(pending.hint).toMatch(/same requestId/);
      for (const code of ['workbench_open_target_unavailable', 'workbench_open_target_mismatch', 'workbench_open_target_required']) {
        const g = gateway(all, async () => { throw new Error(code); });
        const outcome = await openInTurn(g, code, { target: opener, openTarget: opener });
        expect(outcome).toMatchObject({ status: 'not_executed', error: code, isError: true });
        expect(outcome.hint).toMatch(/Never open another device or window/);
      }
      // After dispatch, an unknown App outcome stays unknown.
      const g = gateway(all, async () => { throw new Error('bot_offline'); });
      expect(await openInTurn(g, 'offline', { target: opener, openTarget: opener })).toMatchObject({ status: 'unknown', error: 'bot_offline' });
    });
  });
});
