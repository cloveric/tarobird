import { BrowserQRCodeReader } from "@zxing/browser";
import { QrCameraReader } from "../../src/qr-camera.js";

export type CameraFrame = { label: string; text: string; size: number; modules: number[]; width: number; minModulePixels?: number };
export function compareFrames(frames: CameraFrame[]) {
  const old = new BrowserQRCodeReader(), current = new QrCameraReader();
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d")!;
  try {
    return frames.map(frame => {
      canvas.width = frame.width; canvas.height = frame.width * .75;
      const side = Math.max(frame.width * .42, (frame.size + 8) * (frame.minModulePixels ?? 0)), scale = side / (frame.size + 8);
      const left = (canvas.width - side) / 2, top = (canvas.height - side) / 2;
      const pixels = context.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const col = Math.floor((x - left) / scale) - 4, row = Math.floor((y - top) / scale) - 4;
        const inside = x >= left && y >= top && x < left + side && y < top + side;
        const dark = row >= 0 && col >= 0 && row < frame.size && col < frame.size && frame.modules[row * frame.size + col];
        const value = !inside ? 210 : dark ? 0 : 255, i = (y * canvas.width + x) * 4;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value; pixels.data[i + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const read = (reader: BrowserQRCodeReader) => {
        const start = performance.now();
        try { return { ok: reader.decodeFromCanvas(canvas).getText() === frame.text, ms: performance.now() - start }; }
        catch { return { ok: false, ms: performance.now() - start }; }
      };
      return { label: frame.label, modulePixels: scale, legacy: read(old), current: read(current) };
    });
  } finally { current.dispose(); canvas.width = canvas.height = 1; }
}
