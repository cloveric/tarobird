export type ImagePoint = { x: number; y: number };
export type ImageSize = { width: number; height: number };
export type ImageFit = "contain" | "width";
export const clampImageValue = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function imageFitRatio(image: ImageSize, viewport: ImageSize, fit: ImageFit): number {
  if (!image.width || !image.height || !viewport.width || !viewport.height) return 0;
  return Math.min(1, viewport.width / image.width, fit === "width" ? 960 / image.width : viewport.height / image.height);
}

export function imageAnchor(point: ImagePoint, scroll: ImagePoint, image: ImageSize, viewport: ImageSize): ImagePoint {
  return {
    x: (scroll.x + point.x - Math.max(0, (viewport.width - image.width) / 2)) / image.width,
    y: (scroll.y + point.y - Math.max(0, (viewport.height - image.height) / 2)) / image.height,
  };
}

export function imageScrollAt(anchor: ImagePoint, point: ImagePoint, image: ImageSize, viewport: ImageSize): ImagePoint {
  return {
    x: clampImageValue(Math.max(0, (viewport.width - image.width) / 2) + anchor.x * image.width - point.x, 0, Math.max(0, image.width - viewport.width)),
    y: clampImageValue(Math.max(0, (viewport.height - image.height) / 2) + anchor.y * image.height - point.y, 0, Math.max(0, image.height - viewport.height)),
  };
}
