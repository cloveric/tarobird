import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { HubServer } from '../src/hub/server.js';
import { deviceProof } from '../src/hub/auth.js';
import { deviceFields, sessionFor, testDevice } from './helpers/pairing-invite.js';
// @ts-expect-error release acceptance helper runs directly in Node, outside the TS build
import { createAcceptanceInvitationIssuer, requestAcceptancePairing } from '../scripts/standalone-acceptance-pairing.mjs';

let hub: HubServer, root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'live-pairing-')); hub = await HubServer.start({ stateDir: root }); });
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

it('pairs both acceptance devices through unique invitations without bypassing owner approval', async () => {
  const issue = await createAcceptanceInvitationIssuer(hub.auth, deviceProof);
  const invitations: string[] = [];
  for (const id of ['acceptance_desktop', 'acceptance_phone']) {
    const device = testDevice(id);
    const pair = await requestAcceptancePairing(hub.url, async () => {
      const invitation = await issue(); invitations.push(invitation.invite); return invitation;
    }, deviceFields(device));
    expect(await hub.store.db.get('SELECT 1 FROM devices WHERE id=?', [id])).toBeUndefined();
    await expect(sessionFor(hub.auth, device)).rejects.toMatchObject({ code: 'untrusted_device' });
    await hub.auth.approve(pair.code, 'local-owner');
    expect(await sessionFor(hub.auth, device)).toMatchObject({ userId: 'owner', deviceId: id });
  }
  expect(new Set(invitations).size).toBe(2);
});

it('keeps old uninvited requests rejected and surfaces invalid invitations', async () => {
  const fields = deviceFields(testDevice('acceptance_rejected'));
  const old = await fetch(hub.url + '/api/pair', { method: 'POST', body: JSON.stringify(fields) });
  expect(old.status).toBe(403); expect(await old.json()).toMatchObject({ error: 'pairing_invite_required' });
  await expect(requestAcceptancePairing(hub.url, async () => ({ invite: 'invalid' }), fields)).rejects.toThrow('Acceptance pairing failed');
  expect(await hub.store.db.get('SELECT 1 FROM devices WHERE id=?', [fields.deviceId])).toBeUndefined();
});
