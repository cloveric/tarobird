import { useEffect, useState } from "react";

/** Eye boxes are fractions of the square avatar edge. */
export type FaceEye = { x: number; y: number; w: number; h: number };
export type FaceGeometry = { eyes: [FaceEye, FaceEye]; ink: string };
export type AvatarFace = FaceGeometry & { plain: string };

type Blob = { n: number; x0: number; x1: number; y0: number; y1: number; r: number; g: number; b: number };
const dark = (data: Uint8ClampedArray, i: number) => data[i + 3]! > 200 && Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < 90;

/** Finds two solid dark eyes on a transparent cutout mascot. Opaque pictures
 * (photos, framed tiles) are rejected so they keep body motion only. */
export function findFace(data: Uint8ClampedArray, width: number, height: number): FaceGeometry | null {
  const total = width * height;
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 16) clear++;
  if (clear < total * .15) return null;
  const scale = total / 65536, seen = new Uint8Array(total), stack = new Int32Array(total), blobs: Blob[] = [];
  for (let start = 0; start < total; start++) {
    if (seen[start] || !dark(data, start * 4)) continue;
    const blob: Blob = { n: 0, x0: width, x1: 0, y0: height, y1: 0, r: 0, g: 0, b: 0 };
    let top = 0; stack[top++] = start; seen[start] = 1;
    while (top) {
      const p = stack[--top]!, x = p % width, y = (p - x) / width, i = p * 4;
      blob.n++; blob.r += data[i]!; blob.g += data[i + 1]!; blob.b += data[i + 2]!;
      if (x < blob.x0) blob.x0 = x; if (x > blob.x1) blob.x1 = x; if (y < blob.y0) blob.y0 = y; if (y > blob.y1) blob.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q >= 0 && !seen[q] && dark(data, q * 4)) { seen[q] = 1; stack[top++] = q; }
      }
    }
    const w = blob.x1 - blob.x0 + 1, h = blob.y1 - blob.y0 + 1;
    if (blob.n >= 12 * scale && blob.n <= 3000 * scale && blob.n / (w * h) > .55 && w / h > .3 && w / h < 2.2) blobs.push(blob);
  }
  let best: { score: number; pair: [Blob, Blob] } | undefined;
  for (let i = 0; i < blobs.length; i++) for (let j = i + 1; j < blobs.length; j++) {
    const [a, b] = [blobs[i]!, blobs[j]!].sort((p, q) => p.x0 + p.x1 - q.x0 - q.x1) as [Blob, Blob];
    const aw = a.x1 - a.x0 + 1, bw = b.x1 - b.x0 + 1, ah = a.y1 - a.y0 + 1, bh = b.y1 - b.y0 + 1;
    const ratio = Math.max(a.n, b.n) / Math.min(a.n, b.n);
    const dy = Math.abs(a.y0 + a.y1 - b.y0 - b.y1) / 2, dx = (b.x0 + b.x1 - a.x0 - a.x1) / 2;
    const cy = (a.y0 + a.y1 + b.y0 + b.y1) / 4 / height;
    if (ratio >= 1.8 || dy >= .5 * Math.max(ah, bh) + 3 || dx <= 1.2 * Math.max(aw, bw) || dx >= width * .55 || cy < .2 || cy > .85) continue;
    const score = ratio + dy / 10 - (a.n + b.n) * .0005 / scale;
    if (!best || score < best.score) best = { score, pair: [a, b] };
  }
  if (!best) return null;
  const [a, b] = best.pair, n = a.n + b.n;
  const eye = (blob: Blob): FaceEye => ({ x: blob.x0 / width, y: blob.y0 / height, w: (blob.x1 - blob.x0 + 1) / width, h: (blob.y1 - blob.y0 + 1) / height });
  const channel = (value: number) => Math.round(value / n).toString(16).padStart(2, "0");
  return { eyes: [eye(a), eye(b)], ink: `#${channel(a.r + b.r)}${channel(a.g + b.g)}${channel(a.b + b.b)}` };
}

/** Paints over the detected eyes with the surrounding face colour so animated
 * eyes can be drawn on top. Each row is interpolated between its edges; spans
 * touching a light bib or highlight copy the clean row above instead. */
export function eraseEyes(data: Uint8ClampedArray, width: number, height: number, face: FaceGeometry): void {
  const mask = new Uint8Array(width * height);
  for (const eye of face.eyes) {
    const x0 = Math.max(0, Math.floor(eye.x * width) - 3), x1 = Math.min(width - 1, Math.ceil((eye.x + eye.w) * width) + 3);
    const y0 = Math.max(0, Math.floor(eye.y * height) - 3), y1 = Math.min(height - 1, Math.ceil((eye.y + eye.h) * height) + 3);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!dark(data, (y * width + x) * 4)) continue;
      // Two-pixel dilation also covers the anti-aliased rim.
      for (let v = Math.max(0, y - 2); v <= Math.min(height - 1, y + 2); v++) for (let u = Math.max(0, x - 2); u <= Math.min(width - 1, x + 2); u++) mask[v * width + u] = 1;
    }
  }
  const light = (i: number) => Math.min(data[i]!, data[i + 1]!, data[i + 2]!) > 75;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      let end = x; while (end < width && mask[y * width + end]) end++;
      const left = (y * width + Math.max(0, x - 1)) * 4, right = (y * width + Math.min(width - 1, end)) * 4;
      for (let k = x; k < end; k++) {
        const i = (y * width + k) * 4, t = (k - x + 1) / (end - x + 1);
        for (let c = 0; c < 4; c++) {
          data[i + c] = light(left) || light(right) ? y ? data[i - width * 4 + c]! : data[i + c]! : data[left + c]! * (1 - t) + data[right + c]! * t;
        }
      }
      x = end;
    }
  }
}

const FACE_LIMIT = 96;
const faces = new Map<string, Promise<AvatarFace | null>>();
async function computeFace(url: string): Promise<AvatarFace | null> {
  const image = new Image(); image.decoding = "async"; image.src = url; await image.decode();
  const edge = 256, canvas = document.createElement("canvas"); canvas.width = canvas.height = edge;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, edge, edge);
  const pixels = context.getImageData(0, 0, edge, edge), face = findFace(pixels.data, edge, edge);
  if (!face) return null;
  eraseEyes(pixels.data, edge, edge, face); context.putImageData(pixels, 0, 0);
  const blob = await new Promise<globalThis.Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  // A mounted avatar may outlive the bounded cache entry. Self-contained image
  // data remains valid for that consumer and is collected with its face object.
  const plain = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { ...face, plain };
}
/** One analysis per picture URL; failures (decode, tainted canvas) mean no face. */
export function loadAvatarFace(url: string): Promise<AvatarFace | null> {
  let face = faces.get(url);
  if (!face) {
    face = computeFace(url).catch(() => null);
    faces.set(url, face);
    if (faces.size > FACE_LIMIT) {
      const oldest = faces.keys().next().value!;
      faces.delete(oldest);
    }
  }
  return face;
}
export function useAvatarFace(url: string | undefined): AvatarFace | null | undefined {
  const [face, setFace] = useState<{ url: string; value: AvatarFace | null }>();
  useEffect(() => {
    if (!url) return;
    let alive = true;
    void loadAvatarFace(url).then(value => { if (alive) setFace({ url, value }); });
    return () => { alive = false; };
  }, [url]);
  return url && face?.url === url ? face.value : undefined;
}
