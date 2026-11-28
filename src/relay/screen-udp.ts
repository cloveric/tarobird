import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { isIPv4 } from "node:net";
import { decodeStun, decodeStunAddress, encodeStun, encodeStunAddress, STUN, stunNumber, type StunMessage } from "./screen-stun.js";

const REALM = Buffer.from("tarobird-screen");
const GRANT_MS = 90_000;
const ALLOCATION_MS = 90_000;
const BYTES_PER_MS = 1250;
const BURST_BYTES = BYTES_PER_MS * 500;
const MAX_HOST_PAIRS = 4;
const MAX_PAIRS = 128;
const MAX_PACKET = 1600;

export type ScreenRelayPeer = { username: string; credential: string };
export type ScreenRelayGrant = { id: string; sender: ScreenRelayPeer; viewer: ScreenRelayPeer };
type HostQuota = { bytesForwarded: number; droppedPackets: number; budget: number; at: number; pairs: number };
type Pair = { host: string; grant: ScreenRelayGrant; ends: [End, End]; until: number };
type End = {
  allocation?: { pair: Pair; opposite: End }; user: ScreenRelayPeer; key: Buffer;
  remote?: RemoteInfo; tx?: string; until: number; permissionUntil: number; channel?: number;
};
const udpKey = (remote: RemoteInfo) => `${remote.address}:${remote.port}`;
const peer = (): ScreenRelayPeer => ({ username: randomBytes(18).toString("base64url"), credential: randomBytes(24).toString("base64url") });

export function createScreenRelayGrant(): ScreenRelayGrant { return { id: randomUUID(), sender: peer(), viewer: peer() }; }

/** One UDP listener for all authenticated tunnel hosts. TURN messages support
 * browser ICE interoperability; each grant can forward only to its paired
 * allocation on this socket. There is no destination supplied to send(). */
export class ScreenUdpRelay {
  private readonly pairs = new Map<string, Pair>();
  private readonly users = new Map<string, End>();
  private readonly remotes = new Map<string, End>();
  private readonly quotas = new Map<string, HostQuota>();
  private readonly nonceKey = randomBytes(32);
  private readonly timer: ReturnType<typeof setInterval>;
  private responseBudget = 400;
  private responseAt = Date.now();

  private constructor(private readonly socket: Socket, private readonly address: string) {
    socket.on("message", (packet, remote) => this.receive(packet, remote));
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
  }

  static async listen(bind: string, port: number, advertised: string, warning?: () => void): Promise<ScreenUdpRelay> {
    if (!isIPv4(advertised) || advertised === "0.0.0.0") throw new Error("screen_udp_advertised_ipv4_required");
    const socket = createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, bind, () => { socket.off("error", reject); socket.on("error", () => warning?.()); resolve(); });
    }).catch(error => { socket.close(); throw error; });
    return new ScreenUdpRelay(socket, advertised);
  }

  get port(): number { return this.socket.address().port; }

  authorize(host: string, grant: ScreenRelayGrant): ScreenRelayGrant {
    this.sweep();
    const quota = this.quotas.get(host) ?? { bytesForwarded: 0, droppedPackets: 0, budget: BURST_BYTES, at: Date.now(), pairs: 0 };
    if (this.pairs.size >= MAX_PAIRS || quota.pairs >= MAX_HOST_PAIRS || this.pairs.has(grant.id)
      || grant.sender.username === grant.viewer.username || this.users.has(grant.sender.username) || this.users.has(grant.viewer.username)) throw new Error("screen_udp_grant_limit");
    const makeEnd = (user: ScreenRelayPeer): End => ({
      user, key: createHash("md5").update(`${user.username}:${REALM}:${user.credential}`).digest(), until: 0, permissionUntil: 0,
    });
    const ends: [End, End] = [makeEnd(grant.sender), makeEnd(grant.viewer)];
    const pair: Pair = { host, grant, ends, until: Date.now() + GRANT_MS };
    ends[0].allocation = { pair, opposite: ends[1] };
    ends[1].allocation = { pair, opposite: ends[0] };
    this.pairs.set(grant.id, pair);
    for (const end of ends) this.users.set(end.user.username, end);
    quota.pairs++;
    this.quotas.set(host, quota);
    return grant;
  }

  keep(host: string, id: string): void {
    const pair = this.pairs.get(id);
    if (pair?.host === host && pair.until > Date.now()) pair.until = Date.now() + GRANT_MS;
  }

  revoke(host: string, id: string): void {
    const pair = this.pairs.get(id);
    if (pair?.host !== host) return;
    this.pairs.delete(id);
    for (const end of pair.ends) {
      this.users.delete(end.user.username);
      this.removeAllocation(end);
    }
    this.quotas.get(host)!.pairs--;
  }

  disconnect(host: string): void {
    for (const pair of this.pairs.values()) if (pair.host === host) this.revoke(host, pair.grant.id);
  }

  usage(host: string) {
    const quota = this.quotas.get(host);
    return quota && { bytesForwarded: quota.bytesForwarded, droppedPackets: quota.droppedPackets, pairs: quota.pairs };
  }

  close(): void {
    clearInterval(this.timer);
    this.socket.close();
  }

  private removeAllocation(end: End): void {
    if (end.remote) this.remotes.delete(udpKey(end.remote));
    end.remote = undefined;
    end.tx = undefined;
    end.until = 0;
    end.permissionUntil = 0;
    end.channel = undefined;
  }

  private sweep(): void {
    const now = Date.now();
    for (const pair of this.pairs.values()) {
      if (pair.until <= now) this.revoke(pair.host, pair.grant.id);
      else for (const end of pair.ends) if (end.remote && end.until <= now) this.removeAllocation(end);
    }
  }

  private nonce(remote: RemoteInfo, window = Math.floor(Date.now() / 30_000)): string {
    return createHmac("sha256", this.nonceKey).update(`${udpKey(remote)}/${window}`).digest("base64url");
  }

  private send(packet: Buffer, remote: RemoteInfo): void {
    if (this.socket.getSendQueueSize() < BURST_BYTES) this.socket.send(packet, remote.port, remote.address, () => {});
  }

  private limitedReply(): boolean {
    const now = Date.now();
    this.responseBudget = Math.min(400, this.responseBudget + Math.max(0, now - this.responseAt) * .2);
    this.responseAt = now;
    if (this.responseBudget < 1) return true;
    this.responseBudget--;
    return false;
  }

  private receive(packet: Buffer, remote: RemoteInfo): void {
    if (packet.length < 4 || packet.length > MAX_PACKET) return;
    const end = this.remotes.get(udpKey(remote));
    if ((packet[0] & 0xc0) === 0x40) {
      const size = packet.readUInt16BE(2);
      if (end?.channel === packet.readUInt16BE(0) && size && size <= packet.length - 4 && packet.length - 4 - size < 4) this.forward(end, packet.subarray(4, 4 + size));
      return;
    }
    const request = decodeStun(packet);
    if (!request) return;
    if (request.type === STUN.binding) {
      // Binding is stateless and cannot relay anything. Bound responses before
      // starting any cryptographic work for clients without a grant.
      if (!this.limitedReply()) this.send(encodeStun(0x0101, request.transaction, [[STUN.mapped, encodeStunAddress(remote)]]), remote);
      return;
    }
    if (request.type === STUN.send) {
      const data = request.attributes.get(STUN.data);
      if (end && data?.length && this.isPairAddress(request)) this.forward(end, data);
      return;
    }
    if (request.type !== STUN.allocate && request.type !== STUN.refresh && request.type !== STUN.permission && request.type !== STUN.channelBind) return;
    const user = request.attributes.get(STUN.username)?.toString("ascii");
    const candidate = user && this.users.get(user);
    if (!candidate || candidate.allocation!.pair.until <= Date.now() || !request.attributes.get(STUN.realm)?.equals(REALM) || !request.authenticated(candidate.key)) {
      if (!this.limitedReply()) this.error(request, remote, 401, "Unauthorized");
      return;
    }
    const nonce = request.attributes.get(STUN.nonce)?.toString("ascii");
    const window = Math.floor(Date.now() / 30_000);
    if (nonce !== this.nonce(remote, window) && nonce !== this.nonce(remote, window - 1)) {
      if (!this.limitedReply()) this.error(request, remote, 438, "Stale Nonce", candidate.key);
      return;
    }
    this.request(request, remote, candidate, end);
  }

  private error(request: StunMessage, remote: RemoteInfo, code: number, message: string, key?: Buffer): void {
    const attrs: [number, Buffer][] = [[STUN.error, Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(message)])]];
    if (code === 401 || code === 438) attrs.push([STUN.realm, REALM], [STUN.nonce, Buffer.from(this.nonce(remote))]);
    this.send(encodeStun(request.type | 0x0110, request.transaction, attrs, key), remote);
  }

  private request(request: StunMessage, remote: RemoteInfo, end: End, current?: End): void {
    const now = Date.now(), attrs: [number, Buffer][] = [];
    if (request.type === STUN.allocate) {
      if (!request.attributes.get(STUN.transport)?.equals(Buffer.from([17, 0, 0, 0]))) return this.error(request, remote, 442, "Unsupported Transport", end.key);
      const tx = request.transaction.toString("hex");
      if (current && (current !== end || tx !== end.tx) || end.remote && current !== end) return this.error(request, remote, 437, "Allocation Mismatch", end.key);
      const address = encodeStunAddress({ address: this.address, port: this.port });
      attrs.push([STUN.relayed, address], [STUN.mapped, encodeStunAddress(remote)], [STUN.lifetime, stunNumber(ALLOCATION_MS / 1000)]);
      end.remote = remote; end.tx = tx; end.until = now + ALLOCATION_MS;
      this.remotes.set(udpKey(remote), end);
    } else {
      if (current !== end || end.until <= now) return this.error(request, remote, 437, "Allocation Mismatch", end.key);
      if (request.type === STUN.refresh) {
        const lifetime = request.attributes.get(STUN.lifetime);
        if (lifetime?.length === 4 && lifetime.readUInt32BE() === 0) {
          this.removeAllocation(end);
          attrs.push([STUN.lifetime, stunNumber(0)]);
        } else {
          end.until = now + ALLOCATION_MS;
          attrs.push([STUN.lifetime, stunNumber(ALLOCATION_MS / 1000)]);
        }
      } else {
        if (!this.isPairAddress(request)) return this.error(request, remote, 403, "Forbidden Peer", end.key);
        if (request.type === STUN.channelBind) {
          const value = request.attributes.get(STUN.channel);
          const channel = value?.length === 4 ? value.readUInt16BE() : 0;
          if (channel < 0x4000 || channel > 0x4fff || end.channel && end.channel !== channel) return this.error(request, remote, 400, "Invalid Channel", end.key);
          end.channel = channel;
        }
        end.permissionUntil = now + 300_000;
      }
    }
    this.send(encodeStun(request.type | 0x0100, request.transaction, attrs, end.key), remote);
  }

  private isPairAddress(request: StunMessage): boolean {
    const address = decodeStunAddress(request.attributes.get(STUN.peer));
    return address?.address === this.address && address.port === this.port;
  }

  private forward(from: End, bytes: Buffer): void {
    const now = Date.now(), { pair, opposite: to } = from.allocation!;
    if (!to.remote || pair.until <= now || to.until <= now || from.until <= now || from.permissionUntil <= now || to.permissionUntil <= now) return;
    const quota = this.quotas.get(pair.host)!;
    quota.budget = Math.min(BURST_BYTES, quota.budget + Math.max(0, now - quota.at) * BYTES_PER_MS);
    quota.at = now;
    if (quota.budget < bytes.length) { quota.droppedPackets++; return; }
    let wire: Buffer;
    if (to.channel) {
      const header = Buffer.alloc(4);
      header.writeUInt16BE(to.channel); header.writeUInt16BE(bytes.length, 2);
      wire = Buffer.concat([header, bytes]);
    } else {
      wire = encodeStun(STUN.dataIndication, randomBytes(12), [[STUN.peer, encodeStunAddress({ address: this.address, port: this.port })], [STUN.data, bytes]]);
    }
    quota.budget -= bytes.length;
    quota.bytesForwarded += bytes.length;
    this.send(wire, to.remote);
  }
}
