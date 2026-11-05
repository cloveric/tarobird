import type { Duplex } from "node:stream";

/** pipe() ends the destination after EOF and drains its queued writes. Only an
 * aborted source should destroy its peer; destroying on every close truncates
 * the last TLS records when the peer's network is slower than the source. */
export function coupleSockets(first: Duplex, second: Duplex): void {
  const closed = (source: Duplex, peer: Duplex, hadError?: boolean) => {
    if (hadError || !source.readableEnded) { peer.destroy(); return; }
    // pipe() pauses its source when the destination closes. After a clean
    // close that can strand the peer's buffered FIN and keep an otherwise
    // finished public connection in the relay quota until its idle timeout.
    // Drain the remaining read side so EOF can close it normally; its queued
    // writes must still finish, especially on a slow encrypted download.
    // Remove pipe's later close listener before resuming. Otherwise a source
    // destroyed after readable EOF but before writable finish can re-pause it.
    peer.unpipe(source);
    if (!peer.destroyed) peer.resume();
  };
  first.once("close", (hadError?: boolean) => closed(first, second, hadError));
  second.once("close", (hadError?: boolean) => closed(second, first, hadError));
}
