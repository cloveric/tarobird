import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from '@playwright/test';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { deviceProof, hashSecret } from '../../src/hub/auth.js';
import { desktopControllerMarkerKey } from '../../src/hub/local-controller.js';
import { deviceActionProofText } from '../../src/client-protocol/device-actions.js';
import { networkCanonical, networkCommandSchema, type NetworkCommandInput } from '../../src/client-protocol/private-network.js';
import { openSettings } from './fixtures/settings.js';
import { waitForClientOnline } from './fixtures/mobile.js';

test.use({ serviceWorkers: 'block' });
async function controller(hub: HubServer, id: string) {
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pairing = await hub.auth.pair({ deviceId: id, name: '这台电脑', platform: 'macos', publicKey }, 'fixture');
  await hub.auth.approve(pairing.code, 'local-owner');
  const nonce = randomBytes(32).toString('base64url'), connection = randomBytes(16).toString('hex');
  const challenge = await hub.auth.challenge(connection, id, nonce, 'fixture');
  const { token } = await hub.auth.authenticate(connection, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString('base64'));
  return { id, publicKey, privateKey: keys.privateKey, token, session: await hub.auth.authorize(token) };
}
async function command(hub: HubServer, actor: Awaited<ReturnType<typeof controller>>, input: NetworkCommandInput) {
  const value = networkCommandSchema.parse(input.operation === 'attest' ? { ...input, networkId: (await hub.network.view()).membership!.manifest.id } : input);
  const statement = await hub.auth.prepareDeviceAction({ operation: 'network', target: hashSecret(networkCanonical(value)) }, actor.token, actor.session);
  return hub.network.command(value, actor.session, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), actor.privateKey).toString('base64') });
}

for (const width of [1360, 390]) test(`remote device names follow their proven origin in settings at width ${width}`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  const root = await mkdtemp(path.join(tmpdir(), 'network-device-name-'));
  const a = await HubServer.start({ stateDir: path.join(root, 'mac'), clientDir: path.resolve('dist') });
  const b = await HubServer.start({ stateDir: path.join(root, 'asus'), clientDir: path.resolve('dist'), networkExchange: (_host, request) => a.network.peer(request, 'fixture') });
  try {
    const ownerA = await controller(a, 'mac_native'), ownerB = await controller(b, 'asus_native');
    // Native proof persistence is covered by controller-migration tests; here
    // use its exact marker as the renderer fixture, not platform inference.
    await a.store.db.run('INSERT INTO meta(key,value) VALUES(?,?)', [desktopControllerMarkerKey(ownerA.id), JSON.stringify({ id: ownerA.id, publicKey: ownerA.publicKey, nameSource: 'host' })]);
    await a.profile.update({ name: 'example-mac', revision: (await a.profile.read()).revision });
    await b.profile.update({ name: 'example-windows', revision: (await b.profile.read()).revision });
    const created = (await command(a, ownerA, { operation: 'create', name: '测试网络' })).membership!;
    const proposal = (await command(b, ownerB, { operation: 'propose', networkId: created.manifest.id, authorityKey: a.auth.publicKey, seenManifestHash: hashSecret(networkCanonical(created.manifest)) })).proposal!;
    const admitted = (await command(a, ownerA, { operation: 'admit', proposal })).membership!;
    await command(b, ownerB, { operation: 'join', membership: admitted, nonce: proposal.proposal.nonce });
    const remoteKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    await b.network.enroll((await command(a, ownerA, { operation: 'attest', device: { id: 'mac_remote', host: b.auth.publicKey, publicKey: remoteKey, name: '这台电脑', platform: 'macos' } })).membership);
    // A real legacy imported row, not a mocked HTTP response.
    await b.store.db.run("UPDATE devices SET name='这台电脑' WHERE id='mac_remote'");
    await b.store.db.run("DELETE FROM meta WHERE key LIKE 'network-device-name:v1:%'");
    await b.network.tick();
    await page.goto(b.url);
    await page.getByLabel('主机名称', { exact: true }).fill('example-windows');
    await preparePairing(page, b); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await b.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await expect(page.getByLabel('配对码', { exact: true })).toBeHidden({ timeout: 20_000 });
    await openSettings(page, 'devices');
    const row = page.locator('[data-device-id="mac_remote"]');
    await expect(row.locator('.device-display-name')).toHaveText('example-mac');
    await row.getByRole('button', { name: '管理', exact: true }).click();
    const details = page.getByRole('dialog', { name: '管理设备', exact: true });
    await expect(details.locator('.device-detail-heading strong')).toHaveText('example-mac');
    await details.getByRole('button', { name: '重命名设备 example-mac', exact: true }).click();
    await details.getByLabel('设备新名称', { exact: true }).fill('办公室 Mac');
    await a.profile.update({ name: 'example-mac 工作室', revision: (await a.profile.read()).revision });
    await a.network.tick(); await b.network.tick();
    await expect(details.locator('.device-detail-heading strong')).toHaveText('example-mac 工作室', { timeout: 15_000 });
    await expect(details.getByLabel('设备新名称', { exact: true })).toHaveValue('办公室 Mac');
    await details.getByRole('button', { name: '保存', exact: true }).click();
    await expect(details.locator('.device-detail-heading strong')).toHaveText('办公室 Mac');
    await a.profile.update({ name: 'Another Mac name', revision: (await a.profile.read()).revision });
    await a.network.tick(); await b.network.tick();
    await page.reload(); await waitForClientOnline(page); await openSettings(page, 'devices');
    await expect(row.locator('.device-display-name')).toHaveText('办公室 Mac');
    await page.screenshot({ path: testInfo.outputPath('network-device-name.png'), fullPage: true });
  } finally { await page.close(); await b.close(); await a.close(); await rm(root, { recursive: true, force: true }); }
});
