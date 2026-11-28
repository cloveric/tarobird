// Real Electron capture -> Hub -> single-port relay -> Chromium / WebKit.
// Run with node --import tsx client/electron/tests/screen-udp.smoke.mjs
//   --lab <private .noindex directory> --electron <Electron executable>
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash, randomUUID, sign, X509Certificate } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { build } from '../../../node_modules/esbuild/lib/main.js';
import { HubServer } from '../../../src/hub/server.ts';
import { startHubControl } from '../../../src/hub/service.ts';
import { deviceProof, hashSecret } from '../../../src/hub/auth.ts';
import { screenConfigureText } from '../../../src/client-protocol/remote-screen.ts';
import { SCREEN_RTC_SEQUENCE_START, screenRtcOfferText } from '../../../src/client-protocol/screen-rtc.ts';
import { deviceActionProofText } from '../../../src/client-protocol/device-actions.ts';
import { RelayServer } from '../../../src/relay/server.ts';
import { RelayTunnel } from '../../../src/relay/tunnel.ts';
import { probeScreenUdp } from '../../../src/relay/screen-udp-probe.ts';
import { deviceFields, enrollTrusted, loginFor, testDevice } from '../../../tests/helpers/pairing-invite.ts';
import { isolatedRoot } from '../isolation.mjs';
import { helperEnvironment } from '../helper-rpc.mjs';

const { values } = parseArgs({ options: { lab: { type: 'string' }, electron: { type: 'string' }, browser: { type: 'string' }, mode: { type: 'string' },
  'before-confirm': { type: 'string' } } });
if (!values.lab || !values.electron || !['chromium', 'webkit'].includes(values.browser ?? 'chromium') || !['relay', 'lan'].includes(values.mode ?? 'relay')) throw new Error('usage: --lab <private .noindex dir> --electron <executable> [--browser chromium|webkit] [--mode relay|lan]');
const mode = values.mode ?? 'relay', engine = values.browser ?? 'chromium';
const beforeConfirm = values['before-confirm'];
if (beforeConfirm && (mode !== 'relay' || !['drop', 'timeout'].includes(beforeConfirm))) throw new Error('--before-confirm requires relay mode and drop or timeout');
const run = await mkdtemp(path.join(await isolatedRoot(values.lab), 'screen-udp-'));
const app = path.join(run, 'app'), capture = path.join(app, 'screen-capture'), hostDir = path.join(run, 'hub');
const here = path.dirname(fileURLToPath(import.meta.url)), electronDir = path.dirname(here);
await mkdir(capture, { recursive: true });
await Promise.all([
  build({ entryPoints: [path.join(electronDir, 'screen-capture-page.mjs')], outfile: path.join(capture, 'capture.js'), bundle: true, format: 'iife', platform: 'browser', target: 'chrome140' }),
  build({ entryPoints: [path.join(electronDir, 'screen-capture-preload.mjs')], outfile: path.join(app, 'capture-preload.cjs'), bundle: true, format: 'cjs', platform: 'node', external: ['electron'] }),
  build({ entryPoints: [path.join(here, 'screen-udp-smoke-main.mjs')], outfile: path.join(app, 'main.mjs'), bundle: true, format: 'esm', platform: 'node',
    external: ['electron'], banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } }),
  build({ entryPoints: [path.join(here, 'screen-udp-smoke-viewer.ts')], outfile: path.join(run, 'viewer.js'), bundle: true, format: 'esm', platform: 'browser', target: 'esnext' }),
  cp(path.join(electronDir, 'screen-capture.html'), path.join(capture, 'capture.html')),
  writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'tarobird-screen-udp-smoke', main: 'main.mjs', type: 'module' })),
]);
const scripts = await readFile(path.join(run, 'viewer.js'));
const openssl = args => execFileSync('openssl', args, { cwd: run, stdio: 'ignore' });
openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '1', '-subj', '/CN=Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
const certPair = async (name, purpose) => {
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=' + name + '.test']);
  await writeFile(path.join(run, name + '.ext'), `subjectAltName=DNS:${name}.test\nextendedKeyUsage=${purpose}\n`);
  openssl(['x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', name + '.pem', '-days', '1', '-extfile', name + '.ext']);
  return { key: await readFile(path.join(run, name + '.key')), cert: await readFile(path.join(run, name + '.pem')) };
};
const ca = await readFile(path.join(run, 'ca.pem')), serverPair = await certPair('relay', 'serverAuth'), clientPair = await certPair('host', 'clientAuth');
const fingerprint = new X509Certificate(clientPair.cert).fingerprint256;
const wait = async (f, ms = 8000) => {
  const deadline = performance.now() + ms;
  while (!(await f())) {
    if (performance.now() > deadline) throw new Error('fixture deadline');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
let relay, tunnel, web, hub, child, browser, stop, join, viewer, tamperDenied;
const postHub = (body, token) => fetch(hub.url + '/api/screens/rtc', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body),
});
const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
try {
  web = createServer(async (req, res) => {
    try {
      if (req.url?.startsWith('/?')) { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><canvas tabindex="0" style="width:100%;max-width:640px"></canvas><script type="module" src="/viewer.js"></script>'); return; }
      if (req.url === '/viewer.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(scripts); return; }
      if (req.url === '/fixture') return json(res, 200, { join, url: hub.url.replace('http', 'ws') });
      if (req.url === '/identity') return json(res, 200, hub.auth.publicKey);
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) throw new Error('oversized test request'); }
      const value = JSON.parse(body);
      if (req.url === '/sign') {
        const text = screenRtcOfferText({ ...value, deviceId: join.session.deviceId });
        const digest = createHash('sha256').update(text).digest('base64url');
        return json(res, 200, sign(null, deviceProof(join.session.deviceId, value.nonce, digest), viewer.privateKey).toString('base64'));
      }
      if (req.url === '/signal') {
        // The timeout case lets the Hub retire the attempt even if its peer
        // cannot deliver the best-effort close request.
        if (beforeConfirm === 'timeout' && value.type === 'close') return json(res, 503, {});
        if (value.type === 'offer') {
          const altered = value.sdp.replace(/(a=fingerprint:sha-256 )([A-Fa-f0-9])/, (_, label, digit) => label + (digit === 'A' ? 'B' : 'A'));
          tamperDenied = (await postHub({ ...value, sdp: altered }, viewer.token)).status;
        }
        const result = await postHub(value, viewer.token);
        if (!result.ok) console.error('signal', value.type, value.mode, result.status, await result.clone().text());
        return json(res, result.status, await result.json());
      }
      json(res, 404, {});
    } catch (error) { console.error(error.message); json(res, 500, {}); }
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  const webUrl = 'http://127.0.0.1:' + web.address().port;
  hub = await HubServer.start({ stateDir: hostDir, origins: [webUrl], screenUdpRelay: {
    endpoint: () => tunnel?.screenUdpEndpoint, lease: () => tunnel?.screenUdpLease() ?? Promise.resolve(undefined),
  } });
  let withheld = 0;
  if (beforeConfirm) {
    const confirm = hub.remoteScreen.serviceFrameConfirmed.bind(hub.remoteScreen);
    hub.remoteScreen.serviceFrameConfirmed = (...args) => {
      if (args[2] >= SCREEN_RTC_SEQUENCE_START) withheld++;
      else confirm(...args);
    };
  }
  relay = await RelayServer.start({ publicHost: '127.0.0.1', publicPort: 0, tunnelHost: '127.0.0.1', tunnelPort: 0,
    serverName: 'hub.test', clientFingerprint256: fingerprint, tls: { ca, ...serverPair }, screenUdp: { address: '127.0.0.1', hosts: [fingerprint] } });
  tunnel = new RelayTunnel({ host: '127.0.0.1', port: relay.status.tunnelPort, servername: 'relay.test', tls: { ca, ...clientPair },
    targetHost: '127.0.0.1', targetPort: Number(new URL(hub.url).port) });
  tunnel.start();
  await wait(() => tunnel.screenUdpEndpoint);
  if (!(await probeScreenUdp('127.0.0.1', relay.status.tunnelPort))) throw new Error('real UDP ingress unavailable');
  const owner = testDevice('fixture_owner'), paired = testDevice('fixture_viewer'), stranger = testDevice('fixture_other');
  await hub.enrollLocalController(deviceFields(owner)); await enrollTrusted(hub.auth, paired); await enrollTrusted(hub.auth, stranger);
  const local = await loginFor(hub.auth, owner), remote = await loginFor(hub.auth, paired), outsider = await loginFor(hub.auth, stranger);
  viewer = { ...paired, ...remote };
  const config = { operation: 'screen.configure', expectedRevision: 0, enabled: true, udpBoost: true, requestId: randomUUID(),
    grants: [{ deviceId: paired.deviceId, publicKey: paired.publicKey, permission: 'control' }] };
  const proof = await hub.auth.prepareDeviceAction({ operation: 'screen-grant', target: hashSecret(screenConfigureText(config)) }, local.token, local.session);
  await hub.remoteScreen.configure(local.session, config, { nonce: proof.nonce, signature: sign(null, Buffer.from(deviceActionProofText(proof)), owner.privateKey).toString('base64') });
  stop = await startHubControl(hostDir, () => ({ running: true, pid: process.pid, url: hub.url, instanceUrl: hub.instanceUrl, publicKey: hub.auth.publicKey }),
    () => {}, { screenServiceTicket: id => hub.remoteScreen.serviceTicket(id) });
  child = spawn(values.electron, [app, hostDir], { env: helperEnvironment(), stdio: ['ignore', 'inherit', 'inherit'] });
  let status;
  await wait(async () => {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Electron target exited: ${child.exitCode ?? child.signalCode}`);
    return (status = await hub.remoteScreen.status(remote.session)).desktop;
  }, 14_000);
  const display = status.desktop.displays[0];
  join = await hub.remoteScreen.open(remote.session, { desktopId: status.desktop.desktopId, displayId: display.id,
    displayRevision: display.revision, requestId: randomUUID(), codecs: ['vp8', 'h264'] }, { rtc: true });
  if (!join.rtc) throw new Error('target did not negotiate RTC support');
  const denied = await postHub({ type: 'prepare', sessionId: join.session.id, generation: join.session.generation, mode: 'relay' }, outsider.token);
  if (denied.status !== 403) throw new Error('ungranted device could reach signaling');
  browser = await (engine === 'webkit' ? webkit : chromium).launch();
  const page = await browser.newPage(engine === 'webkit' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 800 } });
  if (beforeConfirm) await page.addInitScript(() => {
    // Exercise the viewer's older WebKit feature surface in Chromium.
    delete AbortSignal.any;
    delete AbortSignal.timeout;
    delete AbortSignal.prototype.throwIfAborted;
  });
  await page.addInitScript(() => {
    const native = window.RTCPeerConnection;
    window.screenPeerStats = [];
    window.RTCPeerConnection = class extends native {
      constructor(config) {
        super(config);
        const timer = setInterval(() => {
          if (this.connectionState === 'closed') { clearInterval(timer); return; }
          void this.getStats().then(stats => {
            window.screenPeerStats = Array.from(stats.values()).filter(s => ['transport', 'inbound-rtp', 'local-candidate', 'remote-candidate'].includes(s.type))
              .map(({ type, kind, protocol, framesDecoded, dtlsState, candidateType }) => ({ type, kind, protocol, framesDecoded, dtlsState, candidateType }));
          });
        }, 200);
      }
    };
  });
  const pageErrors = [];
  page.on('pageerror', error => { pageErrors.push(error.message); console.error('viewer', error.message); });
  await page.goto(webUrl + '/?mode=' + mode);
  let report;
  if (beforeConfirm) {
    await page.waitForFunction(() => window.receipt?.udpAcks > 0, undefined, { timeout: 20_000 });
    await wait(() => withheld > 0);
    const before = await page.evaluate(() => ({ ...window.receipt, pixels: window.fixturePixels() }));
    if (before.udpReady !== 0 || before.value.fresh || before.pixels.every(n => n === 0)) throw new Error('expected a painted UDP picture without control freshness');
    await page.evaluate(() => window.viewer.control());
    if (await page.evaluate(() => window.receipt.controlRequests)) throw new Error('unconfirmed UDP picture allowed control');
    if (beforeConfirm === 'drop') {
      relay.screenUdp.close();
      relay.screenUdp = undefined;
    }
    try {
      await page.waitForFunction(generation => window.receipt.tcpGeneration > generation && window.receipt.value.fresh && !window.receipt.value.metrics?.udpConnected,
        before.tcpGeneration, { timeout: 12_000 });
    } catch (error) {
      console.error(JSON.stringify({ beforeConfirm, withheld, before: before.tcpGeneration,
        after: await page.evaluate(() => window.receipt), hub: (await hub.remoteScreen.status(remote.session, { udpStatus: true })).udpStatus }));
      throw error;
    }
    const resumed = await page.evaluate(() => ({ ...window.receipt, pixels: window.fixturePixels() }));
    await page.waitForFunction(pixels => window.fixturePixels().some((value, i) => value !== pixels[i]), resumed.pixels);
    await page.evaluate(() => window.viewer.control());
    await page.waitForFunction(() => window.receipt.value.controlling, undefined, { timeout: 5000 });
    await page.evaluate(() => window.viewer.input({ kind: 'move', x: .4, y: .5 }));
    await wait(() => access(path.join(app, 'synthetic-input')).then(() => true, () => false));
    const after = await page.evaluate(() => window.receipt);
    const sessions = (await hub.remoteScreen.status(remote.session)).sessions;
    if (tamperDenied !== 403 || after.udpReady !== 0 || after.closed !== 0 || sessions.length !== 1 || sessions[0].id !== join.session.id
      || after.lastInputFrame <= 0 || after.lastInputFrame >= SCREEN_RTC_SEQUENCE_START) throw new Error('unconfirmed fallback changed session or accepted an unconfirmed RTC frame');
    report = { beforeConfirm, withheld, udpAcks: before.udpAcks, retiredGeneration: before.tcpGeneration,
      tcpGeneration: resumed.tcpGeneration, confirmedControl: true, syntheticPixelsChanged: true, sameSession: true, closedSockets: after.closed };
  } else {
    try {
      await page.waitForFunction(() => window.receipt?.value?.metrics?.udpConnected && window.receipt?.udpAcks >= 5 && window.receipt?.value?.fresh, undefined, { timeout: 20_000 });
    } catch (error) {
      console.error(JSON.stringify({ viewer: await page.evaluate(() => window.receipt), stats: await page.evaluate(() => window.screenPeerStats), relay: relay.status.screenUdp,
        hub: (await hub.remoteScreen.status(remote.session, { udpStatus: true })).udpStatus }));
      throw error;
    }
    await page.waitForFunction(() => window.receipt.value?.metrics?.bitrateKbps > 0 && window.receipt.value.metrics.sampleCount >= 5);
    if (tamperDenied !== 403) throw new Error('a substituted DTLS fingerprint was accepted');
    const udp = await page.evaluate(() => ({ ...window.receipt, value: window.receipt.value }));
    const relayBytes = relay.status.screenUdp.hosts[0].bytesForwarded;
    if (mode === 'relay' ? udp.value.metrics.route !== 'udp_vps_relay' || relayBytes <= 0
      : !['udp_lan_direct', 'udp_direct'].includes(udp.value.metrics.route)) throw new Error('selected route was not exercised');
    const status = async (query, token = viewer.token) => {
      const response = await fetch(hub.url + '/api/screens/status?' + query, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('could not read screen status');
      return (await response.json()).udpStatus;
    };
    // A controller checking Host-level status may see another viewer playing.
    const hubStatus = await status('includeUdpStatus=1&screenRtc=1', local.token);
    if (hubStatus?.route !== 'udp_connected' || hubStatus?.state !== 'connected' || hubStatus?.tcpRoute !== 'tcp_lan_direct') throw new Error('Hub overstated or missed media evidence');
    const old = await status('includeUdpStatus=1', local.token);
    if (old?.route !== 'tcp_lan_direct' || old?.state !== 'fallback_tcp' || 'tcpRoute' in old) throw new Error('legacy status fields changed');
    await page.evaluate(() => window.viewer.control());
    await page.waitForFunction(() => window.receipt.value?.controlling, undefined, { timeout: 5000 });
    await page.evaluate(() => window.viewer.input({ kind: 'move', x: .4, y: .5 }));
    await wait(() => access(path.join(app, 'synthetic-input')).then(() => true, () => false));
    const before = await page.evaluate(() => window.receipt.tcpAcks);
    if (mode === 'relay') {
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        window.blackFrames = 0;
        window.watchedFrames = 0;
        window.checkPixels = setInterval(() => {
          const pixel = canvas.getContext('2d').getImageData(5, 5, 1, 1).data;
          window.watchedFrames++;
          if (pixel[0] + pixel[1] + pixel[2] < 20) window.blackFrames++;
        }, 25);
      });
      // Interrupt only the real UDP listener in this isolated process.
      relay.screenUdp.close();
      relay.screenUdp = undefined;
    }
    if (mode === 'relay') {
      await page.waitForFunction(tcpAcks => window.receipt.tcpAcks > tcpAcks + 3 && window.receipt.value?.fresh && !window.receipt.value?.metrics?.udpConnected, before, { timeout: 10_000 });
    }
    const after = await page.evaluate(() => {
      clearInterval(window.checkPixels);
      return { ...window.receipt, blackFrames: window.blackFrames, watchedFrames: window.watchedFrames };
    });
    if (mode === 'relay' && (!(after.watchedFrames > 10) || after.blackFrames !== 0)) throw new Error('canvas became black during fallback');
    if (after.closed !== 0) throw new Error('screen sockets closed during fallback');
    report = { mode, engine, viewport: page.viewportSize(), denied: denied.status, tamperDenied, udpAcks: udp.udpAcks,
      udpMetrics: udp.value.metrics, relayBytes, confirmedControl: true, closedSockets: after.closed,
      ...(mode === 'relay' ? { fallbackTcpAcks: after.tcpAcks - before, blackFrames: after.blackFrames,
        sampledCanvasFrames: after.watchedFrames } : {}) };
  }
  if (pageErrors.length) throw new Error('fixture page errors: ' + pageErrors.join(', '));
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); child?.kill(); await stop?.(); tunnel?.stop(); await relay?.close(); await hub?.close(); web?.closeAllConnections(); web?.close();
}
