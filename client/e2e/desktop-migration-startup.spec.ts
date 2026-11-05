import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

// Actual HostApp + IndexedDB startup; only native IPC and network delivery are
// fixtures. One damaged migrated host must not suppress another host's proof.
const html = `<!doctype html><html lang="zh"><body><div id="root"></div><script type="module">
const params=new URLSearchParams(location.search), calls=[], starts=[];
window.runtimeIssue=params.get('runtime')==='waiting'?'runtime_waiting':undefined;
const key=n=>btoa(String.fromCharCode(...[48,42,48,5,6,3,43,101,112,3,33,0,...Array(32).fill(n)]));
const localKey=key(1), remoteKey=key(2);
const invoke=async(command,args={})=>{
  calls.push({command,action:args.action,device:args.device?.deviceId});
  if(command==='desktop_host') return args.action==='pair'?{}:{available:true,running:true,publicKey:localKey,runtimeIssue:window.runtimeIssue,controlCapabilities:['desktop-controller-challenge','enroll-desktop-controller']};
  if(command==='net_document') return 'fixture-document';
  if(command==='github_update_info') return {configured:false,version:'1.0.120',provider:'default',authenticated:false};
  if(command==='desktop_launch_links') return [];
  if(command==='desktop_notifications_supported') return false;
  if(command==='unread_count') return null;
  throw Error('fixture_unhandled_'+command);
};
if(params.get('engine')==='tauri'){
  Object.assign(globalThis,{isTauri:true});
  const {mockIPC}=await import('@tauri-apps/api/mocks'); mockIPC(invoke);
} else window.tarobotDesktop={version:1,engine:'electron',platform:'darwin',invoke,on:()=>()=>{},openSocket:async()=>{throw Error('unexpected_socket');}};
const [{createElement},{createRoot},{HostApp},{HostRegistry},{HostConnections},{HubConnection},{ClientCache},{openDB}]=await Promise.all([
  import('react'),import('react-dom/client'),import('/src/HostApp.tsx'),import('/src/host-registry.ts'),
  import('/src/host-connections.ts'),import('/src/connection.ts'),import('/src/storage.ts'),import('idb')]);
const registry=new HostRegistry();
if(params.has('locale')){
  const {defaultPreferences}=await import('/src/storage.ts'),{setLocale}=await import('/src/i18n.ts');
  const locale=params.get('locale');setLocale(locale);await registry.savePreferences({...defaultPreferences,locale});
}
const add=async(name,hubPublicKey,deviceId)=>registry.add({deviceId,keyRef:deviceId,name,platform:'macos',publicKey:key(3),hubPublicKey,routes:[]},name);
const local=await add('Local',localKey,'device_local'),remote=await add('Remote',remoteKey,'device_remote');
for(const host of [local,remote]){const handle=await registry.open(host.id);await handle.cache.saveDraft('draft','keep '+host.name);handle.cache.close();}
await registry.rememberNativeLocalHost(localKey);
const repaired=params.get('repair')==='local'?local:remote;
if(params.get('repair')!=='none'){const db=await openDB('tarocub-hosts-v1');await db.put('meta',JSON.stringify([repaired.id]),'desktopMigrationRepair');db.close();}
HubConnection.prototype.start=async function(){starts.push(this.identity.hubPublicKey);};
const start=HostConnections.prototype.start;
HostConnections.prototype.start=async function(){await start.call(this);window.bootPool=this;};
window.bootReadback=async()=>{
  if(!window.bootPool)return null;
  const pool=window.bootPool, drafts=[];
  for(const host of [local,remote]){const cache=new ClientCache(host.databaseName);drafts.push(await cache.draft('draft'));cache.close();}
  return {calls,starts,localKey,remoteKey,localHostKey:pool.localHostKey,pending:pool.localControllerPending,
    localConnected:!!pool.connection(local.id),remoteConnected:!!pool.connection(remote.id),
    repair:await registry.migrationRepairHosts(),repairExpected:repaired.id,hosts:(await registry.list()).map(h=>h.deviceId),drafts};
};
createRoot(document.getElementById('root')).render(createElement(HostApp,{Workspace:()=>createElement('div',null,'WORKSPACE'),Pairing:()=>createElement('div',null,'PAIRING')}));
</script></body></html>`;

let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "migration-startup-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/__migration-startup")) return next();
      res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__migration-startup", html));
    });
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); url = server.resolvedUrls!.local[0]! + "__migration-startup";
});
test.afterAll(async () => { await server?.close(); });
test.use({ serviceWorkers: "block" });

for (const engine of ["electron", "tauri"]) for (const repair of ["remote", "local"]) {
  test(`${engine}: ${repair} migration repair preserves per-host startup and original drafts`, async ({ page }) => {
    await page.goto(`${url}?engine=${engine}&repair=${repair}`);
    await expect.poll(() => page.evaluate(() => Boolean((window as any).bootPool))).toBe(true);
    const result = await page.evaluate(() => (window as any).bootReadback());
    await test.info().attach("startup-readback", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(result.localHostKey).toBe(result.localKey);
    expect(result.calls.filter((c: any) => c.command === "desktop_host").map((c: any) => c.action)).toEqual(repair === "remote" ? ["resume", "pair"] : ["resume"]);
    expect(result.pending).toBe(repair === "local");
    expect(result.localConnected).toBe(repair === "remote");
    expect(result.remoteConnected).toBe(repair === "local");
    expect(result.starts).toEqual([repair === "local" ? result.remoteKey : result.localKey]);
    expect(result.calls.filter((c: any) => ["device_create", "device_forget"].includes(c.command))).toEqual([]);
    expect(result.repair).toEqual([result.repairExpected]);
    expect(result.hosts.sort()).toEqual(["device_local", "device_remote"]);
    expect(result.drafts).toEqual(["keep Local", "keep Remote"]);
  });
}

for (const locale of ["zh", "en"]) {
  test(`local update notice stays dismissed during recovery polling (${locale})`, async ({ page }) => {
    await page.clock.install();
    await page.goto(`${url}?repair=none&runtime=waiting&locale=${locale}`);
    await expect.poll(() => page.evaluate(() => Boolean((window as any).bootPool))).toBe(true);
    const notice = page.getByRole("alert");
    await expect(notice).toContainText(locale === "en" ? "Waiting for local tasks" : "正在等待本机任务");
    await notice.getByRole("button", { name: locale === "en" ? "Close" : "关闭", exact: true }).click();
    await expect(notice).toHaveCount(0);
    const resumes = async () => (await page.evaluate(() => (window as any).bootReadback())).calls.filter((call: any) => call.command === "desktop_host" && call.action === "resume").length;
    const before = await resumes();
    for (let poll = 1; poll <= 2; poll++) {
      await page.clock.fastForward(60_000);
      await expect.poll(resumes).toBe(before + poll);
      await expect(notice).toHaveCount(0);
    }
    // Dismissing presentation cannot stop recovery or hide a different issue.
    await page.evaluate(() => { (window as any).runtimeIssue = "runtime_recovery_failed"; });
    await page.clock.fastForward(60_000);
    await expect(notice).toContainText(locale === "en" ? "update did not complete" : "后台更新未完成");
    await page.evaluate(() => { (window as any).runtimeIssue = undefined; });
    await page.clock.fastForward(60_000);
    await expect(notice).toHaveCount(0);
    await page.evaluate(() => { (window as any).runtimeIssue = "runtime_waiting"; });
    await page.clock.fastForward(60_000);
    await expect(notice).toContainText(locale === "en" ? "Waiting for local tasks" : "正在等待本机任务");
    const result = await page.evaluate(() => (window as any).bootReadback());
    expect(result.pending).toBe(false); expect(result.localConnected).toBe(true);
    expect(result.calls.filter((call: any) => call.command === "desktop_host").every((call: any) => ["resume", "pair"].includes(call.action))).toBe(true);
    expect(result.drafts).toEqual(["keep Local", "keep Remote"]);
  });
}
