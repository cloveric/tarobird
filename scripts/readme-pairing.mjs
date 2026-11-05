// Disposable documentation Hub only: bootstrap its fixture owner, then use
// the same bounded invitation and visible import flow as the current App.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { deviceProof } from '../dist/src/hub/auth.js';

const owners = new WeakMap();
export async function prepareReadmePairing(page, hub) {
  let owner = owners.get(hub);
  if (!owner) {
    const keys = generateKeyPairSync('ed25519');
    owner = { deviceId: 'readme_fixture_owner', privateKey: keys.privateKey };
    const { code } = await hub.auth.pair({ deviceId: owner.deviceId, name: 'Documentation fixture', platform: 'web', publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
    await hub.auth.approve(code, 'local-owner');
    owners.set(hub, owner);
  }
  const nonce = randomBytes(32).toString('base64url'), connection = randomBytes(16).toString('hex');
  const challenge = await hub.auth.challenge(connection, owner.deviceId, nonce, '127.0.0.1');
  const { token } = await hub.auth.authenticate(connection, sign(null, deviceProof(owner.deviceId, challenge.nonce, nonce), owner.privateKey).toString('base64'));
  const invitation = await hub.auth.issuePairingInvite(await hub.auth.authorize(token, '127.0.0.1'), { requestId: randomBytes(32).toString('base64url') });
  const data = { v: 1, kind: 'connect', hubPublicKey: hub.auth.publicKey, routes: [{ name: 'Direct', url: hub.url }] };
  const link = `tarocub://pair?data=${encodeURIComponent(JSON.stringify(data))}&invite=${invitation.invite}`;
  await page.getByRole('button', { name: '粘贴连接信息', exact: true }).click();
  await page.getByLabel('配对信息', { exact: true }).fill(link);
  await page.getByRole('button', { name: '使用配对信息', exact: true }).click();
  await page.getByRole('dialog', { name: '粘贴配对信息', exact: true }).waitFor({ state: 'hidden' });
}
