import { SCREEN_MAC_KEYCODES, SCREEN_MODIFIERS, screenIsModifier, screenKeyExtraFlags, screenWheelToMac } from '../../src/client-protocol/screen-keys.ts';
import { toGlobalPoint } from './screen-geometry.mjs';

export const SCREEN_LEASE_MAX_MS = 6000;
export const SCREEN_FRAME_FRESH_MS = 2000;
const BUTTONS = { 0: 'left', 1: 'other', 2: 'right' };

/** One controller lease at a time. Every input is re-authorized here against
 * the lease, a target-confirmed fresh frame, current geometry and permissions.
 * Releases (key/button up of something this lease pressed) bypass freshness
 * and geometry: refusing an up would leave a key stuck on the Mac.
 * Native posting is injected; tests never reach the OS. */
export class ScreenInput {
  #lease; #timer; #keys = new Map(); #buttons = new Map(); #point; #pointAt = 0; #sequence = 0;
  constructor({ native, geometry, frames, ready, monotonic = () => performance.now(), wall = Date.now, onReleased = () => {} }) {
    Object.assign(this, { native, geometry, frames, ready, monotonic, wall, onReleased });
  }
  get lease() { return this.#lease && { ...this.#lease }; }
  /** Last remote pointer position and when it was posted (local-takeover check). */
  get pointer() { return this.#lease && this.#point ? { ...this.#point, at: this.#pointAt } : undefined; }

  /** Host-issued lease (or renewal of the same id). On refusal returns a
   * `lease-denied` reason: screen_frame_stale | screen_lease_invalid |
   * screen_input_denied | screen_geometry_changed | screen_locked. */
  grant(lease) {
    const blocked = this.ready();
    if (blocked) return { ok: false, reason: blocked };
    const frame = this.frames(lease.sessionId, lease.frameSequence, lease.streamGeneration);
    if (!frame || !this.#fresh(frame)) return { ok: false, reason: 'screen_frame_stale' };
    const display = this.geometry.find(frame.displayId);
    if (!display || display.revision !== frame.geometryRevision) return { ok: false, reason: 'screen_geometry_changed' };
    const remaining = Math.min(SCREEN_LEASE_MAX_MS, lease.expiresAt - this.wall());
    if (!(remaining > 0)) return { ok: false, reason: 'screen_lease_invalid' };
    const current = this.#lease;
    if (current && (current.sessionId !== lease.sessionId || current.leaseId !== lease.leaseId || current.generation !== lease.generation)) this.release('screen_lease_invalid');
    const renewal = this.#lease?.leaseId === lease.leaseId;
    // Renewal keeps the dedup sequence and pressed state; a new lease starts clean.
    if (!renewal) { this.#sequence = 0; this.#keys.clear(); this.#buttons.clear(); }
    this.#lease = { sessionId: lease.sessionId, generation: lease.generation, leaseId: lease.leaseId, expiresAt: lease.expiresAt, deadline: this.monotonic() + remaining };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.release('screen_lease_invalid'), remaining + 5);
    this.#timer.unref?.();
    return { ok: true };
  }

  /** Validates and posts one input. Returns a bounded reason code on refusal. */
  apply(input) {
    const lease = this.#lease;
    if (!lease || input.sessionId !== lease.sessionId || input.generation !== lease.generation || input.leaseId !== lease.leaseId) return 'screen_lease_mismatch';
    if (this.monotonic() > lease.deadline || this.wall() > lease.expiresAt) { this.release('screen_lease_invalid'); return 'screen_lease_invalid'; }
    if (input.sequence <= this.#sequence) return 'screen_input_replayed';
    this.#sequence = input.sequence;
    const { event } = input;
    if (this.#releasing(event)) return this.#post(() => this.#release(event)) ?? null;
    const blocked = this.ready();
    if (blocked) { this.release(blocked); return blocked; }
    const frame = this.frames(input.sessionId, input.frameSequence);
    if (!frame || input.expiresAt !== frame.captureMs + SCREEN_FRAME_FRESH_MS || !this.#fresh(frame)) return 'screen_frame_stale';
    if (input.displayId !== frame.displayId || input.displayRevision !== frame.geometryRevision) return 'screen_geometry_changed';
    const display = this.geometry.find(input.displayId);
    if (!display || display.revision !== input.displayRevision) { this.release('screen_geometry_changed'); return 'screen_geometry_changed'; }
    return this.#post(() => this.#press(event, display)) ?? null;
  }

  #fresh(frame) { return this.wall() <= frame.captureMs + SCREEN_FRAME_FRESH_MS && this.monotonic() <= frame.receivedMono + SCREEN_FRAME_FRESH_MS; }
  #releasing(event) {
    return event.kind === 'key' && !event.down && this.#keys.has(event.code)
      || event.kind === 'button' && !event.down && this.#buttons.has(event.button);
  }
  #post(action) {
    try { action(); return undefined; }
    catch { this.release('screen_input_denied'); return 'screen_input_denied'; }
  }
  #flags() {
    let flags = 0;
    for (const code of this.#keys.keys()) if (screenIsModifier(code)) flags |= SCREEN_MODIFIERS[code].flag | SCREEN_MODIFIERS[code].device;
    return flags;
  }
  #press(event, display) {
    if (['move', 'button', 'wheel'].includes(event.kind)) this.#pointAt = this.monotonic();
    switch (event.kind) {
      case 'move': {
        this.#point = toGlobalPoint(display, event.x, event.y);
        const held = [...this.#buttons.keys()][0];
        this.native.mouse(held === undefined ? 'move' : 'drag', BUTTONS[held] ?? 'left', this.#point.x, this.#point.y, 1, this.#flags());
        return;
      }
      case 'button': {
        this.#point = toGlobalPoint(display, event.x, event.y);
        if (!event.down) return; // an up for a button this lease never pressed
        this.#buttons.set(event.button, event.clicks);
        this.native.mouse('down', BUTTONS[event.button], this.#point.x, this.#point.y, event.clicks, this.#flags());
        return;
      }
      case 'wheel': {
        this.#point = toGlobalPoint(display, event.x, event.y);
        const { wheel1, wheel2 } = screenWheelToMac(event.dx, event.dy);
        if (wheel1 || wheel2) this.native.scroll(this.#point.x, this.#point.y, wheel1, wheel2, this.#flags());
        return;
      }
      case 'key': {
        const keycode = SCREEN_MAC_KEYCODES[event.code];
        if (keycode === undefined || !event.down) return;
        const repeat = this.#keys.has(event.code);
        this.#keys.set(event.code, keycode);
        if (screenIsModifier(event.code)) { if (!repeat) this.native.key(keycode, true, this.#flags(), { modifier: true, repeat: false }); return; }
        this.native.key(keycode, true, this.#flags() | screenKeyExtraFlags(event.code), { modifier: false, repeat });
        return;
      }
      case 'text': {
        // Committed IME/explicit text is typed as Unicode, never via the clipboard,
        // and never combined with held shortcut modifiers.
        if ([...this.#keys.keys()].some(code => screenIsModifier(code) && !code.startsWith('Shift'))) throw new Error('screen_text_with_modifiers');
        this.native.text(event.text);
        return;
      }
      default: throw new Error('screen_input_unknown');
    }
  }
  #release(event) {
    if (event.kind === 'button') {
      const clicks = this.#buttons.get(event.button); this.#buttons.delete(event.button);
      const point = this.#point ?? this.native.location();
      this.native.mouse('up', BUTTONS[event.button], point.x, point.y, clicks, this.#flags());
      return;
    }
    const keycode = this.#keys.get(event.code); this.#keys.delete(event.code);
    if (screenIsModifier(event.code)) this.native.key(keycode, false, this.#flags(), { modifier: true, repeat: false });
    else this.native.key(keycode, false, this.#flags() | screenKeyExtraFlags(event.code), { modifier: false, repeat: false });
  }

  /** Releases everything this lease pressed, then forgets the lease. Never
   * waits for the controller: called on expiry, stop, lock, takeover, failure. */
  release(reason = 'screen_released') {
    clearTimeout(this.#timer); this.#timer = undefined;
    const lease = this.#lease; this.#lease = undefined;
    const keys = [...this.#keys.entries()].reverse(), buttons = [...this.#buttons.entries()];
    this.#keys.clear(); this.#buttons.clear();
    const errors = [];
    const attempt = fn => { try { fn(); } catch (error) { errors.push(error); } };
    for (const [code, keycode] of keys.filter(([code]) => !screenIsModifier(code))) attempt(() => this.native.key(keycode, false, 0, { modifier: false, repeat: false }));
    for (const [, keycode] of keys.filter(([code]) => screenIsModifier(code))) attempt(() => this.native.key(keycode, false, 0, { modifier: true, repeat: false }));
    if (buttons.length) {
      let point = this.#point; if (!point) attempt(() => { point = this.native.location(); });
      for (const [button, clicks] of buttons) if (point) attempt(() => this.native.mouse('up', BUTTONS[button], point.x, point.y, clicks, 0));
    }
    // The native layer also tracks what it posted and clears it independently.
    attempt(() => this.native.releaseAll());
    this.#point = undefined;
    if (lease) this.onReleased(lease, reason);
    return errors.length === 0;
  }
}
