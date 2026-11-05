import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchPeer } from '../src/hub/workbench.js';
import { workbenchCommandFrameSchema, type WorkbenchCommandFrame, type WorkbenchRegistration, type WorkbenchRequest } from '../src/client-protocol/workbench.js';

let directory: string, store: HubStore, broker: WorkbenchBroker, conversationId: string, peer: WorkbenchPeer;
let commands: WorkbenchCommandFrame[];
const target = { deviceId: 'device', windowId: 'window', tabId: 'design' };
const bot = { kind: 'bot' as const, id: 'bot', name: 'Design assistant' };
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'design-actor-'));
  store = await HubStore.open(directory); broker = new WorkbenchBroker(store, 1500);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
  conversationId = (await store.createConversation('owner', ['bot'], 'Design', 'design-actor-conv')).id;
  commands = [];
  peer = { key: {}, userId: 'owner', deviceId: 'device', active: () => true, validate: async () => {}, send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } };
});
afterEach(async () => { broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); });
async function register(capabilities: WorkbenchRegistration['capabilities']) {
  await broker.register(peer, { windowId: 'window', generation: 'generation', conversationId, capabilities,
    tabs: [{ id: 'design', kind: 'design', title: 'Design', revision: 0 }], activeTabId: 'design', visible: true });
}
async function dispatch(request: WorkbenchRequest) {
  const result = broker.request({ userId: 'owner', conversationId, actor: bot, validate: async () => {} }, request);
  await expect.poll(() => commands.length).toBe(1);
  const frame = commands[0]!;
  await broker.admit(peer, frame.dispatchId);
  await broker.receive(peer, frame.dispatchId, { requestId: request.requestId, target, status: 'applied', saved: true, revision: 1 });
  expect(await result).toMatchObject({ status: 'applied', saved: true });
  return frame;
}
it('a comments-only App receives the trusted Bot actor without requiring history capability', async () => {
  await register(['design.v1', 'design.comments.v1']);
  const frame = await dispatch({ requestId: 'reply', operation: 'design.comments.reply', target, payload: { threadId: 'c_0123456789', text: 'Reply' } });
  expect(frame.actor).toEqual(bot);
  expect(workbenchCommandFrameSchema.parse(frame).actor).toEqual(bot);
});
it('a history-only App receives the trusted actor for a restore', async () => {
  await register(['design.v1', 'design.history.v1']);
  expect((await dispatch({ requestId: 'restore', operation: 'design.restore', target, expectedRevision: 0, payload: { version: 1 } })).actor).toEqual(bot);
});
it('an older App still receives the strict command shape without actor', async () => {
  await register(['design.v1']);
  const frame = await dispatch({ requestId: 'publish', operation: 'design.publish', target, expectedRevision: 0, payload: { files: { 'project/Main.dc.html': { content: '<h1>Hello</h1>', contentType: 'text/html' } } } });
  expect(frame).not.toHaveProperty('actor');
  expect(() => workbenchCommandFrameSchema.omit({ actor: true }).strict().parse(frame)).not.toThrow();
});
it('a history-only App cannot receive a comment mutation', async () => {
  await register(['design.v1', 'design.history.v1']);
  await expect(broker.request({ userId: 'owner', conversationId, actor: bot, validate: async () => {} }, {
    requestId: 'wrong-capability', operation: 'design.comments.reply', target, payload: { threadId: 'c_0123456789', text: 'Reply' },
  })).rejects.toMatchObject({ code: 'workbench_app_unavailable' });
  expect(commands).toEqual([]);
});
