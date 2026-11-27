import type { HubConnection } from './connection.js';
import { HubHttpError } from './http-error.js';
import {
  nextCrossHostFolderUpdatedAt,
  parseCrossHostFolderKey,
  readCrossHostFolderOrder,
  readyCrossHostFolderOrder,
  setCrossHostServerTimeOffset,
  subscribeCrossHostFolderOrder,
  writeCrossHostFolderOrder,
} from './cross-host-folder-order.js';

export type CrossHostOrderConnectionSource = {
  subscribe: (listener: () => void) => () => void;
  getConnections: () => readonly HubConnection[];
};

type OrderValue = {
  updatedAt?: number;
  pinned: readonly string[];
  ordinary: readonly string[];
};

type ClampedTarget = {
  canonical: string;
  targetTs: number;
  revision: number;
  updatedAt: number;
};

const MAX_CONFLICT_PASSES = 6;

function canonicalOrder(order: Pick<OrderValue, 'pinned' | 'ordinary'>): string {
  return JSON.stringify([order.pinned, order.ordinary]);
}

function hostKeysOf(order: Pick<OrderValue, 'pinned' | 'ordinary'>): Set<string> {
  const hosts = new Set<string>();
  for (const key of order.pinned) {
    const parsed = parseCrossHostFolderKey(key);
    if (parsed) hosts.add(parsed.hostKey);
  }
  for (const key of order.ordinary) {
    const parsed = parseCrossHostFolderKey(key);
    if (parsed) hosts.add(parsed.hostKey);
  }
  return hosts;
}

/** True when `local` is at the exact same positive timestamp as `remote` and
 * matches `remote` with one or more hosts removed locally (e.g. device-local
 * unpairing). Neither side should overwrite the other in this state. */
function isHostPrunedMatch(local: OrderValue, remote: OrderValue): boolean {
  const localTs = local.updatedAt ?? 0;
  const remoteTs = remote.updatedAt ?? 0;
  if (localTs === 0 || localTs !== remoteTs) return false;
  if (canonicalOrder(local) === canonicalOrder(remote)) return false;
  const localHosts = hostKeysOf(local);
  const remoteHosts = hostKeysOf(remote);
  let hasMissingHost = false;
  for (const host of remoteHosts) {
    if (!localHosts.has(host)) hasMissingHost = true;
  }
  if (!hasMissingHost) return false;
  for (const host of localHosts) {
    if (!remoteHosts.has(host)) return false;
  }
  const keep = (key: string) => {
    const parsed = parseCrossHostFolderKey(key);
    return !!parsed && localHosts.has(parsed.hostKey);
  };
  return canonicalOrder({
    pinned: remote.pinned.filter(keep),
    ordinary: remote.ordinary.filter(keep),
  }) === canonicalOrder(local);
}

function isNewerOrder(candidate: OrderValue, current: OrderValue): boolean {
  const candidateTs = candidate.updatedAt ?? 0;
  const currentTs = current.updatedAt ?? 0;
  if (candidateTs !== currentTs) return candidateTs > currentTs;
  if (candidateTs === 0) return false;
  return canonicalOrder(candidate) > canonicalOrder(current);
}

function isEligibleConnection(connection: HubConnection): boolean {
  const { state } = connection;
  return !connection.isClosed
    && !connection.isReadOnly
    && state.status === 'online'
    && state.crossHostFolderOrderAvailable === true
    && state.crossHostFolderOrder !== undefined
    && state.user?.role === 'owner';
}

type ObservedConnectionState = {
  status: HubConnection['state']['status'];
  available: HubConnection['state']['crossHostFolderOrderAvailable'];
  order: HubConnection['state']['crossHostFolderOrder'];
  role: string | undefined;
  readOnly: boolean;
  closed: boolean;
};

function snapshotOf(connection: HubConnection): ObservedConnectionState {
  const { state } = connection;
  return {
    status: state.status,
    available: state.crossHostFolderOrderAvailable,
    order: state.crossHostFolderOrder,
    role: state.user?.role,
    readOnly: connection.isReadOnly,
    closed: connection.isClosed,
  };
}

function sameSnapshot(a: ObservedConnectionState | undefined, b: ObservedConnectionState): boolean {
  return !!a
    && a.status === b.status
    && a.available === b.available
    && a.order === b.order
    && a.role === b.role
    && a.readOnly === b.readOnly
    && a.closed === b.closed;
}

/** Coordinates cross-host folder order sync across all connected owner Hubs
 * that advertise `cross-host-folder-order.v1`, with LWW timestamp reconciliation,
 * one-time pre-upgrade migration upload, and offline reconnect catch-up. */
export class CrossHostFolderOrderSync {
  private readonly subscriptions = new Map<HubConnection, { stop: () => void; snapshot: ObservedConnectionState }>();
  private readonly clampedTargets = new Map<HubConnection, ClampedTarget>();
  private readonly unsubSource: () => void;
  private readonly unsubOrder: () => void;
  private disposed = false;
  private running = false;
  private dirty = false;
  private suppressLocalEvent = false;
  private conflictPasses = 0;
  private currentLoop: Promise<void> = Promise.resolve();

  constructor(private readonly source: CrossHostOrderConnectionSource) {
    this.unsubSource = source.subscribe(() => {
      this.refreshConnections();
      this.schedule();
    });
    this.unsubOrder = subscribeCrossHostFolderOrder(() => {
      if (!this.suppressLocalEvent) {
        this.conflictPasses = 0;
        this.schedule();
      }
    });
    this.refreshConnections();
    this.schedule();
  }

  private refreshConnections(): void {
    if (this.disposed) return;
    const active = new Set(this.source.getConnections());
    for (const [connection, entry] of this.subscriptions) {
      if (!active.has(connection)) {
        entry.stop();
        this.subscriptions.delete(connection);
        this.clampedTargets.delete(connection);
      }
    }
    for (const connection of active) {
      if (this.subscriptions.has(connection)) continue;
      const entry = {
        snapshot: snapshotOf(connection),
        stop: connection.subscribe(() => {
          const next = snapshotOf(connection);
          if (sameSnapshot(entry.snapshot, next)) return;
          entry.snapshot = next;
          this.schedule();
        }),
      };
      this.subscriptions.set(connection, entry);
    }
  }

  schedule(): Promise<void> {
    if (this.disposed) return this.currentLoop;
    this.dirty = true;
    if (!this.running) {
      this.running = true;
      this.currentLoop = this.runLoop().finally(() => {
        this.running = false;
        if (this.dirty && !this.disposed) void this.schedule();
      });
    }
    return this.currentLoop;
  }

  async syncNow(): Promise<void> {
    this.refreshConnections();
    await this.schedule();
    while (this.running) await this.currentLoop;
  }

  private async runLoop(): Promise<void> {
    while (this.dirty && !this.disposed) {
      this.dirty = false;
      await this.reconcilePass();
    }
  }

  private async reconcilePass(): Promise<void> {
    await readyCrossHostFolderOrder();
    if (this.disposed) return;
    const eligible = this.source.getConnections().filter(isEligibleConnection);
    if (!eligible.length) return;

    const offset = eligible.find(c => c.state.serverTimeOffset !== undefined)?.state.serverTimeOffset;
    if (offset !== undefined) setCrossHostServerTimeOffset(offset);

    let bestRemote = eligible[0]!.state.crossHostFolderOrder!;
    for (let i = 1; i < eligible.length; i++) {
      const candidate = eligible[i]!.state.crossHostFolderOrder!;
      if (isNewerOrder(candidate, bestRemote)) bestRemote = candidate;
    }

    let local = readCrossHostFolderOrder();
    const localPrunedFromRemote = isHostPrunedMatch(local, bestRemote);
    if (!localPrunedFromRemote && isNewerOrder(bestRemote, local)) {
      this.suppressLocalEvent = true;
      try {
        writeCrossHostFolderOrder({
          version: 1,
          updatedAt: bestRemote.updatedAt,
          pinned: bestRemote.pinned,
          ordinary: bestRemote.ordinary,
        }, { fromSync: true });
      } finally {
        this.suppressLocalEvent = false;
      }
      local = readCrossHostFolderOrder();
    } else if (
      bestRemote.revision === 0
      && bestRemote.updatedAt === 0
      && (local.updatedAt ?? 0) === 0
      && (local.pinned.length > 0 || local.ordinary.length > 0)
    ) {
      // One-time migration upload: stamp pre-upgrade device-local order so all
      // connected owner devices converge on it.
      this.suppressLocalEvent = true;
      try {
        writeCrossHostFolderOrder(local, { updatedAt: nextCrossHostFolderUpdatedAt(0) });
      } finally {
        this.suppressLocalEvent = false;
      }
      local = readCrossHostFolderOrder();
    }

    const target: OrderValue = localPrunedFromRemote ? bestRemote : local;
    const localMatchesTarget = !localPrunedFromRemote;
    const targetTs = target.updatedAt ?? 0;
    if (targetTs === 0) return;
    const targetCanonical = canonicalOrder(target);

    let sawConflict = false;
    let sawClampedOrNewer = false;
    for (const connection of eligible) {
      if (this.disposed) return;
      const remote = connection.state.crossHostFolderOrder;
      if (!remote || !isNewerOrder(target, remote)) continue;
      const clamped = this.clampedTargets.get(connection);
      if (
        clamped
        && clamped.canonical === targetCanonical
        && clamped.revision === remote.revision
        && clamped.updatedAt === remote.updatedAt
        && canonicalOrder(remote) === clamped.canonical
        && targetTs <= clamped.targetTs
      ) {
        continue;
      }
      try {
        const saved = await connection.saveCrossHostFolderOrder(
          { updatedAt: targetTs, pinned: target.pinned, ordinary: target.ordinary },
          remote.revision,
        );
        if (this.disposed) return;
        const latestLocal = readCrossHostFolderOrder();
        const localDiverged = localMatchesTarget
          && ((latestLocal.updatedAt ?? 0) !== targetTs || canonicalOrder(latestLocal) !== targetCanonical);
        if (saved.updatedAt < targetTs && canonicalOrder(saved) === targetCanonical) {
          this.clampedTargets.set(connection, {
            canonical: targetCanonical,
            targetTs,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          });
          if (localDiverged) {
            this.dirty = true;
            break;
          }
          // Only re-align local updatedAt downward when no connected owner Hub
          // already holds a higher timestamp for the exact same order.
          const higherRemoteExists = this.source.getConnections().some(c => {
            if (!isEligibleConnection(c)) return false;
            const r = c.state.crossHostFolderOrder;
            return !!r && r.updatedAt > saved.updatedAt && canonicalOrder(r) === targetCanonical;
          });
          if (localMatchesTarget && !higherRemoteExists) {
            // Server clamped a far-future offline clock; align local timestamp
            // so remaining Hubs converge without repeating PATCHes.
            this.suppressLocalEvent = true;
            try {
              writeCrossHostFolderOrder({
                version: 1,
                updatedAt: saved.updatedAt,
                pinned: saved.pinned,
                ordinary: saved.ordinary,
              }, { fromSync: true });
            } finally {
              this.suppressLocalEvent = false;
            }
            sawClampedOrNewer = true;
            break;
          }
        } else {
          this.clampedTargets.delete(connection);
          if (localDiverged) {
            this.dirty = true;
            break;
          }
          if (isNewerOrder(saved, target)) {
            sawClampedOrNewer = true;
          }
        }
      } catch (error) {
        if (error instanceof HubHttpError && error.code === 'cross_host_folder_order_changed') {
          this.clampedTargets.delete(connection);
          sawConflict = true;
        }
      }
    }

    const needsRetry = sawConflict || sawClampedOrNewer;
    if (needsRetry && this.conflictPasses < MAX_CONFLICT_PASSES) {
      this.conflictPasses++;
      this.dirty = true;
    } else if (!needsRetry) {
      this.conflictPasses = 0;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.unsubSource();
    this.unsubOrder();
    for (const entry of this.subscriptions.values()) entry.stop();
    this.subscriptions.clear();
    this.clampedTargets.clear();
  }
}
