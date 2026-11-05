import { setListOption } from "./fixtures/mobile.js";
import { expectListOption } from './fixtures/mobile.js';
import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { HubServer } from '../../src/hub/server.js';
import { deviceProof, hashSecret, type AuthSession } from '../../src/hub/auth.js';
import { deviceActionProofText } from '../../src/client-protocol/device-actions.js';
import { networkCanonical, networkCommandSchema, type NetworkCommandInput, type SignedNetworkPeerRequest } from '../../src/client-protocol/private-network.js';
import { createServer } from './fixtures/vite.js';
import { clickAppAction } from './fixtures/desktop-actions.js';
import { openMobileHome, showDisconnectedBots } from './fixtures/mobile.js';

test.use({serviceWorkers:'block', ignoreHTTPSErrors:true});
const visible = (page:Page) => page.locator('.host-workspace:not([hidden])');
type Actor = { privateKey:KeyObject; token:string; session:AuthSession };
async function owner(hub:HubServer):Promise<Actor> {
  const keys=generateKeyPairSync('ed25519'), publicKey=keys.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const id='fixture_owner', pair=await hub.auth.pair({deviceId:id,name:'Fixture owner',publicKey,platform:'web'},'127.0.0.1');
  await hub.auth.approveLocalDesktop(pair.code);
  const clientNonce=randomBytes(32).toString('base64url'), socket=randomBytes(16).toString('hex');
  const challenge=await hub.auth.challenge(socket,id,clientNonce,'127.0.0.1');
  const {token}=await hub.auth.authenticate(socket,sign(null,deviceProof(id,challenge.nonce,clientNonce),keys.privateKey).toString('base64'));
  return {privateKey:keys.privateKey,token,session:await hub.auth.authorize(token)};
}
async function mutate(hub:HubServer, actor:Actor, raw:NetworkCommandInput) {
  const networkId=(await hub.network.view()).membership?.manifest.id ?? '';
  const command=networkCommandSchema.parse(['routes','attest','leave','remove'].includes(raw.operation)?{networkId,...raw}:raw);
  const statement=await hub.auth.prepareDeviceAction({operation:'network',target:hashSecret(networkCanonical(command))},actor.token,actor.session);
  return hub.network.command(command,actor.session,{nonce:statement.nonce,signature:sign(null,Buffer.from(deviceActionProofText(statement)),actor.privateKey).toString('base64')});
}
async function join(a:HubServer, aa:Actor, b:HubServer, ba:Actor) {
  const m=(await a.network.view()).membership!.manifest;
  const {proposal}=await mutate(b,ba,{operation:'propose',networkId:m.id,authorityKey:m.authorityKey,seenManifestHash:hashSecret(networkCanonical(m))});
  const {membership}=await mutate(a,aa,{operation:'admit',proposal:proposal!});
  await mutate(b,ba,{operation:'join',membership:membership!,nonce:proposal!.proposal.nonce});
}

async function appNetworkFixture(names: string[], managedBots = false) {
  const directory=await mkdtemp(path.join(tmpdir(),'network-app-'));
  const vite=await createServer({server:{host:'127.0.0.1',port:0,hmr:false}}); await vite.listen();
  const origin=vite.resolvedUrls!.local[0]!;
  const address=Object.values(networkInterfaces()).flat().find(value=>value?.family==='IPv4' && !value.internal)!.address;
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout','tls.key','-out','tls.crt','-days','1','-subj','/CN=TaroBird disposable test','-addext',`subjectAltName=IP:${address}`,'-addext','basicConstraints=critical,CA:TRUE'],{cwd:directory,stdio:'ignore'});
  const tls={key:await readFile(path.join(directory,'tls.key')),cert:await readFile(path.join(directory,'tls.crt'))};
  const ca=new X509Certificate(tls.cert).raw.toString('base64');
  const hubs:HubServer[]=[], actors:Actor[]=[];
  try {
    for (const name of names) {
      const hub=await HubServer.start({stateDir:path.join(directory,name),host:address,exposure:'public',tls,origins:[new URL(origin).origin],
        ...(managedBots ? { managedBots: { entrypoint: path.resolve('../tests/fixtures/managed-bot-worker.mjs'), env: { PATH: '', CODEX_EXECUTABLE: process.execPath } } } : {}) }); hubs.push(hub);
      const actor=await owner(hub); actors.push(actor);
      await hub.profile.update({name,revision:(await hub.profile.read()).revision});
      await mutate(hub,actor,{operation:'routes',routes:[{name:'Direct',url:hub.url,certificateAuthority:ca}]});
      await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('same_bot','网络助手','fixture')");
      await hub.store.db.run("INSERT INTO conversations(id,type,title,owner_id,created_at,client_action_id) VALUES('same_chat','direct','同名对话','owner',1,'same_action')");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','user','owner',0)");
      await hub.store.db.run("INSERT INTO conversation_members VALUES('same_chat','bot','same_bot',0)");
      await hub.store.publishBotMessage('same_bot',{id:'same_message',conversationId:'same_chat',status:'complete',blocks:[{type:'text',text:`来自${name}`} ]});
    }
    return { origin, hubs, actors, close: async () => { await Promise.allSettled(hubs.map(hub=>hub.close())); await vite.close(); await rm(directory,{recursive:true,force:true}); } };
  } catch (error) { await Promise.allSettled(hubs.map(hub=>hub.close())); await vite.close(); await rm(directory,{recursive:true,force:true}); throw error; }
}

test('one approved device discovers three real TLS Hubs, keeps keys and messages isolated, and retains control without coordinator',async({page},info)=>{
  test.setTimeout(150_000);
  const fixture=await appNetworkFixture(['主机一','主机二','主机三']);
  const {hubs,actors,origin}=fixture;
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  try {
    const [a,b,c]=hubs as [HubServer,HubServer,HubServer];
    await mutate(a,actors[0]!,{operation:'create',name:'我的测试网络'});
    await join(a,actors[0]!,b,actors[1]!); await join(a,actors[0]!,c,actors[2]!);
    await page.goto(origin);
    await page.getByLabel('Hub 地址',{exact:true}).fill(a.url);
    await preparePairing(page, a); await page.getByRole('button',{name:'配对此设备',exact:true}).click();
    await a.auth.approve(await page.getByLabel('配对码',{exact:true}).innerText(),'local-owner');
    await page.getByLabel('配对码',{exact:true}).waitFor({state:'hidden'}); await showDisconnectedBots(page);
    await setListOption(page, '按主机分组', true);
    for(const name of ['主机一','主机二','主机三']) await expect(visible(page).getByRole('region',{name:`主机：${name}`,exact:true}).locator('.host-heading')).toHaveAttribute('aria-label',`${name}，已连接`,{timeout:30000});
    const manifest=(await a.network.view()).membership!.manifest;
    const automatic=manifest.devices.filter(d=>d.id!=='fixture_owner' && !d.revoked);
    expect(automatic).toHaveLength(3);
    expect(new Set(automatic.map(d=>d.publicKey)).size).toBe(3);
    expect(new Set(automatic.map(d=>d.memberId)).size).toBe(1);
    const choose=async(name:string)=>{await visible(page).getByRole('region',{name:`主机：${name}`,exact:true}).getByRole('button',{name:/^同名对话/}).click();};
    await choose('主机二');
    await expect(visible(page).locator('.message-blocks')).toContainText('来自主机二');
    await visible(page).getByRole('textbox',{name:'消息',exact:true}).fill('只发送给主机二');
    await choose('主机三');
    await expect(visible(page).getByRole('textbox',{name:'消息',exact:true})).toHaveValue('');
    await choose('主机二');
    await expect(visible(page).getByRole('textbox',{name:'消息',exact:true})).toHaveValue('只发送给主机二');
    await visible(page).getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(async()=> (await b.store.snapshot('owner','same_chat')).messages.some(m=>m.authorType==='user')).toBe(true);
    for(const other of [a,c]) expect((await other.store.snapshot('owner','same_chat')).messages.some(m=>m.authorType==='user')).toBe(false);
    await clickAppAction(page,'新建 Bot');
    const chooser=page.getByRole('dialog',{name:'选择运行主机',exact:true});
    await chooser.getByRole('button',{name:/主机三/}).click();
    await expect(page.getByRole('dialog',{name:'新建 Bot',exact:true})).toContainText('运行于 主机三');
    await page.keyboard.press('Escape');
    await page.screenshot({path:info.outputPath('three-host-network.png')});
    await page.reload();
    await expect(visible(page).getByRole('region',{name:'主机：主机二',exact:true}).locator('.host-heading')).toHaveAttribute('aria-label','主机二，已连接');
    await a.close();
    await choose('主机二');
    await visible(page).getByRole('textbox',{name:'消息',exact:true}).fill('协调主机离线仍可发送');
    await visible(page).getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(async()=> (await b.store.snapshot('owner','same_chat')).messages.filter(m=>m.authorType==='user').length).toBe(2);
    await clickAppAction(page,'新建 Bot');
    await expect(chooser.getByRole('button',{name:/主机一/})).toBeDisabled(); await page.keyboard.press('Escape');
    await page.setViewportSize({width:390,height:844});
    await visible(page).getByRole('button',{name:'打开会话列表',exact:true}).click();
    // Grouping stays enabled across desktop/phone layouts. Source names belong
    // to section headings, rather than being repeated on each conversation.
    for (const name of ['主机二','主机三']) await expect(visible(page).locator('.mobile-home').getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(visible(page).locator('.mobile-home .mh-folder-host .host-source-badge')).toHaveCount(0);
    await page.screenshot({path:info.outputPath('phone-network.png')});
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

/** Read the real per-host IndexedDB records after ordinary UI interactions. */
async function browserHosts(page: Page) {
  return page.evaluate(async () => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const read = <T,>(db: IDBDatabase, store: string, key?: string) => new Promise<T>((resolve, reject) => { const object = db.transaction(store).objectStore(store), request = key === undefined ? object.getAll() : object.get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const db = await open('tarocub-hosts-v1');
    const records = await read<{id:string;name:string;publicKey:string;deviceId:string;databaseName:string;networkId?:string;networkAuthority?:string;origin?:string;networkBlocked?:boolean}[]>(db, 'hosts'); db.close();
    return Promise.all(records.map(async host => {
      const cache = await open(host.databaseName);
      try {
        const [identity, membership, draft] = await Promise.all([
          read<{deviceId:string;publicKey:string}>(cache, 'settings', 'identity'),
          read<{manifest:{id:string;authorityKey:string;revision:number}} | undefined>(cache, 'settings', 'networkMembership'),
          read<string | undefined>(cache, 'settings', 'draft:same_chat'),
        ]);
        return { ...host, deviceKey: identity.publicKey, pin: membership?.manifest, draft: draft ?? '' };
      } finally { cache.close(); }
    }));
  });
}

test('a network change made on another device requires review, then enrolls the coordinator through member proof without losing drafts', async ({ page }, info) => {
  test.setTimeout(150_000);
  const fixture = await appNetworkFixture(['主机 A', '主机 B']);
  const [a, b] = fixture.hubs as [HubServer, HubServer], [aa, ba] = fixture.actors as [Actor, Actor];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await mutate(a, aa, { operation: 'create', name: '新的统一网络' });
    await mutate(b, ba, { operation: 'create', name: '原来的 B 网络' });
    const previousId = (await b.network.view()).membership!.manifest.id;
    const nextId = (await a.network.view()).membership!.manifest.id;
    await page.goto(fixture.origin);
    await page.getByLabel('Hub 地址', { exact: true }).fill(b.url);
    await preparePairing(page, b); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await b.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
    await expect.poll(async () => (await browserHosts(page)).find(host => host.publicKey === b.auth.publicKey)?.pin?.id, { timeout: 30000 }).toBe(previousId);
    expect(await browserHosts(page)).toHaveLength(1);
    await visible(page).getByRole('button', { name: /^同名对话/ }).click();
    await expect(visible(page).locator('.message-blocks')).toContainText('来自主机 B');
    await visible(page).getByRole('textbox', { name: '消息', exact: true }).fill('换网之前尚未发送的 B 草稿');
    await expect.poll(async () => (await browserHosts(page))[0]!.draft).toBe('换网之前尚未发送的 B 草稿');
    const original = (await browserHosts(page))[0]!;

    // A different authorized device changes B on the real Hubs. The browser
    // keeps its existing B identity and receives no manual pairing for A.
    const forwarded: SignedNetworkPeerRequest[] = [], receivePeer = a.network.peer.bind(a.network);
    a.network.peer = async (raw, source) => { const value = raw as SignedNetworkPeerRequest; if (value.request?.attest) forwarded.push(value); return receivePeer(raw, source); };
    await join(a, aa, b, ba);
    await expect.poll(async () => (await b.network.view()).membership?.manifest.authorityKey).toBe(a.auth.publicKey);
    await expect(page.locator('.network-change-notice')).toBeVisible({ timeout: 30000 });
    for (const viewport of [{ width: 1360, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toBeVisible();
      const geometry = await page.evaluate(() => {
        const workspace = document.querySelector('.host-workspace:not([hidden])')!;
        const rect = (selector: string, root: ParentNode = workspace) => {
          const box = root.querySelector(selector)!.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
        };
        return { viewport: { width: innerWidth, height: innerHeight }, notice: rect('.network-change-notice', document), header: rect('.conversation-header'), messages: rect('.message-scroll'), composer: rect('.composer-wrap') };
      });
      await info.attach(`network-notice-${viewport.width}-geometry`, { body: JSON.stringify(geometry), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath(`network-notice-${viewport.width}.png`) });
      expect.soft(geometry.composer.bottom, `Composer remains inside ${viewport.width}px viewport: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(viewport.height + 1);
      expect.soft(geometry.header.bottom, 'Network notice follows the chat header').toBeLessThanOrEqual(geometry.notice.top + 1);
      expect.soft(geometry.notice.bottom, 'Network notice does not cover message content').toBeLessThanOrEqual(geometry.messages.top + 1);
      expect.soft(geometry.notice.left).toBeGreaterThanOrEqual(geometry.header.left - 1);
      expect.soft(geometry.notice.right).toBeLessThanOrEqual(geometry.header.right + 1);
    }
    await visible(page).getByRole('button', { name: '打开会话列表', exact: true }).click();
    await expect(visible(page).locator('.mh-tabbar')).toBeVisible();
    await expect(page.locator('.network-change-notice')).toHaveCount(1);
    const homeGeometry = await visible(page).locator('.mobile-home').evaluate(home => {
      const rect = (selector: string) => {
        const box = home.querySelector(selector)!.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      };
      return { header: rect('.mh-header'), notice: rect('.network-change-notice'), body: rect('.mh-body'), tabs: rect('.mh-tabbar'), height: innerHeight };
    });
    await info.attach('network-notice-mobile-home-geometry', { body: JSON.stringify(homeGeometry), contentType: 'application/json' });
    expect(homeGeometry.header.bottom).toBeLessThanOrEqual(homeGeometry.notice.top + 1);
    expect(homeGeometry.notice.bottom).toBeLessThanOrEqual(homeGeometry.body.top + 1);
    expect(homeGeometry.body.bottom).toBeLessThanOrEqual(homeGeometry.tabs.top + 1);
    expect(homeGeometry.tabs.bottom).toBeLessThanOrEqual(homeGeometry.height + 1);
    await visible(page).locator('.mobile-home').getByRole('button', { name: /同名对话/ }).click();
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('换网之前尚未发送的 B 草稿');
    await page.setViewportSize({ width: 1360, height: 900 });
    expect((await browserHosts(page))[0]!.pin!.id).toBe(previousId);
    expect(await browserHosts(page)).toHaveLength(1);

    await page.locator('.network-change-notice').getByRole('button', { name: '查看变更', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '设备与网络', exact: true });
    await expect(manager.getByText('主机 B · 主机的网络已变更', { exact: true })).toBeVisible();
    await manager.getByRole('button', { name: '查看变更', exact: true }).click();
    const review = page.getByRole('dialog', { name: '查看网络变更', exact: true });
    await expect(review).toContainText('新的统一网络');
    await expect(review).toContainText('主机 A'); await expect(review).toContainText('主机 B');
    await expect(review.getByRole('button', { name: '确认变更', exact: true })).toBeDisabled();
    await review.getByRole('checkbox', { name: '确认使用这个网络及其已授权设备', exact: true }).check();
    await review.getByRole('button', { name: '确认变更', exact: true }).click();
    await expect(review).not.toBeVisible();
    await manager.getByRole('button', { name: '关闭设备与网络', exact: true }).click();
    await expect(page.locator('.network-change-notice')).not.toBeVisible();
    await setListOption(page, '按主机分组', true);
    for (const name of ['主机 A', '主机 B']) await expect(visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).locator('.host-heading')).toHaveAttribute('aria-label', `${name}，已连接`, { timeout: 30000 });

    // Connected UI state can precede the serialized identity/manifest save.
    await expect.poll(async () => {
      const saved = await browserHosts(page);
      return saved.length === 2 && saved.every(host => host.pin?.id === nextId && host.pin.authorityKey === a.auth.publicKey && host.networkId === nextId && host.networkAuthority === a.auth.publicKey);
    }).toBe(true);
    const after = await browserHosts(page), browserB = after.find(host => host.publicKey === b.auth.publicKey)!, browserA = after.find(host => host.publicKey === a.auth.publicKey)!;
    expect(after).toHaveLength(2);
    expect(browserB.deviceId).toBe(original.deviceId); expect(browserB.deviceKey).toBe(original.deviceKey);
    expect(browserA.deviceKey).not.toBe(browserB.deviceKey);
    expect(after.every(host => host.pin?.id === nextId && host.pin.authorityKey === a.auth.publicKey && host.networkId === nextId && host.networkAuthority === a.auth.publicKey)).toBe(true);
    expect(browserB.origin).toBe('paired'); expect(browserA.origin).toBe('network');
    const proof = forwarded.find(value => value.request.attest!.sourceDeviceId === browserB.deviceId && value.request.attest!.device.host === a.auth.publicKey);
    expect(proof).toBeDefined();
    expect(proof!.request.publicKey).toBe(b.auth.publicKey);
    expect(proof!.request.attest!.statement.hubPublicKey).toBe(b.auth.publicKey);
    expect(proof!.request.attest!.statement.deviceId).toBe(browserB.deviceId);
    expect(proof!.request.attest!.proof.nonce).toBe(proof!.request.attest!.statement.nonce);
    const members = (await a.network.view()).membership!.manifest.devices.filter(item => item.id === browserA.deviceId || item.id === browserB.deviceId);
    expect(members).toHaveLength(2); expect(new Set(members.map(item => item.memberId)).size).toBe(1);
    expect(members.every(item => item.originHost === b.auth.publicKey && item.attestedBy === b.auth.publicKey && !item.revoked)).toBe(true);

    const choose = async (name: string) => visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).getByRole('button', { name: /^同名对话/ }).click();
    await choose('主机 A'); await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
    await choose('主机 B'); await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('换网之前尚未发送的 B 草稿');
    await expect(visible(page).locator('.message-blocks')).toContainText('来自主机 B');
    await page.screenshot({ path: info.outputPath('reviewed-network-change.png') });
    await page.reload();
    await setListOption(page, '按主机分组', true);
    for (const name of ['主机 A', '主机 B']) await expect(visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).locator('.host-heading')).toHaveAttribute('aria-label', `${name}，已连接`, { timeout: 30000 });
    await expect(page.locator('.network-change-notice')).not.toBeVisible();
    const reopened = await browserHosts(page);
    expect(reopened.every(host => host.pin?.id === nextId && host.networkId === nextId && host.networkAuthority === a.auth.publicKey)).toBe(true);
    expect(reopened.find(host => host.publicKey === b.auth.publicKey)!.deviceId).toBe(original.deviceId);
    await choose('主机 B'); await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('换网之前尚未发送的 B 草稿');
    await expect(visible(page).locator('.message-blocks')).toContainText('来自主机 B');
    await visible(page).getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await b.store.snapshot('owner', 'same_chat')).messages.some(message => message.authorType === 'user')).toBe(true);
    expect((await a.store.snapshot('owner', 'same_chat')).messages.some(message => message.authorType === 'user')).toBe(false);
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('an unfinished candidate from a previous network is replaced only after its real TLS host confirms the new membership', async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await appNetworkFixture(['新协调主机', '待重新发现主机']);
  const [a, b] = fixture.hubs as [HubServer, HubServer], [aa, ba] = fixture.actors as [Actor, Actor];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await mutate(a, aa, { operation: 'create', name: '新网络' });
    await mutate(b, ba, { operation: 'create', name: '旧网络' });
    const old = (await b.network.view()).membership!.manifest;
    await page.goto(fixture.origin);
    const pending = await page.evaluate(async ({ networkId, authorityKey, host }) => {
      const { HostRegistry } = await import('/src/host-registry.ts');
      const { createIdentity } = await import('/src/identity.ts');
      const registry = new HostRegistry();
      try {
        const identity = { ...await createIdentity('尚未完成配对的设备', host.routes), hubPublicKey: host.publicKey };
        const candidate = await registry.networkCandidate(networkId, authorityKey, host, async () => identity);
        return { deviceId: candidate!.identity.deviceId, publicKey: candidate!.identity.publicKey };
      } finally { registry.close(); }
    }, { networkId: old.id, authorityKey: old.authorityKey, host: old.hosts.find(host => host.publicKey === b.auth.publicKey)! });
    await mutate(b, ba, { operation: 'leave', expectedState: 'active' }); await join(a, aa, b, ba);
    const received: { manifest: { id: string; devices: { id: string; publicKey: string }[] } }[] = [];
    const enroll = b.network.enroll.bind(b.network);
    b.network.enroll = async raw => { received.push(raw as typeof received[number]); return enroll(raw); };
    await page.getByLabel('Hub 地址', { exact: true }).fill(a.url);
    await preparePairing(page, a); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await a.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
    await setListOption(page, '按主机分组', true);
    for (const name of ['新协调主机', '待重新发现主机']) await expect(visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).locator('.host-heading')).toHaveAttribute('aria-label', `${name}，已连接`, { timeout: 30000 });
    const records = await browserHosts(page), root = records.find(host => host.publicKey === a.auth.publicKey)!, peer = records.find(host => host.publicKey === b.auth.publicKey)!;
    expect(records).toHaveLength(2); expect(peer.origin).toBe('network');
    expect(peer.deviceId).not.toBe(pending.deviceId); expect(peer.deviceKey).not.toBe(pending.publicKey); expect(peer.deviceKey).not.toBe(root.deviceKey);
    expect(peer.networkId).toBe((await a.network.view()).membership!.manifest.id);
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received[0]!.manifest.id).toBe(peer.networkId);
    expect(received[0]!.manifest.devices.some(device => device.id === peer.deviceId)).toBe(false);
    expect(received.some(value => value.manifest.devices.some(device => device.id === peer.deviceId && device.publicKey === peer.deviceKey))).toBe(true);
    expect(await b.store.device(pending.deviceId)).toBeUndefined();
    expect((await b.store.device(peer.deviceId))?.public_key).toBe(peer.deviceKey);
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('tarocub-hosts-v1'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
      try { return await new Promise<number>((resolve, reject) => { const count = db.transaction('networkCandidates').objectStore('networkCandidates').count(); count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error); }); }
      finally { db.close(); }
    })).toBe(0);
    await visible(page).getByRole('region', { name: '主机：待重新发现主机', exact: true }).getByRole('button', { name: /^同名对话/ }).click();
    await expect(visible(page).locator('.message-blocks')).toContainText('来自待重新发现主机');
    await page.reload();
    await expect(visible(page).getByRole('region', { name: '主机：待重新发现主机', exact: true }).locator('.host-heading')).toHaveAttribute('aria-label', '待重新发现主机，已连接');
    expect((await browserHosts(page)).find(host => host.publicKey === b.auth.publicKey)!.deviceId).toBe(peer.deviceId);
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('a phone first paired to C keeps A/B and its drafts after C leaves, then explicitly pairs C as an independent host', async ({ page }, info) => {
  test.setTimeout(180_000);
  const fixture = await appNetworkFixture(['主机 A', '主机 B', '主机 C'], true);
  const [a, b, c] = fixture.hubs as [HubServer, HubServer, HubServer];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const choose = async (name: string) => visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).getByRole('button', { name: /^同名对话/ }).click();
  const connected = async (name: string) => expect(visible(page).getByRole('region', { name: `主机：${name}`, exact: true }).locator('.host-heading')).toHaveAttribute('aria-label', `${name}，已连接`, { timeout: 30000 });
  try {
    const otherHistory = await c.store.createConversation('owner', ['same_bot'], 'C 的另一段历史', 'retained_second');
    await c.store.publishBotMessage('same_bot', { conversationId: otherHistory.id, blocks: [{ type: 'text', text: '停用后仍可选择的另一段历史' }] });
    await mutate(a, fixture.actors[0]!, { operation: 'create', name: '手机保留的 A/B 网络' });
    await join(a, fixture.actors[0]!, b, fixture.actors[1]!); await join(a, fixture.actors[0]!, c, fixture.actors[2]!);
    await page.goto(fixture.origin);
    await page.getByLabel('Hub 地址', { exact: true }).fill(c.url);
    await preparePairing(page, c); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await c.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
    await setListOption(page, '按主机分组', true);
    for (const name of ['主机 A', '主机 B', '主机 C']) await connected(name);
    const networkId = (await a.network.view()).membership!.manifest.id;
    await expect.poll(async () => (await browserHosts(page)).filter(host => host.pin?.id === networkId).length, { timeout: 30000 }).toBe(3);
    for (const name of ['主机 A', '主机 B', '主机 C']) {
      await choose(name);
      await visible(page).getByRole('textbox', { name: '消息', exact: true }).fill(`${name} 退出前的未发送草稿`);
    }
    await expect.poll(async () => (await browserHosts(page)).every(host => host.draft === `${host.name} 退出前的未发送草稿`)).toBe(true);
    const original = await browserHosts(page), oldC = original.find(host => host.publicKey === c.auth.publicKey)!;
    const residentBots = await c.store.bots('owner'), residentHistory = (await c.store.snapshot('owner', 'same_chat')).messages;

    await clickAppAction(page, '设备与网络');
    const overview = page.getByRole('dialog', { name: '设备与网络', exact: true });
    await page.screenshot({ path: info.outputPath('desktop-network-overview.png'), animations: 'disabled' });
    await overview.locator('.network-member').filter({ hasText: '主机 C' }).click();
    await page.getByRole('dialog', { name: '主机 C', exact: true }).getByRole('button', { name: '退出网络', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '让「主机 C」退出网络？', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('desktop-network-leave-confirmation.png'), animations: 'disabled' });
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await overview.getByRole('button', { name: '关闭设备与网络', exact: true }).click();

    // This actor is the trusted local desktop controller, not the phone whose
    // original pairing happened to be made on C.
    await mutate(c, fixture.actors[2]!, { operation: 'leave', expectedState: 'active' });
    await expect.poll(async () => (await browserHosts(page)).find(host => host.publicKey === c.auth.publicKey)?.networkBlocked, { timeout: 30000 }).toBe(true);
    for (const name of ['主机 A', '主机 B']) await connected(name);
    await expect(visible(page).getByRole('region', { name: '主机：主机 C', exact: true })).toHaveCount(0);
    const retained = await browserHosts(page);
    expect(retained).toHaveLength(3);
    for (const host of retained.filter(host => host.publicKey !== c.auth.publicKey)) {
      expect(host.networkBlocked).not.toBe(true); expect(host.pin?.id).toBe(networkId);
      expect(host.deviceId).toBe(original.find(value => value.publicKey === host.publicKey)!.deviceId);
      expect(host.draft).toBe(`${host.name} 退出前的未发送草稿`);
    }
    expect(retained.find(host => host.publicKey === c.auth.publicKey)!.draft).toBe('主机 C 退出前的未发送草稿');
    expect((await c.store.device(oldC.deviceId))?.revoked).toBe(1);
    expect((await c.store.device(fixture.actors[2]!.session.deviceId))?.revoked).toBe(0);
    expect(await c.store.bots('owner')).toEqual(residentBots);
    expect((await c.store.snapshot('owner', 'same_chat')).messages).toEqual(residentHistory);

    await choose('主机 A');
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('主机 A 退出前的未发送草稿');
    await visible(page).getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await a.store.snapshot('owner', 'same_chat')).messages.some(message => message.authorType === 'user')).toBe(true);
    await a.store.publishBotMessage('same_bot', { conversationId: 'same_chat', blocks: [{ type: 'text', text: 'C 退出后仍能收到 A 的回复' }] });
    await expect(visible(page).locator('.message-blocks').filter({ hasText: 'C 退出后仍能收到 A 的回复' })).toBeVisible();
    for (const name of ['主机 A', '主机 B']) {
      await clickAppAction(page, '新建 Bot');
      const chooser = page.getByRole('dialog', { name: '选择运行主机', exact: true });
      await expect(chooser.getByRole('button', { name: /主机 C/ })).toHaveCount(0);
      await chooser.getByRole('button', { name: new RegExp(name) }).click();
      const creation = page.getByRole('dialog', { name: '新建 Bot', exact: true });
      await creation.getByLabel('Bot 名称', { exact: true }).fill(`${name} 退出后新建`);
      await creation.getByRole('button', { name: '创建 Bot', exact: true }).click();
      await expect(creation).toContainText('Bot 已上线，可以开始对话。', { timeout: 15000 });
      await page.keyboard.press('Escape');
    }
    for (const target of [a, b]) expect((await target.store.bots('owner')).some(bot => bot.name.endsWith('退出后新建') && bot.online === 1)).toBe(true);
    expect(await c.store.bots('owner')).toEqual(residentBots);

    await page.setViewportSize({ width: 390, height: 844 });
    await visible(page).getByRole('button', { name: '打开会话列表', exact: true }).click();
    const home = visible(page).locator('.mobile-home');
    const bRecord = retained.find(host => host.publicKey === b.auth.publicKey)!;
    await expect(home.locator(`.mh-row[data-host-id="${oldC.id}"]`)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('phone-ab-list-after-c-leaves.png'), animations: 'disabled' });
    await home.locator(`.mh-row[data-host-id="${bRecord.id}"][data-conversation-id="same_chat"]`).click();
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('主机 B 退出前的未发送草稿');
    await visible(page).getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await b.store.snapshot('owner', 'same_chat')).messages.some(message => message.authorType === 'user')).toBe(true);
    await b.store.publishBotMessage('same_bot', { conversationId: 'same_chat', blocks: [{ type: 'text', text: '手机继续接收 B 的回复' }] });
    await expect(visible(page).locator('.message-blocks').filter({ hasText: '手机继续接收 B 的回复' })).toBeVisible();
    await visible(page).getByRole('textbox', { name: '消息', exact: true }).fill('重新配对 C 时保留的 B 草稿');
    await page.screenshot({ path: info.outputPath('phone-after-c-leaves.png'), animations: 'disabled' });

    await page.setViewportSize({ width: 1360, height: 900 });
    await setListOption(page, '显示未连接 Bot', false);
    await clickAppAction(page, '设备与网络');
    await page.getByRole('dialog', { name: '设备与网络', exact: true }).getByRole('button', { name: '此设备的连接', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '此设备的连接', exact: true });
    await manager.locator('.host-manager-row').filter({ has: page.getByText('主机 C', {exact:true}) }).getByRole('button', { name: '查看历史记录', exact: true }).click();
    await expect(visible(page).getByText('这是已停用连接的本机历史。历史和草稿保留。', { exact: true })).toBeVisible();
    await expect(visible(page).locator('.message-blocks')).toContainText('来自主机 C');
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('主机 C 退出前的未发送草稿');
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveAttribute('readonly', '');
    await expect(visible(page).getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await expectListOption(page, '显示未连接 Bot', false);
    for (const group of [false, true]) {
      await setListOption(page, '按主机分组', group);
      for (const layout of ['按 Bot', '按对话']) {
        await visible(page).locator('.sidebar').getByRole('button', { name: layout, exact: true }).click();
        await expect(visible(page).locator(`.sidebar [data-conversation-id="${otherHistory.id}"]`)).toBeVisible();
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await openMobileHome(page);
    const historyHome = visible(page).locator('.mobile-home');
    await expectListOption(page, '显示未连接 Bot', false);
    await historyHome.locator(`.mh-row[data-conversation-id="${otherHistory.id}"]`).click();
    await expect(visible(page).locator('.message-blocks')).toContainText('停用后仍可选择的另一段历史');
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveAttribute('readonly', '');
    await openMobileHome(page); await historyHome.locator('.mh-row[data-conversation-id="same_chat"]').click();
    await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('主机 C 退出前的未发送草稿');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.screenshot({ path: info.outputPath('departed-c-readonly-history.png'), animations: 'disabled' });
    await visible(page).locator('.sidebar').getByRole('button', { name: '按 Bot', exact: true }).click();
    await showDisconnectedBots(page);
    await choose('主机 B');
    await expect(visible(page).getByRole('region', { name: '主机：主机 C', exact: true })).toHaveCount(0);
    await clickAppAction(page, '设备与网络');
    await page.getByRole('dialog', { name: '设备与网络', exact: true }).getByRole('button', { name: '此设备的连接', exact: true }).click();
    await manager.locator('.host-manager-row').filter({ has: page.getByText('主机 C', {exact:true}) }).getByRole('button', { name: '从此设备移除', exact: true }).click();
    const removal = page.getByRole('dialog', { name: '从此设备移除「主机 C」？', exact: true });
    await expect(removal).toContainText('1 份草稿');
    await removal.getByRole('checkbox').check();
    await removal.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect.poll(async () => (await browserHosts(page)).length).toBe(2);
    await manager.getByRole('button', { name: '连接另一台主机', exact: true }).click();
    await page.getByLabel('Hub 地址', { exact: true }).fill(c.url);
    await preparePairing(page, c); await page.getByRole('button', { name: '配对此设备', exact: true }).click();
    await c.auth.approve(await page.getByLabel('配对码', { exact: true }).innerText(), 'local-owner');
    await page.getByLabel('配对码', { exact: true }).waitFor({ state: 'hidden' }); await showDisconnectedBots(page);
    await setListOption(page, '按主机分组', true);
    for (const name of ['主机 A', '主机 B', '主机 C']) await connected(name);
    const rejoined = await browserHosts(page), freshC = rejoined.find(host => host.publicKey === c.auth.publicKey)!;
    expect(freshC.deviceId).not.toBe(oldC.deviceId); expect(freshC.deviceKey).not.toBe(oldC.deviceKey);
    expect(freshC.networkBlocked).not.toBe(true); expect(freshC.pin).toBeUndefined(); expect(freshC.networkId).toBeUndefined();
    expect((await c.network.view()).membership).toBeUndefined();
    expect((await c.store.device(oldC.deviceId))?.revoked).toBe(1);
    expect((await a.network.view()).membership!.manifest.devices.some(device => device.id === freshC.deviceId)).toBe(false);
    await choose('主机 C'); await expect(visible(page).locator('.message-blocks')).toContainText('来自主机 C');
    await visible(page).getByRole('textbox', { name: '消息', exact: true }).fill('只发给重新配对的独立 C');
    await visible(page).getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await c.store.snapshot('owner', 'same_chat')).messages.some(message => message.authorType === 'user')).toBe(true);
    await choose('主机 B'); await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('重新配对 C 时保留的 B 草稿');
    await page.reload();
    await setListOption(page, '按主机分组', true);
    for (const name of ['主机 A', '主机 B', '主机 C']) await connected(name);
    await choose('主机 B'); await expect(visible(page).getByRole('textbox', { name: '消息', exact: true })).toHaveValue('重新配对 C 时保留的 B 草稿');
    expect((await browserHosts(page)).find(host => host.publicKey === c.auth.publicKey)!.pin).toBeUndefined();
    expect((await c.network.view()).membership).toBeUndefined();
    expect(errors).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});
