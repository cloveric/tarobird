// Disposable peer for PairingJourneyTest. No user host, fleet or model accounts.
import { HubServer } from '../../dist/src/hub/server.js';
import { desktopTls } from '../../dist/src/hub/desktop-tls.js';
import { loadHubTls } from '../../dist/src/hub/tls.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { deviceProof } from '../../dist/src/hub/auth.js';
import QRCode from '../node_modules/qrcode/lib/index.js';
const output = path.resolve(process.argv[2]); await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'android-pairing-peer-'));
const tls = await loadHubTls(await desktopTls(root, ['10.0.2.2', '127.0.0.1']));
const certificateAuthority = (await desktopTls(root, ['10.0.2.2', '127.0.0.1'])).certificateAuthority;
let hub = await HubServer.start({ stateDir: root, host: '0.0.0.0', port: 0, exposure: 'public', tls });
const port = Number(new URL(hub.url).port), publicKey = hub.auth.publicKey;
// Bootstrap a trusted, isolated fixture owner, then use the same bounded
// invitation required by the public pairing flow. Never weaken /api/pair.
const ownerKeys = generateKeyPairSync('ed25519');
const ownerId = 'android_fixture_owner';
const owner = await hub.auth.pair({ deviceId: ownerId, name: 'Fixture owner', platform: 'web', publicKey: ownerKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, '127.0.0.1');
await hub.auth.approve(owner.code, 'local-owner');
const clientNonce = randomBytes(32).toString('base64url'), connection = 'fixture-owner-connection';
const challenge = await hub.auth.challenge(connection, ownerId, clientNonce, '127.0.0.1');
const login = await hub.auth.authenticate(connection, sign(null, deviceProof(ownerId, challenge.nonce, clientNonce), ownerKeys.privateKey).toString('base64'));
const invitation = await hub.auth.issuePairingInvite(await hub.auth.authorize(login.token, '127.0.0.1'), { requestId: randomBytes(32).toString('base64url') });
await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('acceptance','原生验收助手','isolated-disabled-secret')");
const conversation = await hub.store.createConversation('owner', ['acceptance'], '原生配对验收', 'native-pairing');
const typography = process.argv.includes('--typography') ? '\n\n## 核对结果 / Review\n\n正文与表格字号一致。**保留原始金额**，ready to review.\n\n| 项目 Item | 金额 Amount | 状态 Status |\n| --- | ---: | --- |\n| 酒店 Hotel | 1,041.28 | 待确认 Pending |\n| 电费 Utilities | 81.70 | 已核对 Checked |\n\n使用 `ledger.csv` 查看明细。\n\n> 待确认的记录暂不合并。\n\n```js\n// 核对金额 / Check totals\nconst status = "ready";\nfunction total() { return 1122.98; }\n```' : '';
await hub.store.publishBotMessage('acceptance', { conversationId: conversation.id, blocks: [{ type: 'text', text: '原生 TLS 聊天同步成功' + typography }] });
const control = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/approve') {
      const rows = await hub.store.db.all("SELECT platform FROM pairing_requests WHERE status='pending'");
      if (rows.length !== 1 || rows[0].platform !== 'android') throw Error('unexpected_pairing_subject');
      await hub.auth.approve(url.searchParams.get('code'), 'local-owner');
    } else if (url.pathname === '/restart') {
      await hub.close();
      hub = await HubServer.start({ stateDir: root, host: '0.0.0.0', port, exposure: 'public', tls });
    } else if (url.pathname === '/verify') {
      let accepted = 0;
      for (let n = 0; n < 60; n++) {
        accepted = (await hub.store.db.get("SELECT count(*) AS n FROM audit_log WHERE kind='auth.accepted'")).n;
        if (accepted >= 3) break;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const devices = await hub.store.devices('owner');
      if (devices.filter(device => device.platform === 'android').length !== 1 || devices.length !== 2 || accepted < 3) throw Error('authentication_or_identity_not_preserved');
      await writeFile(path.join(output, 'native-pairing-result.json'), JSON.stringify({ platform: 'Android emulator API 36', surface: 'packaged WebView, native Capacitor transport and signing', approvedDevices: devices.filter(device => device.platform === 'android').length, fixtureOwners: 1, acceptedHandshakes: accepted, pairingReload: 'passed', chatSync: 'passed', hostRestart: 'passed', physicalPhone: 'not tested', gatewayEngine: 'not used by this pairing test' }, null, 2));
    } else throw Error('unknown_control');
    res.writeHead(200); res.end('ok');
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
const payload = { v: 1, kind: 'connect', hubPublicKey: publicKey, routes: [{ name: 'Direct', url: `https://10.0.2.2:${port}`, certificateAuthority }], deployment: 'computer' };
const link = 'tarocub://pair?data=' + encodeURIComponent(JSON.stringify(payload)) + '&invite=' + invitation.invite;
const qr = (await QRCode.toDataURL(link, { scale: 3, margin: 4, errorCorrectionLevel: 'M' })).split(',')[1];
await writeFile(path.join(output, 'fixture.json'), JSON.stringify({ qr, link, controlPort: control.address().port }));
console.log('Isolated Android pairing peer ready');
let closing = false;
async function close() { if (closing) return; closing = true; control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); await hub.close(); await rm(root, { recursive: true, force: true }); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
