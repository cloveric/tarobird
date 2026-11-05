import { X509Certificate, verify } from "node:crypto";
import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { MAX_NETWORK_BYTES, networkCanonical, networkHostSchema, networkManifestProof, signedNetworkManifestSchema, signedNetworkPeerRequestSchema, type NetworkHost, type SignedNetworkManifest, type SignedNetworkPeerRequest } from "../client-protocol/private-network.js";
import { orderedRoutes, type Route } from "../client-protocol/routes.js";
import { parsePublicKey } from "./auth.js";
import { HubError } from "./store.js";
import { isLoopbackOrUnspecified as loopback } from "../client-protocol/loopback-address.js";
import { forgetPeerPin, observePeerCertificate, peerPin, peerTlsOptions, TlsPinMismatch, type PeerTls } from "./peer-tls.js";

export { MAX_NETWORK_BYTES } from "../client-protocol/private-network.js";
const REQUEST_TIMEOUT_MS = 8_000;
const ROUTE_TIMEOUT_MS = 3_000;

export { loopback };

export function certificateAuthority(route: Route): string | undefined {
  if (!route.certificateAuthority) return undefined;
  try {
    const der = Buffer.from(route.certificateAuthority, "base64");
    if (der.toString("base64") !== route.certificateAuthority) throw new Error("invalid_base64");
    const certificate = new X509Certificate(der);
    if (!certificate.raw.equals(der)) throw new Error("invalid_der");
    return certificate.toString();
  } catch { throw new HubError("network_peer_certificate_invalid", 400); }
}

/** No redirects, system CA/explicit DER CA validation and normal hostname
 * verification. The signed manifest is separately pinned to the authority key;
 * the request itself goes only to the TLS leaf the peer proved (peer-tls.ts),
 * so a TLS-terminating relay cannot read the membership it carries. */
function send(route: Route, path: string, body: Buffer | undefined, signal: AbortSignal, timeoutMs: number, tls: PeerTls): Promise<unknown> {
  const url = new URL(route.url);
  if (url.protocol !== "https:" || loopback(url.hostname)) throw new HubError("network_route_must_be_remote", 400);
  const ca = certificateAuthority(route);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const req = request(new URL(path, url), {
      method: body ? "POST" : "GET", agent: false, rejectUnauthorized: true, signal,
      ...(ca ? { ca } : {}), ...peerTlsOptions(tls),
      // DNS aliases must not turn a shared route into a loopback service. Node
      // still verifies the certificate against the requested hostname.
      lookup: (hostname, options, callback) => lookup(hostname, options, (error, address, family) => {
        if (error) { callback(error, address, family); return; }
        const addresses = Array.isArray(address) ? address.map(item => item.address) : [address];
        if (addresses.some(item => !isIP(item) || loopback(item))) { callback(new Error("network_route_must_be_remote"), address, family); return; }
        callback(null, address, family);
      }),
      headers: { ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}), Accept: "application/json" },
    }, res => {
      if (res.statusCode !== 200) { res.destroy(); finish(new HubError("network_peer_rejected", 502)); return; }
      const unobserved = observePeerCertificate(res, tls);
      if (unobserved) { res.destroy(); finish(unobserved); return; }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_NETWORK_BYTES) { res.destroy(); finish(new HubError("network_peer_response_too_large", 502)); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_NETWORK_BYTES) { res.destroy(); finish(new HubError("network_peer_response_too_large", 502)); return; }
        chunks.push(chunk);
      });
      res.on("error", () => finish(new HubError("network_peer_unavailable", 503)));
      res.on("aborted", () => finish(new HubError("network_peer_unavailable", 503)));
      res.on("end", () => {
        try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { finish(new HubError("network_peer_response_invalid", 502)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new HubError("network_peer_timeout", 504)), timeoutMs); timer.unref();
    req.on("error", error => finish(error instanceof HubError ? error : new HubError(signal.aborted ? "network_peer_cancelled" : "network_peer_unavailable", 503)));
    req.end(body);
  });
}

export async function exchangeNetworkPeer(rawHost: NetworkHost, rawRequest: SignedNetworkPeerRequest, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SignedNetworkManifest> {
  const host = networkHostSchema.parse(rawHost), signed = signedNetworkPeerRequestSchema.parse(rawRequest);
  if (networkCanonical(host) !== networkCanonical(rawHost) || networkCanonical(signed) !== networkCanonical(rawRequest)) throw new HubError("network_peer_request_invalid", 400);
  if (host.revoked || host.state !== "active" || !host.routes.length) throw new HubError("network_peer_unavailable", 503);
  if (signed.request.known && (signed.request.known.manifest.authorityKey !== host.publicKey || signed.request.known.manifest.id !== signed.request.networkId)) throw new HubError("network_peer_identity_mismatch", 403);
  const body = Buffer.from(JSON.stringify(signed));
  if (body.length > MAX_NETWORK_BYTES) throw new HubError("network_peer_request_too_large", 413);
  const signal = options.signal ?? new AbortController().signal;
  const deadline = Date.now() + Math.min(REQUEST_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS));
  let lastError: unknown = new HubError("network_peer_unavailable", 503);
  for (const route of orderedRoutes(host.routes)) {
    if (signal.aborted) throw new HubError("network_peer_cancelled", 503);
    const remaining = Math.min(deadline - Date.now(), signed.request.expiresAt - Date.now());
    if (remaining <= 0) throw new HubError("network_peer_timeout", 504);
    try {
      // Read-only: a rotated certificate may be re-proved once on this route.
      let raw: unknown;
      for (let attempt = 0; ; attempt++) {
        const left = () => Math.min(deadline - Date.now(), signed.request.expiresAt - Date.now(), ROUTE_TIMEOUT_MS);
        if (left() <= 0) throw new HubError("network_peer_timeout", 504);
        const { pin, cached } = await peerPin(host.publicKey, route, (path, tls) => send(route, path, undefined, signal, left(), tls));
        if (left() <= 0) throw new HubError("network_peer_timeout", 504);
        try { raw = await send(route, "/api/network/peer", body, signal, left(), { pin }); break; }
        catch (error) {
          if (error instanceof TlsPinMismatch) { forgetPeerPin(host.publicKey, route); if (cached && attempt === 0) continue; }
          throw error;
        }
      }
      const result = signedNetworkManifestSchema.parse(raw);
      if (networkCanonical(result) !== networkCanonical(raw)) throw new HubError("network_peer_response_invalid", 502);
      if (signal.aborted) throw new HubError("network_peer_cancelled", 503);
      if (signed.request.expiresAt <= Date.now()) throw new HubError("network_peer_timeout", 504);
      if (result.manifest.authorityKey !== host.publicKey || result.manifest.id !== signed.request.networkId
        || result.manifest.revision < (signed.request.known?.manifest.revision ?? 0)
        || !verify(null, Buffer.from(networkManifestProof(result.manifest)), parsePublicKey(host.publicKey), Buffer.from(result.signature, "base64"))) throw new HubError("network_peer_identity_mismatch", 403);
      return result;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof HubError ? lastError : new HubError("network_peer_response_invalid", 502);
}
