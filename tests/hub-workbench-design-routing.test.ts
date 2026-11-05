import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore, HubError } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import { workbenchRequestSchema, type WorkbenchCommandFrame, type WorkbenchContext, type WorkbenchRegistration } from '../src/client-protocol/workbench.js';

// Bot Design control must address one exact design. Every new design starts at
// revision 0, so revision CAS cannot tell two designs apart: a guessed or
// live-active tab could durably overwrite the wrong design.
describe('Design routing never guesses the target design', () => {
  let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, otherConversationId: string;
  let commands: WorkbenchCommandFrame[], peer: WorkbenchPeer, actor: WorkbenchActor;
  const files = { files: { 'project/Main.dc.html': { content: '<x-dc>edit</x-dc>', contentType: 'text/html' as const } } };
  const designs = [{ id: 'design-a', kind: 'design' as const, title: 'A', revision: 0 }, { id: 'design-b', kind: 'design' as const, title: 'B', revision: 0 }];
  const window = (conversation: string, windowId: string, activeTabId: string, tabs: WorkbenchRegistration['tabs'] = designs): WorkbenchRegistration =>
    ({ windowId, generation: 'gen', conversationId: conversation, capabilities: ['whiteboard.v1', 'design.v1'], tabs, activeTabId, visible: true });
  const tab = (tabId: string, windowId = 'window') => ({ deviceId: 'device', windowId, tabId });
  const frozen = (tabId: string): WorkbenchContext => ({ target: tab(tabId), kind: 'design', title: tabId, revision: 0 });
  /** A refusal may be a Host rejection or a not_executed receipt; nothing may reach the App. */
  async function refused(request: Promise<unknown>) {
    const outcome = await request.then(receipt => receipt as { status?: string; error?: string }, (error: unknown) => ({ status: 'rejected', error: error instanceof HubError ? error.code : String(error) }));
    expect(['rejected', 'not_executed']).toContain(outcome.status);
    expect(commands).toHaveLength(0);
    return outcome.error;
  }
  async function dispatched() { for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 5)); expect(commands).toHaveLength(1); return commands.shift()!; }
  async function settle(frame: WorkbenchCommandFrame) {
    await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, frame.request.operation === 'design.publish'
      ? { requestId: frame.request.requestId, target: frame.target, status: 'applied', saved: true, revision: 1 }
      : { requestId: frame.request.requestId, target: frame.target, status: 'success', revision: 0, result: {} });
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hub-design-routing-'));
    store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 1500);
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
    conversationId = (await store.createConversation('owner', ['bot'], 'Design A', 'design-a-conv')).id;
    otherConversationId = (await store.createConversation('owner', ['bot'], 'Design B', 'design-b-conv')).id;
    commands = [];
    peer = { key: {}, userId: 'owner', deviceId: 'device', active: () => true, validate: async () => {}, send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } };
    actor = { userId: 'owner', conversationId, validate: async () => {} };
    await broker.register(peer, window(conversationId, 'window', 'design-a'));
  });
  afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });

  it('never routes a slide creation to an older canvas-only client or another selected window', async () => {
    await broker.register(peer, {...window(conversationId,'new-client','design-b'),capabilities:['design.v1','design.slides.v1']});
    expect(await refused(broker.request(actor,{requestId:'slides-old-client',operation:'design.create',target:{deviceId:'device',windowId:'window'},payload:{format:'slides'}}))).toBe('workbench_app_unavailable');
    const pending=broker.request(actor,{requestId:'slides-new-client',operation:'design.create',target:{deviceId:'device',windowId:'new-client'},payload:{format:'slides'}});
    const frame=await dispatched();expect(frame.target.windowId).toBe('new-client');expect(frame.request.payload).toEqual({format:'slides'});
    await broker.admit(peer,frame.dispatchId);
    await broker.receive(peer,frame.dispatchId,{requestId:frame.request.requestId,target:frame.target,status:'applied',saved:true,revision:0,result:{tabId:'new-deck'}});
    expect(await pending).toMatchObject({status:'applied',saved:true});
  });

  it('an explicit complete target reaches exactly that design while another design is active', async () => {
    await broker.register(peer, window(conversationId, 'window', 'design-b'));
    const read = broker.request(actor, { requestId: 'read-a', operation: 'design.read', target: tab('design-a'), payload: {} });
    const readFrame = await dispatched(); expect(readFrame.target).toEqual(tab('design-a')); await settle(readFrame);
    expect(await read).toMatchObject({ status: 'success', target: tab('design-a') });
    const publish = broker.request(actor, { requestId: 'publish-a', operation: 'design.publish', target: tab('design-a'), expectedRevision: 0, payload: files });
    const publishFrame = await dispatched(); expect(publishFrame.target).toEqual(tab('design-a')); await settle(publishFrame);
    expect(await publish).toMatchObject({ status: 'applied', saved: true, target: tab('design-a') });
  });

  it('a partial explicit target is refused for read and publish instead of using the live active design', async () => {
    // The Bot read design A, then the person switched to design B (also revision 0).
    await broker.register(peer, window(conversationId, 'window', 'design-b'));
    for (const request of [
      { requestId: 'partial-read', operation: 'design.read' as const, target: { deviceId: 'device', windowId: 'window' }, payload: {} },
      { requestId: 'partial-publish', operation: 'design.publish' as const, target: { deviceId: 'device', windowId: 'window' }, expectedRevision: 0, payload: files },
    ]) expect(await refused(broker.request(actor, request))).toBe('workbench_target_required');
  });

  it('a partial explicit target is not completed from the frozen context', async () => {
    const turn = { ...actor, context: frozen('design-a') };
    await broker.register(peer, window(conversationId, 'window', 'design-b'));
    expect(await refused(broker.request(turn, { requestId: 'partial-read-with-context', operation: 'design.read', target: { deviceId: 'device', windowId: 'window' }, payload: {} }))).toBe('workbench_target_required');
    expect(await refused(broker.request(turn, { requestId: 'partial-publish-with-context', operation: 'design.publish', target: { deviceId: 'device', windowId: 'window' }, expectedRevision: 0, payload: files }))).toBe('workbench_target_required');
  });

  it('a read without a request target uses the complete frozen context tab, never the live active design', async () => {
    const turn = { ...actor, context: frozen('design-a') };
    await broker.register(peer, window(conversationId, 'window', 'design-b'));
    const read = broker.request(turn, { requestId: 'frozen-read', operation: 'design.read', payload: {} });
    const frame = await dispatched(); expect(frame.target).toEqual(tab('design-a')); await settle(frame);
    expect(await read).toMatchObject({ status: 'success', target: tab('design-a') });
  });

  it('a publish must name its tab even when the turn froze one (a design created this turn can share revision 0)', async () => {
    const turn = { ...actor, context: frozen('design-a') };
    expect(await refused(broker.request(turn, { requestId: 'frozen-publish', operation: 'design.publish', expectedRevision: 0, payload: files }))).toBe('workbench_target_required');
  });

  it('without any target or frozen context, read and publish are refused even with a single active design', async () => {
    for (const request of [
      { requestId: 'bare-read', operation: 'design.read' as const, payload: {} },
      { requestId: 'bare-publish', operation: 'design.publish' as const, expectedRevision: 0, payload: files },
    ]) expect(await refused(broker.request(actor, request))).toBe('workbench_target_required');
  });

  it('a frozen context on a non-design tab never reaches a design', async () => {
    await broker.register(peer, window(conversationId, 'window', 'board', [{ id: 'board', kind: 'whiteboard', title: 'Board', revision: 0 }, ...designs]));
    const turn = { ...actor, context: { target: tab('board'), kind: 'whiteboard' as const, revision: 0 } };
    expect(await refused(broker.request(turn, { requestId: 'board-context-read', operation: 'design.read', payload: {} }))).toBe('workbench_wrong_kind');
    expect(await refused(broker.request(turn, { requestId: 'board-context-publish', operation: 'design.publish', expectedRevision: 0, payload: files }))).toBe('workbench_target_required');
  });

  it('design.create and tabs.list still need no tab', async () => {
    const create = broker.request(actor, { requestId: 'create', operation: 'design.create', target: { deviceId: 'device', windowId: 'window' }, payload: { title: 'New' } });
    const createFrame = await dispatched(); expect(createFrame.target).toEqual({ deviceId: 'device', windowId: 'window' });
    await broker.admit(peer, createFrame.dispatchId);
    await broker.receive(peer, createFrame.dispatchId, { requestId: 'create', target: createFrame.target, status: 'applied', saved: true, revision: 0, result: { tabId: 'design-c' } });
    expect(await create).toMatchObject({ status: 'applied', result: { tabId: 'design-c' } });
    const list = broker.request(actor, { requestId: 'list', operation: 'tabs.list' });
    const listFrame = await dispatched(); expect(listFrame.target.tabId).toBeUndefined();
    await broker.admit(peer, listFrame.dispatchId);
    await broker.receive(peer, listFrame.dispatchId, { requestId: 'list', target: listFrame.target, status: 'success', result: {} });
    expect(await list).toMatchObject({ status: 'success' });
  });

  it('a complete target in another conversation is unavailable to this conversation', async () => {
    await broker.register(peer, window(otherConversationId, 'other-window', 'design-x', [{ id: 'design-x', kind: 'design', title: 'X', revision: 0 }]));
    expect(await refused(broker.request(actor, { requestId: 'cross-read', operation: 'design.read', target: tab('design-x', 'other-window'), payload: {} }))).toBe('workbench_app_unavailable');
    expect(await refused(broker.request(actor, { requestId: 'cross-publish', operation: 'design.publish', target: tab('design-x', 'other-window'), expectedRevision: 0, payload: files }))).toBe('workbench_app_unavailable');
    expect((await broker.list(actor)).map(item => item.windowId)).toEqual(['window']);
  });

  it('a target remembered from an older turn is not redirected after its design closes or its window is replaced', async () => {
    // The design was closed: the old tab is not swapped for the remaining active design.
    await broker.register(peer, window(conversationId, 'window', 'design-b', [designs[1]!]));
    expect(await refused(broker.request(actor, { requestId: 'closed-design', operation: 'design.publish', target: tab('design-a'), expectedRevision: 0, payload: files }))).toBe('workbench_target_closed');
    // An App reload registers a fresh window id; the remembered window is gone.
    broker.unregister(peer, 'window');
    await broker.register(peer, window(conversationId, 'reloaded-window', 'design-a'));
    expect(await refused(broker.request(actor, { requestId: 'replaced-window', operation: 'design.publish', target: tab('design-a'), expectedRevision: 0, payload: files }))).toBe('workbench_app_unavailable');
  });

  it('a Design requestId reused by a later turn conflicts instead of replaying, and a same-turn retry keeps the created tab', async () => {
    const turn = (sourceMessageId: string) => ({ ...actor, sourceMessageId });
    const create = { requestId: 'design_create_1', operation: 'design.create' as const, target: { deviceId: 'device', windowId: 'window' }, payload: { title: 'Design' } };
    const first = broker.request(turn('message-1'), create);
    const frame = await dispatched(); await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, { requestId: 'design_create_1', target: frame.target, status: 'applied', saved: true, revision: 0, result: { tabId: 'design-new' } });
    expect(await first).toMatchObject({ status: 'applied', result: { tabId: 'design-new' } });
    // The same turn reconciling an uncertain result gets the original identity back, without a second create.
    expect(await broker.request(turn('message-1'), create)).toMatchObject({ status: 'applied', result: { tabId: 'design-new' } });
    expect(commands).toHaveLength(0);
    // A later turn copying the guidance example must not receive the earlier turn's success.
    expect(await refused(broker.request(turn('message-2'), create))).toBe('request_id_conflict');
  });

  it('while a Design request is in flight, the same id from another source is refused and the same source shares one dispatch', async () => {
    const create = { requestId: 'inflight_create', operation: 'design.create' as const, target: { deviceId: 'device', windowId: 'window' }, payload: { title: 'Design' } };
    const first = broker.request({ ...actor, sourceMessageId: 'message-1' }, create);
    const frame = await dispatched();
    const retry = broker.request({ ...actor, sourceMessageId: 'message-1' }, create);
    expect(await refused(broker.request({ ...actor, sourceMessageId: 'message-2' }, create))).toBe('request_id_conflict');
    // A sourceless (direct user) request is a different source too.
    expect(await refused(broker.request(actor, create))).toBe('request_id_conflict');
    await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, { requestId: 'inflight_create', target: frame.target, status: 'applied', saved: true, revision: 0, result: { tabId: 'design-new' } });
    expect(await first).toMatchObject({ status: 'applied', result: { tabId: 'design-new' } });
    expect(await retry).toMatchObject({ status: 'applied', result: { tabId: 'design-new' } });
    expect(commands).toHaveLength(0);
  });

  it('a Design publish id reused by a later turn conflicts even with identical arguments', async () => {
    const publish = { requestId: 'design_edit_1', operation: 'design.publish' as const, target: tab('design-a'), expectedRevision: 0, payload: files };
    const first = broker.request({ ...actor, sourceMessageId: 'message-1' }, publish);
    await settle(await dispatched()); expect(await first).toMatchObject({ status: 'applied', saved: true });
    expect(await refused(broker.request({ ...actor, sourceMessageId: 'message-2' }, publish))).toBe('request_id_conflict');
    expect(await broker.request({ ...actor, sourceMessageId: 'message-1' }, publish)).toMatchObject({ status: 'applied', saved: true });
    expect(commands).toHaveLength(0);
  });

  it('after a Host restart the same turn still gets the created tab and another turn is still refused', async () => {
    const create = { requestId: 'restart_create', operation: 'design.create' as const, target: { deviceId: 'device', windowId: 'window' }, payload: { title: 'Design' } };
    const first = broker.request({ ...actor, sourceMessageId: 'message-1' }, create);
    const frame = await dispatched(); await broker.admit(peer, frame.dispatchId);
    await broker.receive(peer, frame.dispatchId, { requestId: 'restart_create', target: frame.target, status: 'applied', saved: true, revision: 0, result: { tabId: 'design-new', extra: 'not retained' } });
    await first;
    // A new broker on the same store: no in-memory flight, only the durable journal.
    broker.close(); broker = new WorkbenchBroker(store, 1500); await broker.register(peer, window(conversationId, 'window', 'design-a'));
    const replay = await broker.request({ ...actor, sourceMessageId: 'message-1' }, create);
    expect(replay).toMatchObject({ status: 'applied', result: { tabId: 'design-new' } });
    expect(replay.result).toEqual({ tabId: 'design-new' });
    expect(commands).toHaveLength(0);
    expect(await refused(broker.request({ ...actor, sourceMessageId: 'message-2' }, create))).toBe('request_id_conflict');
  });

  it('a journal written before tab retention is replayed without inventing a tab id', async () => {
    const input = { requestId: 'legacy_create', operation: 'design.create' as const, target: { deviceId: 'device', windowId: 'window' }, payload: { title: 'Design' } };
    const fingerprint = createHash('sha256').update(JSON.stringify({ request: workbenchRequestSchema.parse(input), context: null })).digest('hex');
    const legacy = { createdAt: Date.now(), readOnly: false, sourceMessageId: 'message-1', fingerprint, target: input.target,
      receipt: { requestId: 'legacy_create', status: 'applied', target: input.target, revision: 0, saved: true } };
    await store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [`workbench-command:owner:${conversationId}:legacy_create`, JSON.stringify(legacy)]);
    const replay = await broker.request({ ...actor, sourceMessageId: 'message-1' }, input);
    expect(replay).toMatchObject({ status: 'applied', saved: true });
    expect(replay.result).toBeUndefined();
    expect(commands).toHaveLength(0);
  });

  it('the same turn with different arguments still conflicts, while the same id in another conversation is independent', async () => {
    const turn = { ...actor, sourceMessageId: 'message-1' };
    const first = broker.request(turn, { requestId: 'shared_id', operation: 'design.read', target: tab('design-a'), payload: {} });
    await settle(await dispatched()); expect(await first).toMatchObject({ status: 'success' });
    expect(await refused(broker.request(turn, { requestId: 'shared_id', operation: 'design.read', target: tab('design-b'), payload: {} }))).toBe('request_id_conflict');
    // Another conversation keeps its own journal for the same requestId.
    await broker.register(peer, window(otherConversationId, 'other-window', 'design-x', [{ id: 'design-x', kind: 'design', title: 'X', revision: 0 }]));
    const other = broker.request({ ...actor, conversationId: otherConversationId, sourceMessageId: 'message-other' }, { requestId: 'shared_id', operation: 'design.read', target: tab('design-x', 'other-window'), payload: {} });
    const frame = await dispatched(); expect(frame.conversationId).toBe(otherConversationId); expect(frame.target).toEqual(tab('design-x', 'other-window'));
    await settle(frame); expect(await other).toMatchObject({ status: 'success', target: tab('design-x', 'other-window') });
  });
});
