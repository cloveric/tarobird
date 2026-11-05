/** Long press on a QR image: fires once after `delay` while the same primary
 * touch stays within `slop` pixels and the image does not scroll. Any movement,
 * scroll, release, cancel, blur or hidden page cancels it. Pure apart from the
 * injected timer, so the gesture rules are testable without a browser. */
export type HoldPoint = { x: number; y: number };
export type HoldTimers = { set: (run: () => void, delay: number) => unknown; clear: (handle: unknown) => void };
export class HoldTracker {
  private pending?: { pointer: number; x: number; y: number; top: number; timer: unknown };
  constructor(private hold: (point: HoldPoint) => void, private timers: HoldTimers = { set: (run, delay) => setTimeout(run, delay), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) }, private delay = 500, private slop = 10) {}
  get active(): boolean { return !!this.pending; }
  down(pointer: number, point: HoldPoint, top: number): void {
    this.cancel();
    const pending = { pointer, x: point.x, y: point.y, top, timer: undefined as unknown };
    pending.timer = this.timers.set(() => { if (this.pending !== pending) return; this.pending = undefined; this.hold({ x: pending.x, y: pending.y }); }, this.delay);
    this.pending = pending;
  }
  move(pointer: number, point: HoldPoint): void {
    if (this.pending?.pointer === pointer && Math.hypot(point.x - this.pending.x, point.y - this.pending.y) > this.slop) this.cancel();
  }
  /** The image's current top; a scrolling sheet moves it under a still finger. */
  scroll(top: number): void { if (this.pending && Math.abs(top - this.pending.top) > this.slop) this.cancel(); }
  cancel(): void { if (this.pending) this.timers.clear(this.pending.timer); this.pending = undefined; }
}
