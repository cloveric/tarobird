import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import type { ViteDevServer } from "vite";

const html = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';
import {ClientCache} from '/src/storage.ts';import {useWorkbench} from '/src/use-workbench.ts';
const identity={deviceId:'device',hubPublicKey:'host',publicKey:'key',name:'test',routes:[]};
const cache=new ClientCache('workbench-registration');await cache.initializeIdentity(identity);
const listeners=new Set(),f=window.workbenchRegistrationFixture={sent:[]};
const connection=f.connection={cache,identity,state:{status:'online',user:{id:'owner'},workbenchAvailable:true},sessionEpoch:1,isReadOnly:false,isClosed:false,
 subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},subscribeWorkbench(){return()=>{}},conversationRevision(){return 0},
 async send(frame){f.sent.push(structuredClone(frame))}};
f.emit=()=>listeners.forEach(fn=>fn());
function App(){const w=useWorkbench(connection,'conversation','owner',true);f.workbench=w;React.useEffect(()=>{void w.ensure()},[w.ensure]);return React.createElement('output',null,String(!!w.controller));}
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`;
let server: ViteDevServer, url: string;
test.beforeAll(async () => {
  server = await createServer({ plugins: [{ name: "workbench-registration-harness", configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => { if (req.url !== "/__workbench_registration") return next(); res.setHeader("Content-Type", "text/html"); res.end(await vite.transformIndexHtml("/__workbench_registration", html)); });
  } }], server: { port: 0, host: "127.0.0.1" } });
  await server.listen(); url = server.resolvedUrls!.local[0] + "__workbench_registration";
});
test.afterAll(async () => { await server.close(); });
test("registration follows authenticated session identity even if online state is unchanged", async ({ page }) => {
  await page.goto(url); await expect(page.locator("output")).toHaveText("true");
  await expect.poll(() => page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.filter((frame: any) => frame.type === "workbench.register").length)).toBe(1);
  const initial = await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent[0].registration);
  // Same-task offline/connecting/online: the old 80ms debounce never observed it.
  const fast = await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture;
    f.connection.state.status = "offline"; f.emit(); f.connection.state.status = "connecting"; f.emit();
    f.connection.sessionEpoch++; f.connection.state.status = "online"; f.emit();
    return f.sent.filter((frame: any) => frame.type === "workbench.register").map((frame: any) => frame.registration);
  });
  expect(fast).toEqual([initial, initial]);
  // A new authenticated peer is sufficient; a visible online transition is not required.
  const replaced = await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture; f.connection.sessionEpoch++; f.emit();
    return f.sent.filter((frame: any) => frame.type === "workbench.register").map((frame: any) => frame.registration);
  });
  expect(replaced).toEqual([initial, initial, initial]);
  await page.evaluate(() => { const f = (window as any).workbenchRegistrationFixture; for (let i = 0; i < 10; i++) f.emit(); });
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.filter((frame: any) => frame.type === "workbench.register").length)).toBe(3);
});

test("busy chat notifications do not postpone a changed workbench registration", async ({ page }) => {
  await page.goto(url); await expect(page.locator("output")).toHaveText("true");
  await expect.poll(() => page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.length)).toBe(1);
  await page.clock.install();
  await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture;
    f.connection.state.workbenchDesignAvailable = true;
    f.emit();
    f.noise = setInterval(() => f.emit(), 10);
  });
  await page.clock.runFor(250);
  const registered = await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.filter((frame: any) => frame.type === "workbench.register"));
  expect(registered).toHaveLength(2);
  expect(registered[1].registration.capabilities).toContain("design.v1");
  await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture;
    clearInterval(f.noise); f.connection.state.workbenchMarkdownAvailable = true; f.emit();
  });
  await page.clock.runFor(80);
  expect(await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.at(-1).registration.capabilities)).toContain("markdown.v1");
  // A pending old-session window is cancelled on offline/epoch replacement.
  await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture;
    f.connection.state.workbenchSlidesAvailable = true; f.emit();
    f.connection.state.status = "offline"; f.emit();
  });
  await page.clock.runFor(160);
  expect(await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent.length)).toBe(3);
  await page.evaluate(() => {
    const f = (window as any).workbenchRegistrationFixture;
    f.connection.sessionEpoch++; f.connection.state.status = "online"; f.emit();
  });
  await page.clock.runFor(160);
  const final = await page.evaluate(() => (window as any).workbenchRegistrationFixture.sent);
  expect(final).toHaveLength(4); expect(final[3].registration.capabilities).toContain("design.slides.v1");
});
