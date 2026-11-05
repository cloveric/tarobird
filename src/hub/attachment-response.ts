/** One byte range only. Unsatisfiable/malformed ranges never fall through to a
 * full private download. If-Range mismatch intentionally returns the full entity. */
export function attachmentResponse(size: number, sha256: string, range?: string, ifRange?: string | readonly string[]): {
  status: 200 | 206 | 416; headers: Record<string, string | number>; start?: number; end?: number;
} {
  const etag = `"${sha256}"`;
  const headers: Record<string, string | number> = { ETag: etag, "Accept-Ranges": "bytes" };
  if (!range || ifRange && ifRange !== etag) return { status: 200, headers: { ...headers, "Content-Length": size } };
  const reject = () => ({ status: 416 as const, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || !match[1] && !match[2]) return reject();
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return reject();
  const start = match[1] ? first : Math.max(0, size - last);
  const end = match[1] && match[2] ? Math.min(last, size - 1) : size - 1;
  if (size <= 0 || start >= size || end < start) return reject();
  return { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 }, start, end };
}
