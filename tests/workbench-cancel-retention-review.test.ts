import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from '../src/hub/workbench.js';
import type { WorkbenchCommandFrame } from '../src/client-protocol/workbench.js';

// The bounded cache for an unmatched cancel is not ownership of a live request.
// Once cancelled, a held request must not become executable when that cache ages
// or evicts entries. These gates cover both sides of initial authentication.
for (const stage of ['initial validation', 'target resolution'] as const) {
  for (const eviction of ['capacity', 'expiry'] as const) {
    it(`keeps an active cancellation during ${stage} after unmatched-cache ${eviction}`, async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'workbench-cancel-retention-'));
      const store = await HubStore.open(directory), broker = new WorkbenchBroker(store, 100);
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { reached = resolve; });
      const commands: WorkbenchCommandFrame[] = [];
      let holdPeer = false, held = false;
      const wait = async () => { if (!held) { held = true; reached(); await gate; } };
      try {
        await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
        const conversationId = (await store.createConversation('owner', ['bot'], 'Review', 'review')).id;
        const actor: WorkbenchActor = { userId: 'owner', conversationId, sourceMessageId: 'turn', validate: async () => {} };
        const peer: WorkbenchPeer = { key: {}, userId: 'owner', deviceId: 'd', active: () => true,
          validate: async () => { if (holdPeer) await wait(); },
          send: async frame => { if (frame.type === 'workbench.command') commands.push(frame); } };
        await broker.register(peer, { windowId: 'w', generation: 'g', conversationId, capabilities: ['whiteboard.v1'], tabs: [], visible: true });
        holdPeer = stage === 'target resolution';
        const work = broker.request({ ...actor, validate: stage === 'initial validation' ? wait : actor.validate }, { requestId: 'held', operation: 'whiteboard.create', payload: {} });
        await entered;
        await broker.cancelRequest(actor, 'held');
        if (eviction === 'capacity') for (let i = 0; i < 300; i++) await broker.cancelRequest(actor, `unmatched_${i}`);
        else await new Promise(resolve => setTimeout(resolve, 120));
        release();
        const receipt = await work;
        expect(commands).toEqual([]);
        expect(receipt).toMatchObject({ status: 'not_executed', error: 'workbench_cancelled' });
      } finally { release(); broker.close(); await store.db.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
}
