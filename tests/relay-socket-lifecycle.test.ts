import { once } from "node:events";
import { Duplex, PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { expect, test } from "vitest";
import { coupleSockets } from "../src/relay/socket-lifecycle.js";

test.each([false, true])("normal EOF drains bytes already queued to the other socket (reverse=%s)", async (reverse) => {
  const payload = Buffer.from("last encrypted response records");
  let releaseWrite: (() => void) | undefined;
  const delivered: Buffer[] = [];
  const source = new Duplex({ allowHalfOpen: false, read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const destination = new Duplex({
    read() {},
    write(chunk, _encoding, callback) { releaseWrite = () => { delivered.push(Buffer.from(chunk)); callback(); }; },
    final(callback) { this.push(null); callback(); },
  });
  if (reverse) coupleSockets(destination, source); else coupleSockets(source, destination);
  source.pipe(destination).pipe(source);
  try {
    const closed = once(source, "close"); source.push(payload); source.push(null);
    await closed; // The source closes while the peer still has a pending write.
    expect(releaseWrite).toBeDefined(); expect(destination.destroyed).toBe(false);
    const drained = finished(destination, { readable: false }); releaseWrite!(); await drained;
    expect(Buffer.concat(delivered)).toEqual(payload);
  } finally { source.destroy(); destination.destroy(); }
});

test.each([false, true])("an aborted socket promptly destroys its peer (reverse=%s)", async (reverse) => {
  const source = new PassThrough(), destination = new PassThrough();
  source.on("error", () => undefined);
  if (reverse) coupleSockets(destination, source); else coupleSockets(source, destination);
  const closed = once(destination, "close"); source.destroy(new Error("connection reset")); await closed;
  expect(destination.destroyed).toBe(true);
});

test.each([false, true])("close after EOF but before write finish does not re-pause its peer (reverse=%s)", async reverse => {
  const source = new Duplex({ allowHalfOpen: true, read() {}, write(_chunk, _encoding, _callback) {} });
  const peer = new Duplex({ allowHalfOpen: false, read() {}, write(_chunk, _encoding, callback) { callback(); } });
  if (reverse) coupleSockets(peer, source); else coupleSockets(source, peer);
  source.pipe(peer).pipe(source);
  try {
    source.write("unfinished reverse-direction write");
    const ended = once(source, "end"); source.push(null); await ended;
    const closed = once(source, "close"); source.destroy(); await closed;
    expect(source.readableEnded).toBe(true); expect(source.writableFinished).toBe(false);
    // These unread bytes precede FIN, like TLS close_notify. A paused stream
    // cannot consume them and release its connection quota.
    peer.push("trailing close bytes"); peer.push(null);
    await expect.poll(() => peer.destroyed, { timeout: 1000 }).toBe(true);
    expect(peer.readableEnded).toBe(true);
  } finally { source.destroy(); peer.destroy(); }
});
