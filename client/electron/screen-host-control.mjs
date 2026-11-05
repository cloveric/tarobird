import { lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const MAX_REPLY = 4096;
const APP_ID = 'com.tarobot.client', LEGACY_APP_ID = 'com.tarocub.client';
/** Bounded failure codes only: OS messages can contain filesystem paths. */
const CODE = /^[a-z_]{1,64}$/;
const coded = (error, fallback) => new Error(CODE.test(error?.message ?? '') ? error.message : fallback);

async function directoryPresent(directory) {
  let info;
  try { info = await lstat(directory); } catch (error) { if (error?.code === 'ENOENT') return false; throw new Error('screen_host_directory_unavailable'); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('screen_host_directory_redirected');
  return true;
}
/** The canonical Host directory for an App state directory, exactly as the
 * native core resolves it (`native_identity::for_app_data`/`host_directory`):
 * `<appData>/com.tarobot.client/host`, an existing legacy
 * `<appData>/com.tarocub.client/host`, or — for isolated development/audit
 * roots — `<root>/host`. Both present is ambiguous and fails closed. Resolved
 * on every attempt, so a Host created after the App started is found. */
export async function screenHostDirectory(appStateDir) {
  if (path.basename(appStateDir) !== APP_ID) return path.join(appStateDir, 'host');
  const base = path.dirname(appStateDir);
  const current = path.join(base, APP_ID, 'host'), legacy = path.join(base, LEGACY_APP_ID, 'host');
  const present = async (id, host) => await directoryPresent(path.join(base, id)) && directoryPresent(host);
  const [hasCurrent, hasLegacy] = [await present(APP_ID, current), await present(LEGACY_APP_ID, legacy)];
  if (hasCurrent && hasLegacy) throw new Error('screen_host_directory_conflict');
  return hasLegacy ? legacy : current;
}

/** Same owner-only key file rules as the Host CLI (`src/hub/service.ts`). */
async function controlToken(directory) {
  const file = path.join(directory, 'hub-control.key');
  let info, token;
  try { info = await lstat(file); } catch (error) { throw new Error(error?.code === 'ENOENT' ? 'screen_host_unavailable' : 'unsafe_hub_control_key'); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('unsafe_hub_control_key');
  try { token = (await readFile(file, 'utf8')).trim(); } catch { throw new Error('unsafe_hub_control_key'); }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('unsafe_hub_control_key');
  return token;
}
function request(directory, body, { connect = net.createConnection, timeoutMs = 10000 } = {}) {
  const socketPath = path.join(directory, 'hub-control.sock');
  if (Buffer.byteLength(socketPath) > 100) return Promise.reject(new Error('screen_host_unavailable'));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let data = ''; let settled = false;
    const done = (error, value) => { if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(value); };
    socket.setTimeout(timeoutMs, () => done(new Error('screen_host_timeout')));
    socket.on('connect', () => socket.write(JSON.stringify(body) + '\n'));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > MAX_REPLY) { done(new Error('screen_host_reply_invalid')); return; }
      if (!data.includes('\n')) return;
      try { done(undefined, JSON.parse(data.trim())); } catch { done(new Error('screen_host_reply_invalid')); }
    });
    socket.on('error', () => done(new Error('screen_host_unavailable')));
    socket.on('end', () => { if (!settled && data.trim()) { try { done(undefined, JSON.parse(data.trim())); } catch { done(new Error('screen_host_reply_invalid')); } } });
    socket.on('close', () => done(new Error('screen_host_unavailable')));
  });
}

/** One-use target registration ticket from the Host's private control socket
 * in `hostDir`. Binds to the Host key observed on that same socket. Failures
 * are bounded `[a-z_]` codes. */
export async function screenServiceTicket(hostDir, desktopId, options = {}) {
  const status = await request(hostDir, { command: 'status' }, options);
  if (status?.running !== true || typeof status.publicKey !== 'string') throw new Error('screen_host_unavailable');
  const token = await controlToken(hostDir);
  const reply = await request(hostDir, { command: 'screen-service-ticket', token, desktopId, expectedPublicKey: status.publicKey }, options);
  const ticket = reply?.screenServiceTicket;
  if (reply?.running !== true || reply.controlError || reply.publicKey !== status.publicKey || typeof ticket?.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket)) {
    throw new Error(typeof reply?.controlError === 'string' && CODE.test(reply.controlError) ? reply.controlError : 'screen_host_unavailable');
  }
  const port = Number.isSafeInteger(reply.instancePort) ? reply.instancePort : Number(new URL(reply.instanceUrl ?? 'http://127.0.0.1:0').port);
  if (!(port > 0 && port < 65536)) throw new Error('screen_host_unavailable');
  // From the same reply that issued the ticket, i.e. the Hub process the
  // ticket is valid for. Bounded; only well-formed names are kept.
  const capabilities = Array.isArray(reply.controlCapabilities)
    ? reply.controlCapabilities.slice(0, 32).filter(name => typeof name === 'string' && /^[a-z0-9.-]{1,64}$/.test(name)) : [];
  return { ticket: ticket.ticket, expiresAt: ticket.expiresAt, instancePort: port, publicKey: status.publicKey, capabilities };
}
/** The App's ticket: `appStateDir` is the App state directory
 * (`paths.hostStateDir`, the native core's `--host-state-dir`), never the Host
 * directory itself; the canonical Host directory is resolved on every call. */
export async function desktopScreenTicket(appStateDir, desktopId, options = {}) {
  const hostDir = await screenHostDirectory(appStateDir).catch(error => { throw coded(error, 'screen_host_directory_unavailable'); });
  return screenServiceTicket(hostDir, desktopId, options);
}
