import https from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { verifyTlsIdentity } from '../../src/client-protocol/tls-identity.ts';
import { readScreenFrame, SCREEN_PACKET_LIMIT } from '../../src/client-protocol/screen-wire.ts';
import { watchScreenSocket } from '../../src/core/screen-heartbeat.ts';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const screenNetworkSchema = z.object({ url: z.string().max(2048), publicKey: z.string().regex(/^[A-Za-z0-9+/]{59}=$/), certificateAuthority: z.string().max(4096).optional() }).strict();
export function screenRoute(raw) {
  const v = screenNetworkSchema.parse(raw), url = new URL(v.url), host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
    || url.protocol === 'http:' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('screen_route_invalid');
  if (v.certificateAuthority && (url.protocol !== 'https:' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.certificateAuthority))) throw new Error('invalid_host_authority');
  const ca = v.certificateAuthority ? `-----BEGIN CERTIFICATE-----\n${v.certificateAuthority.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----` : undefined;
  return { ...v, url, hostname: host, tls: { ...(ca ? { ca } : {}), servername: isIP(host) ? '' : host, rejectUnauthorized: true } };
}
/** No credentials in the proof request. CA + hostname are verified first;
 * the signed proof is bound to our actual leaf DER and fresh nonce. */
export async function screenPin(route, signal) {
  if (route.url.protocol === 'http:') return undefined;
  const nonce = randomBytes(32).toString('base64url');
  return new Promise((resolve, reject) => {
    const req = https.get(new URL(`/api/tls-identity?nonce=${nonce}`, route.url), { ...route.tls, agent: false, signal, timeout: 5000 }, res => {
      const certificate = res.socket.getPeerCertificate?.().raw;
      if (res.statusCode !== 200 || !certificate?.length) { req.destroy(new Error('tls_identity_unavailable')); return; }
      const chunks = []; let size = 0;
      res.on('error', reject);
      res.on('data', chunk => { size += chunk.length; if (size > 4096) req.destroy(new Error('tls_identity_too_large')); else chunks.push(chunk); });
      res.on('end', () => {
        try {
          const pin = hash(certificate);
          verifyTlsIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8')), { publicKey: route.publicKey, nonce, certificateSha256: pin },
            (key, signature, message) => verify(null, message, createPublicKey({ key: Buffer.from(key, 'base64'), type: 'spki', format: 'der' }), Buffer.from(signature, 'base64')));
          resolve(pin);
        } catch (error) { reject(error); }
      });
    });
    req.once('timeout', () => req.destroy(new Error('tls_identity_timeout'))); req.once('error', reject);
  });
}
export function openScreenSocket(route, pin, role, ticket, { signal, receive, close } = {}) {
  if (!['control', 'media'].includes(role) || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('screen_channel_invalid');
  if (route.url.protocol === 'https:' && !/^[0-9a-f]{64}$/.test(pin ?? '')) throw new Error('tls_identity_required');
  const url = new URL(`/screen/v1/${role}`, route.url); url.protocol = route.url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { ...route.tls, agent: false, followRedirects: false, handshakeTimeout: 5000,
    maxPayload: SCREEN_PACKET_LIMIT, perMessageDeflate: false,
    // A new, non-pooled TLS connection every time. Credentials are sent only
    // after the CA/hostname + exact leaf pin verified inside this handshake.
    checkServerIdentity(host, cert) { return checkServerIdentity(host, cert) || (!cert.raw || hash(cert.raw) !== pin ? new Error('tls_identity_mismatch') : undefined); },
  });
  const abort = () => ws.terminate(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  let failureReason, attachTimer;
  ws.on('open', () => {
    watchScreenSocket(ws, () => { failureReason = 'screen_network_timeout'; ws.terminate(); });
    // A successful WebSocket upgrade/pong is not an authenticated screen join.
    attachTimer = setTimeout(() => { failureReason = 'screen_connect_timeout'; ws.terminate(); }, 5000);
    attachTimer.unref();
    ws.send(JSON.stringify({ type: 'hello', ticket }));
  });
  ws.on('message', (raw, binary) => {
    try {
      if (binary) { if (role !== 'media') throw new Error('screen_binary_direction'); const bytes = new Uint8Array(raw); readScreenFrame(bytes); receive?.(bytes); }
      else {
        if (raw.length > 16384) throw new Error('screen_control_size');
        const value = JSON.parse(raw.toString('utf8')); receive?.(value);
        if (value?.type === 'attached') clearTimeout(attachTimer);
      }
    } catch { ws.close(4000, 'screen_protocol_invalid'); }
  });
  ws.on('error', () => ws.terminate());
  ws.once('close', (code, reason) => { clearTimeout(attachTimer); signal?.removeEventListener('abort', abort); close?.(failureReason || reason.toString() || 'screen_network_closed', code); });
  return ws;
}
