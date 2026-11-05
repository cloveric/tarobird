import type { HubConnection } from "./connection.js";
import { coalescedReader } from "./coalesced-reader.js";

/** Tombstones and replacement snapshots already advance this view revision.
 * Group settings and reconnect can cause an extra read; streaming cannot.
 * A burst of deletions keeps one active read and one trailing read. */
export function observeMessageDeletions(connection: HubConnection, publish: (hidden: Set<string>) => void): () => void {
  let revision = connection.groupDiscussionRevision, online = connection.state.status === "online";
  const reader = coalescedReader(() => connection.cache.deletedMessageIds(), publish);
  const unsubscribe = connection.subscribe(() => {
    // A peer window can advance shared IDB while this socket is disconnected;
    // resume then starts after that deletion, without replaying its tombstone.
    const reconnected = !online && connection.state.status === "online";
    online = connection.state.status === "online";
    if (revision === connection.groupDiscussionRevision && !reconnected) return;
    revision = connection.groupDiscussionRevision; reader.request();
  });
  reader.request();
  return () => { unsubscribe(); reader.close(); };
}
