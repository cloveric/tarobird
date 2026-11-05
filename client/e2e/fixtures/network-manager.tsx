import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NetworkManager } from "../../src/NetworkManager.js";
import { runtimeHostId } from "../../src/host-registry.js";
import { reviewedNetworkHash } from "../../src/network-join.js";
import { networkCommandSchema } from "../../../src/client-protocol/private-network.js";
import type { ConnectedHost } from "../../src/host-connections.js";
import type { NetworkCommand, NetworkView, SignedNetworkManifest, SignedNetworkProposal } from "../../../src/client-protocol/private-network.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";
import "../../src/safe-area.css";
import "../../src/porcelain-details.css";

// Only this browser fixture owns these simulated connections. No live host or
// client credentials are read and no network command leaves the page.
const key = (byte: number) => btoa(String.fromCharCode(48,42,48,5,6,3,43,101,112,3,33,0,...new Array(32).fill(byte)));
const keys = [key(1), key(2), key(3)];
let failParentRefresh = false;
const calls: Array<{ host: number; command: NetworkCommand }> = [];
const initial: SignedNetworkManifest = { signature: "A".repeat(86) + "==", manifest: { v: 1, id: "network-fixture", name: "工作网络", authorityKey: keys[0]!, genesisNonce: "g".repeat(43), revokedMembers: [], blockedBindings: [], revision: 1, devices: [], hosts: [
  { publicKey: keys[0]!, name: "同名主机", routes: [{ name: "Direct", url: "https://host-a.test" }], state: "active" as const, revoked: false },
  { publicKey: keys[2]!, name: "尚未连接的工作主机", routes: [{ name: "Direct", url: "https://host-c.test" }], state: "active" as const, revoked: false },
] } };
class FixtureConnection {
  listeners = new Set<() => void>();
  identity;
  state;
  admissions = new Map<string, SignedNetworkManifest>();
  dropAdmission = false;
  failJoin = true;
  failRefresh = false;
  refreshError = "";
  failAfterJoin = false;
  failAfterDeparture = false;
  failLeave = "";
  failRoutes = "";
  routesWaiting = false;
  confirmedChanges: NetworkView[] = [];
  constructor(readonly index: number) {
    this.identity = { routes: [{ name: "Direct" as const, url: `https://host-${index ? "b" : "a"}.test` }], hubPublicKey: keys[index], publicKey: key(index + 5), deviceId: `device-${index}`, name: "Fixture" };
    this.state = { networkChange: undefined as NetworkView | undefined, status: "online", networkAvailable: true, user: { id: "owner", role: "owner", name: "Owner" }, hostProfile: { name: "同名主机", revision: 0 }, network: { host: { publicKey: keys[index]!, name: "同名主机", routes: this.identity.routes, state: "active" as const, revoked: false }, ...(index ? {} : { membership: structuredClone(initial) }), sync: index ? "standalone" : "current", lastSyncedAt: Date.now() } as NetworkView };
  }
  subscribe(callback: () => void) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  emit() { this.listeners.forEach(callback => callback()); }
  async refreshNetwork() { if (heldRefresh) await heldRefresh.promise; if (this.refreshError) throw new Error(this.refreshError); if (this.failRefresh) throw new Error("模拟目录刷新失败"); return this.state.network; }
  async confirmNetworkChange(review: NetworkView) {
    this.confirmedChanges.push(structuredClone(review));
    if (JSON.stringify(review.membership) !== JSON.stringify(this.state.networkChange?.membership)) throw new Error("network_review_changed");
    this.state.network = this.state.networkChange!; this.state.networkChange = undefined; this.emit();
  }
  async networkCommand(command: NetworkCommand) {
    calls.push({ host: this.index, command: structuredClone(command) });
    if (heldCommand?.operation === command.operation) await heldCommand.promise;
    if (command.operation === "create") {
      networkCommandSchema.parse(command);
      const membership = structuredClone(initial);
      membership.manifest = { ...membership.manifest, id: "created-network", name: command.name, authorityKey: this.state.network.host.publicKey, hosts: [this.state.network.host] };
      this.state.network = { ...this.state.network, membership, sync: "current" };
    }
    if (command.operation === "routes") {
      if (this.failRoutes) throw new Error(this.failRoutes);
      this.state.network = { ...this.state.network, host: { ...this.state.network.host, routes: command.routes } };
      if (this.routesWaiting) this.state.network.sync = "waiting";
    }
    if (command.operation === "propose") {
      const proposal: SignedNetworkProposal = { signature: "A".repeat(86) + "==", proposal: { v: 1, host: { publicKey: this.state.network.host.publicKey, name: this.state.network.host.name, routes: this.state.network.host.routes }, devices: [], authorityKey: command.authorityKey, networkId: command.networkId, seenManifestHash: command.seenManifestHash, nonce: "n".repeat(43), expiresAt: Date.now() + 60_000 } };
      return { view: this.state.network, proposal };
    }
    if (command.operation === "admit") {
      const prior = this.admissions.get(command.proposal.proposal.nonce);
      if (prior) return { view: this.state.network, membership: prior };
      if (command.proposal.proposal.seenManifestHash !== reviewedNetworkHash(this.state.network.membership!.manifest)) throw new Error("network_review_changed");
      const membership = structuredClone(this.state.network.membership!);
      membership.manifest.revision++;
      membership.manifest.hosts = [...membership.manifest.hosts.filter(host => host.publicKey !== command.proposal.proposal.host.publicKey), { ...command.proposal.proposal.host, state: "pending", revoked: false, proposalNonce: command.proposal.proposal.nonce, expiresAt: command.proposal.proposal.expiresAt }];
      this.state.network = { ...this.state.network, membership }; this.admissions.set(command.proposal.proposal.nonce, membership); this.emit();
      if (this.dropAdmission) { this.dropAdmission = false; throw new Error("模拟加入确认响应丢失"); }
      return { view: this.state.network, membership };
    }
    if (command.operation === "join") {
      if (this.failJoin) { this.failJoin = false; throw new Error("模拟连接中断"); }
      const membership = structuredClone(command.membership); membership.manifest.revision++;
      membership.manifest.hosts = membership.manifest.hosts.map(host => host.publicKey === this.state.network.host.publicKey ? { publicKey: host.publicKey, name: host.name, routes: host.routes, state: "active", revoked: false } : host);
      this.state.network = { ...this.state.network, membership, sync: "current" };
      connections[0]!.state.network = { ...connections[0]!.state.network, membership }; connections[0]!.emit();
      if (this.failAfterJoin) connections[0]!.failRefresh = true;
    }
    if (command.operation === "remove") {
      const membership = structuredClone(this.state.network.membership!); membership.manifest.revision++;
      membership.manifest.hosts = membership.manifest.hosts.map(host => host.publicKey === command.publicKey ? { ...host, revoked: true } : host);
      this.state.network = { ...this.state.network, membership };
    }
    if (command.operation === "leave") {
      if (this.failLeave) throw new Error(this.failLeave);
      const own = this.state.network.membership?.manifest.hosts.find(host => host.publicKey === this.state.network.host.publicKey);
      if (command.expectedState !== (own?.state ?? "standalone")) throw new Error("network_host_state_changed");
      this.state.network = { host: { ...this.state.network.host, state: "active" }, sync: "standalone", lastSyncedAt: Date.now() };
    }
    if ((command.operation === "remove" || command.operation === "leave") && this.failAfterDeparture) this.failRefresh = true;
    this.emit(); return { view: this.state.network };
  }
  resume() {}
  async http(_url: string, init?: RequestInit) {
    if (init?.method === "PATCH") {
      profileWrites.push(init.body as string);
      if (heldProfile) await heldProfile.promise;
      const input = JSON.parse(init.body as string) as { name: string; revision: number };
      if (input.revision !== this.state.hostProfile.revision) throw new Error("host_profile_changed");
      this.state.hostProfile = { name: input.name, revision: input.revision + 1 };
      this.state.network = { ...this.state.network, host: { ...this.state.network.host, name: input.name } }; this.emit();
    }
    return this.state.hostProfile;
  }
}
const connections = [new FixtureConnection(0), new FixtureConnection(1)];
let heldCommand: { operation: string; promise: Promise<void>; release: () => void } | undefined;
let heldRefresh: { promise: Promise<void>; release: () => void } | undefined;
let heldProfile: { promise: Promise<void>; release: () => void } | undefined;
const profileWrites: string[] = [];
const entries = connections.map((connection, index) => ({ host: { id: runtimeHostId(keys[index]!), publicKey: keys[index], name: "同名主机", registrationId: `fixture-${index}`, state: "ready", deviceId: `device-${index}`, databaseName: `fixture-${index}`, createdAt: index }, connection })) as unknown as ConnectedHost[];
(window as unknown as { networkFixture: unknown }).networkFixture = {
  calls,
  profileWrites,
  holdProfile() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); heldProfile = { promise, release }; },
  releaseProfile() { const current = heldProfile; heldProfile = undefined; current?.release(); },
  holdRefresh() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); heldRefresh = { promise, release }; },
  releaseRefresh() { const current = heldRefresh; heldRefresh = undefined; current?.release(); },
  holdCommand(operation: string) {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    heldCommand = { operation, promise, release };
  },
  releaseCommand() { const current = heldCommand; heldCommand = undefined; current?.release(); },
  refreshFailure(index: number, error: string) { connections[index]!.refreshError = error; },
  standaloneTarget(name: string) {
    const connection = connections[0]!;
    connection.state.hostProfile = { name, revision: connection.state.hostProfile.revision + 1 };
    connection.state.network = { host: { ...connection.state.network.host, name }, sync: "standalone", lastSyncedAt: Date.now() };
    connection.emit();
  },
  singleton(pending: "none" | "active" | "expired" = "none") {
    const membership = structuredClone(initial); membership.manifest.v = 2; membership.manifest.revision++;
    membership.manifest.hosts = [membership.manifest.hosts[0]!];
    if (pending !== "none") membership.manifest.hosts.push({ publicKey: keys[2]!, name: "待加入主机", routes: [], state: "pending", revoked: false, proposalNonce: "p".repeat(43), expiresAt: pending === "active" ? Date.now() + 60_000 : 1 });
    connections[0]!.state.network = { ...connections[0]!.state.network, membership }; connections[0]!.emit();
  },
  dropAdmissionResponse() { connections[0]!.dropAdmission = true; connections[1]!.failJoin = false; },
  confirmedChanges() { return connections[1]!.confirmedChanges; },
  newNetwork() {
    const host = { ...connections[1]!.state.network.host, state: "active" as const };
    connections[1]!.state.networkChange = { host, sync: "current", lastSyncedAt: Date.now(), membership: { signature: "A".repeat(86) + "==", manifest: { ...structuredClone(initial.manifest), id: "changed-network", name: "新的工作网络", hosts: [...initial.manifest.hosts, host] } } }; connections[1]!.emit();
  },
  leaveNetwork() { connections[1]!.state.networkChange = { host: connections[1]!.state.network.host, sync: "standalone", lastSyncedAt: Date.now() }; connections[1]!.emit(); },
  changeReviewAgain() { const view = structuredClone(connections[1]!.state.networkChange!); view.membership!.manifest.name = "再次变更的网络"; view.membership!.manifest.revision++; connections[1]!.state.networkChange = view; connections[1]!.emit(); },
  failRefreshAfterDeparture() { connections[0]!.failAfterDeparture = true; connections[1]!.failAfterDeparture = true; },
  failRefreshAfterJoin() { connections[1]!.failJoin = false; connections[1]!.failAfterJoin = true; },
  ownMultiHostNetwork() { const membership = structuredClone(initial); membership.manifest.id = "other-network"; membership.manifest.authorityKey = keys[1]!; membership.manifest.hosts[0] = { ...connections[1]!.state.network.host }; connections[1]!.state.network = { ...connections[1]!.state.network, membership, sync: "current" }; connections[1]!.emit(); },
  pendingSource() {
    const membership = structuredClone(initial); membership.manifest.revision++;
    const host = { ...connections[1]!.state.network.host, state: "pending" as const, proposalNonce: "p".repeat(43), expiresAt: Date.now() + 60_000 };
    membership.manifest.hosts.push(host);
    connections[0]!.state.network = { ...connections[0]!.state.network, membership };
    connections[1]!.state.network = { host, membership, sync: "waiting", lastSyncedAt: Date.now() };
    connections.forEach(connection => connection.emit());
  },
  completePending() {
    const membership = structuredClone(connections[0]!.state.network.membership!); membership.manifest.revision++;
    membership.manifest.hosts = membership.manifest.hosts.map(host => host.publicKey === keys[1] ? { publicKey: host.publicKey, name: host.name, routes: host.routes, state: "active", revoked: false } : host);
    connections[0]!.state.network = { ...connections[0]!.state.network, membership };
    connections[1]!.state.network = { host: membership.manifest.hosts.find(host => host.publicKey === keys[1])!, membership, sync: "current", lastSyncedAt: Date.now() };
    connections.forEach(connection => connection.emit());
  },
  sourceOnline(online: boolean) { connections[1]!.state.status = online ? "online" : "offline"; connections[1]!.emit(); },
  offlineAuthority() { connections[0]!.state.status = "offline"; connections[0]!.emit(); },
  authorityAccess(role: string, networkAvailable = true) { connections[0]!.state.user.role = role; connections[0]!.state.networkAvailable = networkAvailable; connections[0]!.emit(); },
  overview(names = ["example-mac", "示例电脑"], networkName = "我的网络") {
    const membership = structuredClone(initial); membership.manifest.name = networkName; membership.manifest.revision++;
    membership.manifest.hosts = connections.map((connection, index) => ({ ...connection.state.network.host, name: names[index]!, state: "active" as const }));
    connections.forEach((connection, index) => {
      connection.state.hostProfile = { name: names[index]!, revision: connection.state.hostProfile.revision + 1 };
      connection.state.network = { host: membership.manifest.hosts[index]!, membership, sync: "current", lastSyncedAt: Date.now() };
      connection.emit();
    });
  },
  authorityStatus(status: string) { connections[0]!.state.status = status; connections[0]!.emit(); },
  multipleRoutes(index = 1) {
    const connection = connections[index]!;
    connection.identity.routes = [...connection.identity.routes, { name: "Tailscale", url: "https://100.80.1.20:8788" }, { name: "VPS", url: "https://relay.example" }] as typeof connection.identity.routes;
    connection.emit();
  },
  requireRouteReview(index = 1) { const connection = connections[index]!; connection.state.network = { ...connection.state.network, host: { ...connection.state.network.host, routes: [] } }; connection.emit(); },
  failNameRefresh() { connections[0]!.failRefresh = true; failParentRefresh = true; },
  renameElsewhere() { connections[0]!.state.hostProfile = { name: "其他设备的新名称", revision: 1 }; connections[0]!.emit(); },
  // Host-detail and route pages. These only change local fixture state.
  failLeave(index: number, error: string) { connections[index]!.failLeave = error; },
  failRoutes(index: number, error: string) { connections[index]!.failRoutes = error; },
  routesWaiting(index: number) { connections[index]!.routesWaiting = true; },
  sourceAccess(role: string) { connections[1]!.state.user.role = role; connections[1]!.emit(); },
  noShareableRoutes(index: number) {
    const connection = connections[index]!;
    connection.identity = { ...connection.identity, routes: [{ name: "Direct" as const, url: "http://127.0.0.1:8788" }] };
    connection.state.network = { ...connection.state.network, host: { ...connection.state.network.host, routes: [] } }; connection.emit();
  },
  standaloneAll() {
    connections.forEach(connection => { connection.state.network = { host: connection.state.network.host, sync: "standalone", lastSyncedAt: Date.now() }; connection.emit(); });
  },
  changeDirectory() { const membership = structuredClone(connections[0]!.state.network.membership!); membership.manifest.revision++; membership.manifest.hosts.push({ publicKey: key(4), name: "刚加入的另一台主机", routes: [], state: "active", revoked: false }); connections[0]!.state.network = { ...connections[0]!.state.network, membership }; connections[0]!.emit(); connections[1]!.failJoin = false; },
};
function Fixture() {
  const [open, setOpen] = useState(true), [connectionsOpen, setConnectionsOpen] = useState(false);
  const [localHostKey, setLocalHostKey] = useState("");
  const [hosts, setHosts] = useState(entries), [destination, setDestination] = useState("");
  const [deviceApproval, setDeviceApproval] = useState(false);
  const [target, setTarget] = useState<{ key?: string; details?: boolean; mount: number }>({ mount: 0 });
  Object.assign((window as any).networkFixture, {
    localController: (enabled: boolean) => setLocalHostKey(enabled ? keys[0]! : ""), noHosts: () => setHosts([]), deviceApproval: setDeviceApproval,
    openFor: (index: number, details = false) => { setTarget(old => ({ key: keys[index], details, mount: old.mount + 1 })); setOpen(true); },
  });
  const [initialJoin, setInitialJoin] = useState<{hostId:string;networkHostId:string}>();
  return <><button onClick={() => setOpen(true)}>打开网络</button><button onClick={() => { setInitialJoin({hostId:entries[1]!.host.id,networkHostId:entries[0]!.host.id}); setOpen(true); }}>继续配对后加入</button>{connectionsOpen && <p>连接设置入口</p>}{destination && <p>{destination}</p>}{open && <NetworkManager key={target.mount} initialHostKey={target.key} initialHostDetails={target.details} joined={async () => { if (failParentRefresh) throw new Error("模拟父级目录刷新失败"); }} initialJoin={initialJoin} entries={hosts} localHostKey={localHostKey} close={() => setOpen(false)} addHost={() => { setOpen(false); setDestination("配对入口"); }} confirmDevice={deviceApproval ? (hostKey, mode) => setDestination(`确认新设备入口：${keys.indexOf(hostKey)}:${mode}`) : undefined} manageConnections={() => { setOpen(false); setConnectionsOpen(true); }}/>}</>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
