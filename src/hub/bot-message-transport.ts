import { verify } from "node:crypto";
import { lookup } from "node:dns";
import { request } from "node:https";
import { botReplyProof, type SignedBotPassport } from "../client-protocol/bot-messages.js";
import { orderedRoutes, type Route } from "../client-protocol/routes.js";
import type { NetworkHost } from "../client-protocol/private-network.js";
import { parsePublicKey } from "./auth.js";
import { forgetPeerPin, observePeerCertificate, peerPin, peerTlsOptions, TlsPinMismatch, type PeerTls } from "./peer-tls.js";
import { certificateAuthority, loopback } from "./network-peer.js";
import { HubError } from "./store.js";

export const BOT_TRANSFER_BYTES = 12 * 1024 * 1024;
// Each operation performs a challenge followed by one signed request. Pace new
// operations before transmission so a supported file batch cannot exhaust the
// peer endpoint's shared 8-request/second ingress budget. This is not a retry:
// every request is still sent at most once, including after a lost response.
const peerSlots = new Map<string, number>();
async function pacePeer(key: string): Promise<void> {
  const now = performance.now();
  for (const [peer, next] of peerSlots) if (next <= now) peerSlots.delete(peer);
  const next = Math.max(now, peerSlots.get(key) ?? now);
  // Keep local queueing bounded and well within the signed passport lifetime.
  if (next - now > 10_000 || !peerSlots.has(key) && peerSlots.size >= 1024) throw new HubError("bot_message_transfer_busy", 429);
  peerSlots.set(key, next + 300);
  if (next > now) await new Promise(resolve => setTimeout(resolve, next - now));
}
function exchange(route: Route, path: string, method: string, body?: Buffer, passport?: SignedBotPassport, tls: PeerTls = {}): Promise<any> {
  const base = new URL(route.url);
  if (base.protocol !== "https:" || loopback(base.hostname)) throw new HubError("network_route_must_be_remote", 400);
  const ca = certificateAuthority(route);
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, base), { method, agent: false, rejectUnauthorized: true, ...(ca ? { ca } : {}), ...peerTlsOptions(tls),
      lookup: (name, options, callback) => lookup(name, options, (err, address, family) => {
        if (!err && (Array.isArray(address) ? address : [{ address }]).some(a => loopback(a.address))) err = new Error("network_route_must_be_remote") as NodeJS.ErrnoException;
        callback(err, address, family);
      }), headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/octet-stream", "Content-Length": body.length } : {}),
        ...(passport ? { "X-TaroBot-Message-Passport": Buffer.from(JSON.stringify(passport)).toString("base64url") } : {}) },
    }, res => {
      // Reject first: destroying with an error before `res` has an error
      // listener would emit an unhandled 'error'.
      const unobserved = observePeerCertificate(res, tls);
      if (unobserved) { reject(unobserved); res.destroy(); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > BOT_TRANSFER_BYTES) res.destroy(new Error("bot_message_reply_too_large")); else chunks.push(c); });
      res.on("error", reject); res.on("aborted", () => reject(new Error("bot_message_reply_interrupted")));
      res.on("end", () => { try {
        const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (res.statusCode !== 200) throw new HubError(data.error ?? "bot_message_peer_rejected", res.statusCode ?? 502);
        resolve(data);
      } catch (e) { reject(e); } });
    });
    const timeout = () => req.destroy(new HubError("bot_message_transport_timeout", 504));
    // Probes stay short. Signed transfers get a size-based, bounded deadline;
    // a slow but progressing chunk must not inherit the five-second probe cap.
    const totalMs = passport ? Math.min(60_000, Math.max(15_000, 10_000 + Math.ceil((body?.length ?? 0) / (128 * 1024)) * 1000)) : 5000;
    const timer = setTimeout(timeout, totalMs); timer.unref();
    const connectTimer = setTimeout(timeout, 5000); connectTimer.unref();
    req.once("socket", socket => socket.once("secureConnect", () => clearTimeout(connectTimer)));
    req.setTimeout(15_000, timeout);
    req.once("close", () => { clearTimeout(timer); clearTimeout(connectTimer); }); req.on("error", reject); req.end(body);
  });
}

/** Probe routes without private data. Once a route proves the expected Hub key
 * on a pinned certificate, transmit exactly once. A lost response never causes
 * a fallback POST. */
export async function exchangeBotMessage(host: NetworkHost, signed: SignedBotPassport, body: Buffer): Promise<unknown> {
  await pacePeer(host.publicKey);
  for (let attempt = 0; ; attempt++) {
    let chosen: Route | undefined, pin = "", cached = false;
    for (const route of orderedRoutes(host.routes)) {
      try { ({ pin, cached } = await peerPin(host.publicKey, route, (path, tls) => exchange(route, path, "GET", undefined, undefined, tls))); chosen = route; break; }
      catch { /* Probes contain no messages, credentials or files. */ }
    }
    if (!chosen) throw new HubError("bot_message_peer_unavailable_or_upgrade_required", 503);
    if (signed.passport.expiresAt <= Date.now()) throw new HubError("bot_message_passport_expired", 401);
    let reply: any;
    try { reply = await exchange(chosen, signed.passport.path, signed.passport.method, body, signed, { pin }); }
    catch (error) {
      // The handshake failed before anything was written. A rotated certificate
      // is re-proved once; a fresh pin that already mismatches is not retried.
      if (error instanceof TlsPinMismatch) { forgetPeerPin(host.publicKey, chosen); if (cached && attempt === 0) continue; }
      throw error;
    }
    if (!verify(null, Buffer.from(botReplyProof(signed.passport.nonce, reply.result)), parsePublicKey(host.publicKey), Buffer.from(reply.signature ?? "", "base64"))) throw new HubError("bot_message_reply_signature_invalid", 403);
    return reply.result;
  }
}
