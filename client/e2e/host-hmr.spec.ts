import { preparePairing } from "./fixtures/pairing-invite.js";
import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { createServer } from "./fixtures/vite.js";
import { HubServer } from "../../src/hub/server.js";

test.use({ serviceWorkers: "block" });

test("Fast Refresh replaces closed host resources after direct and dependency updates without losing pairing", async ({ page }) => {
  // Only these temporary copies are edited. Browser storage belongs to the
  // fresh Playwright context and origin; no user profile or production Hub.
  const root = await mkdtemp(path.join(os.tmpdir(), "tarocub-host-hmr-"));
  const owner = path.join(root, "HostApp.tsx"), dependency = path.join(root, "hmr-dependency.ts");
  const source = (await readFile(path.resolve("src/HostApp.tsx"), "utf8"))
    .replace(/from "\.\.\/\.\.\/src\/([^"]+)\.js"/g, `from "/@fs/${path.resolve("../src")}/$1.ts"`)
    .replace(/from "\.\//g, 'from "/src/')
    .replace(/import "\.\//g, 'import "/src/')
    .replace(/import\("\.\//g, 'import("/src/');
  const copy = (revision: number) => `import { revision as dependencyRevision } from "./hmr-dependency";\nvoid dependencyRevision;\n${source}\nvoid ${revision};\n`;
  await writeFile(owner, copy(0)); await writeFile(dependency, "export const revision = 0;\n");
  let vite: ViteDevServer | undefined, hub: HubServer | undefined;
  try {
    const html = `<!doctype html><html><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { HostApp } from '/@fs/${owner}';
      import { Pairing } from '/src/Pairing.tsx';
      import '/src/styles.css';
      import '/src/brand-theme.css';
      import '/src/palette-tokens.css';
      const f = window.hostHmrFixture = { pageEpoch:crypto.randomUUID(), mounts:0, connections:[], connection:undefined };
      function Workspace({connection,shell}) {
        const [draft,setDraft]=React.useState('');
        React.useEffect(()=>{f.mounts++;f.connections.push(connection);f.connection=connection;connection.cache.draft('hmr-probe').then(setDraft);},[connection]);
        return React.createElement('main',{'data-testid':'hmr-workspace'},
          React.createElement('h1',null,shell.host.name),
          React.createElement('p',{'data-testid':'hmr-draft'},draft),
          React.createElement('button',{onClick:()=>shell.updatePreferences({...shell.preferences,fontSize:shell.preferences.fontSize+1})},'普通界面更新'),shell.controls);
      }
      createRoot(document.getElementById('root')).render(React.createElement(HostApp,{Workspace,Pairing}));
    </script></body></html>`;
    vite = await createServer({ plugins: [{ name: "host-hmr-harness", configureServer(server) {
      server.middlewares.use(async (req,res,next) => {
        if(req.url !== "/__host-hmr") return next();
        res.setHeader("Content-Type","text/html");res.end(await server.transformIndexHtml("/__host-hmr",html));
      });
    } }], resolve: { dedupe: ["react", "react-dom", "zod", "lucide-react"] }, server: { port: 0, strictPort: false, host: "127.0.0.1", fs: { allow: [path.resolve(".."),root] } } });
    await vite.listen(); const origin = vite.resolvedUrls!.local[0]!;
    hub = await HubServer.start({ stateDir: path.join(root,"hub"), origins:[new URL(origin).origin] });
    await page.goto(origin + "__host-hmr");
    await page.getByRole("textbox", {name:"主机名称",exact:true}).fill("HMR 独立主机");
    await page.getByRole("textbox", {name:"Hub 地址",exact:true}).fill(hub.url);
    await preparePairing(page, hub); await page.getByRole("button", {name:"配对此设备",exact:true}).click();
    await hub.auth.approve(await page.getByLabel("配对码",{exact:true}).innerText(),"local-owner");
    await page.getByLabel("配对码", { exact: true }).waitFor({ state: "hidden" });
    await expect(page.getByTestId("hmr-workspace")).toBeVisible();
    const before = await page.evaluate(async () => {
      const f=(window as any).hostHmrFixture;
      await f.connection.cache.saveDraft("hmr-probe","持久草稿仍在");
      return {epoch:f.pageEpoch,mounts:f.mounts,deviceId:f.connection.identity.deviceId};
    });
    const verify = async (expectedMounts: number) => {
      await expect.poll(() => page.evaluate(() => (window as any).hostHmrFixture.mounts)).toBe(expectedMounts);
      await expect(page.getByTestId("hmr-draft")).toHaveText("持久草稿仍在");
      await expect(page.getByText("无法读取本地数据，请重试。",{exact:true})).toHaveCount(0);
      await expect(page.getByRole("button",{name:"配对此设备",exact:true})).toHaveCount(0);
      const current = await page.evaluate(() => {
        const f=(window as any).hostHmrFixture;
        return {epoch:f.pageEpoch,deviceId:f.connection.identity.deviceId,
          fresh:f.connections.at(-1)!==f.connections.at(-2)};
      });
      expect(current).toEqual({epoch:before.epoch,deviceId:before.deviceId,fresh:true});
    };
    await page.getByRole("button",{name:"普通界面更新",exact:true}).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--font-size"))).toBe("15px");
    expect(await page.evaluate(() => (window as any).hostHmrFixture.mounts)).toBe(before.mounts);
    await writeFile(owner,copy(1)); await verify(before.mounts+1);
    // Non-boundary dependency updates must propagate to the owner's timestamp,
    // not preserve its now-closed registry merely because its own text is equal.
    await writeFile(dependency,"export const revision = 1;\n"); await verify(before.mounts+2);
  } finally {
    await page.close(); await vite?.close(); await hub?.close(); await rm(root,{recursive:true,force:true});
  }
});
