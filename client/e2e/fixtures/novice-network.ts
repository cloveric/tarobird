import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { HubServer } from "../../../src/hub/server.js";
import { deviceProof, hashSecret } from "../../../src/hub/auth.js";
import { deviceActionProofText } from "../../../src/client-protocol/device-actions.js";
import { networkCanonical, networkCommandSchema, type NetworkCommandInput } from "../../../src/client-protocol/private-network.js";
import { createServer } from "./vite.js";

export async function noviceNetworkFixture(managedBots?: Parameters<typeof HubServer.start>[0]["managedBots"]) {
  const root = await mkdtemp(path.join(tmpdir(), "tarobot-novice-"));
  const address = Object.values(networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)!.address;
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "tls.key", "-out", "tls.crt", "-days", "1", "-subj", "/CN=Disposable onboarding audit", "-addext", `subjectAltName=IP:${address}`, "-addext", "basicConstraints=critical,CA:TRUE"], { cwd: root, stdio: "ignore" });
  const tls = { key: await readFile(path.join(root, "tls.key")), cert: await readFile(path.join(root, "tls.crt")) };
  const certificateAuthority = new X509Certificate(tls.cert).raw.toString("base64");
  const hubs: HubServer[] = [], keys = new Map<string, { publicKey: string; privateKey: KeyObject }>();
  let started = false;
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/novice-desktop.ts"></script></body></html>';
  const vite = await createServer({ server: { host: "127.0.0.1", port: 0, hmr: false }, plugins: [{ name: "novice-network-fixture", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      const url = new URL(request.url!, "http://fixture");
      try {
        if (url.pathname === "/__novice") { response.setHeader("Content-Type", "text/html"); response.end(await server.transformIndexHtml(url.pathname, html)); return; }
        if (url.pathname === "/__novice/config") { response.end(JSON.stringify({ origins: [...hubs.map(hub => hub.url), origin.slice(0, -1)] })); return; }
        const match = url.pathname.match(/^\/__novice\/proxy\/([012])(\/.*)$/);
        if (match) {
          const upstream = httpsRequest(hubs[Math.min(1, Number(match[1]))]!.url + match[2] + url.search, { ca: tls.cert, method: request.method, headers: { ...request.headers, host: new URL(hubs[Math.min(1, Number(match[1]))]!.url).host } }, result => { response.writeHead(result.statusCode!, result.headers); result.pipe(response); });
          upstream.on("error", error => { response.statusCode = 502; response.end(JSON.stringify({ error: error.message })); }); request.pipe(upstream); return;
        }
        if (url.pathname !== "/__novice/native" || request.method !== "POST") return next();
        let body = ""; for await (const chunk of request) body += chunk;
        const { command, args } = JSON.parse(body), local = hubs[1]!;
        let result: unknown;
        if (command === "desktop_host") {
          if (args.action === "start") { started = true; await local.profile.update({ name: args.device.hostName, revision: (await local.profile.read()).revision }); }
          if (args.action === "pair") { const { keyRef: _keyRef, ...device } = args.device; const pair = await local.auth.pair(device, "127.0.0.1").catch(error => { if (String(error).includes("device_already_registered")) return undefined; throw error; }); if (pair) await local.auth.approveLocalDesktop(pair.code); }
          result = { available: true, running: started, ...(started ? { url: origin.slice(0, -1), publicKey: local.auth.publicKey } : {}), hostName: (await local.profile.read()).name,
            ...(["network", "tailscale"].includes(args.action) ? { routes: [{ name: "Direct", url: local.url, certificateAuthority }] } : {}) };
        } else if (command === "device_create") {
          const key = generateKeyPairSync("ed25519"), deviceId = `device_${randomBytes(16).toString("hex")}`, publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
          keys.set(deviceId, { publicKey, privateKey: key.privateKey }); result = { deviceId, keyRef: deviceId, publicKey };
        } else if (command === "device_forget") { keys.delete(args.keyRef); result = null; }
        else if (command === "device_sign" || command === "device_sign_action") {
          const key = keys.get(args.keyRef); if (!key) throw new Error("device_key_unavailable");
          const text = command === "device_sign" ? deviceProof(args.deviceId, args.nonce, args.clientNonce) : Buffer.from(deviceActionProofText(args.statement));
          result = sign(null, text, key.privateKey).toString("base64");
        } else throw new Error("fixture_unknown_native_command");
        response.end(JSON.stringify(result));
      } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    });
  } }] });
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0]!, phoneOrigin = origin.replace("127.0.0.1", "localhost");
  const ws = new WebSocketServer({ noServer: true });
  vite.httpServer!.on("upgrade", (request, socket, head) => {
    const match = request.url?.match(/^\/__novice\/proxy\/([012])\/ws$/); if (!match) return;
    ws.handleUpgrade(request, socket, head, downstream => {
      const upstream = new WebSocket(hubs[Math.min(1, Number(match[1]))]!.url.replace(/^http/, "ws") + "/ws", { ca: tls.cert, origin: new URL(origin).origin });
      const queued: Buffer[] = []; downstream.on("message", bytes => { if (upstream.readyState === WebSocket.OPEN) upstream.send(bytes.toString()); else queued.push(Buffer.from(bytes as Buffer)); });
      upstream.on("open", () => queued.splice(0).forEach(bytes => upstream.send(bytes.toString())));
      upstream.on("message", bytes => downstream.send(bytes.toString()));
      upstream.on("error", () => downstream.close());
      upstream.on("close", () => downstream.close()); downstream.on("close", () => upstream.close());
    });
  });
  const actors: Array<{ token: string; privateKey: KeyObject }> = [];
  const mutate = async (index: number, raw: NetworkCommandInput) => {
    const hub = hubs[index]!, actor = actors[index]!, command = networkCommandSchema.parse(raw), session = await hub.auth.authorize(actor.token);
    const statement = await hub.auth.prepareDeviceAction({ operation: "network", target: hashSecret(networkCanonical(command)) }, actor.token, session);
    return hub.network.command(command, session, { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), actor.privateKey).toString("base64") });
  };
  try {
    for (const name of ["家里的 Mac mini", "新的 MacBook Pro"]) {
      const hub = await HubServer.start({ stateDir: path.join(root, String(hubs.length)), host: address, exposure: "public", tls, origins: [new URL(origin).origin, new URL(phoneOrigin).origin], managedBots }); hubs.push(hub);
      await hub.profile.update({ name, revision: (await hub.profile.read()).revision });
      const key = generateKeyPairSync("ed25519"), publicKey = key.publicKey.export({ format: "der", type: "spki" }).toString("base64"), deviceId = "fixture_owner";
      const pair = await hub.auth.pair({ deviceId, publicKey, name: "隔离验收控制器", platform: "web" }, "127.0.0.1"); await hub.auth.approveLocalDesktop(pair.code);
      const clientNonce = randomBytes(32).toString("base64url"), socket = randomBytes(16).toString("hex"), challenge = await hub.auth.challenge(socket, deviceId, clientNonce, "127.0.0.1");
      const { token } = await hub.auth.authenticate(socket, sign(null, deviceProof(deviceId, challenge.nonce, clientNonce), key.privateKey).toString("base64")); actors.push({ token, privateKey: key.privateKey });
    }
    await mutate(0, { operation: "routes", networkId: "", routes: [{ name: "Direct", url: hubs[0]!.url, certificateAuthority }] });
    await mutate(0, { operation: "create", name: "家里的网络" });
    return { origin, phoneOrigin, hubs, mutate, close: async () => { for (const client of ws.clients) client.terminate(); ws.close(); await Promise.allSettled(hubs.map(hub => hub.close())); await vite.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await Promise.allSettled(hubs.map(hub => hub.close())); await vite.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
