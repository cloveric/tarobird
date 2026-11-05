/** Browser-safe address guard shared by signed routes and host transports. */
export function isLoopbackOrUnspecified(address: string): boolean {
  let host = address.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.includes(":")) {
    try { host = new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, ""); } catch { /* Invalid literals are rejected by the route/transport parser. */ }
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
      host = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    }
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "0.0.0.0" || host === "::1" || host === "::";
}
