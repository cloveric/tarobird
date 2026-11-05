/** Target display identity and coordinates. Electron `screen` bounds are macOS
 * global points (origin at the main display's top-left, y down, negative for
 * displays left/above it), the same space CGEvent uses. A display's revision
 * changes whenever anything that affects coordinate mapping changes. */
export const SCREEN_ENCODE_LONG_EDGE = 1920;
export const SCREEN_ENCODE_AREA = 1920 * 1080;
/** H.264 level 4.0 frame size (the legacy `avc1.640028` stream). */
export const SCREEN_ENCODE_MACROBLOCKS = 8192;
const KEY = /^[A-Za-z0-9_-]{1,128}$/;

export class ScreenGeometry {
  #revisions = new Map(); #shapes = new Map(); #next = 1;
  /** `uuidOf(nativeId)` returns the CoreGraphics display UUID (stable across
   * reconnects) or null; the native id is only a fallback identity. */
  constructor({ screen, uuidOf = () => null }) { this.screen = screen; this.uuidOf = uuidOf; }

  displays() {
    const result = [];
    for (const [index, display] of this.screen.getAllDisplays().entries()) {
      if (!Number.isSafeInteger(display.id) || display.id < 0) continue;
      const nativeId = String(display.id);
      const uuid = this.uuidOf(display.id);
      const id = typeof uuid === 'string' && KEY.test(uuid) ? uuid : `cg-${nativeId}`;
      const { x, y, width, height } = display.bounds;
      if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) continue;
      const shape = [Math.round(x), Math.round(y), Math.round(width), Math.round(height), display.scaleFactor, display.rotation, nativeId].join(',');
      if (this.#shapes.get(id) !== shape) { this.#shapes.set(id, shape); this.#revisions.set(id, this.#next++); }
      const name = typeof display.label === 'string' && display.label.trim() ? display.label.trim().slice(0, 128) : `Display ${index + 1}`;
      result.push({ id, nativeId, name, revision: this.#revisions.get(id), x: Math.round(x), y: Math.round(y),
        width: Math.round(width), height: Math.round(height), scale: display.scaleFactor,
        rotation: [0, 90, 180, 270].includes(display.rotation) ? display.rotation : 0 });
    }
    return result.slice(0, 16);
  }

  /** The current description of `id`, or undefined if it is gone. */
  find(id) { return this.displays().find(display => display.id === id); }
}

/** Encoded size for a display: physical pixels scaled to the quality profile's
 * caps (default: the legacy/balanced long edge ≤1920, area ≤1920×1080), aspect
 * preserved, even dimensions, never upscaled. The size also fits the
 * profile's H.264 level in 16×16 macroblocks: the 1920×1080 area alone lets
 * e.g. a 16:10 display round to 1820×1138 = 8208 blocks, which a level-4.0
 * encoder refuses (the session then silently fell back to software VP8). */
export function encodeSize(display, { longEdge = SCREEN_ENCODE_LONG_EDGE, area = SCREEN_ENCODE_AREA, macroblocks = SCREEN_ENCODE_MACROBLOCKS } = {}) {
  const physicalWidth = display.width * display.scale, physicalHeight = display.height * display.scale;
  let factor = Math.min(1, longEdge / Math.max(physicalWidth, physicalHeight), Math.sqrt(area / (physicalWidth * physicalHeight)));
  const even = value => Math.max(2, Math.floor(value * factor / 2) * 2);
  // Block rounding overshoots by at most one block row and column (≈3 % at
  // 1080p); fine steps keep the largest size that fits.
  for (let step = 0; step < 256; step++) {
    const size = { width: even(physicalWidth), height: even(physicalHeight) };
    if (Math.ceil(size.width / 16) * Math.ceil(size.height / 16) <= macroblocks) return size;
    factor *= 0.999;
  }
  throw new Error('screen_encode_size');
}

/** Normalized [0,1] position on `display` to a global point. 1 maps to the last
 * physical pixel of this display, never to the adjacent display's first one. */
export function toGlobalPoint(display, nx, ny) {
  if (!(nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1)) throw new Error('screen_point_out_of_bounds');
  const pixel = 1 / display.scale;
  return { x: display.x + Math.min(nx * display.width, display.width - pixel), y: display.y + Math.min(ny * display.height, display.height - pixel) };
}
