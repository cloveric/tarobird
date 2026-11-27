import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { emptyConversationFolders } from '../../src/client-protocol/conversation-folders.js';
import type { HubConnection } from './connection.js';
import type { InboxRow } from './conversation-inbox.js';
import {
  crossHostFolderOrderWriteError,
  folderHostIdentity,
  readCrossHostFolderOrder,
  subscribeCrossHostFolderOrder,
  type CrossHostFolderSource,
  type StoredCrossHostFolderOrder,
} from './cross-host-folder-order.js';
import { CrossHostFolderOrderSync, type CrossHostOrderConnectionSource } from './cross-host-folder-order-sync.js';

export type CrossHostFolderHost = {
  id: string;
  name: string;
  connection: HubConnection;
};

export function useCrossHostFolderOrder(): StoredCrossHostFolderOrder {
  return useSyncExternalStore(subscribeCrossHostFolderOrder, readCrossHostFolderOrder, readCrossHostFolderOrder);
}

export function useCrossHostFolderOrderWriteError(): string | undefined {
  return useSyncExternalStore(subscribeCrossHostFolderOrder, crossHostFolderOrderWriteError, crossHostFolderOrderWriteError);
}

export function useCrossHostFolderOrderSync(source: CrossHostOrderConnectionSource): void {
  useEffect(() => {
    const coordinator = new CrossHostFolderOrderSync(source);
    return () => coordinator.dispose();
  }, [source]);
}

const connectionTokens = new WeakMap<HubConnection, number>();
let nextConnectionToken = 1;
function tokenOf(connection: HubConnection): number {
  let token = connectionTokens.get(connection);
  if (!token) {
    token = nextConnectionToken++;
    connectionTokens.set(connection, token);
  }
  return token;
}

type FolderSnapshot = {
  folders: HubConnection['state']['conversationFolders'];
  status: HubConnection['state']['status'];
  foldersAvailable: HubConnection['state']['foldersAvailable'];
  folderReorderAvailable: HubConnection['state']['folderReorderAvailable'];
  folderPinAvailable: HubConnection['state']['folderPinAvailable'];
};

function readSnapshot(connection: HubConnection): FolderSnapshot {
  const { state } = connection;
  return {
    folders: state.conversationFolders,
    status: state.status,
    foldersAvailable: state.foldersAvailable,
    folderReorderAvailable: state.folderReorderAvailable,
    folderPinAvailable: state.folderPinAvailable,
  };
}

function sameSnapshot(a: FolderSnapshot | undefined, b: FolderSnapshot): boolean {
  return !!a
    && a.folders === b.folders
    && a.status === b.status
    && a.foldersAvailable === b.foldersAvailable
    && a.folderReorderAvailable === b.folderReorderAvailable
    && a.folderPinAvailable === b.folderPinAvailable;
}

/** Re-render when any listed host changes its folder snapshot, online status,
 * or folder capabilities, without firing on unrelated chat stream updates. */
export function useHostFolderUpdates(hosts: readonly { connection: HubConnection }[]): number {
  const [version, setVersion] = useState(0);
  const connections = hosts.map(host => host.connection);
  const signature = connections.map(tokenOf).join(',');
  const rendered = useRef<Map<HubConnection, FolderSnapshot>>(new Map());
  rendered.current = new Map(connections.map(connection => [connection, readSnapshot(connection)]));

  useEffect(() => {
    const snapshots = new Map(rendered.current);
    const check = (connection: HubConnection) => {
      const next = readSnapshot(connection);
      if (sameSnapshot(snapshots.get(connection), next)) return;
      snapshots.set(connection, next);
      setVersion(value => value + 1);
    };
    const stops = connections.map(connection => connection.subscribe(() => check(connection)));
    // Reconcile any state transition that landed between render and effect commit.
    for (const connection of connections) check(connection);
    return () => { for (const stop of stops) stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return version;
}

export function buildCrossHostFolderSources(hosts: readonly CrossHostFolderHost[]): CrossHostFolderSource[] {
  return hosts.map(host => {
    const { state } = host.connection;
    const online = state.status === 'online';
    return {
      hostId: host.id,
      hostKey: folderHostIdentity(host.connection.identity, host.id),
      hostName: host.name,
      folders: state.conversationFolders ?? emptyConversationFolders(),
      online,
      foldersAuthoritative: online && state.foldersAvailable === true && state.conversationFolders !== undefined,
    };
  });
}

/** Match the exact folder assignment rules used by FolderSections so visibility
 * calculations stay aligned across CombinedSidebar and MobileHome. */
export function buildHostFolderRowCounts(
  hosts: readonly CrossHostFolderHost[],
  rows: readonly InboxRow[],
): (hostId: string, folderId: string | null) => number {
  const counts = new Map<string, number>();
  const byHost = new Map(hosts.map(host => {
    const state = host.connection.state.conversationFolders ?? emptyConversationFolders();
    return [host.id, {
      known: new Set(state.folders.map(folder => folder.id)),
      assignments: new Map(state.assignments.map(item => [item.conversationId, item.folderId])),
    }] as const;
  }));
  for (const row of rows) {
    const info = byHost.get(row.hostId);
    if (!info) continue;
    const assigned = info.assignments.get(row.conversation.id);
    const folderKey = assigned && info.known.has(assigned) ? assigned : '';
    const mapKey = `${row.hostId}\0${folderKey}`;
    counts.set(mapKey, (counts.get(mapKey) ?? 0) + 1);
  }
  return (hostId: string, folderId: string | null) => counts.get(`${hostId}\0${folderId ?? ''}`) ?? 0;
}
