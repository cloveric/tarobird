import { app, BrowserWindow, net, protocol, session } from "electron";
import assert from "node:assert/strict";
import path from "node:path";
import { SCHEMES, assetHandler } from "../assets.mjs";
import { secureContents, secureSession, secureWebPreferences } from "../security.mjs";

// Invoked with a fixture directory whose assets contain the production shell
// and inert fixture bundle. All state and the entire session are isolated.
const root = process.argv.at(-1);
protocol.registerSchemesAsPrivileged(SCHEMES);
app.enableSandbox();
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", path.join(root, "profile"));
app.setPath("sessionData", path.join(root, "session"));
const deadline = setTimeout(() => { console.error("fixture_timeout"); app.exit(1); }, 15000);
void app.whenReady().then(async () => {
  let win;
  try {
    const ses = session.fromPartition("plugin-policy-smoke");
    secureSession(ses, { owns: contents => contents === win?.webContents });
    const assets = path.join(root, "assets");
    await ses.protocol.handle("tarobot", assetHandler(assets, url => net.fetch(url)));
    const widget = assetHandler(assets, url => net.fetch(url), { widget: true });
    let dnsHeader;
    await ses.protocol.handle("tarobot-widget", async request => {
      const result = await widget(request);
      dnsHeader = result.headers.get("x-dns-prefetch-control");
      return result;
    });
    win = new BrowserWindow({ show: false, webPreferences: secureWebPreferences(undefined, ses) });
    secureContents(win.webContents);
    win.webContents.on("console-message", details => {
      if (/Content Security Policy|CSP|permission policy/i.test(details.message)) console.log(details.message);
    });
    const failures = [];
    win.webContents.on("did-fail-load", (_event, code, description, url) => {
      if (url.startsWith("data:text/html,")) failures.push({ code, description });
    });
    await win.loadURL("tarobot://app/index.html");
    const receipt = await win.webContents.executeJavaScript(`new Promise(resolve => {
      const output = document.querySelector('#result');
      if (output.textContent) return resolve(output.textContent);
      new MutationObserver((_, observer) => { observer.disconnect(); resolve(output.textContent); }).observe(output, { childList: true });
    })`);
    const result = JSON.parse(receipt);
    assert.equal(result.childFrames, 0);
    assert.equal(result.hints, 0);
    assert.equal(result.dns, "off");
    assert.equal(dnsHeader, "off");
    assert.deepEqual(result.rtc, Array(3).fill("undefined"));
    assert.equal(result.workerStarted, false);
    assert.ok(result.violations.includes("worker-src"));
    for (const name of ["child-src", "frame-src", "worker-src"]) assert.ok(result.csp.includes(`${name} 'none'`));
    const frames = win.webContents.mainFrame.framesInSubtree.map(frame => frame.url);
    assert.ok(result.violations.includes("frame-src") || failures.some(failure => failure.description === "ERR_BLOCKED_BY_CSP"));
    assert.ok(failures.some(failure => failure.description === "ERR_BLOCKED_BY_CSP"));
    console.log(JSON.stringify({ electron: process.versions.electron, chromium: process.versions.chrome, dnsHeader, frames, failures, ...result }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    win?.destroy();
    clearTimeout(deadline);
  }
});
