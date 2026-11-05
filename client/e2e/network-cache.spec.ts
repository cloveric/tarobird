import { test, expect } from "@playwright/test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { networkGenesisText, networkManifestProof, type NetworkManifest, type SignedNetworkManifest } from "../../src/client-protocol/private-network.js";
import type { ClientCache, Identity } from "../src/storage.js";
import type { HostRegistry } from "../src/host-registry.js";
import type { HubConnection } from "../src/connection.js";
import type { NetworkSync } from "../src/network-sync.js";
import type { HostConnections } from "../src/host-connections.js";
import type { prepareLocalController, recoverLocalController } from "../src/local-controller.js";

const root = generateKeyPairSync("ed25519"), peer = generateKeyPairSync("ed25519"), device = generateKeyPairSync("ed25519");
const key = (pair: typeof root) => pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const rootKey = key(root), peerKey = key(peer), deviceKey = key(device), genesisNonce = randomBytes(32).toString("base64url");
const id = `net_${createHash("sha256").update(networkGenesisText(rootKey, genesisNonce)).digest("hex")}`;
const identity: Identity = { deviceId: "source_device", publicKey: deviceKey, hubPublicKey: rootKey, name: "Fixture", routes: [] };
function directory(revision = 3, changes: Partial<NetworkManifest> = {}): SignedNetworkManifest {
  const manifest: NetworkManifest = { v: 1, id, name: "Home", authorityKey: rootKey, genesisNonce, revision,
    hosts: [{ publicKey: rootKey, name: "Root", routes: [], state: "active", revoked: false }], devices: [], revokedMembers: [], blockedBindings: [], ...changes };
  return { manifest, signature: sign(null, Buffer.from(networkManifestProof(manifest)), root.privateKey).toString("base64") };
}
type Fixture = { recoverLocalController: typeof recoverLocalController; prepareLocalController: typeof prepareLocalController; ClientCache: typeof ClientCache; HostRegistry: typeof HostRegistry; HostConnections: typeof HostConnections; HubConnection: typeof HubConnection; NetworkSync: typeof NetworkSync; cache: ClientCache; identity: Identity; sync?: NetworkSync; syncDone?: Promise<void>; release?: () => void; snapshot?: () => Promise<unknown> };
const html = `<!doctype html><html><body><script type="module">
import {ClientCache} from '/src/storage.ts'; import {HostRegistry} from '/src/host-registry.ts'; import {HostConnections} from '/src/host-connections.ts'; import {HubConnection} from '/src/connection.ts'; import {NetworkSync} from '/src/network-sync.ts'; import {prepareLocalController,recoverLocalController} from '/src/local-controller.ts';
const identity=${JSON.stringify(identity)}; const cache=new ClientCache('network-cache-fixture'); await cache.initializeIdentity(identity);
window.networkCacheFixture={prepareLocalController,recoverLocalController,ClientCache,HostRegistry,HostConnections,HubConnection,NetworkSync,cache,identity};
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "network-cache-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__network_cache") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__network_cache", html)); });
  } }], server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__network_cache";
});
test.afterAll(async () => { await server.close(); });
test.beforeEach(async ({ page }) => { await page.goto(url); await page.waitForFunction(() => !!(window as unknown as { networkCacheFixture?: Fixture }).networkCacheFixture); });

test("verified directory survives reload with its exact revision and signature", async ({ page }) => {
  const value = directory();
  await page.evaluate(async value => { const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture; await f.cache.saveNetworkMembership(f.identity, value); }, value);
  await page.reload(); await page.waitForFunction(() => !!(window as unknown as { networkCacheFixture?: Fixture }).networkCacheFixture);
  expect(await page.evaluate(() => (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture.cache.networkMembership())).toEqual(value);
});

test("implicit refresh rejects root changes, network changes, clearing, rollback and equal-revision conflicts", async ({ page }) => {
  const initial = directory(), newer = directory(4), older = directory(2), conflict = directory(3, { name: "Conflicting directory" });
  const result = await page.evaluate(async ({ initial, newer, older, conflict }) => {
    const { cache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    await cache.saveNetworkMembership(identity, initial);
    const error = async (value?: SignedNetworkManifest) => { try { await cache.saveNetworkMembership(identity, value); return ""; } catch (e) { return (e as Error).message; } };
    const failures = await Promise.all([
      error({ ...initial, manifest: { ...initial.manifest, authorityKey: "changed-root" } }),
      error({ ...initial, manifest: { ...initial.manifest, id: "changed_network" } }), error(), error(older), error(conflict),
    ]);
    const untouched = await cache.networkMembership();
    await cache.saveNetworkMembership(identity, initial); await cache.saveNetworkMembership(identity, newer);
    return { failures, untouched, latest: await cache.networkMembership() };
  }, { initial, newer, older, conflict });
  expect(result).toEqual({ failures: ["network_membership_changed", "network_membership_changed", "network_membership_changed", "network_directory_stale", "network_directory_stale"], untouched: initial, latest: newer });
});

test("a higher revision cannot downgrade the accepted network protocol even after explicit review", async ({ page }) => {
  const current=directory(4,{v:2,hosts:[{publicKey:rootKey,name:"Root",routes:[],state:"active",revoked:false,protocol:2}]}), rollback=directory(5);
  const result=await page.evaluate(async({current,rollback})=>{
    const {cache,identity}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    await cache.saveNetworkMembership(identity,current);await cache.saveDraft("chat","keep protocol draft");
    const failures=[];for(const explicit of [false,true]){try{await cache.saveNetworkMembership(identity,rollback,explicit);failures.push("");}catch(error){failures.push((error as Error).message);}}
    return {failures,membership:await cache.networkMembership(),draft:await cache.draft("chat")};
  },{current,rollback});
  expect(result).toEqual({failures:["network_directory_stale","network_directory_stale"],membership:current,draft:"keep protocol draft"});
});

test("legacy device scope can be classified but an explicit scope cannot change or disappear without member revocation", async ({ page }) => {
  const legacy=directory(4,{v:2,hosts:[{publicKey:rootKey,name:"Root",routes:[],state:"active",revoked:false,protocol:2}],devices:[{id:identity.deviceId,publicKey:deviceKey,host:rootKey,name:identity.name,platform:"web",memberId:"member_fixture",originHost:rootKey,attestedBy:rootKey,revoked:false}]}),
    current=directory(5,{...legacy.manifest,revision:5,devices:legacy.manifest.devices.map(device=>({...device,scope:"network" as const}))}),
    changed=directory(6,{...current.manifest,revision:6,devices:current.manifest.devices.map(device=>({...device,scope:"host" as const}))}),
    missing=directory(6,{...legacy.manifest,revision:6}),
    revoked=directory(6,{...current.manifest,revision:6,devices:[],revokedMembers:["member_fixture"]});
  const result=await page.evaluate(async({legacy,current,changed,missing,revoked})=>{
    const {cache,identity}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    await cache.saveNetworkMembership(identity,legacy);await cache.saveNetworkMembership(identity,current);
    const failures=[];for(const value of [changed,missing])for(const explicit of [false,true]){try{await cache.saveNetworkMembership(identity,value,explicit);failures.push("");}catch(error){failures.push((error as Error).message);}}
    const preserved=await cache.networkMembership();await cache.saveNetworkMembership(identity,revoked);
    return {failures,preserved,revoked:await cache.networkMembership()};
  },{legacy,current,changed,missing,revoked});
  expect(result).toEqual({failures:Array(4).fill("network_directory_stale"),preserved:current,revoked});
});

test("explicit join or leave changes the pin without deleting unsent text or attachment drafts", async ({ page }) => {
  const nextNonce = randomBytes(32).toString("base64url");
  const initial = directory(), replacement = directory(1, { genesisNonce: nextNonce, id: `net_${createHash("sha256").update(networkGenesisText(rootKey, nextNonce)).digest("hex")}` });
  const result = await page.evaluate(async ({ initial, replacement }) => {
    const { cache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    await cache.saveNetworkMembership(identity, initial); await cache.saveDraft("chat", "unsent text");
    await cache.saveConversationDraft("chat", { files: [new File(["exact\u0000draft"], "draft.txt")], previewStyle: "card" }, identity);
    await cache.saveNetworkMembership(identity, replacement, true); const joined = await cache.networkMembership();
    await cache.saveNetworkMembership(identity, undefined, true);
    const attachment = (await cache.conversationDraft("chat", identity)).draft.files[0]!;
    return { joined, left: await cache.networkMembership(), text: await cache.draft("chat"), name: attachment.name, bytes: await attachment.text() };
  }, { initial, replacement });
  expect(result).toEqual({ joined: replacement, left: undefined, text: "unsent text", name: "draft.txt", bytes: "exact\u0000draft" });
});

test("explicit leave cannot be undone by a late implicit refresh, including after reload", async ({ page }) => {
  const value = directory();
  await page.evaluate(async value => {
    const { cache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    await cache.saveNetworkMembership(identity, value); await cache.saveNetworkMembership(identity, undefined, true);
  }, value);
  await page.reload(); await page.waitForFunction(() => !!(window as unknown as { networkCacheFixture?: Fixture }).networkCacheFixture);
  const result = await page.evaluate(async value => {
    const { cache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    let failure = ""; try { await cache.saveNetworkMembership(identity, value); } catch (e) { failure = (e as Error).message; }
    const stillLeft = await cache.networkMembership();
    await cache.saveNetworkMembership(identity, value, true);
    return { failure, stillLeft, explicitJoin: await cache.networkMembership() };
  }, value);
  expect(result).toEqual({ failure: "network_membership_changed", stillLeft: undefined, explicitJoin: value });
});

test("another identity, a retired cache and a reset generation cannot write a late directory", async ({ page }) => {
  const value = directory();
  const result = await page.evaluate(async value => {
    const { cache, ClientCache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    await cache.saveNetworkMembership(identity, value);
    const error = async (work: () => Promise<unknown>) => { try { await work(); return ""; } catch (e) { return (e as Error).message; } };
    const identities = [{ ...identity, deviceId: "other" }, { ...identity, publicKey: "other-key" }, { ...identity, hubPublicKey: "other-host" }];
    const foreign = await Promise.all(identities.map(actor => error(() => cache.saveNetworkMembership(actor, value, true))));
    const retired = new ClientCache(cache.databaseName); await retired.identity(); retired.close();
    const closed = await error(() => retired.saveNetworkMembership(identity, value, true));
    const stale = new ClientCache(cache.databaseName); await stale.identity(); await cache.beginReset();
    const reset = await error(() => stale.saveNetworkMembership(identity, value, true));
    const fresh = new ClientCache(cache.databaseName); await fresh.finishReset(); await fresh.initializeIdentity({ ...identity, deviceId: "new" });
    const afterReset = await error(() => stale.saveNetworkMembership(identity, value, true));
    const empty = await fresh.networkMembership(); stale.close(); fresh.close();
    return { foreign, closed, reset, afterReset, empty };
  }, value);
  expect(result).toEqual({ foreign: Array(3).fill("host_cache_identity_mismatch"), closed: "local_cache_closed", reset: "local_reset_in_progress", afterReset: "local_reset_in_progress", empty: undefined });
});

test("removing a registered host fences every previously open cache without touching another host", async ({ page }) => {
  const value = directory();
  const result = await page.evaluate(async ({ value, peerKey }) => {
    const { HostRegistry, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new HostRegistry("network-removal-fixture"), host = await registry.add(identity, "Root"), other = await registry.add({ ...identity, deviceId: "other-device", hubPublicKey: peerKey }, "Other");
    const a = await registry.open(host.id), b = await registry.open(other.id);
    await a.cache.saveNetworkMembership(a.identity, value); await b.cache.saveDraft("chat", "other host draft");
    await registry.beginRemoval(host.id);
    let failure = ""; try { await a.cache.saveNetworkMembership(a.identity, value, true); } catch (e) { failure = (e as Error).message; }
    const result = { failure, otherDraft: await b.cache.draft("chat"), state: (await registry.list()).find(entry => entry.id === host.id)!.state };
    a.cache.close(); b.cache.close(); registry.close(); return result;
  }, { value, peerKey });
  expect(result).toEqual({ failure: "local_reset_in_progress", otherDraft: "other host draft", state: "removing" });
});

test("two windows retain the highest accepted revision despite delayed refreshes", async ({ page }) => {
  const initial = directory(), newer = directory(9), stale = directory(8);
  const result = await page.evaluate(async ({ initial, newer, stale }) => {
    const { cache, ClientCache, identity } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const other = new ClientCache(cache.databaseName); await cache.saveNetworkMembership(identity, initial);
    await other.saveNetworkMembership(identity, newer);
    let failure = ""; try { await cache.saveNetworkMembership(identity, stale); } catch (e) { failure = (e as Error).message; }
    const latest = await cache.networkMembership(); other.close(); return { failure, latest };
  }, { initial, newer, stale });
  expect(result).toEqual({ failure: "network_directory_stale", latest: newer });
});

function syncDirectory(revision: number, revoked: boolean): SignedNetworkManifest {
  return directory(revision, {
    hosts: [
      { publicKey: rootKey, name: "Root", routes: [], state: "active", revoked: false },
      { publicKey: peerKey, name: "Peer", routes: [{ name: "Direct", url: "https://peer.example" }], state: "active", revoked },
    ],
    devices: [{ id: identity.deviceId, publicKey: deviceKey, host: rootKey, name: identity.name, platform: "web", memberId: "member_fixture", originHost: rootKey, attestedBy: rootKey, revoked: false }],
  });
}
async function prepareSync(page: import("@playwright/test").Page, latest: SignedNetworkManifest, remote: SignedNetworkManifest, blockedRequest: boolean, paired = false, localDestination = false) {
  await page.evaluate(async ({ latest, remote, peerKey, blockedRequest, paired, localDestination }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new f.HostRegistry("network-sync-fixture"), meta = { networkId: latest.manifest.id, networkAuthority: latest.manifest.authorityKey, networkRoutes: [] };
    const sourceHost = await registry.add(f.identity, "Root");
    await registry.networkMetadata(sourceHost.id, meta.networkId, meta.networkAuthority);
    const peerIdentity = { ...f.identity, deviceId: "peer_device", hubPublicKey: peerKey, routes: [{ name: "Direct" as const, url: "https://peer.example" }] };
    if (!paired) await registry.networkCandidate(meta.networkId, meta.networkAuthority, remote.manifest.hosts.find(host => host.publicKey === peerKey)!, async () => peerIdentity);
    let peerHost = await registry.add(peerIdentity, "Peer", paired ? undefined : { ...meta, networkRoutes: peerIdentity.routes });
    if (paired) { await registry.networkMetadata(peerHost.id, latest.manifest.id, latest.manifest.authorityKey); peerHost = (await registry.list()).find(host => host.id === peerHost.id)!; }
    const sourceHandle = await registry.open(sourceHost.id), peerHandle = await registry.open(peerHost.id);
    const source = new f.HubConnection(sourceHandle.identity, sourceHandle.cache), target = new f.HubConnection(peerHandle.identity, peerHandle.cache);
    await target.cache.saveNetworkMembership(target.identity, latest.manifest.hosts.find(host => host.publicKey === peerKey)!.revoked ? remote : latest);
    await target.cache.saveDraft("chat", "keep unsent text");
    source.networkKnown = latest; source.networkRemote = latest; target.networkKnown = latest; target.networkRemote = remote;
    const view = { host: latest.manifest.hosts[0]!, membership: latest, sync: "current" as const, lastSyncedAt: 1 };
    source.state = { ...source.state, status: "online", networkAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, network: view };
    source.refreshNetwork = async () => view;
    const pool = { state: { hosts: [{ host: sourceHost, connection: source }, { host: peerHost, connection: target }], loading: false }, localHostKey: localDestination ? peerKey : latest.manifest.authorityKey } as unknown as HostConnections;
    // Keep the transport pending to prove that local revocation and durable
    // cache work finish before the remote server can acknowledge anything.
    let hits = 0;
    window.fetch = async (_input, init) => {
      hits++;
      if (blockedRequest) await new Promise<void>((resolve, reject) => {
        f.release = resolve;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    };
    f.snapshot = async () => { const registered = (await registry.list()).find(host => host.id === peerHost.id)!; return { hits, closed: target.isClosed, blocked: registered.networkBlocked ?? false, networkId: registered.networkId,
      revision: (await target.cache.networkMembership())!.manifest.revision, draft: await target.cache.draft("chat") }; };
    f.sync = new f.NetworkSync(pool, registry); f.syncDone = f.sync.refresh();
  }, { latest, remote, peerKey, blockedRequest, paired, localDestination });
}

test("revocation suspends the peer and persists its newer directory before a stalled delivery", async ({ page }) => {
  await prepareSync(page, syncDirectory(7, true), syncDirectory(6, false), true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture.snapshot!())).toEqual({ hits: 1, closed: true, blocked: true, networkId: id, revision: 7, draft: "keep unsent text" });
  await page.evaluate(async () => { const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture; f.release!(); await f.syncDone; f.sync!.close(); });
});

test("a restored peer receives the current directory even when the client cache is already current", async ({ page }) => {
  await prepareSync(page, syncDirectory(7, false), syncDirectory(6, false), false);
  const result = await page.evaluate(async () => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    await f.syncDone; await f.sync!.refresh(); const result = await f.snapshot!(); f.sync!.close(); return result;
  });
  expect(result).toEqual({ hits: 2, closed: false, blocked: false, networkId: id, revision: 7, draft: "keep unsent text" });
});

test("network removal fences an originally paired phone connection while preserving its unsent draft", async ({ page }) => {
  await prepareSync(page, syncDirectory(7, true), syncDirectory(6, false), true, true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture.snapshot!())).toEqual({ hits: 1, closed: true, blocked: true, networkId: id, revision: 7, draft: "keep unsent text" });
  await page.evaluate(async () => { const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture; f.release!(); await f.syncDone; f.sync!.close(); });
});

test("the verified native local host remains accessible when its own network destination is removed", async ({ page }) => {
  await prepareSync(page,syncDirectory(7,true),syncDirectory(6,false),true,true,true);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture.snapshot!())).toEqual({hits:1,closed:false,blocked:false,networkId:id,revision:6,draft:"keep unsent text"});
  await page.evaluate(async()=>{const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;f.release!();await f.syncDone;f.sync!.close();});
});

test("revoking this controller binding stops a still-active destination without removing its cached draft", async ({ page }) => {
  const before=syncDirectory(6,false),latest=directory(7,{...before.manifest,v:2,hosts:before.manifest.hosts.map(host=>({...host,protocol:2 as const})),revision:7,devices:[...before.manifest.devices,{id:"peer_device",publicKey:deviceKey,host:peerKey,name:"Local controller",platform:"web",memberId:"retired_controller",originHost:rootKey,attestedBy:rootKey,scope:"host",revoked:true}]});
  await prepareSync(page,latest,before,true,true);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture.snapshot!())).toEqual({hits:1,closed:true,blocked:true,networkId:id,revision:7,draft:"keep unsent text"});
  await page.evaluate(async()=>{const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;f.release!();await f.syncDone;f.sync!.close();});
});

test("a registry fence also suspends an already running pool and history cannot queue new sends", async ({ page }) => {
  const result=await page.evaluate(async({peerKey,rootKey,id})=>{
    const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture,registry=new f.HostRegistry("pool-fence-fixture");
    const original=f.HubConnection.prototype.start;f.HubConnection.prototype.start=async function(){this.state={...this.state,status:"offline"};};
    const host=await registry.add({...f.identity,hubPublicKey:peerKey},"Phone pair");await registry.networkMetadata(host.id,id,rootKey);
    const handle=await registry.open(host.id);await handle.cache.saveDraft("chat","keep this draft");handle.cache.close();
    const pool=new f.HostConnections(registry);await pool.start();const connection=pool.connection(host.id)!;
    await registry.blockNetworkHost(host.id,id,host.registrationId);await pool.refresh();connection.resume(true);
    let failure="";try{await connection.send({v:1,type:"message.send",conversationId:"chat",clientMsgId:"never-send",text:"no network delivery",attachments:[]});}catch(error){failure=(error as Error).message;}
    const result={closed:connection.isClosed,blocked:connection.isNetworkBlocked,status:connection.state.status,failure:!!failure,queued:(await connection.cache.outbox()).length,draft:await connection.cache.draft("chat")};
    pool.close();registry.close();f.HubConnection.prototype.start=original;return result;
  },{peerKey,rootKey,id});
  expect(result).toEqual({closed:true,blocked:true,status:"offline",failure:true,queued:0,draft:"keep this draft"});
});

test("native controller migration failure pauses only the local host and reopening retries the same identity", async ({ page }) => {
  const result = await page.evaluate(async ({ rootKey, peerKey }) => {
    const f = (window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    let registry = new f.HostRegistry("local-controller-fixture");
    const local = await registry.add({...f.identity, keyRef:"fixture-native-key"}, "This computer");
    const remote = await registry.add({...f.identity, hubPublicKey:peerKey, deviceId:"remote-device"}, "Remote");
    const handle = await registry.open(local.id); await handle.cache.saveDraft("chat", "original local draft"); handle.cache.close();
    const requests: string[] = [], starts: string[] = [], originalStart = f.HubConnection.prototype.start;
    f.HubConnection.prototype.start = async function () { starts.push(this.identity.hubPublicKey!); };
    const makePool = async (prepared: {publicKey?:string;pending:boolean}) => {
      const pool = new f.HostConnections(registry); pool.localHostKey = prepared.publicKey ?? ""; pool.localControllerPending = prepared.pending; await pool.start(); return pool;
    };
    try {
      const first = await f.prepareLocalController(registry, async args => {
        requests.push(args.action);
        if (args.action === "pair") throw new Error("keychain_temporarily_unavailable");
        return {available:true,publicKey:rootKey};
      });
      let pool = await makePool(first); pool.resume();
      const paused = {local:!!pool.connection(local.id),remote:!!pool.connection(remote.id),starts:[...starts],key:await registry.nativeLocalHost(),blocked:(await registry.list()).some(host=>host.networkBlocked)};
      pool.close(); registry.close(); registry = new f.HostRegistry("local-controller-fixture");
      const unavailable = await f.prepareLocalController(registry, async () => { throw new Error("native_unavailable"); });
      pool = await makePool(unavailable);
      const stillPaused = {local:!!pool.connection(local.id),remote:!!pool.connection(remote.id),pending:unavailable.pending};
      pool.close();
      let paired: Record<string, unknown> | undefined;
      const ready = await f.prepareLocalController(registry, async args => {
        if (args.action === "pair") { paired=args.device; return {}; }
        return {available:true,publicKey:rootKey};
      });
      pool = await makePool(ready);
      const restored = {local:!!pool.connection(local.id),remote:!!pool.connection(remote.id),pending:ready.pending,identity:pool.connection(local.id)!.identity.deviceId,draft:await pool.connection(local.id)!.cache.draft("chat")};
      pool.close(); return {requests,paused,stillPaused,restored,paired};
    } finally { registry.close(); f.HubConnection.prototype.start=originalStart; }
  }, {rootKey,peerKey});
  expect(result).toEqual({requests:["resume","pair"],paused:{local:false,remote:true,starts:[peerKey],key:rootKey,blocked:false},stillPaused:{local:false,remote:true,pending:true},restored:{local:true,remote:true,pending:false,identity:identity.deviceId,draft:"original local draft"},paired:{deviceId:identity.deviceId,name:identity.name,publicKey:identity.publicKey,keyRef:"fixture-native-key",platform:undefined}});
});

test("a known local cache failure does not block a separately paired remote host", async ({ page }) => {
  const result = await page.evaluate(async ({ rootKey, peerKey }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new f.HostRegistry("local-controller-open-failure");
    const local = await registry.add({ ...f.identity, keyRef: "fixture-native-key" }, "Local");
    const remote = await registry.add({ ...f.identity, hubPublicKey: peerKey, deviceId: "remote-device" }, "Remote");
    const open = registry.open.bind(registry), start = f.HubConnection.prototype.start;
    registry.open = async (id) => { if (id === local.id) throw new Error("host_cache_identity_mismatch"); return open(id); };
    const requests: string[] = [], starts: string[] = [];
    f.HubConnection.prototype.start = async function () { starts.push(this.identity.hubPublicKey!); };
    const pool = new f.HostConnections(registry);
    try {
      const prepared = await f.prepareLocalController(registry, async ({ action }) => { requests.push(action); return { available: true, publicKey: rootKey }; });
      pool.localHostKey = prepared.publicKey!; pool.localControllerPending = prepared.pending;
      await pool.start(); pool.resume();
      return { prepared, requests, starts, local: !!pool.connection(local.id), remote: !!pool.connection(remote.id) };
    } finally { pool.close(); registry.close(); f.HubConnection.prototype.start = start; }
  }, { rootKey, peerKey });
  // A cache/registry failure does not establish that native credentials are bad.
  expect(result).toEqual({ prepared: { publicKey: rootKey, pending: true, issue: "controller_failed" }, requests: ["resume"], starts: [peerKey], local: false, remote: true });
});

test("unknown native startup fails closed while client-only installations remain usable", async ({ page }) => {
  const result = await page.evaluate(async rootKey => {
    const f = (window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const registry = new f.HostRegistry("local-controller-unknown");
    let failure=""; try { await f.prepareLocalController(registry, async () => { throw new Error("native_unavailable"); }); } catch (error) { failure=(error as Error).message; }
    const clientOnly = await f.prepareLocalController(registry, async () => ({available:false}));
    const statusOnly = await f.prepareLocalController(registry, async args => {
      if(args.action === "resume") throw new Error("host_runtime_unavailable");
      return {available:true,publicKey:rootKey};
    });
    const remembered=await registry.nativeLocalHost(); registry.close();
    return {failure,clientOnly,statusOnly,remembered};
  },rootKey);
  expect(result).toEqual({failure:"local_controller_unavailable",clientOnly:{pending:false},statusOnly:{publicKey:rootKey,pending:true,issue:"background"},remembered:rootKey});
});

test("only a signed active-leave receipt survives self revocation; close, reset and invalid replies remain fenced", async ({ page }) => {
  const before=syncDirectory(6,false),receipt=syncDirectory(7,true),pkcs8=device.privateKey.export({type:"pkcs8",format:"der"}).toString("base64"),sessionHash=createHash("sha256").update("fixture-session").digest("hex");
  const result=await page.evaluate(async({before,receipt,pkcs8,sessionHash,peerKey})=>{
    const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture,results=[];
    for(const mode of ["revoked","close","reset","invalid"] as const) {
      const privateKey=await crypto.subtle.importKey("pkcs8",Uint8Array.from(atob(pkcs8),c=>c.charCodeAt(0)),"Ed25519",false,["sign"]);
      const identity={...f.identity,hubPublicKey:peerKey,privateKey,routes:[{name:"Direct" as const,url:"https://peer.example"}]},cache=new f.ClientCache(`departure-receipt-${mode}`);
      await cache.initializeIdentity(identity);await cache.saveNetworkMembership(identity,before);await cache.saveDraft("chat","retained draft");
      const connection=new f.HubConnection(identity,cache);connection.pinNetwork(before.manifest.id,before.manifest.authorityKey);connection.networkKnown=before;
      connection.state={...connection.state,status:"online",networkAvailable:true,route:identity.routes[0],network:{host:before.manifest.hosts[1]!,membership:before,sync:"current",lastSyncedAt:1}};
      const internals=connection as unknown as {token:string;httpRequest(path:string,init?:RequestInit):Promise<unknown>;acceptRevocation():Promise<void>};internals.token="fixture-session";
      internals.httpRequest=async(path,init)=>{if(path!=="/api/devices/challenge")throw new Error("unexpected_request");const action=JSON.parse(String(init!.body));return{hubPublicKey:peerKey,deviceId:identity.deviceId,sessionHash,action,targetDigest:action.target,nonce:"A".repeat(43),expiresAt:Date.now()+30_000};};
      window.fetch=async()=>{
        if(mode==="revoked")await internals.acceptRevocation();else if(mode==="close")connection.close();else if(mode==="reset")await cache.beginReset();
        return new Response(JSON.stringify({view:{host:before.manifest.hosts[1],sync:"standalone",lastSyncedAt:0},membership:mode==="invalid"?before:receipt}),{status:200});
      };
      let error="";try{await connection.networkCommand({operation:"leave",expectedState:"active"});}catch(cause){error=(cause as Error).message;}
      results.push({mode,success:!error,receipt:!!connection.networkDeparture,status:connection.state.status,closed:connection.isClosed,draft:await cache.draft("chat")});connection.close();cache.close();
    }
    return results;
  },{before,receipt,pkcs8,sessionHash,peerKey});
  expect(result).toEqual([
    {mode:"revoked",success:true,receipt:true,status:"offline",closed:true,draft:"retained draft"},
    {mode:"close",success:false,receipt:false,status:"offline",closed:true,draft:"retained draft"},
    {mode:"reset",success:false,receipt:false,status:"online",closed:false,draft:"retained draft"},
    {mode:"invalid",success:false,receipt:false,status:"online",closed:false,draft:"retained draft"},
  ]);
});

test("a delayed cache acknowledgment from an old refresh cannot restore the in-memory pin after leaving", async ({ page }) => {
  const value = directory(), pkcs8 = device.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), sessionHash = createHash("sha256").update("fixture-session").digest("hex");
  const result = await page.evaluate(async ({ value, pkcs8, sessionHash }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const privateKey = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pkcs8), c => c.charCodeAt(0)), "Ed25519", false, ["sign"]);
    const connection = new f.HubConnection({ ...f.identity, privateKey }, f.cache);
    const current = { host: value.manifest.hosts[0]!, membership: value, sync: "current" as const, lastSyncedAt: 1 };
    const left = { host: value.manifest.hosts[0]!, sync: "standalone" as const, lastSyncedAt: 0 };
    connection.networkKnown = value; connection.networkRemote = value; connection.pinNetwork(value.manifest.id, value.manifest.authorityKey);
    connection.state = { ...connection.state, status: "online", networkAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, network: current };
    const internals = connection as unknown as { token: string; httpRequest(path: string, init?: RequestInit): Promise<unknown> };
    internals.token = "fixture-session";
    internals.httpRequest = async (path, init) => {
      if (path === "/api/network") return current;
      if (path === "/api/host-profile") return { name: "Root", revision: 1 };
      if (path === "/api/devices/challenge") { const action = JSON.parse(String(init!.body)); return { hubPublicKey: f.identity.hubPublicKey, deviceId: f.identity.deviceId, sessionHash, action, targetDigest: action.target, nonce: "A".repeat(43), expiresAt: Date.now() + 30_000 }; }
      if (path === "/api/network/manage") return { view: left };
      throw new Error("unexpected_request");
    };
    const save = f.cache.saveNetworkMembership.bind(f.cache);
    let started!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    f.cache.saveNetworkMembership = async (...args) => {
      await save(...args);
      if (!args[2] && args[1]) { started(); await new Promise<void>(resolve => { release = resolve; }); }
    };
    const oldRefresh = connection.refreshNetwork(); await waiting;
    await connection.networkCommand({ operation: "leave", expectedState: "active" }); release(); await oldRefresh;
    const result = { cached: await f.cache.networkMembership(), known: connection.networkKnown, visible: connection.state.network?.membership };
    connection.close(); return result;
  }, { value, pkcs8, sessionHash });
  expect(result).toEqual({ cached: undefined, known: undefined, visible: undefined });
});

test("a discovered host stays pending until enrollment succeeds and retry keeps the same device key", async ({ page }) => {
  const enrollmentKey = key(generateKeyPairSync("ed25519"));
  const base = syncDirectory(7, false), authorization = directory(7, { hosts: base.manifest.hosts, devices: [...base.manifest.devices,
    { id: "candidate_device", publicKey: enrollmentKey, host: peerKey, name: "Fixture", platform: "web", memberId: "member_fixture", originHost: rootKey, attestedBy: rootKey, revoked: false },
  ] });
  await page.evaluate(async ({ authorization, enrollmentKey, peerKey }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new f.HostRegistry("network-discovery-fixture"), root = authorization.manifest.hosts[0]!, peer = authorization.manifest.hosts[1]!;
    const sourceHost = await registry.add(f.identity, "Root");
    await registry.networkMetadata(sourceHost.id, authorization.manifest.id, root.publicKey);
    const sourceHandle = await registry.open(sourceHost.id), source = new f.HubConnection(sourceHandle.identity, sourceHandle.cache);
    const candidate = { ...f.identity, deviceId: "candidate_device", publicKey: enrollmentKey, hubPublicKey: peerKey, routes: peer.routes };
    await registry.networkCandidate(authorization.manifest.id, root.publicKey, peer, async () => candidate);
    source.networkKnown = authorization; source.networkRemote = authorization;
    const view = { host: root, membership: authorization, sync: "current" as const, lastSyncedAt: 1 };
    source.state = { ...source.state, status: "online", networkAvailable: true, user: { id: "owner", name: "Owner", role: "owner" }, network: view };
    source.refreshNetwork = async () => view;
    const pool = { state: { hosts: [{ host: sourceHost, connection: source }], loading: false }, localHostKey: root.publicKey, connection: () => undefined } as unknown as HostConnections;
    let requests = 0;
    window.fetch = async () => {
      requests++;
      if (requests === 1) { await new Promise<void>(resolve => { f.release = resolve; }); return new Response("{}", { status: 503 }); }
      return new Response("{}", { status: 200 });
    };
    f.snapshot = async () => ({ requests, devices: (await registry.list()).map(host => host.deviceId) });
    f.sync = new f.NetworkSync(pool, registry); f.syncDone = f.sync.refresh();
  }, { authorization, enrollmentKey, peerKey });
  await expect.poll(() => page.evaluate(() => (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture.snapshot!())).toEqual({ requests: 1, devices: [identity.deviceId] });
  expect(await page.evaluate(async () => { const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture; f.release!(); await f.syncDone; return f.snapshot!(); })).toEqual({ requests: 1, devices: [identity.deviceId] });
  expect(await page.evaluate(async () => { const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture; await f.sync!.refresh(); const result = await f.snapshot!(); f.sync!.close(); return result; })).toEqual({ requests: 2, devices: [identity.deviceId, "candidate_device"] });
});

test("candidate replacement fences late enrollment when native key cleanup fails and resumes safely", async ({ page }) => {
  const result = await page.evaluate(async ({ rootKey, peerKey, deviceKey }) => {
    const { HostRegistry } = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new HostRegistry("candidate-cleanup-fixture"), calls: string[] = [];
    let fail = true, created = 0;
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { invoke: async (command: string, args: {keyRef:string}) => { if (command !== "device_forget") throw new Error("unexpected_native_call"); calls.push(args.keyRef); if (fail) { fail = false; throw new Error("native_cleanup_failed"); } } } });
    const host = { publicKey: peerKey, name: "Peer", routes: [], state: "active" as const, revoked: false };
    const oldIdentity = { deviceId:"device_old_candidate",keyRef:"device_old_candidate",publicKey:deviceKey,hubPublicKey:peerKey,name:"Old",routes:[] };
    const newIdentity = { ...oldIdentity,deviceId:"device_new_candidate",keyRef:"device_new_candidate",name:"New" };
    const old = await registry.networkCandidate("old-network",rootKey,host,async()=>oldIdentity);
    const create = async () => { created++; return newIdentity; };
    const error = async (work:()=>Promise<unknown>) => { try { await work(); return ""; } catch (cause) { return (cause as Error).message; } };
    const failedCleanup = await error(()=>registry.networkCandidate("new-network",rootKey,host,create,async()=>undefined));
    const lateWhileCleanupFailed = await error(()=>registry.add(old!.identity,"Old",{networkId:"old-network",networkAuthority:rootKey,networkRoutes:[]}));
    const beforeRetry = {created,registered:(await registry.list()).length};
    const fresh = await registry.networkCandidate("new-network",rootKey,host,create,async()=>undefined);
    const oldRequest = await registry.networkCandidate("old-network",rootKey,host,async()=> {throw new Error("old_key_must_not_be_created");});
    const lateAfterReplacement = await error(()=>registry.add(old!.identity,"Old",{networkId:"old-network",networkAuthority:rootKey,networkRoutes:[]}));
    await registry.add(fresh!.identity,"New",{networkId:"new-network",networkAuthority:rootKey,networkRoutes:[]});
    await registry.finishNetworkCandidate(old!); await registry.finishNetworkCandidate(fresh!);
    const registered = (await registry.list()).map(host=>({deviceId:host.deviceId,networkId:host.networkId})); registry.close();
    return {failedCleanup,lateWhileCleanupFailed,beforeRetry,lateAfterReplacement,oldRequest,created,calls,registered};
  }, {rootKey,peerKey,deviceKey});
  expect(result).toEqual({failedCleanup:"native_cleanup_failed",lateWhileCleanupFailed:"network_enrollment_superseded",beforeRetry:{created:0,registered:0},lateAfterReplacement:"network_enrollment_superseded",oldRequest:undefined,created:1,calls:["device_old_candidate","device_old_candidate"],registered:[{deviceId:"device_new_candidate",networkId:"new-network"}]});
});

test("a registered direct pairing wins over an unfinished candidate and its draft and key stay intact", async ({ page }) => {
  const result = await page.evaluate(async ({rootKey,peerKey,deviceKey}) => {
    const {HostRegistry} = (window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const registry = new HostRegistry("candidate-registered-fixture"), calls:string[]=[];
    Object.assign(window,{isTauri:true,__TAURI_INTERNALS__:{invoke:async(command:string,args:{keyRef:string})=>{calls.push(`${command}:${args.keyRef}`);}}});
    const host={publicKey:peerKey,name:"Peer",routes:[],state:"active" as const,revoked:false};
    const oldIdentity={deviceId:"device_old_candidate",keyRef:"device_old_candidate",publicKey:deviceKey,hubPublicKey:peerKey,name:"Old",routes:[]};
    const candidate=await registry.networkCandidate("old-network",rootKey,host,async()=>oldIdentity);
    const paired=await registry.add({...oldIdentity,deviceId:"device_paired",keyRef:"device_paired"},"Paired");
    const handle=await registry.open(paired.id); await handle.cache.saveDraft("chat","keep paired draft");
    let created=false; const ignored=await registry.networkCandidate("new-network",rootKey,host,async()=>{created=true;return oldIdentity;});
    let late="";try{await registry.add(candidate!.identity,"Late",{networkId:"old-network",networkAuthority:rootKey,networkRoutes:[]});}catch(e){late=(e as Error).message;}
    const result={ignored,created,calls,late,draft:await handle.cache.draft("chat"),deviceId:(await registry.list())[0]!.deviceId,keyRef:(await handle.cache.identity())!.keyRef};handle.cache.close();registry.close();return result;
  },{rootKey,peerKey,deviceKey});
  expect(result).toEqual({ignored:undefined,created:false,calls:[],late:"host_already_registered",draft:"keep paired draft",deviceId:"device_paired",keyRef:"device_paired"});
});

test("a second tab can replace a pending candidate without a late old add registering backward", async ({ page, context }) => {
  const other=await context.newPage(); await other.goto(url); await other.waitForFunction(()=>!!(window as any).networkCacheFixture);
  try {
    const old=await page.evaluate(async({rootKey,peerKey,deviceKey})=>{
      const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
      const registry=new HostRegistry("candidate-tabs-fixture"),host={publicKey:peerKey,name:"Peer",routes:[],state:"active" as const,revoked:false};
      const candidate=await registry.networkCandidate("old-network",rootKey,host,async()=>({deviceId:"old_tab",publicKey:deviceKey,hubPublicKey:peerKey,name:"Old",routes:[]}));registry.close();return candidate!;
    },{rootKey,peerKey,deviceKey});
    const fresh=await other.evaluate(async({rootKey,peerKey,deviceKey})=>{
      const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
      const registry=new HostRegistry("candidate-tabs-fixture"),host={publicKey:peerKey,name:"Peer",routes:[],state:"active" as const,revoked:false};
      const candidate=await registry.networkCandidate("new-network",rootKey,host,async()=>({deviceId:"new_tab",publicKey:deviceKey,hubPublicKey:peerKey,name:"New",routes:[]}),async()=>undefined);registry.close();return candidate!;
    },{rootKey,peerKey,deviceKey});
    expect(await page.evaluate(async old=>{
      const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
      const registry=new HostRegistry("candidate-tabs-fixture");let error="";try{await registry.add(old.identity,"Late old reply",{networkId:old.networkId,networkAuthority:old.authorityKey,networkRoutes:old.host.routes});}catch(e){error=(e as Error).message;}registry.close();return error;
    },old)).toBe("network_enrollment_superseded");
    expect(await other.evaluate(async fresh=>{
      const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
      const registry=new HostRegistry("candidate-tabs-fixture");await registry.add(fresh.identity,"New",{networkId:fresh.networkId,networkAuthority:fresh.authorityKey,networkRoutes:fresh.host.routes});await registry.finishNetworkCandidate(fresh);const result=(await registry.list()).map(host=>host.deviceId);registry.close();return result;
    },fresh)).toEqual(["new_tab"]);
  } finally {await other.close();}
});

test("replacing a candidate never clears a previously dismissed network", async ({ page }) => {
  const result=await page.evaluate(async({rootKey,peerKey,deviceKey})=>{
    const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const registry=new HostRegistry("candidate-dismissed-fixture"),host={publicKey:peerKey,name:"Peer",routes:[],state:"active" as const,revoked:false};
    const make=(deviceId:string)=>({deviceId,publicKey:deviceKey,hubPublicKey:peerKey,name:"Fixture",routes:[]});
    const first=await registry.networkCandidate("dismissed-network",rootKey,host,async()=>make("first"));
    const registered=await registry.add(first!.identity,"First",{networkId:first!.networkId,networkAuthority:rootKey,networkRoutes:[]});
    const removed=await registry.beginRemoval(registered.id);await registry.finishRemoval(removed.id,removed.registrationId,{shared:async()=>undefined,push:async()=>undefined,browser:async()=>undefined,key:async()=>undefined});
    await registry.networkCandidate("intermediate-network",rootKey,host,async()=>make("intermediate"),async()=>undefined);
    await registry.networkCandidate("latest-network",rootKey,host,async()=>make("latest"),async()=>undefined);
    let created=false;const dismissed=await registry.networkCandidate("dismissed-network",rootKey,host,async()=>{created=true;return make("wrong");});registry.close();return {dismissed,created};
  },{rootKey,peerKey,deviceKey});
  expect(result).toEqual({dismissed:undefined,created:false});
});

test("offline startup restores the verified network directory without pretending the host is online or losing drafts", async ({ page }) => {
  const waiting=directory(),removed=syncDirectory(8,true);
  const result=await page.evaluate(async({waiting,removed,peerKey})=>{
    const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const values=[];
    for(const [index,membership] of [waiting,removed].entries()) {
      const identity={...f.identity,deviceId:`cached_${index}`,hubPublicKey:index?peerKey:f.identity.hubPublicKey};
      const cache=new f.ClientCache(`offline-start-fixture-${index}`);await cache.initializeIdentity(identity);await cache.saveNetworkMembership(identity,membership);await cache.saveDraft("chat","offline draft");
      const connection=new f.HubConnection(identity,cache);(connection as unknown as {networkBlocked:boolean}).networkBlocked=true;await connection.start();
      values.push({membership:connection.state.network?.membership,sync:connection.state.network?.sync,status:connection.state.status,available:connection.state.networkAvailable,draft:await cache.draft("chat")});connection.close();cache.close();
    }
    return values;
  },{waiting,removed,peerKey});
  expect(result).toEqual([{membership:waiting,sync:"waiting",status:"offline",available:undefined,draft:"offline draft"},{membership:removed,sync:"removed",status:"offline",available:undefined,draft:"offline draft"}]);
});

test("another confirmed network can continue an interrupted candidate cleanup without reviving either old attempt", async ({ page }) => {
  const result=await page.evaluate(async({rootKey,peerKey,deviceKey})=>{
    const {HostRegistry}=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const registry=new HostRegistry("candidate-cleanup-replaced-fixture"),calls:string[]=[];let failed=false;
    Object.assign(window,{isTauri:true,__TAURI_INTERNALS__:{invoke:async(_command:string,args:{keyRef:string})=>{calls.push(args.keyRef);if(!failed){failed=true;throw new Error("cleanup_failed");}}}});
    const host={publicKey:peerKey,name:"Peer",routes:[],state:"active" as const,revoked:false};
    const make=(deviceId:string)=>({deviceId,keyRef:deviceId,publicKey:deviceKey,hubPublicKey:peerKey,name:"Fixture",routes:[]});
    await registry.networkCandidate("network-one",rootKey,host,async()=>make("device_one"));
    try{await registry.networkCandidate("network-two",rootKey,host,async()=>make("device_two"),async()=>undefined);}catch{}
    const third=await registry.networkCandidate("network-three",rootKey,host,async()=>make("device_three"),async()=>undefined);
    let created=false;const again=async(network:string)=>registry.networkCandidate(network,rootKey,host,async()=>{created=true;return make("device_wrong");});
    const old=[await again("network-one"),await again("network-two")];registry.close();return{deviceId:third!.identity.deviceId,calls,old,created};
  },{rootKey,peerKey,deviceKey});
  expect(result).toEqual({deviceId:"device_three",calls:["device_one","device_one"],old:[undefined,undefined],created:false});
});

test("candidate preflight rejects stale, noncanonical and oversized replies without touching its saved identity", async ({ page }) => {
  const stale=syncDirectory(7,false), nonce=randomBytes(32).toString("base64url");
  const current=directory(1,{...stale.manifest,genesisNonce:nonce,id:`net_${createHash("sha256").update(networkGenesisText(rootKey,nonce)).digest("hex")}`});
  const revoked=syncDirectory(8,true);
  const result=await page.evaluate(async({stale,current,revoked,rootKey,peerKey,deviceKey})=>{
    const f=(window as unknown as {networkCacheFixture:Fixture}).networkCacheFixture;
    const registry=new f.HostRegistry("candidate-target-confirmation-fixture"), calls:string[]=[];
    Object.assign(window,{isTauri:true,__TAURI_INTERNALS__:{invoke:async(command:string)=>{calls.push(command);throw new Error("native_identity_must_not_change");}}});
    const host=current.manifest.hosts[1]!, pendingIdentity={deviceId:"legitimate_pending",keyRef:"legitimate_key",publicKey:deviceKey,hubPublicKey:peerKey,name:"Pending",routes:host.routes};
    const pending=await registry.networkCandidate(current.manifest.id,rootKey,host,async()=>pendingIdentity);
    const registered=await registry.add(f.identity,"Root"), handle=await registry.open(registered.id), source=new f.HubConnection(handle.identity,handle.cache);
    const view={host:stale.manifest.hosts[0]!,membership:stale,sync:"current" as const,lastSyncedAt:1};
    source.networkKnown=stale;source.networkRemote=stale;
    source.state={...source.state,status:"online",networkAvailable:true,user:{id:"owner",name:"Owner",role:"owner"},network:view};source.refreshNetwork=async()=>view;
    const pool={state:{hosts:[{host:registered,connection:source}],loading:false},localHostKey:rootKey,connection:()=>undefined} as unknown as HostConnections;
    const sync=new f.NetworkSync(pool,registry);let requests=0;
    const noncanonical=structuredClone(stale);noncanonical.manifest.hosts[1]!.routes[0]!.url+="/";
    const responses=[undefined,{}, {host,membership:current,sync:"current",lastSyncedAt:1}, {host:revoked.manifest.hosts[1],membership:revoked,sync:"removed",lastSyncedAt:1}, {host,membership:stale,sync:"current",lastSyncedAt:1}, {host,membership:noncanonical,sync:"current",lastSyncedAt:1}];
    for(const [index,response] of responses.entries()) {
      window.fetch=async()=>{requests++;if(index===4)source.state={...source.state,networkChange:{host,membership:current,sync:"current",lastSyncedAt:1}};return new Response(JSON.stringify(response??{}),{status:index===0?403:200});};
      await sync.refresh();source.state={...source.state,networkChange:undefined};
    }
    let bodyPulls=0,bodyCancelled=0;
    window.fetch=async()=>{
      requests++;
      const body=new ReadableStream<Uint8Array>({pull(controller){bodyPulls++;controller.enqueue(new Uint8Array(1024*1024).fill(32));if(bodyPulls===10)controller.close();},cancel(){bodyCancelled++;}},{highWaterMark:0});
      // A misleading header must not bypass the actual streamed byte limit.
      return new Response(body,{status:200,headers:{"Content-Length":"1"}});
    };
    await sync.refresh();
    const intact=await registry.networkCandidate(current.manifest.id,rootKey,host,async()=>{throw new Error("must_reuse_current_candidate");});
    let staleStillRetryable=false;
    try {await registry.networkCandidate(stale.manifest.id,rootKey,host,async()=>{throw new Error("must_not_create");},async()=>{staleStillRetryable=true;throw new Error("target_still_rejects");});}catch{}
    await registry.add(pending!.identity,"Pending",{networkId:current.manifest.id,networkAuthority:rootKey,networkRoutes:host.routes});
    const result={requests,calls,bodyPulls,bodyCancelled,deviceId:intact?.identity.deviceId,staleStillRetryable,registered:(await registry.list()).find(host=>host.publicKey===peerKey)?.deviceId};
    sync.close();source.close();handle.cache.close();registry.close();return result;
  },{stale,current,revoked,rootKey,peerKey,deviceKey});
  expect(result).toEqual({requests:7,calls:[],bodyPulls:3,bodyCancelled:1,deviceId:"legitimate_pending",staleStillRetryable:true,registered:"legitimate_pending"});
});


test("wake recovery revalidates the native controller and unpauses the same connection without restarting the App", async ({ page }) => {
  const result = await page.evaluate(async ({ rootKey, peerKey }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new f.HostRegistry("wake-native-proof");
    const local = await registry.add({ ...f.identity, keyRef: "fixture-key" }, "Original");
    const remote = await registry.add({ ...f.identity, hubPublicKey: peerKey, deviceId:"remote" }, "Remote");
    await registry.rememberNativeLocalHost(rootKey);
    const handle = await registry.open(local.id); await handle.cache.saveDraft("chat", "keep me"); handle.cache.close();
    const original = f.HubConnection.prototype.start; f.HubConnection.prototype.start = async () => {};
    const pool = new f.HostConnections(registry); pool.localHostKey = rootKey; pool.localControllerPending = true;
    const requests: string[] = [];
    try {
      await pool.start();
      const before = { local: !!pool.connection(local.id), remote: !!pool.connection(remote.id) };
      const applied = await f.recoverLocalController(registry, pool, () => {}, () => true, async args => {
        requests.push(args.action); return { available:true, running:true, publicKey:rootKey };
      });
      return { before, applied, requests, after:{local:!!pool.connection(local.id),remote:!!pool.connection(remote.id),pending:pool.localControllerPending}, draft:await pool.connection(local.id)!.cache.draft("chat") };
    } finally { pool.close(); registry.close(); f.HubConnection.prototype.start = original; }
  }, { rootKey, peerKey });
  expect(result).toEqual({before:{local:false,remote:true},applied:true,requests:["resume","pair"],after:{local:true,remote:true,pending:false},draft:"keep me"});
});

test("a stale wake attempt cannot replace a newly paired host or clear its pause", async ({ page }) => {
  const result = await page.evaluate(async ({ rootKey, peerKey }) => {
    const f = (window as unknown as { networkCacheFixture: Fixture }).networkCacheFixture;
    const registry = new f.HostRegistry("wake-stale"); await registry.rememberNativeLocalHost(rootKey);
    const pool = new f.HostConnections(registry); pool.localHostKey=rootKey; pool.localControllerPending=true;
    let release!: () => void; const held = new Promise<void>(resolve => {release=resolve}); let published=0;
    const work = f.recoverLocalController(registry,pool,()=>{published++},()=>true,async()=>{await held; return {available:true,running:true,publicKey:rootKey}}).catch(error=>(error as Error).message);
    await Promise.resolve(); pool.localHostKey=peerKey; release(); const status=await work;
    const remembered=await registry.nativeLocalHost(); pool.close();registry.close();return {status,published,key:pool.localHostKey,pending:pool.localControllerPending,remembered};
  },{rootKey,peerKey});
  expect(result).toEqual({status:"local_controller_recovery_superseded",published:0,key:peerKey,pending:true,remembered:rootKey});
});
