import { describe, expect, it } from "vitest";
import { designWheelDelta } from "../src/design-wheel.js";

const wheel = (deltaX: number, deltaY: number, deltaMode = 0) => designWheelDelta({ deltaX, deltaY, deltaMode }, 800, 600);
describe("Design / PPT viewport wheel", () => {
  it("preserves fine trackpad motion and direction without forcing a device classification", () => {
    expect(wheel(3, 4)).toMatchObject({ dx: 3, dy: 4 });
    expect(wheel(-0.25, 0.5)).toMatchObject({ dx: -0.25, dy: 0.5 });
    expect(wheel(0, 0)).toEqual({ dx: 0, dy: 0, zoomLog: -0 });
  });
  it("bounds fast/accelerated mouse motion in both axes with no diagonal bonus", () => {
    for (const size of [48, 120, 480, 5000]) {
      const result = wheel(size, size * 2);
      expect(Math.hypot(result.dx, result.dy)).toBeLessThanOrEqual(60);
      expect(result.dy / result.dx).toBeCloseTo(2);
      expect(wheel(-size, -size * 2).dy).toBeCloseTo(-result.dy);
    }
    expect(wheel(0, 120).dy).toBeGreaterThan(30);
  });
  it("converts line/page deltas before damping, including horizontal page motion", () => {
    expect(wheel(0, 3, 1)).toEqual(wheel(0, 48));
    expect(wheel(1, 1, 2)).toEqual(wheel(800, 600));
    expect(wheel(0, 1, 2).dy).toBeLessThanOrEqual(60);
  });
  it("keeps small zoom increments and makes large zoom steps reversible and bounded", () => {
    expect(wheel(0, 2).zoomLog).toBeCloseTo(-0.02);
    for (const size of [12, 120, 5000]) {
      const out = Math.exp(wheel(0, size).zoomLog), into = Math.exp(wheel(0, -size).zoomLog);
      expect(out).toBeGreaterThan(.92); expect(into).toBeLessThan(1.09);
      expect(out * into).toBeCloseTo(1);
    }
  });
  it("ignores non-finite input rather than poisoning the viewport", () => {
    expect(wheel(NaN, Infinity)).toMatchObject({ dx: 0, dy: 0 });
  });
});
