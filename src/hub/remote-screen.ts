import { randomBytes, randomUUID } from "node:crypto";
import {
  SCREEN_FRAME_FRESH_MS, SCREEN_LEASE_MS, SCREEN_MAX_VIEWERS, SCREEN_TICKET_MS, SCREEN_SERVICE_QUALITY_FEATURE,
  screenConfigureSchema, screenConfigureText, screenDesktopSchema, screenOpenSchema, screenPolicySchema, screenViewerCommandSchema, screenStreamSchema,
  type ScreenStream, type ScreenConfigure, type ScreenDesktop, type ScreenJoin, type ScreenPolicy, type ScreenServiceCommand, type ScreenSession, type ScreenStatus,
} from "../client-protocol/remote-screen.js";
import type { DeviceActionProof } from "../client-protocol/device-actions.js";
import { hashSecret, type AuthSession, type HubAuth } from "./auth.js";
import { HubError, type HubStore } from "./store.js";
import type { ScreenFrameHeader } from "../client-protocol/screen-wire.js";
import { screenQualityProfile, type ScreenQuality } from "../client-protocol/screen-quality.js";

const POLICY_KEY = "remote-screen:policy:v1", LAST_COMMAND_KEY = "remote-screen:command:v1";
const secret = () => randomBytes(32).toString("base64url");
const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export type ScreenControlSink = { send(value: unknown): boolean; close(reason: string): void };
export type ScreenMediaSink = { send(bytes: Uint8Array): boolean; configure(stream: ScreenStream): boolean; close(reason: string): void };
type Lease = { id: string; expiresAt: number; ready: boolean; sequence: number; heldKeys: Set<string>; heldButtons: Set<number>; challenge: { nonce: string; validUntil: number; leaseUntil: number } };
type Frame = { key: boolean; captureMs: number; confirmed: boolean; streamGeneration: number; pendingAck: boolean };
type Live = { value: ScreenSession; auth: AuthSession; publicKey: string; control?: ScreenControlSink; media?: ScreenMediaSink; frames: Map<number, Frame>; lastFrame: number; lastKeyRequest: number; visible: boolean; started: boolean; lease?: Lease; codecs: ("h264" | "vp8")[]; quality?: ScreenQuality; streamGeneration: number; stream?: ScreenStream; awaitingKey: boolean; pendingControl?: number; lastCapture: number; rateAt: number; rateBudget: number };
type Ticket = { kind: "service" | "target-media" | "control" | "media"; id: string; expiresAt: number; epoch?: string };

/** Identity/policy stays in the Host. Frames and ephemeral input never enter
 * the message store, Bot queues, durable outbox or journal. */
export class HubRemoteScreen {
  private policy?: ScreenPolicy;
  private loading?: Promise<ScreenPolicy>;
  private desktop?: ScreenDesktop;
  private service?: ScreenControlSink;
  private serviceEpoch = "";
  private serviceSeen = 0;
  /** Optional protocol features the registered target advertised in its hello. */
  private serviceFeatures = new Set<string>();
  private sessions = new Map<string, Live>();
  private tickets = new Map<string, Ticket>();
  private requests = new Map<string, { body: string; join: ScreenJoin }>();
  private unlisten: () => void;
  private disposed = false;
  private clockWall: number; private clockMono: number;
  constructor(readonly store: HubStore, readonly auth: HubAuth, private now = Date.now, private monotonic = () => performance.now()) {
    this.clockWall = now(); this.clockMono = monotonic();
    this.unlisten = auth.onRevoke(device => { for (const live of [...this.sessions.values()]) if (live.auth.deviceId === device) this.closeSession(live.value.id, "device_revoked"); });
  }
  private async readPolicy(): Promise<ScreenPolicy> {
    if (this.policy) return this.policy;
    this.loading ??= this.store.db.serial(async () => {
      const row = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [POLICY_KEY]);
      try { return this.policy = row ? screenPolicySchema.parse(JSON.parse(row.value)) : { revision: 0, enabled: false, grants: [] }; }
      catch { throw new HubError("screen_policy_invalid", 503); }
    }).finally(() => { this.loading = undefined; });
    return this.loading;
  }
  private async principal(session: AuthSession, local = false) {
    return this.store.db.serial(async () => {
      const device = await this.auth.validateSessionInTransaction(session);
      const canManage = (await this.auth.localDesktopControllersInTransaction()).has(device.id);
      if (local && !canManage) throw new HubError("local_controller_required", 403);
      return { device, canManage };
    });
  }
  async status(session: AuthSession): Promise<ScreenStatus> {
    await this.readPolicy(); const { device, canManage } = await this.principal(session), policy = this.policy!;
    const devices = canManage ? await this.store.db.serial(() => this.store.db.all<{ id: string; name: string; platform: string; publicKey: string }>("SELECT id,name,platform,public_key AS publicKey FROM devices WHERE revoked=0 ORDER BY created_at LIMIT 256")) : undefined;
    const permission = policy.grants.find(g => g.deviceId === device.id && g.publicKey === device.public_key)?.permission ?? "none";
    return { supported: true, enabled: policy.enabled, canManage, permission,
      ...(canManage ? { policy: structuredClone(policy), devices } : {}),
      desktop: (canManage || policy.enabled && permission !== "none") && this.desktop ? structuredClone(this.desktop) : null,
      sessions: [...this.sessions.values()].filter(s => canManage || s.auth.deviceId === device.id).map(s => structuredClone(s.value)), serverTime: this.now() };
  }
  async configure(session: AuthSession, raw: unknown, proof: DeviceActionProof): Promise<ScreenPolicy> {
    const command = screenConfigureSchema.parse(raw), digest = hashSecret(screenConfigureText(command));
    await this.readPolicy();
    const policy = await this.store.db.transaction(async () => {
      await this.auth.validateSessionInTransaction(session); await this.store.requireOwner(session.userId);
      if (!(await this.auth.localDesktopControllersInTransaction()).has(session.deviceId)) throw new HubError("local_controller_required", 403);
      const stored = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [POLICY_KEY]);
      const current = stored ? screenPolicySchema.parse(JSON.parse(stored.value)) : { revision: 0, enabled: false, grants: [] };
      const previous = await this.store.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [LAST_COMMAND_KEY]);
      const receipt = previous ? JSON.parse(previous.value) : undefined;
      if (receipt?.deviceId === session.deviceId && receipt?.requestId === command.requestId) {
        if (receipt.digest !== digest) throw new HubError("screen_request_conflict", 409);
        return current;
      }
      await this.auth.consumeScreenGrant(session, digest, proof);
      if (command.expectedRevision !== current.revision) throw new HubError("screen_policy_changed", 409);
      const grants: ScreenPolicy["grants"] = [];
      for (const grant of command.grants) {
        const device = await this.store.db.get<{ public_key: string; revoked: number }>("SELECT public_key,revoked FROM devices WHERE id=?", [grant.deviceId]);
        if (!device || device.revoked || device.public_key !== grant.publicKey) {
          // App/CLI carry the current policy forward. Retire an unchanged stale
          // grant so unpairing cannot lock even Disable; never accept a new or
          // modified grant for an invalid identity, or transfer it to a new key.
          if (current.grants.some(saved => saved.deviceId === grant.deviceId && saved.publicKey === grant.publicKey && saved.permission === grant.permission)) continue;
          throw new HubError("screen_device_changed", 409);
        }
        grants.push(grant);
      }
      const next = screenPolicySchema.parse({ revision: command.expectedRevision + 1, enabled: command.enabled, grants });
      await this.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [POLICY_KEY, JSON.stringify(next)]);
      await this.store.db.run("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", [LAST_COMMAND_KEY, JSON.stringify({ deviceId: session.deviceId, requestId: command.requestId, digest })]);
      return next;
    });
    if (!this.policy || policy.revision > this.policy.revision) this.policy = policy;
    const effective = this.policy;
    for (const live of [...this.sessions.values()]) {
      const grant = effective.grants.find(g => g.deviceId === live.auth.deviceId && g.publicKey === live.publicKey);
      if (!effective.enabled || !grant) this.closeSession(live.value.id, "screen_permission_revoked");
      else if (grant.permission !== "control" && live.value.controlAllowed) { live.value.controlAllowed = false; this.release(live, "screen_control_revoked"); this.notify(live); }
    }
    void this.store.audit("screen.policy", session.deviceId, { revision: policy.revision, enabled: policy.enabled, grants: policy.grants.length });
    return structuredClone(policy);
  }
  /** Called exclusively by the authenticated local control socket, never HTTP. */
  serviceTicket(desktopId: string): { ticket: string; expiresAt: number } {
    if (this.disposed || !/^[A-Za-z0-9_-]{1,128}$/.test(desktopId)) throw new HubError("screen_service_unavailable", 503);
    if (this.service) throw new HubError("screen_desktop_busy", 409);
    return this.issueTicket("service", desktopId);
  }
  private issueTicket(kind: Ticket["kind"], target: string, epoch?: string) {
    this.pruneTickets();
    if (this.tickets.size >= 64) throw new HubError("screen_rate_limited", 429);
    const ticket = secret(), expiresAt = this.now() + SCREEN_TICKET_MS;
    this.tickets.set(hashSecret(ticket), { kind, id: target, expiresAt, epoch });
    return { ticket, expiresAt };
  }
  private takeTicket(raw: string, kind: Ticket["kind"]): Ticket {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new HubError("screen_ticket_invalid", 401);
    const key = hashSecret(raw), ticket = this.tickets.get(key); this.tickets.delete(key);
    if (!ticket || ticket.kind !== kind || ticket.expiresAt <= this.now() || this.disposed) throw new HubError("screen_ticket_invalid", 401);
    return ticket;
  }
  registerService(ticket: string, raw: unknown, sink: ScreenControlSink, features: readonly string[] = []): { epoch: string } {
    const desktop = screenDesktopSchema.parse(raw), claim = this.takeTicket(ticket, "service");
    if (claim.id !== desktop.desktopId || this.service) throw new HubError("screen_desktop_busy", 409);
    this.service = sink; this.serviceEpoch = id("desktop"); this.desktop = desktop; this.serviceSeen = this.now();
    this.serviceFeatures = new Set(features.slice(0, 16));
    return { epoch: this.serviceEpoch };
  }
  serviceMedia(ticket: string): { epoch: string; sessionId: string; generation: string } {
    const claim = this.takeTicket(ticket, "target-media"), live = this.sessions.get(claim.id);
    if (!this.service || claim.epoch !== this.serviceEpoch || !live) throw new HubError("screen_service_unavailable", 503);
    return { epoch: this.serviceEpoch, sessionId: claim.id, generation: live.value.generation };
  }
  serviceStatus(epoch: string, raw: unknown): void {
    if (!this.service || epoch !== this.serviceEpoch) throw new HubError("screen_service_retired", 409);
    const next = screenDesktopSchema.parse(raw);
    if (next.desktopId !== this.desktop!.desktopId || next.instanceId !== this.desktop!.instanceId || next.loginSession !== this.desktop!.loginSession) {
      this.serviceLost(epoch, "screen_desktop_changed"); throw new HubError("screen_desktop_changed", 409);
    }
    this.desktop = next; this.serviceSeen = this.now();
    for (const live of [...this.sessions.values()]) {
      const display = next.displays.find(d => d.id === live.value.display.id);
      if (next.locked || next.capture !== "granted") this.closeSession(live.value.id, next.locked ? "screen_locked" : "screen_capture_denied");
      else if (!display || JSON.stringify(display) !== JSON.stringify(live.value.display)) this.closeSession(live.value.id, "screen_geometry_changed");
      else if (!next.accessibility && live.lease) this.release(live, "screen_accessibility_denied");
    }
  }
  serviceLost(epoch: string, reason = "screen_service_offline"): void {
    if (epoch !== this.serviceEpoch) return;
    for (const live of [...this.sessions.values()]) this.closeSession(live.value.id, reason);
    const sink = this.service; this.service = undefined; this.desktop = undefined; this.serviceEpoch = ""; this.serviceFeatures = new Set();
    sink?.close(reason);
  }
  async open(session: AuthSession, raw: unknown): Promise<ScreenJoin> {
    const input = screenOpenSchema.parse(raw); await this.readPolicy(); const { device } = await this.principal(session);
    const grant = this.policy!.grants.find(g => g.deviceId === device.id && g.publicKey === device.public_key);
    if (!this.policy!.enabled || !grant) throw new HubError("screen_not_authorized", 403);
    const requestKey = `${session.deviceId}:${input.requestId}`, body = JSON.stringify(input), previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.body !== body) throw new HubError("screen_request_conflict", 409);
      if (!this.sessions.has(previous.join.session.id)) throw new HubError("screen_session_closed", 410);
      return structuredClone(previous.join);
    }
    if (!this.service || !this.desktop || this.desktop.desktopId !== input.desktopId) throw new HubError("screen_service_offline", 503);
    if (this.desktop.locked) throw new HubError("screen_locked", 409);
    if (this.desktop.capture !== "granted") throw new HubError("screen_capture_denied", 409);
    const display = this.desktop.displays.find(d => d.id === input.displayId && d.revision === input.displayRevision);
    if (!display) throw new HubError("screen_geometry_changed", 409);
    // An explicit quality the target cannot honour is refused, never ignored:
    // the viewer would otherwise label a default-quality picture as requested.
    // A size only H.264 can carry needs a viewer that decodes H.264.
    if (input.quality !== undefined && (!this.serviceFeatures.has(SCREEN_SERVICE_QUALITY_FEATURE) || screenQualityProfile(input.quality).h264Only && !input.codecs.includes("h264"))) throw new HubError("screen_quality_unsupported", 409);
    if (this.sessions.size >= SCREEN_MAX_VIEWERS) throw new HubError("screen_viewers_full", 409);
    const value: ScreenSession = { id: id("screen"), desktopId: input.desktopId, generation: id("generation"), display: structuredClone(display),
      deviceId: device.id, deviceName: device.name, controlAllowed: grant.permission === "control", state: "connecting", createdAt: this.now() };
    const join: ScreenJoin = { session: value, controlTicket: this.issueTicket("control", value.id).ticket, mediaTicket: this.issueTicket("media", value.id).ticket, expiresAt: this.now() + SCREEN_TICKET_MS, serverTime: this.now(),
      ...(input.quality !== undefined ? { quality: input.quality } : {}) };
    this.sessions.set(value.id, { value, auth: session, publicKey: device.public_key, frames: new Map(), lastFrame: 0, lastKeyRequest: 0, visible: true, started: false, codecs: input.codecs, quality: input.quality, streamGeneration: 1, awaitingKey: true, lastCapture: 0, rateAt: this.now(), rateBudget: 180 });
    if (this.requests.size >= 128) this.requests.delete(this.requests.keys().next().value!);
    this.requests.set(requestKey, { body, join: structuredClone(join) });
    void this.store.audit("screen.connected", session.deviceId, { sessionId: value.id, desktopId: value.desktopId, displayId: display.id, ...(input.quality !== undefined ? { quality: input.quality } : {}) });
    return structuredClone(join);
  }
  async attachViewer(ticket: string, kind: "control" | "media", sink: ScreenControlSink | ScreenMediaSink): Promise<string> {
    const claim = this.takeTicket(ticket, kind), live = this.sessions.get(claim.id);
    if (!live) throw new HubError("screen_session_closed", 410);
    await this.auth.validateSession(live.auth);
    if (this.sessions.get(claim.id) !== live) throw new HubError("screen_session_closed", 410);
    if (kind === "control") { if (live.control) throw new HubError("screen_channel_busy", 409); live.control = sink as ScreenControlSink; }
    else { if (live.media) throw new HubError("screen_channel_busy", 409); live.media = sink as ScreenMediaSink; }
    this.startVisible(live);
    this.notify(live); return claim.id;
  }
  private startVisible(live: Live): void {
    if (live.control && live.media && live.visible && !live.started) {
      live.started = true;
      // A session opened with a quality is bound to a target that advertised it.
      if (live.quality !== undefined && !this.serviceFeatures.has(SCREEN_SERVICE_QUALITY_FEATURE)) { this.closeSession(live.value.id, "screen_quality_unsupported"); throw new HubError("screen_quality_unsupported", 409); }
      const mediaTicket = this.issueTicket("target-media", live.value.id, this.serviceEpoch).ticket;
      if (!this.toService({ type: "start", session: structuredClone(live.value), mediaTicket, streamGeneration: live.streamGeneration, codecs: live.codecs, ...(live.quality !== undefined ? { quality: live.quality } : {}) })) { this.closeSession(live.value.id, "screen_service_offline"); throw new HubError("screen_service_offline", 503); }
    }
  }
  private toService(command: ScreenServiceCommand): boolean { return this.service?.send(command) ?? false; }
  private notify(live: Live): void {
    if (live.control && !live.control.send({ type: "state", session: live.value, serverTime: this.now(), controlPending: !!live.pendingControl, streamGeneration: live.streamGeneration, lease: live.lease?.ready ? { id: live.lease.id, expiresAt: live.lease.expiresAt, challenge: live.lease.challenge.nonce, challengeExpiresAt: live.lease.challenge.validUntil } : undefined })) this.closeSession(live.value.id, "screen_control_backpressure");
  }
  private fresh(live: Live, sequence: number): boolean { const frame = live.frames.get(sequence); return !!frame?.confirmed && this.now() - frame.captureMs <= SCREEN_FRAME_FRESH_MS && frame.streamGeneration === live.streamGeneration; }
  private resetStream(live: Live): void {
    this.release(live, "screen_stream_changed");
    if (live.streamGeneration >= 0xffffffff) { this.closeSession(live.value.id, "screen_generation_exhausted"); return; }
    live.streamGeneration++; live.stream = undefined; live.awaitingKey = true; live.frames.clear();
    live.value.state = live.visible ? "connecting" : "paused";
  }
  /** Config and frames share one ordered socket. Old generations are retired in
   * their entirety; no decoder is allowed to resume an old reference chain. */
  stream(epoch: string, sessionId: string, generation: string, raw: unknown): boolean {
    const live = this.sessions.get(sessionId), stream = screenStreamSchema.parse(raw);
    if (epoch !== this.serviceEpoch || !live?.started || live.value.generation !== generation) return false;
    if (stream.streamGeneration < live.streamGeneration) return true;
    // The session's quality bounds what the target may send: a legacy or
    // balanced session never exceeds the pre-quality 1920 / 1920×1080 contract
    // (older viewers refuse more), and a target cannot exceed what was asked.
    const d = live.value.display, cap = screenQualityProfile(live.quality);
    if (!live.visible || stream.streamGeneration !== live.streamGeneration || stream.geometryRevision !== d.revision || live.stream || !live.codecs.includes(stream.codec)
      || Math.abs(stream.width / stream.height - d.width / d.height) > .02
      || Math.max(stream.width, stream.height) > cap.longEdge || stream.width * stream.height > cap.area || cap.h264Only && stream.codec !== "h264") {
      this.closeSession(sessionId, "screen_stream_invalid"); return false;
    }
    live.stream = stream;
    if (!live.media?.configure(stream)) { this.closeSession(sessionId, "screen_congested"); return false; }
    return true;
  }
  /** Only call after validating the binary frame header. Never persist bytes. */
  frame(epoch: string, sessionId: string, generation: string, header: ScreenFrameHeader, bytes: Uint8Array): boolean {
    const live = this.sessions.get(sessionId);
    if (!this.service || epoch !== this.serviceEpoch || !live?.started || live.value.generation !== generation) return false;
    if (header.streamGeneration < live.streamGeneration) return true; // Entire retired generation, including its decoder, was discarded.
    const stream = live.stream;
    if (!live.visible || !stream || header.sequence <= live.lastFrame || header.geometryRevision !== live.value.display.revision || header.captureMs > this.now() + 250
      || header.captureMs < live.lastCapture || this.now() - header.captureMs > SCREEN_FRAME_FRESH_MS || header.streamGeneration !== live.streamGeneration
      || live.awaitingKey && !header.key || header.codec !== stream.codec || header.width !== stream.width || header.height !== stream.height) {
      this.closeSession(sessionId, "screen_frame_invalid_or_stale"); return false;
    }
    live.awaitingKey = false; live.lastFrame = header.sequence; live.lastCapture = header.captureMs;
    if (!live.media?.send(bytes)) { this.closeSession(sessionId, "screen_congested"); return false; }
    live.frames.set(header.sequence, { key: header.key, captureMs: header.captureMs, streamGeneration: header.streamGeneration, confirmed: false, pendingAck: false });
    for (const [seq, frame] of live.frames) if (this.now() - frame.captureMs > SCREEN_FRAME_FRESH_MS || live.frames.size > 90) live.frames.delete(seq);
    if (live.value.state === "connecting") { live.value.state = "viewing"; this.notify(live); }
    return true;
  }
  viewerCommand(sessionId: string, raw: unknown): void {
    const input = screenViewerCommandSchema.parse(raw), live = this.sessions.get(sessionId);
    if (!live || input.sessionId !== sessionId || input.generation !== live.value.generation) throw new HubError("screen_session_changed", 409);
    if (input.type === "disconnect") { this.closeSession(sessionId, "screen_disconnected"); return; }
    if (input.type === "release") { this.release(live, "screen_control_stopped"); return; }
    live.rateBudget = Math.min(180, live.rateBudget + Math.max(0, this.now() - live.rateAt) * .12); live.rateAt = this.now();
    if (live.rateBudget < 1) { this.closeSession(sessionId, "screen_input_rate_limited"); throw new HubError("screen_input_rate_limited", 429); } live.rateBudget--;
    if (input.type === "visibility") {
      if (live.visible === input.visible) return;
      live.visible = input.visible;
      if (!input.visible) this.resetStream(live);
      live.value.state = input.visible ? "connecting" : "paused";
      if (!live.started) this.startVisible(live);
      else if (!this.toService({ type: "pause", sessionId, paused: !input.visible, streamGeneration: live.streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
      this.notify(live); return;
    }
    if (input.type === "keyframe") {
      if (live.visible && this.now() - live.lastKeyRequest >= 500) {
        live.lastKeyRequest = this.now(); this.resetStream(live);
        if (!this.toService({ type: "reset", sessionId, streamGeneration: live.streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
        this.notify(live);
      } return;
    }
    if (input.type === "ack") {
      const frame = live.frames.get(input.frameSequence);
      // Decoder receipt returns a bounded encoder credit even after a slow
      // round trip. Input freshness is still checked by the target and below
      // in serviceFrameConfirmed; a late ACK never makes old video controllable.
      if (!live.visible || !frame || frame.pendingAck || frame.streamGeneration !== live.streamGeneration) return;
      frame.pendingAck = true;
      if (!this.toService({ type: "ack", sessionId, frameSequence: input.frameSequence, streamGeneration: frame.streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
      return;
    }
    if (input.type === "input" && (input.event.kind === "key" || input.event.kind === "button") && !input.event.down) {
      // Release only something forwarded under this STILL VALID lease. A stale
      // picture/geometry must not trap a held input, but cannot revive a lease.
      const lease = live.lease, held = input.event.kind === "key" ? lease?.heldKeys.has(input.event.code) : lease?.heldButtons.has(input.event.button);
      if (live.visible && live.value.controlAllowed && this.desktop?.accessibility && !this.desktop.locked
        && lease?.ready && lease.id === input.leaseId && lease.expiresAt > this.now() && input.desktopId === live.value.desktopId
        && input.sequence > lease.sequence && held) {
        lease.sequence = input.sequence;
        if (input.event.kind === "key") lease.heldKeys.delete(input.event.code); else lease.heldButtons.delete(input.event.button);
        if (!this.toService(input)) this.release(live, "screen_service_offline");
        return;
      }
    }
    if (!live.visible || !this.fresh(live, input.frameSequence)) { this.release(live, "screen_frame_stale"); throw new HubError("screen_frame_stale", 409); }
    if (!live.value.controlAllowed || !this.desktop?.accessibility || this.desktop.locked) {
      const reason = !live.value.controlAllowed ? "screen_control_not_authorized" : this.desktop?.locked ? "screen_locked" : "screen_accessibility_denied";
      this.release(live, reason);
      // The viewing grant can remain valid when a control grant is withdrawn.
      // Report the refusal even if the downgrade already released the lease.
      live.value.reason = reason; this.notify(live);
      throw new HubError(reason, 403);
    }
    if (input.type === "control") {
      if ([...this.sessions.values()].some(s => s.lease || s.pendingControl)) { live.value.reason = "screen_control_busy"; this.notify(live); return; }
      this.resetStream(live); live.value.reason = undefined; live.pendingControl = this.now() + 3000;
      if (!this.toService({ type: "reset", sessionId, streamGeneration: live.streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
      this.notify(live); return;
    }
    if (!live.lease || live.lease.id !== input.leaseId || !live.lease.ready || live.lease.expiresAt <= this.now()) { this.release(live, "screen_lease_expired"); throw new HubError("screen_lease_expired", 409); }
    if (input.type === "renew") {
      const challenge = live.lease.challenge;
      if (challenge.nonce !== input.challenge || challenge.validUntil <= this.now()) { this.release(live, "screen_renew_expired"); throw new HubError("screen_renew_expired", 409); }
      // Fixed at issue time, never arrival + TTL for an old queued renewal.
      live.lease.expiresAt = challenge.leaseUntil;
      live.lease.challenge = this.renewChallenge();
      if (!this.toService({ type: "lease", sessionId, generation: live.value.generation, leaseId: live.lease.id, expiresAt: live.lease.expiresAt,
        frameSequence: input.frameSequence, streamGeneration: live.streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
      this.notify(live); return;
    }
    const v = live.value;
    if (input.desktopId !== v.desktopId || input.displayId !== v.display.id || input.displayRevision !== v.display.revision || input.sequence <= live.lease.sequence
      || input.expiresAt !== live.frames.get(input.frameSequence)!.captureMs + SCREEN_FRAME_FRESH_MS || input.expiresAt <= this.now()) {
      this.release(live, "screen_input_stale"); throw new HubError("screen_input_stale", 409);
    }
    live.lease.sequence = input.sequence;
    if (!this.toService(input)) { this.release(live, "screen_service_offline"); return; }
    if (input.event.kind === "key" && input.event.down) live.lease.heldKeys.add(input.event.code);
    if (input.event.kind === "button" && input.event.down) live.lease.heldButtons.add(input.event.button);
  }
  /** Target confirms this decoder ACK against its actual capture sequence and
   * capture clock. No freshness decision uses a controlling device's clock. */
  serviceFrameConfirmed(epoch: string, sessionId: string, sequence: number, captureMs: number, streamGeneration: number): void {
    const live = this.sessions.get(sessionId), frame = live?.frames.get(sequence);
    if (epoch !== this.serviceEpoch || !live?.visible || !frame?.pendingAck || frame.confirmed || streamGeneration !== live.streamGeneration || frame.captureMs !== captureMs || this.now() - captureMs > SCREEN_FRAME_FRESH_MS || frame.streamGeneration !== live.streamGeneration) return;
    frame.confirmed = true;
    if (!live.control?.send({ type: "frame-ready", sessionId, generation: live.value.generation, streamGeneration, frameSequence: sequence, expiresAt: captureMs + SCREEN_FRAME_FRESH_MS })) { this.closeSession(sessionId, "screen_control_backpressure"); return; }
    if (live.pendingControl && frame.key && live.pendingControl > this.now() && live.value.controlAllowed && this.desktop?.accessibility && !this.desktop.locked) {
      live.pendingControl = undefined;
      live.lease = { id: secret(), expiresAt: this.now() + SCREEN_LEASE_MS, sequence: 0, heldKeys: new Set(), heldButtons: new Set(), ready: false, challenge: this.renewChallenge() };
      if (!this.toService({ type: "lease", sessionId, generation: live.value.generation, leaseId: live.lease.id, expiresAt: live.lease.expiresAt, frameSequence: sequence, streamGeneration })) this.closeSession(sessionId, "screen_service_offline");
    }
  }
  serviceLeaseReady(epoch: string, sessionId: string, leaseId: string): void {
    const live = this.sessions.get(sessionId);
    if (epoch !== this.serviceEpoch || !live?.lease || live.lease.id !== leaseId || live.lease.expiresAt <= this.now()) return;
    live.lease.ready = true; live.value.reason = undefined; live.value.state = "controlling"; this.notify(live);
  }
  serviceLeaseDenied(epoch: string, sessionId: string, leaseId: string, reason: string): void {
    const live = this.sessions.get(sessionId);
    if (epoch !== this.serviceEpoch || !live?.lease || live.lease.id !== leaseId) return;
    this.release(live, reason);
  }
  serviceStop(epoch: string, sessionId?: string, reason = "screen_local_takeover"): void {
    if (epoch !== this.serviceEpoch) return;
    for (const live of [...this.sessions.values()]) if (!sessionId || live.value.id === sessionId) this.closeSession(live.value.id, reason);
  }
  private renewChallenge() { const now = this.now(); return { nonce: secret(), validUntil: now + 3000, leaseUntil: now + SCREEN_LEASE_MS }; }
  private release(live: Live, reason: string): void {
    const pending = live.pendingControl; live.pendingControl = undefined;
    if (!live.lease && !pending) return;
    live.value.reason = reason === "screen_control_stopped" || reason === "screen_stream_changed" ? undefined : reason;
    if (!live.lease) { this.notify(live); return; }
    live.lease = undefined;
    this.toService({ type: "release", sessionId: live.value.id, reason });
    if (live.value.state === "controlling") live.value.state = live.visible ? "viewing" : "paused";
    this.notify(live);
  }
  closeSession(sessionId: string, reason: string): void {
    const live = this.sessions.get(sessionId); if (!live) return;
    this.sessions.delete(sessionId); this.release(live, reason);
    this.toService({ type: "stop", sessionId, reason });
    live.value.state = "closed"; live.value.reason = reason;
    live.control?.send({ type: "state", session: live.value, serverTime: this.now() });
    live.control?.close(reason); live.media?.close(reason); live.frames.clear();
    for (const [key, ticket] of this.tickets) if (ticket.id === sessionId) this.tickets.delete(key);
    void this.store.audit("screen.disconnected", live.auth.deviceId, { sessionId, reason });
  }
  async stop(session: AuthSession, sessionId?: string): Promise<void> {
    const { canManage } = await this.principal(session);
    if (!sessionId && !canManage) throw new HubError("local_controller_required", 403);
    const selected = sessionId ? [this.sessions.get(sessionId)].filter((v): v is Live => !!v) : [...this.sessions.values()];
    for (const live of selected) if (!canManage && live.auth.deviceId !== session.deviceId) throw new HubError("screen_not_authorized", 403);
    for (const live of selected) this.closeSession(live.value.id, "screen_stopped");
  }
  tick(): void {
    const now = this.now(), mono = this.monotonic(); this.pruneTickets();
    const clockChanged = now - this.clockWall > 6000 || Math.abs((now - this.clockWall) - (mono - this.clockMono)) > 1000;
    this.clockWall = now; this.clockMono = mono;
    if (clockChanged && this.service) { this.serviceLost(this.serviceEpoch, "screen_clock_or_sleep_changed"); return; }
    if (this.service && now - this.serviceSeen > 5000) { this.serviceLost(this.serviceEpoch, "screen_service_timeout"); return; }
    for (const live of [...this.sessions.values()]) {
      if (live.auth.expiresAt <= now) this.closeSession(live.value.id, "session_expired");
      else if ((!live.control || !live.media) && now - live.value.createdAt > SCREEN_TICKET_MS) this.closeSession(live.value.id, "screen_connect_timeout");
      else if (live.pendingControl && live.pendingControl <= now) this.release(live, "screen_control_timeout");
      else if (live.lease && (live.lease.expiresAt <= now || ![...live.frames.values()].some(f => f.confirmed && now - f.captureMs <= SCREEN_FRAME_FRESH_MS))) this.release(live, "screen_frame_or_lease_expired");
    }
  }
  async sweep(): Promise<void> {
    for (const live of [...this.sessions.values()]) {
      try { if ((await this.auth.validateSession(live.auth)).public_key !== live.publicKey) throw new Error("device_key_changed"); }
      catch { this.closeSession(live.value.id, "device_revoked_or_expired"); }
    }
  }
  private pruneTickets(): void { for (const [key, value] of this.tickets) if (value.expiresAt <= this.now()) this.tickets.delete(key); }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.unlisten(); this.serviceLost(this.serviceEpoch, "screen_host_stopped"); this.tickets.clear(); this.requests.clear(); }
}
