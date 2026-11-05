// Isolated updater fixtures: a lab CA, a CONNECT proxy that terminates TLS for
// the real GitHub hostnames, ad-hoc signed app bundles and a fake Host
// `desktop-update` runtime. Nothing here reads or writes the user's App,
// Host, keychain or network beyond 127.0.0.1.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';

export const HOSTS = ['github.com', 'api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'updates.example.test'];

export function labRoot() {
  const base = process.env.TAROBOT_UPDATER_LAB_ROOT;
  if (!base || !base.includes('.noindex')) throw new Error('TAROBOT_UPDATER_LAB_ROOT must point inside a .noindex lab directory');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'updater-lab-'));
}

export function pki(dir) {
  mkdirSync(dir, { recursive: true });
  const run = args => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=TaroBot Updater Lab CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['x509', '-in', 'ca.pem', '-outform', 'DER', '-out', 'ca.der']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=updater-lab']);
  writeFileSync(path.join(dir, 'leaf.ext'), `subjectAltName=${HOSTS.map(host => `DNS:${host}`).join(',')}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext']);
  return { caDer: path.join(dir, 'ca.der'), key: readFileSync(path.join(dir, 'leaf.key')), cert: readFileSync(path.join(dir, 'leaf.pem')) };
}

/** `routes[host + pathname]` → handler(req, res, body). Records every request. */
export async function fakeInternet({ key, cert }) {
  const routes = new Map(), requests = [];
  const app = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, `https://${req.headers.host}`);
      const record = { host: req.headers.host, method: req.method, path: url.pathname, search: url.search, authorization: req.headers.authorization ?? null, accept: req.headers.accept ?? null, body: Buffer.concat(chunks).toString() };
      requests.push(record);
      const handler = routes.get(`${req.method} ${req.headers.host}${url.pathname}`);
      if (!handler) { res.writeHead(404); res.end(); return; }
      handler(req, res, record);
    });
  });
  const context = tls.createSecureContext({ key, cert });
  const connects = [];
  const proxy = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
  proxy.on('connect', (req, socket, head) => {
    const [host, port] = req.url.split(':');
    connects.push(req.url);
    if (!HOSTS.includes(host) || port !== '443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) socket.unshift(head);
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context, ALPNProtocols: ['http/1.1'] });
    secure.on('error', () => socket.destroy());
    app.emit('connection', secure);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return {
    proxy: `http://127.0.0.1:${proxy.address().port}`, routes, requests, connects,
    route(method, url, handler) { const parsed = new URL(url); routes.set(`${method} ${parsed.host}${parsed.pathname}`, handler); },
    json(method, url, value, status = 200) { this.route(method, url, (_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'function' ? JSON.stringify(value()) : JSON.stringify(value)); }); },
    close: () => new Promise(resolve => { proxy.closeAllConnections?.(); app.closeAllConnections?.(); proxy.close(() => resolve()); }),
  };
}

let executable;
function macho(root) {
  if (executable) return executable;
  const source = path.join(root, 'main.c');
  writeFileSync(source, 'int main(void) { return 0; }\n');
  executable = path.join(root, 'fixture-main');
  execFileSync('cc', ['-o', executable, source]);
  return executable;
}

/** Ad-hoc sealed bundle with a real Mach-O main executable, so
 * `codesign --verify --deep --strict` behaves as for a shipped App. */
export function makeApp(root, dir, { version, identifier = 'com.tarobot.client', marker = version }) {
  const app = path.join(dir, 'TaroBot.app');
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>TaroBot</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>TaroBot</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`);
  execFileSync('cp', [macho(root), path.join(app, 'Contents/MacOS/TaroBot')]);
  writeFileSync(path.join(app, 'Contents/Resources/marker.txt'), marker);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

export function archiveApp(app, out) {
  execFileSync('tar', ['--no-xattrs', '-czf', out, '-C', path.dirname(app), path.basename(app)], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return readFileSync(out);
}

export function plistValue(app, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')]).toString().trim();
}

/** Bundled Host runtime stand-in. Mode and log live in the resolved Host
 * directory, which also proves the updater derived the right directory. */
export function fakeHostRuntime(resources) {
  mkdirSync(path.join(resources, 'dist/src'), { recursive: true });
  symlinkSync(process.execPath, path.join(resources, 'node'));
  writeFileSync(path.join(resources, 'dist/src/index.js'), `
const fs = require('fs'), path = require('path');
const [command, directory] = process.argv.slice(2);
const log = line => fs.appendFileSync(path.join(directory, 'lab-events.log'), line + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
let mode = 'ok'; try { mode = JSON.parse(fs.readFileSync(path.join(directory, 'lab-mode.json'), 'utf8')).mode; } catch {}
log('start ' + command + ' ' + mode);
if (command !== 'desktop-update') { process.exitCode = 2; return; }
if (mode === 'refuse') { emit({ phase: 'error' }); process.exitCode = 1; return; }
let finished = false, data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; if (data.trim() === '{"command":"finish"}') finished = true; });
let timer;
process.stdin.on('end', () => {
  clearInterval(timer);
  if (!finished) { log('resumed'); emit({ phase: 'complete' }); return; }
  log('finish');
  if (mode === 'finish-fail') { emit({ phase: 'error' }); process.exitCode = 1; return; }
  emit({ phase: 'complete' });
});
const ready = () => { log('ready'); emit({ phase: 'ready' }); };
if (mode === 'wait') { timer = setInterval(() => { if (fs.existsSync(path.join(directory, 'lab-release'))) { clearInterval(timer); ready(); } }, 25); }
else ready();
`);
}

const started = [];
/** Lab teardown: EOF first (the updater's own shutdown), then SIGKILL for a
 * lab process that ignored it, so a failed assertion cannot hang the run. */
export async function stopUpdaters() {
  await Promise.all(started.map(async updater => {
    if (updater.child.exitCode !== null || updater.child.signalCode !== null) return;
    updater.child.stdin.end();
    const timer = setTimeout(() => updater.child.kill('SIGKILL'), 5000);
    await updater.exited; clearTimeout(timer);
  }));
}

/** JSONL client for one updater process. */
export function startUpdater(binary, args, env) {
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  const pending = new Map(), events = [], lines = [];
  let sequence = 0, buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      lines.push(line);
      const value = JSON.parse(line);
      if (value.event) { events.push(value); continue; }
      const waiter = pending.get(value.id); pending.delete(value.id);
      if ('error' in value) waiter.reject(Object.assign(new Error(value.error), { code: value.error })); else waiter.resolve(value.result);
    }
  });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const updater = {
    child, events, lines, exited, stderr: () => stderr,
    call(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
    },
    raw(line) { child.stdin.write(line + '\n'); },
    end() { child.stdin.end(); return exited; },
  };
  started.push(updater);
  return updater;
}
