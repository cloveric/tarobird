import { describe, expect, it } from "vitest";
import { imageAnchor, imageFitRatio, imageScrollAt } from "../client/src/image-viewer-geometry.js";

describe("image viewer geometry", () => {
  it("preserves composition for a portrait and starts long pages at readable width", () => {
    const screen = { width: 390, height: 844 };
    expect(imageFitRatio({ width: 1200, height: 2400 }, screen, "contain")).toBe(.325);
    expect(imageFitRatio({ width: 720, height: 7200 }, screen, "contain")).toBeCloseTo(844 / 7200);
    expect(imageFitRatio({ width: 720, height: 7200 }, screen, "width")).toBeCloseTo(390 / 720);
    expect(imageFitRatio({ width: 10, height: 10 }, screen, "contain")).toBe(1);
  });
  it("keeps the point under the cursor across a zoom and screen rotation", () => {
    const screen = { width: 390, height: 844 }, image = { width: 1170, height: 2340 };
    const point = { x: 150, y: 400 }, scroll = { x: 250, y: 800 };
    const anchor = imageAnchor(point, scroll, image, screen);
    const larger = { width: image.width * 1.6, height: image.height * 1.6 };
    expect(imageAnchor(point, imageScrollAt(anchor, point, larger, screen), larger, screen)).toEqual(anchor);
    const rotated = { width: 844, height: 390 }, centre = { x: 422, y: 195 };
    expect(imageAnchor(centre, imageScrollAt(anchor, centre, larger, rotated), larger, rotated)).toEqual(anchor);
  });
  it("never scrolls past the image and includes letterbox offsets", () => {
    const screen = { width: 390, height: 844 }, image = { width: 390, height: 200 };
    expect(imageAnchor({ x: 195, y: 422 }, { x: 0, y: 0 }, image, screen)).toEqual({ x: .5, y: .5 });
    expect(imageScrollAt({ x: -1, y: 3 }, { x: 195, y: 422 }, image, screen)).toEqual({ x: 0, y: 0 });
    expect(imageScrollAt({ x: 4, y: -1 }, { x: 195, y: 422 }, { width: 1000, height: 1000 }, screen)).toEqual({ x: 610, y: 0 });
  });
});
