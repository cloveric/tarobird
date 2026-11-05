import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore, HubError } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import { workbenchRegistrationSchema, workbenchRequestShapeError, type WorkbenchCommandFrame, type WorkbenchContext, type WorkbenchRegistration } from '../src/client-protocol/workbench.js';

// design.open may only open the Workbench of the App chat that sent the turn.
// It never picks another device, window, conversation or user, and its result
// names the real controller tab the App registered before replying.
describe('design.open reaches only the frozen opener of the sending App', () => {
  let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, otherConversationId: string;
  let commands: WorkbenchCommandFrame[], cancels: string[], peer: WorkbenchPeer, turn: { ended?: boolean };
  const opener = { deviceId: 'device', windowId: 'opener' };
  const real = { deviceId: 'device', windowId: 'controller', tabId: 'design-a' };
  const peerFor = (deviceId: string, userId = 'owner'): WorkbenchPeer => ({ key: {}, userId, deviceId, active: () => true, validate: async () => {},
    send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); else cancels.push(frame.reason); } });
  const openerWindow = (conversation = conversationId, windowId = 'opener', visible = true): WorkbenchRegistration =>
    ({ windowId, generation: 'opener-gen', conversationId: conversation, capabilities: ['design.open.v1'], tabs: [], visible });
  const controller = (tabs: WorkbenchRegistration['tabs'] = [{ id: 'design-a', kind: 'design', title: 'A', revision: 3 }], visible = true): WorkbenchRegistration =>
    ({ windowId: 'controller', generation: 'controller-gen', conversationId, capabilities: ['whiteboard.v1', 'design.v1'], tabs, ...(tabs.length ? { activeTabId: tabs[0]!.id } : {}), visible });
  const closedPanel: WorkbenchContext = { target: opener, openTarget: opener };
  const bot = (context: WorkbenchContext | null = closedPanel, sourceMessageId = 'msg_source'): WorkbenchActor =>
    ({ sourceMessageId, userId: 'owner', conversationId, ...(context ? { context } : {}), validate: async () => { if (turn.ended) throw new HubError('workbench_turn_ended', 409); } });
  const open = (requestId: string, target?: object) => ({ requestId, operation: 'design.open' as const, payload: {}, ...(target ? { target } : {}) });
  const applied = (frame: WorkbenchCommandFrame, result: unknown = { target: real, created: false }) =>
    ({ requestId: frame.request.requestId, target: frame.target, status: 'applied' as const, saved: true, revision: 3, result: result as never });
  const journal = (requestId: string) => store.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', [`workbench-command:owner:${conversationId}:${requestId}`]);
  async function dispatched() { for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 5)); expect(commands).toHaveLength(1); return commands.shift()!; }
  async function refused(request: Promise<unknown>, requestId: string) {
    const code = await request.then(receipt => (receipt as { status: string; error?: string }).status === 'not_executed' ? (receipt as { error: string }).error : `resolved:${JSON.stringify(receipt)}`, (error: unknown) => error instanceof HubError ? error.code : String(error));
    expect(commands).toEqual([]);
    return { code, journal: await journal(requestId) };
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hub-design-open-'));
    store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 1500);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    conversationId = (await store.createConversation('owner', ['bot'], 'Design open', 'design-open-conv')).id;
    otherConversationId = (await store.createConversation('owner', ['bot'], 'Other', 'design-open-other')).id;
    commands = []; cancels = []; turn = {};
    peer = peerFor('device');
    await broker.register(peer, openerWindow());
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it('opens through the opener, requires the real controller registration before the receipt, and replays idempotently', async () => {
    const reply = broker.request(bot(), open('open-1'));
    const frame = await dispatched();
    expect(frame.target).toEqual(opener);
    expect(frame.request).toMatchObject({ operation: 'design.open', payload: {} });
    await broker.admit(peer, frame.dispatchId);
    // The App opens the panel lazily and publishes the real controller first.
    await broker.register(peer, controller());
    await broker.receive(peer, frame.dispatchId, applied(frame));
    const receipt = await reply;
    expect(receipt).toEqual({ requestId: 'open-1', target: opener, status: 'applied', saved: true, revision: 3, result: { target: real, created: false } });
    expect(JSON.parse((await journal('open-1'))!.value).receipt.result).toEqual({ target: real, created: false });
    // The durable replay returns the same real target; nothing is dispatched again.
    expect(await broker.request(bot(), open('open-1'))).toMatchObject({ status: 'applied', result: { target: real } });
    expect(commands).toEqual([]);
    // The Bot continues on the returned real target.
    const read = broker.request(bot(), { requestId: 'read-1', operation: 'design.read', target: real, payload: {} });
    const readFrame = await dispatched(); expect(readFrame.target).toEqual(real);
    await broker.admit(peer, readFrame.dispatchId);
    await broker.receive(peer, readFrame.dispatchId, { requestId: 'read-1', target: real, status: 'success', revision: 3, result: {} });
    expect(await read).toMatchObject({ status: 'success', target: real });
  });

  it('settles unknown when the receipt arrives before or without the real controller registration', async () => {
    const cases: Array<[string, () => Promise<void>, unknown]> = [
      ['not-registered', async () => {}, { target: real, created: true }],
      ['other-socket', async () => { await broker.register(peerFor('device'), controller()); }, { target: real, created: true }],
      ['missing-tab', async () => { await broker.register(peer, controller([{ id: 'design-b', kind: 'design', title: 'B' }])); }, { target: real, created: false }],
      ['wrong-kind', async () => { await broker.register(peer, controller([{ id: 'design-a', kind: 'whiteboard', title: 'A' }])); }, { target: real, created: false }],
      ['hidden-controller', async () => { await broker.register(peer, controller(undefined, false)); }, { target: real, created: false }],
      ['opener-as-result', async () => {}, { target: { ...opener, tabId: 'design-a' }, created: false }],
      ['malformed', async () => { await broker.register(peer, controller()); }, { target: { deviceId: 'device', windowId: 'controller' }, created: false }],
    ];
    for (const [requestId, prepare, result] of cases) {
      await broker.unregister(peer, 'controller');
      const reply = broker.request(bot(), open(requestId));
      const frame = await dispatched();
      await broker.admit(peer, frame.dispatchId);
      await prepare();
      await broker.receive(peer, frame.dispatchId, applied(frame, result));
      expect(await reply, requestId).toMatchObject({ status: 'unknown', error: 'workbench_open_target_unregistered', target: opener });
      expect(JSON.parse((await journal(requestId))!.value).receipt).not.toHaveProperty('result');
    }
  });

  it('requires a saved receipt: success is not a valid design.open outcome', async () => {
    const reply = broker.request(bot(), open('open-success'));
    const frame = await dispatched(); await broker.admit(peer, frame.dispatchId);
    await expect(broker.receive(peer, frame.dispatchId, { requestId: 'open-success', target: frame.target, status: 'success', result: { target: real, created: false } })).rejects.toMatchObject({ code: 'workbench_saved_receipt_required' });
    broker.close(); expect(await reply).toMatchObject({ status: 'unknown' });
  });

  it('a Bot turn without a frozen opener, or naming another window, dispatches nothing', async () => {
    await broker.register(peer, controller());
    expect(await refused(broker.request(bot(null), open('no-context')), 'no-context')).toEqual({ code: 'workbench_open_target_required', journal: undefined });
    expect(await refused(broker.request(bot({ target: real }), open('panel-only')), 'panel-only')).toEqual({ code: 'workbench_open_target_required', journal: undefined });
    for (const [requestId, target] of [
      ['other-window', { deviceId: 'device', windowId: 'controller' }],
      ['other-device', { deviceId: 'phone', windowId: 'opener' }],
      ['with-tab', { ...opener, tabId: 'design-a' }],
    ] as const) expect(await refused(broker.request(bot(), open(requestId, target)), requestId)).toEqual({ code: 'workbench_open_target_mismatch', journal: undefined });
    // Exactly the frozen opener is accepted as an explicit target.
    const reply = broker.request(bot(), open('explicit-same', opener));
    const frame = await dispatched(); expect(frame.target).toEqual(opener);
    broker.close(); await reply;
  });

  it('never opens an opener of another conversation, user or device, or a hidden one', async () => {
    await broker.unregister(peer);
    await broker.register(peer, openerWindow(otherConversationId));
    expect((await refused(broker.request(bot(), open('other-conversation')), 'other-conversation')).code).toBe('workbench_open_target_unavailable');
    await broker.unregister(peer);
    const stranger = peerFor('device', 'stranger');
    // Even a co-member's opener (same device ID, same conversation) is not the turn author's.
    await store.db.run("INSERT INTO conversation_members(conversation_id,member_type,member_id) VALUES(?,'user','stranger')", [conversationId]);
    await broker.register(stranger, openerWindow());
    expect((await refused(broker.request(bot(), open('other-user')), 'other-user')).code).toBe('workbench_open_target_unavailable');
    await broker.unregister(stranger);
    await broker.register(peerFor('phone'), openerWindow());
    expect((await refused(broker.request(bot(), open('other-device')), 'other-device')).code).toBe('workbench_open_target_unavailable');
    await broker.register(peer, openerWindow(conversationId, 'opener', false));
    expect((await refused(broker.request(bot(), open('hidden')), 'hidden')).code).toBe('workbench_open_target_unavailable');
  });

  // An ended turn also fails the request itself; the journal keeps the outcome.
  const outcome = async (reply: Promise<unknown>, requestId: string) => {
    const settled = await reply.then(receipt => receipt as Record<string, unknown>, (error: unknown) => ({ rejected: error instanceof HubError ? error.code : String(error) }));
    return { ...settled, ...JSON.parse((await journal(requestId))!.value).receipt };
  };
  it('cancels before admission when the turn cancels, ends, or the opener retires or hides', async () => {
    const cases: Array<[string, (dispatchId: string) => Promise<void>, string]> = [
      ['cancelled', async () => { await broker.cancelRequest(bot(), 'cancelled'); }, 'workbench_cancelled'],
      ['navigated', async () => { broker.unregister(peer, 'opener'); }, 'workbench_app_disconnected'],
      ['hidden', async () => { await broker.register(peer, openerWindow(conversationId, 'opener', false)); }, 'workbench_open_target_unavailable'],
      ['source-ended', async dispatchId => { turn.ended = true; await expect(broker.admit(peer, dispatchId)).rejects.toMatchObject({ code: 'workbench_turn_ended' }); }, 'workbench_turn_ended'],
    ];
    for (const [requestId, interrupt, reason] of cases) {
      turn.ended = false; await broker.register(peer, openerWindow());
      const reply = broker.request(bot(), open(requestId));
      const frame = await dispatched();
      await interrupt(frame.dispatchId);
      expect(await outcome(reply, requestId), requestId).toMatchObject({ status: 'not_executed', error: reason, target: opener });
      expect(cancels.at(-1)).toBe(reason);
      // A late admission or completion cannot revive it.
      await expect(broker.admit(peer, frame.dispatchId)).rejects.toMatchObject({ code: 'workbench_dispatch_not_found' });
      await broker.receive(peer, frame.dispatchId, applied(frame));
    }
  });

  it('a cancel that overtakes the command keeps it from ever reaching the App', async () => {
    await broker.cancelRequest(bot(), 'early');
    expect(await broker.request(bot(), open('early'))).toMatchObject({ status: 'not_executed', error: 'workbench_cancelled' });
    expect(commands).toEqual([]);
  });

  it('after admission the outcome is unknown if the turn ends before the receipt', async () => {
    const reply = broker.request(bot(), open('ended-after-admit'));
    const frame = await dispatched(); await broker.admit(peer, frame.dispatchId);
    await broker.register(peer, controller());
    turn.ended = true;
    await broker.receive(peer, frame.dispatchId, applied(frame));
    expect(await outcome(reply, 'ended-after-admit')).toMatchObject({ rejected: 'workbench_turn_ended', status: 'unknown', error: 'workbench_turn_ended' });
  });

  it('a closed-panel context targets nothing else: other operations behave like a turn without context', async () => {
    await broker.register(peer, controller());
    // No ambiguity with the opener, no implicit opener target.
    const listing = broker.request(bot(), { requestId: 'tabs', operation: 'tabs.list' });
    const listFrame = await dispatched(); expect(listFrame.target).toEqual({ deviceId: 'device', windowId: 'controller' });
    broker.close(); await listing;
    broker = new WorkbenchBroker(store, 1500); await broker.register(peer, openerWindow()); await broker.register(peer, controller());
    expect(await refused(broker.request(bot(), { requestId: 'read-no-target', operation: 'design.read', payload: {} }), 'read-no-target')).toMatchObject({ code: 'workbench_target_required' });
    expect(await refused(broker.request(bot(), { requestId: 'opener-board', operation: 'whiteboard.create', target: opener, payload: {} }), 'opener-board')).toMatchObject({ code: 'workbench_app_unavailable' });
    expect(await refused(broker.request(bot(), { requestId: 'opener-tabs', operation: 'tabs.list', target: opener }), 'opener-tabs')).toMatchObject({ code: 'workbench_app_unavailable' });
  });

  it('the owner must name the opener explicitly; there is no implicit fallback', async () => {
    const owner: WorkbenchActor = { userId: 'owner', conversationId, validate: async () => {} };
    expect(await refused(broker.request(owner, open('owner-implicit')), 'owner-implicit')).toEqual({ code: 'workbench_open_target_required', journal: undefined });
    await broker.register(peer, controller());
    expect((await refused(broker.request(owner, open('owner-controller', { deviceId: 'device', windowId: 'controller' })), 'owner-controller')).code).toBe('workbench_open_target_unavailable');
    const reply = broker.request(owner, open('owner-explicit', opener));
    const frame = await dispatched(); expect(frame.target).toEqual(opener);
    broker.close(); await reply;
  });

  it('freezes the sender opener as a locator: retired is kept, contradictory or foreign is refused, design.open stays strict', async () => {
    expect(await broker.validateContext('owner', conversationId, closedPanel, 'device')).toEqual(closedPanel);
    await expect(broker.validateContext('owner', conversationId, closedPanel, 'phone')).rejects.toMatchObject({ code: 'workbench_open_target_unavailable' });
    await expect(broker.validateContext('owner', conversationId, closedPanel)).rejects.toMatchObject({ code: 'workbench_open_target_unavailable' });
    // A live registration at that address belonging to another conversation contradicts it.
    await expect(broker.validateContext('owner', otherConversationId, closedPanel, 'device')).rejects.toMatchObject({ code: 'workbench_open_target_unavailable' });
    // Mixed or forged content never rides on an opener.
    await expect(broker.validateContext('owner', conversationId, { ...closedPanel, kind: 'design' }, 'device')).rejects.toMatchObject({ code: 'invalid_workbench_context' });
    await expect(broker.validateContext('owner', conversationId, { target: opener }, 'device')).rejects.toMatchObject({ code: 'invalid_workbench_context' });
    await broker.register(peer, controller());
    const forged = { deviceId: 'device', windowId: 'controller' };
    await expect(broker.validateContext('owner', conversationId, { target: forged, openTarget: forged }, 'device')).rejects.toMatchObject({ code: 'workbench_open_target_unavailable' });
    await expect(broker.validateContext('owner', conversationId, { target: real, openTarget: forged }, 'device')).rejects.toMatchObject({ code: 'workbench_open_target_unavailable' });
    const panel: WorkbenchContext = { target: real, kind: 'design', revision: 3, openTarget: opener };
    expect(await broker.validateContext('owner', conversationId, panel, 'device')).toEqual(panel);
    // The opener retires (navigation, panel close) while the user is sending:
    // chat is not rejected, and the real content target keeps its own guard.
    broker.unregister(peer, 'opener');
    expect(await broker.validateContext('owner', conversationId, closedPanel, 'device')).toEqual(closedPanel);
    expect(await broker.validateContext('owner', conversationId, panel, 'device')).toEqual(panel);
    broker.assertContextActive('owner', conversationId, closedPanel);
    broker.assertContextActive('owner', conversationId, panel);
    broker.unregister(peer, 'controller');
    expect(() => broker.assertContextActive('owner', conversationId, panel)).toThrow(expect.objectContaining({ code: 'workbench_target_unavailable' }));
    await broker.register(peer, openerWindow(conversationId, 'opener', false));
    expect(await broker.validateContext('owner', conversationId, closedPanel, 'device')).toEqual(closedPanel);
    // Command time stays exact: a frozen retired or hidden opener opens nothing.
    expect((await refused(broker.request(bot(), open('hidden-frozen')), 'hidden-frozen')).code).toBe('workbench_open_target_unavailable');
    broker.unregister(peer, 'opener');
    await broker.register(peer, openerWindow(conversationId, 'opener-new'));
    expect((await refused(broker.request(bot(), open('retired-frozen')), 'retired-frozen')).code).toBe('workbench_open_target_unavailable');
  });

  it('bounds openers separately, so visible chats never consume the Workbench panel quota', async () => {
    for (let n = 1; n < 8; n++) await broker.register(peer, openerWindow(conversationId, `opener-${n}`));
    await expect(broker.register(peer, openerWindow(conversationId, 'opener-8'))).rejects.toMatchObject({ code: 'workbench_window_limit' });
    for (let n = 0; n < 16; n++) await broker.register(peer, { ...controller(), windowId: `panel-${n}` });
    await expect(broker.register(peer, { ...controller(), windowId: 'panel-16' })).rejects.toMatchObject({ code: 'workbench_window_limit' });
    // Re-registering an existing window is never a new allocation.
    await broker.register(peer, openerWindow(conversationId, 'opener-7'));
    await broker.register(peer, { ...controller(), windowId: 'panel-15' });
  });

  it('keeps the opener a contentless window and design.open payload empty', () => {
    expect(workbenchRegistrationSchema.safeParse(openerWindow()).success).toBe(true);
    expect(workbenchRegistrationSchema.safeParse({ ...openerWindow(), capabilities: ['design.open.v1', 'design.v1'] }).success).toBe(false);
    expect(workbenchRegistrationSchema.safeParse({ ...openerWindow(), tabs: [{ id: 'x', kind: 'design', title: 'X' }] }).success).toBe(false);
    expect(workbenchRegistrationSchema.safeParse({ ...openerWindow(), activeTabId: 'x' }).success).toBe(false);
    expect(workbenchRegistrationSchema.safeParse({ ...controller(), capabilities: ['whiteboard.v1', 'charts.v1', 'browser.v1', 'markdown.v1', 'design.v1'] }).success).toBe(true);
    expect(workbenchRequestShapeError({ operation: 'design.open', payload: {} })).toBeUndefined();
    expect(workbenchRequestShapeError({ operation: 'design.open' })).toBeUndefined();
    expect(workbenchRequestShapeError({ operation: 'design.open', payload: { title: 'x' } })).toBe('invalid_design_payload');
  });
});
