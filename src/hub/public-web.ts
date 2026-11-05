import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readable } from "node:stream";
import { normalizedLink } from "../client-protocol/links.js";

const blocked = new BlockList(), globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(ip, prefix, "ipv4");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, prefix, "ipv6");
export function isPublicPreviewAddress(ip: string): boolean {
  const family = isIP(ip); return family === 4 ? !blocked.check(ip, "ipv4") : family === 6 && globalV6.check(ip, "ipv6") && !blocked.check(ip, "ipv6");
}
function checkedUrl(raw: string): URL {
  const normalized = normalizedLink(raw); if (!normalized) throw new Error("preview_url_blocked");
  const url = new URL(normalized), host = url.hostname.replace(/^\[|\]$/g, ""); url.hash = "";
  if (url.port || !host.includes(".") && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|home|lan|onion)\.?$/i.test(host)) throw new Error("preview_address_blocked");
  if (isIP(host) && !isPublicPreviewAddress(host)) throw new Error("preview_address_blocked"); return url;
}
export type PreviewTransport = (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<{ status: number; headers: Headers; body: AsyncIterable<Uint8Array> }>;
const requestOnce: PreviewTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    signal, agent: false, maxHeaderSize: 32 * 1024,
    headers: { "User-Agent": "TaroCub-LinkPreview/1.0", Accept: "text/html,application/xhtml+xml,image/png,image/jpeg,image/webp,image/gif", "Accept-Encoding": "identity" },
    // Use the checked DNS answer for the connection, preserving hostname for TLS
    // and Host. No environment proxy, cookies, authorization or referer is sent.
    lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
  }, (response) => {
    const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    resolve({ status: response.statusCode ?? 500, headers, body: response });
  });
  request.on("error", reject); request.end();
});
export interface PublicResource { url: string; mime: string; charset?: string; body: Buffer }
export async function readPublicResource(raw: string, accept: string, maxBytes: number, signal: AbortSignal, dependencies: { lookup?: (host: string) => Promise<LookupAddress[]>; request?: PreviewTransport } = {}): Promise<PublicResource> {
  const resolve = dependencies.lookup ?? ((host: string) => dnsLookup(host, { all: true })); let url = checkedUrl(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted(); const host = url.hostname.replace(/^\[|\]$/g, "");
    const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await new Promise<LookupAddress[]>((done, fail) => {
      const aborted = () => fail(signal.reason); signal.addEventListener("abort", aborted, { once: true });
      void resolve(host).then(done, fail).finally(() => signal.removeEventListener("abort", aborted));
    });
    if (!answers.length || answers.some((answer) => !isPublicPreviewAddress(answer.address))) throw new Error("preview_address_blocked");
    signal.throwIfAborted(); const reply = await (dependencies.request ?? requestOnce)(url, answers.find((a) => a.family === 4) ?? answers[0]!, signal);
    const input = Readable.from((async function* () {
      let bytes = 0;
      for await (const chunk of reply.body) { bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error("preview_too_large"); yield chunk; }
    })()); let stream: Readable = input;
    try {
      if ([301, 302, 303, 307, 308].includes(reply.status)) {
        if (redirects === 3) throw new Error("preview_redirect_limit");
        const location = reply.headers.get("location"); if (!location) throw new Error("preview_redirect_invalid"); url = checkedUrl(new URL(location, url).href); continue;
      }
      if (reply.status < 200 || reply.status >= 300) throw new Error("preview_http_error");
      const mime = (reply.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!accept.split(",").includes(mime)) throw new Error("preview_content_type");
      if (Number(reply.headers.get("content-length")) > maxBytes) throw new Error("preview_too_large");
      const encoding = reply.headers.get("content-encoding")?.toLowerCase();
      if (encoding && encoding !== "identity") {
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
        if (!decoder) throw new Error("preview_encoding"); input.on("error", (error) => decoder.destroy(error)); stream = input.pipe(decoder);
      }
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of stream) { signal.throwIfAborted(); const data = Buffer.from(chunk); bytes += data.length; if (bytes > maxBytes) throw new Error("preview_too_large"); chunks.push(data); }
      const charset = reply.headers.get("content-type")?.match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
      return { url: url.href, mime, ...(charset ? { charset } : {}), body: Buffer.concat(chunks) };
    } finally { stream.destroy(); input.destroy(); if (reply.body instanceof Readable) reply.body.destroy(); }
  }
  throw new Error("preview_redirect_limit");
}
