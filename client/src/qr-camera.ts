import jsQR from "jsqr";
import { BrowserQRCodeReader } from "@zxing/browser";
import { ChecksumException, FormatException, NotFoundException, Result, BarcodeFormat } from "@zxing/library";

export function qrFrameMiss(error: unknown): boolean {
  return error instanceof NotFoundException || error instanceof ChecksumException || error instanceof FormatException;
}

/** Optional camera hints must never discard an otherwise usable stream. */
export async function preferContinuousFocus(stream: MediaStream): Promise<void> {
  for (const track of stream.getVideoTracks()) try {
    const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { focusMode?: string[] }) | undefined;
    if (track.readyState === "live" && caps?.focusMode?.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] });
    }
  } catch { /* Unsupported focus controls are common on mobile WebViews. */ }
}

/** Serial bounded frame decoding: no overlapping timers or image-import loop. */
export class QrCameraReader extends BrowserQRCodeReader {
  private readonly bounded = document.createElement("canvas");
  constructor() {
    super(undefined, { delayBetweenScanAttempts: 100, delayBetweenScanSuccess: 100 });
  }
  override decodeFromCanvas(source: HTMLCanvasElement): Result {
    let canvas = source;
    const scale = Math.min(1, 1920 / Math.max(source.width, source.height), Math.sqrt(2_100_000 / (source.width * source.height)));
    if (scale < 1) {
      this.bounded.width = Math.max(1, Math.round(source.width * scale));
      this.bounded.height = Math.max(1, Math.round(source.height * scale));
      const context = this.bounded.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("camera_canvas_unavailable");
      context.drawImage(source, 0, 0, this.bounded.width, this.bounded.height);
      canvas = this.bounded;
    }
    let miss: unknown;
    try { return super.decodeFromCanvas(canvas); }
    catch (error) { if (!qrFrameMiss(error)) throw error; miss = error; }
    const pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height);
    if (!pixels) throw new Error("camera_canvas_unavailable");
    const decoded = jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
    if (decoded) return new Result(decoded.data, Uint8Array.from(decoded.binaryData), decoded.binaryData.length * 8, [], BarcodeFormat.QR_CODE);

    throw miss;
  }
  dispose(): void {
    this.bounded.width = this.bounded.height = 1;
  }
}
