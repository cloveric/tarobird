import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HubStore } from '../src/hub/store.js';
import { HubPromptQueue } from '../src/hub/prompt-queue.js';
import { PROMPT_QUEUE_ENGINES, type PromptQueueAction, promptQueueSnapshotSchema } from '../src/client-protocol/prompt-queue.js';
import { assertHostRuntimeCompatible } from '../src/host-cli/schema-guard.js';
describe('durable per-message queue pause (#104)', () => {
    let dir: string, store: HubStore, queue: HubPromptQueue, chat: string, request = 0;
    beforeEach(async () => {
        dir = await mkdtemp(path.join(os.tmpdir(), 'queue-pause-'));
        store = await HubStore.open(dir);
        queue = new HubPromptQueue(store);
        request = 0;
        await store.db.run("INSERT INTO bots(id,name,secret_hash,engine) VALUES('bot','Queue','fixture','codex')");
        chat = (await store.createConversation('owner', ['bot'], 'Queue', 'create')).id;
        await queue.registerWorker('bot', true);
    });
    afterEach(async () => { await store.db.close(); await rm(dir, { recursive: true, force: true }); });
    const send = async (text: string) => (await store.sendMessage('owner', { conversationId: chat, clientMsgId: `send_${++request}`, text, attachments: [] })).message;
    const read = () => queue.read('owner', 'bot', chat);
    const change = async (action: PromptQueueAction) => queue.mutate('owner', chat, { botId: 'bot', requestId: `op_${++request}`, revision: (await read()).revision, action });
    it.each(PROMPT_QUEUE_ENGINES)('%s skips the paused head and resumes it at its retained position', async (engine) => {
        await store.db.run('UPDATE bots SET engine=? WHERE id=?', [engine, 'bot']);
        const a = await send('paused first'), b = await send('next'), c = await send('last');
        const before = await read();
        const paused = await change({ type: 'pause', messageId: a.id });
        expect(paused.revision).not.toBe(before.revision);
        expect(paused.items[0]).toMatchObject({ state: 'queued', paused: true, canPause: false, canResume: true, canMove: true, canEdit: true, canCancel: true });
        expect((await queue.claim('bot', true, false)).map(m => m.id)).toEqual([b.id]);
        expect((await read()).items.map(i => i.message.id)).toEqual([a.id, b.id, c.id]);
        await store.acknowledgeDelivery('bot', b.id);
        await change({ type: 'resume', messageId: a.id });
        expect((await queue.claim('bot', true, false)).map(m => m.id)).toEqual([a.id]);
        await expect(change({ type: 'pause', messageId: a.id })).rejects.toThrow('queue_already_dispatched');
        await store.acknowledgeDelivery('bot', a.id);
        expect((await queue.claim('bot', true, false)).map(m => m.id)).toEqual([c.id]);
    });
    it.each([true, false])('serializes simultaneous pause and take (pause submitted first=%s)', async (pauseFirst) => {
        const a = await send('racing input'), snapshot = await read();
        const pause = () => queue.mutate('owner', chat, { botId: 'bot', requestId: 'race-pause', revision: snapshot.revision, action: { type: 'pause', messageId: a.id } });
        const take = () => queue.take('bot', chat, () => true);
        const results = await Promise.allSettled(pauseFirst ? [pause(), take()] : [take(), pause()]);
        if (pauseFirst) {
            expect(results[0].status).toBe('fulfilled');
            expect(results[1]).toEqual({ status: 'fulfilled', value: undefined });
            expect((await read()).items[0]).toMatchObject({ paused: true, state: 'queued' });
        }
        else {
            expect(results[0]).toMatchObject({ status: 'fulfilled', value: { id: a.id } });
            expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'queue_already_dispatched' } });
            expect((await read()).items[0]).toMatchObject({ paused: false, state: 'dispatched' });
        }
    });
    it('pull wake/take and even a downgraded worker skip paused inputs', async () => {
        const a = await send('hold'), b = await send('go');
        await change({ type: 'pause', messageId: a.id });
        const ready = new Set<string>();
        expect(await queue.claim('bot', true, false, () => true, true, true, true, { ready })).toEqual([]);
        expect([...ready]).toEqual([chat]);
        expect((await queue.take('bot', chat, () => true))?.id).toBe(b.id);
        await store.acknowledgeDelivery('bot', b.id);
        const empty = new Set<string>();
        await queue.claim('bot', true, true, () => true, true, true, true, { ready: empty });
        expect(empty.size).toBe(0);
        expect(await queue.take('bot', chat, () => true)).toBeUndefined();
        expect(await queue.claim('bot', false, true)).toEqual([]);
    });
    it('restarts still paused, keeps positions through edit/move, and cancellation cannot revive it', async () => {
        const a = await send('hold'), b = await send('move');
        await change({ type: 'pause', messageId: a.id });
        await store.db.close();
        store = await HubStore.open(dir);
        queue = new HubPromptQueue(store);
        expect((await read()).items[0].paused).toBe(true);
        await change({ type: 'edit', messageId: a.id, text: 'edited while paused' });
        await change({ type: 'move', messageId: a.id, beforeId: null });
        expect((await read()).items.map(i => i.message.id)).toEqual([b.id, a.id]);
        expect((await read()).items[1].paused).toBe(true);
        await change({ type: 'cancel', messageId: a.id });
        await expect(change({ type: 'resume', messageId: a.id })).rejects.toThrow('queue_changed');
        expect((await queue.claim('bot', true, false)).map(m => m.id)).toEqual([b.id]);
    });
    it('fences pause against claim and preserves idempotent receipts across resume', async () => {
        const a = await send('race');
        const before = await read();
        const command = { botId: 'bot', requestId: 'same', revision: before.revision, action: { type: 'pause' as const, messageId: a.id } };
        await queue.mutate('owner', chat, command);
        await change({ type: 'resume', messageId: a.id });
        const replay = await queue.mutate('owner', chat, command);
        expect(replay.items[0].paused ?? false).toBe(false);
        await queue.take('bot', chat, () => true);
        await expect(queue.mutate('owner', chat, { ...command, requestId: 'late' })).rejects.toThrow('queue_already_dispatched');
    });
    it('skip semantics do not unblock paused text as a slash command flush', async () => {
        const a = await send('hold'), b = await send('ordinary'), c = await send('/new');
        await change({ type: 'pause', messageId: a.id });
        await expect(change({ type: 'pause', messageId: c.id })).rejects.toThrow('queue_item_unsupported');
        expect((await queue.claim('bot', true, false)).map(m => m.id)).toEqual([b.id, c.id]);
        expect((await read()).items[0].paused).toBe(true);
    });
    it('migrates schema 24 with ordinary rows unchanged and fences unsafe runtime downgrades', async () => {
        const a = await send('existing');
        await store.db.exec("ALTER TABLE deliveries DROP COLUMN queue_paused; UPDATE meta SET value='24' WHERE key='schema_version'");
        await store.db.close();
        store = await HubStore.open(dir);
        queue = new HubPromptQueue(store);
        expect((await read()).items[0]).toMatchObject({ state: 'queued', canPause: true });
        expect((await read()).items[0].paused ?? false).toBe(false);
        await change({ type: 'pause', messageId: a.id });
        expect((await store.db.get<{
            value: string;
        }>("SELECT value FROM meta WHERE key='schema_version'"))?.value).toBe('25');
        const old = path.join(dir, 'old-runtime');
        await mkdir(old);
        await writeFile(path.join(old, 'package.json'), JSON.stringify({ tarobotHostUpdate: { format: 1, minHubSchema: 1, maxHubSchema: 24 } }));
        await expect(assertHostRuntimeCompatible(dir, path.join(old, 'index.js'))).rejects.toThrow('host_schema_incompatible:25:runtime_1-24');
    });
    it('reads old snapshots without inventing support for pausing', () => {
        const old = promptQueueSnapshotSchema.parse({ supported: true, botId: 'bot', conversationId: 'chat', revision: 'r', items: [], capabilities: { reorder: true, edit: true, cancel: true } });
        expect(old.capabilities.pause).toBeUndefined();
    });
});
