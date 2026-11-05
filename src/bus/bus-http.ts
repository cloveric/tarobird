import { request } from "node:http";

// A complete engine turn can return a large document, but never buffer an
// unbounded response from another local process.
export const MAX_BUS_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Single POST, no redirects or retries. The caller owns the absolute deadline. */
export function postBusTurn(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
    // Global fetch imposes its own 300s response-header deadline, shorter than
    // a delegated turn. A private one-shot HTTP request has only our deadline
    // and cannot change timeouts/pooling for unrelated HTTP clients.
    const req = request(url, { method: "POST", headers: { ...headers, Connection: "close" }, signal, agent: false }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const tooLarge = () => {
        fail(Object.assign(new Error("Bus response exceeds the response limit"), { code: "BUS_RESPONSE_TOO_LARGE" }));
        res.destroy(); req.destroy();
      };
      res.on("error", fail);
      res.on("aborted", () => fail(Object.assign(new Error("Bus response was interrupted"), { code: "ECONNRESET" })));
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BUS_RESPONSE_BYTES) { tooLarge(); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks, bytes).toString("utf8") });
      });
      if (Number(res.headers["content-length"]) > MAX_BUS_RESPONSE_BYTES) tooLarge();
    });
    req.on("error", fail);
    req.end(body);
  });
}
