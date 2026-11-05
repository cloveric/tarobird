import { describe, expect, it } from 'vitest';
import { eraseEyes, findFace } from '../client/src/avatar-face.js';

const EDGE = 256;
/** A transparent cutout: an orange disc with dark oval eyes. */
function mascot({ eyes = [[100, 140], [156, 140]] as number[][], opaque = false } = {}) {
  const data = new Uint8ClampedArray(EDGE * EDGE * 4);
  for (let y = 0; y < EDGE; y++) for (let x = 0; x < EDGE; x++) {
    const i = (y * EDGE + x) * 4, face = (x - 128) ** 2 + (y - 140) ** 2 < 100 ** 2;
    const eye = eyes.some(([cx, cy]) => ((x - cx!) / 10) ** 2 + ((y - cy!) / 17) ** 2 < 1);
    if (face || opaque) data.set(eye ? [27, 25, 25, 255] : face ? [250, 128, 40, 255] : [230, 230, 230, 255], i);
  }
  return data;
}
const darkInside = (data: Uint8ClampedArray, x0: number, x1: number, y0: number, y1: number) => {
  let count = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = (y * EDGE + x) * 4; if (data[i + 3]! > 200 && Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < 90) count++; }
  return count;
};

describe('avatar face', () => {
  it('finds both eyes on a transparent mascot, left to right, with their ink', () => {
    const face = findFace(mascot(), EDGE, EDGE)!;
    expect(face).not.toBeNull();
    const [left, right] = face.eyes;
    // Box centres include the pixel edge, so allow one pixel.
    expect(Math.abs((left.x + left.w / 2) * EDGE - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs((right.x + right.w / 2) * EDGE - 156)).toBeLessThanOrEqual(1);
    expect(Math.abs((left.y + left.h / 2) * EDGE - 140)).toBeLessThanOrEqual(1);
    expect(left.h).toBeGreaterThan(left.w);
    expect(face.ink).toBe('#1b1919');
  });

  it('leaves opaque pictures and single-eye shapes to body motion only', () => {
    expect(findFace(mascot({ opaque: true }), EDGE, EDGE)).toBeNull();
    expect(findFace(mascot({ eyes: [[128, 140]] }), EDGE, EDGE)).toBeNull();
    expect(findFace(mascot({ eyes: [] }), EDGE, EDGE)).toBeNull();
  });

  it('paints the eyes away with face colour and keeps the silhouette', () => {
    const data = mascot(), face = findFace(data, EDGE, EDGE)!;
    const alpha = data.filter((_, i) => i % 4 === 3).reduce((sum, value) => sum + value, 0);
    expect(darkInside(data, 85, 171, 118, 162)).toBeGreaterThan(800);
    eraseEyes(data, EDGE, EDGE, face);
    expect(darkInside(data, 85, 171, 118, 162)).toBe(0);
    expect(data.filter((_, i) => i % 4 === 3).reduce((sum, value) => sum + value, 0)).toBe(alpha);
    const centre = (140 * EDGE + 100) * 4;
    expect([...data.slice(centre, centre + 4)]).toEqual([250, 128, 40, 255]);
  });
});
