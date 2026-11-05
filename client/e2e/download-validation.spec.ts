import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "../../src/client-protocol/index.js";
import { downloadAttachment, type DownloadConnection } from "../src/downloads.js";
import { HubHttpError } from "../src/http-error.js";
import type { DownloadCheckpoint, DownloadCheckpointStore } from "../src/download-checkpoints.js";

function fixture(read: (headers: Record<string, string>) => Response | Promise<Response>) {
  let released = 0;
  const connection: DownloadConnection = { state: { status: "online" }, isClosed: false, subscribe: () => () => undefined, resume: () => undefined,
    beginFileTransfer: () => () => { released++; }, readAttachment: async (_id, headers, consume) => consume(await read(headers)) };
  return { connection, released: () => released };
}
function response(data: Buffer, start: number, end: number, overrides: Record<string, string> = {}) {
  const headers = { ETag: `"${createHash("sha256").update(data).digest("hex")}"`, "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${end}/${data.length}`, ...overrides };
  return new Response(data.subarray(start, end + 1), { status: 206, headers });
}
for (const fault of ["network", "epoch-abort", "token-expired", "session-expired"] as const) test(`${fault}: a failed range retries only the unconfirmed chunk and releases the transfer after digest verification`, async () => {
  const data = Buffer.alloc(CHUNK_BYTES + 17, 7), requests: string[] = []; let failed = false;
  const { connection, released } = fixture((headers) => { requests.push(headers.Range!); const start = Number(headers.Range!.split("=")[1]!.split("-")[0]);
    if (start && !failed) {
      failed = true;
      if (fault === "epoch-abort") return new Response(new ReadableStream({ start(controller) { controller.error(new DOMException("Epoch ended", "AbortError")); } }), { status: 206, headers: { "Content-Range": `bytes ${start}-${data.length - 1}/${data.length}`, ETag: `"${createHash("sha256").update(data).digest("hex")}"` } });
      if (fault === "token-expired" || fault === "session-expired") throw new HubHttpError(401, fault === "token-expired" ? "token_expired_or_invalid" : "session_expired");
      throw new TypeError("network_lost");
    }
    return response(data, start, Math.min(data.length, start + CHUNK_BYTES) - 1);
  });
  let resumed = 0; connection.resume = () => { resumed++; };
  const blob = await downloadAttachment(connection, "fixture"); expect(Buffer.from(await blob.arrayBuffer())).toEqual(data);
  expect(requests).toEqual([`bytes=0-${CHUNK_BYTES - 1}`, `bytes=${CHUNK_BYTES}-${data.length - 1}`, `bytes=${CHUNK_BYTES}-${data.length - 1}`]); expect(released()).toBe(1);
  expect(resumed).toBe(fault.endsWith("expired") ? 1 : 0);
});
for (const scenario of ["wrong-range", "wrong-hash", "changed-etag", "changed-size", "whole-body-after-range", "revoked"] as const) test(`${scenario} never returns a corrupt or unauthorized attachment`, async () => {
  const data = Buffer.alloc(CHUNK_BYTES + 17, 7); let calls = 0;
  const { connection, released } = fixture(() => {
    const start = calls++ ? CHUNK_BYTES : 0, end = Math.min(data.length, start + CHUNK_BYTES) - 1;
    if (start && scenario === "revoked") throw new HubHttpError(401, "device_revoked");
    if (start && scenario === "whole-body-after-range") return new Response(data, { headers: { "Content-Length": String(data.length) } });
    return response(data, start, end, scenario === "wrong-range" ? { "Content-Range": `bytes 1-${end}/${data.length}` }
      : scenario === "wrong-hash" || start && scenario === "changed-etag" ? { ETag: `"${"0".repeat(64)}"` }
      : start && scenario === "changed-size" ? { "Content-Range": `bytes ${start}-${end}/${data.length + 1}` } : {});
  });
  await expect(downloadAttachment(connection, "fixture")).rejects.toThrow(); expect(calls).toBeLessThanOrEqual(2); expect(released()).toBe(1);
});
test("older full-body Hubs remain readable; cancellation while offline releases the wait", async () => {
  const old = fixture(() => new Response("old", { headers: { "Content-Length": "3" } })); expect(await (await downloadAttachment(old.connection, "fixture")).text()).toBe("old");
  const streamed = fixture(() => new Response("old-streamed")); expect(await (await downloadAttachment(streamed.connection, "fixture")).text()).toBe("old-streamed");
  for (const etag of ['W/"digest"', '"malformed"']) { const invalid = fixture(() => new Response("old", { headers: { ETag: etag, "Content-Length": "3" } })); await expect(downloadAttachment(invalid.connection, "fixture")).rejects.toThrow("校验失败"); }
  const offline = fixture(() => { throw new Error("must_not_fetch"); }); offline.connection.state.status = "offline";
  const controller = new AbortController(), pending = downloadAttachment(offline.connection, "fixture", { signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toThrow("下载已取消"); expect(offline.released()).toBe(1);
});

function checkpointFixture() {
  let meta: DownloadCheckpoint | undefined;
  const chunks = new Map<number, ArrayBuffer>();
  const store: DownloadCheckpointStore = {
    load: async () => meta,
    read: async (_id, _revision, index) => chunks.get(index),
    append: async (_id, value, start, bytes) => { meta = value; chunks.set(start / CHUNK_BYTES, bytes); return true; },
    discard: async () => { meta = undefined; chunks.clear(); },
  };
  return { store, meta: () => meta, chunks };
}
test("cancelled download commits a prefix and a new invocation fetches only the remainder", async () => {
  const data = Buffer.alloc(CHUNK_BYTES * 2 + 17, 7), checkpoint = checkpointFixture(), ranges: string[] = [];
  const { connection } = fixture((headers) => { ranges.push(headers.Range!); const start = Number(headers.Range!.split("=")[1]!.split("-")[0]); return response(data, start, Math.min(data.length, start + CHUNK_BYTES) - 1); });
  Object.assign(connection, { downloadCheckpoints: checkpoint.store });
  const abort = new AbortController();
  await expect(downloadAttachment(connection, "fixture", { signal: abort.signal, progress: () => abort.abort() })).rejects.toThrow("下载已取消");
  expect(checkpoint.meta()?.offset).toBe(CHUNK_BYTES);
  const file = await downloadAttachment(connection, "fixture");
  expect(Buffer.from(await file.arrayBuffer())).toEqual(data);
  expect(ranges).toEqual([`bytes=0-${CHUNK_BYTES - 1}`, `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`, `bytes=${CHUNK_BYTES * 2}-${data.length - 1}`]);
  expect(checkpoint.meta()).toBeUndefined();
});

for (const fault of ["missing-chunk", "corrupt-chunk", "changed-etag", "changed-mime", "whole-body", "forbidden", "quota"] as const) test(`persisted prefix: ${fault} preserves integrity and authorization`, async () => {
  const data = Buffer.alloc(CHUNK_BYTES * 2 + 17, 7), checkpoint = checkpointFixture(), ranges: string[] = []; let secondAttempt = false;
  const { connection, released } = fixture((headers) => {
    ranges.push(headers.Range!); const start = Number(headers.Range!.split("=")[1]!.split("-")[0]);
    if (secondAttempt && fault === "forbidden") throw new HubHttpError(403, "attachment_forbidden");
    if (secondAttempt && fault === "whole-body") return new Response(data, { headers: { "Content-Length": String(data.length) } });
    return response(data, start, Math.min(data.length, start + CHUNK_BYTES) - 1, secondAttempt && fault === "changed-etag" ? { ETag: `"${"b".repeat(64)}"` } : secondAttempt && fault === "changed-mime" ? { "Content-Type": "text/plain" } : {});
  });
  Object.assign(connection, { downloadCheckpoints: checkpoint.store });
  const abort = new AbortController();
  await expect(downloadAttachment(connection, "fixture", { signal: abort.signal, progress: () => abort.abort() })).rejects.toThrow("下载已取消");
  expect(checkpoint.meta()?.offset).toBe(CHUNK_BYTES); secondAttempt = true;
  if (fault === "missing-chunk") checkpoint.chunks.clear();
  if (fault === "corrupt-chunk") new Uint8Array(checkpoint.chunks.get(0)!)[0] ^= 1;
  if (fault === "quota") checkpoint.store.append = async () => { throw new DOMException("Disk full", "QuotaExceededError"); };
  const download = downloadAttachment(connection, "fixture");
  if (fault === "missing-chunk" || fault === "quota") expect(Buffer.from(await (await download).arrayBuffer())).toEqual(data);
  else await expect(download).rejects.toThrow();
  expect(ranges[1]).toBe(fault === "missing-chunk" ? `bytes=0-${CHUNK_BYTES - 1}` : `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`);
  expect(checkpoint.meta()).toBeUndefined(); expect(released()).toBe(2);
});

test("offline cancellation never hydrates a large persisted prefix", async () => {
  const checkpoint = checkpointFixture(); let loaded = 0;
  checkpoint.store.load = async () => { loaded++; throw new Error("must_not_read_offline"); };
  const { connection } = fixture(() => { throw new Error("must_not_request_offline"); });
  connection.state.status = "offline"; Object.assign(connection, { downloadCheckpoints: checkpoint.store });
  const abort = new AbortController(), pending = downloadAttachment(connection, "fixture", { signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 20)); expect(loaded).toBe(0); abort.abort();
  await expect(pending).rejects.toThrow("下载已取消"); expect(loaded).toBe(0);
});

test("recovery status clears before checkpoint hydration after reconnecting", async () => {
  const checkpoint = checkpointFixture(), states: boolean[] = []; let changed: () => void = () => undefined, loaded = false;
  checkpoint.store.load = async () => { expect(states.at(-1)).toBe(false); loaded = true; return undefined; };
  const { connection } = fixture(() => new Response("file")); connection.state.status = "offline";
  connection.subscribe = (notify) => { changed = notify; return () => undefined; };
  Object.assign(connection, { downloadCheckpoints: checkpoint.store });
  const pending = downloadAttachment(connection, "fixture", { recovering: (value) => states.push(value) });
  expect(states).toEqual([true]); connection.state.status = "online"; changed();
  expect(await (await pending).text()).toBe("file"); expect(loaded).toBe(true); expect(states.slice(0, 2)).toEqual([true, false]);
});
