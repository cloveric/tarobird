import { test, expect } from "@playwright/test";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";

const html = `<!doctype html><html lang="zh"><body><div id="root"></div><script type="module">
import {mockIPC} from '@tauri-apps/api/mocks';
Object.assign(globalThis,{isTauri:true});
const requests=[]; window.bootRequests=requests;
mockIPC((command,args)=>{
  requests.push({command,action:args?.action});
  if(command==='desktop_host') {
    if(sessionStorage.getItem('runtime-recovered')) return {available:true,running:false};
    throw 'desktop_host_operation_failed|exit=1|reason=module_missing|error=ERR_MODULE_NOT_FOUND|phase=desktop_module|kind=Error';
  }
  if(command==='net_document') return 'fixture-document';
  throw 'fixture_unhandled_command';
});
const [{createElement},{createRoot},{HostApp},{HostRegistry},{startupAttempt}]=await Promise.all([
import('react'),import('react-dom/client'),import('/src/HostApp.tsx'),import('/src/host-registry.ts'),import('/src/startup-diagnostics.ts')]);
import '/src/styles.css';import '/src/brand-theme.css';import '/src/palette-tokens.css';
window.startupAttempt=startupAttempt;
const registry=new HostRegistry();
if(location.search.includes('saved') && !(await registry.list()).length) {
  const host=await registry.add({deviceId:'device_saved',keyRef:'device_saved',name:'Old computer',platform:'windows',
    publicKey:'MCowBQYDK2VwAyEAHTOtHY4pE6KDRulDdkNNtHlm7G5NvzDbpuJfCQ3rQdk=',
    hubPublicKey:'MCowBQYDK2VwAyEAHTOtHY4pE6KDRulDdkNNtHlm7G5NvzDbpuJfCQ3rQdk=',routes:[]},'Saved host');
  const handle=await registry.open(host.id);await handle.cache.saveDraft('saved-chat','draft before reinstall');handle.cache.close();
}
window.bootState=async()=>{const hosts=await registry.list();const first=hosts[0];if(!first)return {hosts:[]};
  const handle=await registry.open(first.id);try{return {hosts,identity:handle.identity,draft:await handle.cache.draft('saved-chat')};}finally{handle.cache.close();}};
createRoot(document.getElementById('root')).render(createElement(HostApp,{Workspace:()=>createElement('div',null,'WORKSPACE'),Pairing:()=>createElement('h1',null,'PAIRING_READY')}));
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "startup-failure-fixture", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (!req.url?.startsWith("/__startup")) return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__startup", html)); });
  } }], server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen(); url = server.resolvedUrls!.local[0]! + "__startup";
});
test.afterAll(async () => { await server?.close(); });
test.use({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36", serviceWorkers: "block" });

test("unknown native startup shows useful safe diagnostics and retries without creating an identity", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "TaroBird 暂时无法启动" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("本机运行组件未能正常响应，暂时无法进入 TaroBird。");
  const card = await page.locator(".startup-failure-card").boundingBox();
  const retry = await page.getByRole("button", { name: "重新尝试" }).boundingBox();
  expect(card!.width).toBeLessThanOrEqual(502); expect(retry!.y - card!.y).toBeLessThan(300);
  await page.getByText("查看诊断信息", { exact: true }).click();
  const diagnostics = JSON.parse(await page.locator(".startup-failure-card pre").innerText());
  expect(diagnostics).toMatchObject({ platform: "windows", stage: "local_controller", attempts: [
    { action: "resume", code: "desktop_host_operation_failed", exit: 1, reason: "module_missing", error: "ERR_MODULE_NOT_FOUND", phase: "desktop_module", kind: "Error" },
    { action: "status", code: "desktop_host_operation_failed", exit: 1, reason: "module_missing", error: "ERR_MODULE_NOT_FOUND", phase: "desktop_module", kind: "Error" },
  ] });
  await page.screenshot({ path: test.info().outputPath("startup-failure.png") });
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as any).copiedDiagnostics = value; } } }); });
  await page.getByRole("button", { name: "复制诊断信息" }).click();
  await expect(page.getByRole("status")).toHaveText("诊断信息已复制");
  expect(JSON.parse(await page.evaluate(() => (window as any).copiedDiagnostics))).toEqual(diagnostics);
  expect(await page.evaluate(() => (window as any).bootRequests.filter((r: any) => r.command === "device_create" || r.command === "device_forget" || r.command === "net_http"))).toEqual([]);
  await page.evaluate(() => sessionStorage.setItem("runtime-recovered", "1"));
  await page.getByRole("button", { name: "重新尝试" }).click();
  await expect(page.getByRole("heading", { name: "PAIRING_READY" })).toBeVisible();
});

test("uninstall/reinstall residual pairing and drafts survive repeated startup failures", async ({ page }) => {
  await page.goto(url + "?saved");
  await expect(page.getByRole("heading", { name: "TaroBird 暂时无法启动" })).toBeVisible();
  const before = await page.evaluate(() => (window as any).bootState());
  expect(before.draft).toBe("draft before reinstall");
  await page.getByRole("button", { name: "重新尝试" }).click();
  await expect(page.getByRole("heading", { name: "TaroBird 暂时无法启动" })).toBeVisible();
  expect(await page.evaluate(() => (window as any).bootState())).toEqual(before);
  expect(await page.evaluate(() => (window as any).bootRequests.filter((r: any) => r.command === "desktop_host").map((r: any) => r.action))).toEqual(["resume", "status"]);
});

test("unrecognized native diagnostics cannot expose paths, tokens or raw stderr", async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "TaroBird 暂时无法启动" })).toBeVisible();
  expect(await page.evaluate(() => {
    const parse = (window as any).startupAttempt;
    return [parse("status", new Error("private C:\\Users\\secret token=123")),
      parse("resume", "desktop_host_operation_failed|exit=-1073741515|reason=private-token|path=C:\\private"),
      parse("status", "desktop_host_launch_failed|os=5"),
      parse("status", "desktop_host_operation_failed|exit=1|reason=unknown|error=private|kind=private|phase=private"),
      parse("status", "desktop_host_operation_failed|exit=1|reason=unknown|error=EINVAL|kind=TypeError|phase=desktop_command"),
      ...["control_closed", "control_timeout", "control_response_invalid", "resource_busy", "database_schema_invalid", "host_not_ready", "selected_runtime_failed", "module_url_invalid", "state_validation_failed"]
        .map(reason => parse("status", "desktop_host_operation_failed|exit=1|reason=" + reason))];
  })).toEqual([
    { action: "status", code: "native_request_failed" },
    { action: "resume", code: "desktop_host_operation_failed", exit: -1073741515 },
    { action: "status", code: "desktop_host_launch_failed", os: 5 },
    { action: "status", code: "desktop_host_operation_failed", exit: 1, reason: "unknown" },
    { action: "status", code: "desktop_host_operation_failed", exit: 1, reason: "unknown", error: "EINVAL", kind: "TypeError", phase: "desktop_command" },
    ...["control_closed", "control_timeout", "control_response_invalid", "resource_busy", "database_schema_invalid", "host_not_ready", "selected_runtime_failed", "module_url_invalid", "state_validation_failed"]
      .map(reason => ({ action: "status", code: "desktop_host_operation_failed", exit: 1, reason })),
  ]);
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }); });
  await page.getByRole("button", { name: "复制诊断信息" }).click();
  await expect(page.getByRole("status")).toHaveText("复制失败，请选择文字后复制。");
});
