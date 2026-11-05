import { BrowserQRCodeReader } from "@zxing/browser";
import { DecodeHintType, type ResultPoint } from "@zxing/library";
import { t } from "./i18n.js";

type Region = { x: number; y: number; width: number; height: number };

/** Axis-aligned finder triples provide screenshot crops even when perspective
 * sampling fails. A small crop excludes neighboring UI; the larger padding
 * also retains all seven finder modules in low-version codes. */
function finderRegions(points: ResultPoint[], source: Region, scale: number): Region[] {
  const regions: Region[] = [];
  for (const corner of points) for (const across of points) for (const down of points) {
    const width = Math.abs(across.getX() - corner.getX()), height = Math.abs(down.getY() - corner.getY());
    if (width < 28 || Math.abs(width - height) > width * 0.05 || Math.abs(across.getY() - corner.getY()) > width * 0.03 || Math.abs(down.getX() - corner.getX()) > height * 0.03) continue;
    for (const padding of [0.125, 0.25]) {
      const left = Math.max(0, Math.min(corner.getX(), across.getX()) - width * padding);
      const top = Math.max(0, Math.min(corner.getY(), down.getY()) - height * padding);
      const right = Math.min(source.width * scale, Math.max(corner.getX(), across.getX()) + width * padding);
      const bottom = Math.min(source.height * scale, Math.max(corner.getY(), down.getY()) + height * padding);
      // Preserve source pixel alignment: a fractional crop origin would add
      // another interpolation phase to already-resampled screenshot modules.
      const x = Math.floor(source.x + left / scale), y = Math.floor(source.y + top / scale);
      regions.push({ x, y, width: Math.ceil(source.x + right / scale) - x, height: Math.ceil(source.y + bottom / scale) - y });
    }
    if (regions.length >= 4) return regions;
  }
  return regions;
}

/** Decode once-loaded pixels at bounded scales; screenshot modules are often
 * too small for the finder at native resolution. No network service is used. */
export async function decodeQrImage(url: string, active: () => boolean): Promise<string | undefined> {
  const image = new Image(); image.src = url;
  try { await image.decode(); }
  catch { throw new Error(t("无法打开这张图片，请选择 PNG 或 JPEG 格式的二维码图片。")); }
  if (!active()) return;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error(t("无法读取图片，请改用粘贴配对信息。"));
  let points: ResultPoint[] = [];
  const readers = [
    new BrowserQRCodeReader(new Map<DecodeHintType, unknown>([
      [DecodeHintType.TRY_HARDER, true],
      [DecodeHintType.NEED_RESULT_POINT_CALLBACK, { foundPossibleResultPoint: (point: ResultPoint) => { if (points.length < 20) points.push(point); } }],
    ])),
    new BrowserQRCodeReader(new Map([[DecodeHintType.PURE_BARCODE, true]])),
  ];
  const width = image.naturalWidth, height = image.naturalHeight;
  const full: Region = { x: 0, y: 0, width, height };
  const passes: { region: Region; scale: number; threshold?: number; locate?: boolean }[] = [
    { region: full, scale: 1, locate: true }, { region: full, scale: 2 }, { region: full, scale: 0.5 },
    { region: full, scale: 1.5, threshold: 96 }, { region: full, scale: 1.5, threshold: 160 },
  ];
  // A full screenshot may contain a small QR. Shrinking the whole image to the
  // canvas budget destroys its modules; bounded overlapping tiles preserve
  // the original detail without allocating one enormous canvas.
  const side = Math.min(width, height);
  if (Math.max(width, height) > side * 1.4) {
    const count = Math.min(8, Math.ceil(Math.max(width, height) / (side * 0.7)));
    for (let index = 0; index < count; index++) {
      const region = { x: (width - side) * index / (count - 1), y: (height - side) * index / (count - 1), width: side, height: side };
      passes.push({ region, scale: 1, locate: true }, { region, scale: 1.5, threshold: 128 });
    }
  }
  const crops = new Set<string>();
  try {
    for (const pass of passes) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (!active()) return;
      points = [];
      const region = pass.region;
      const maxScale = Math.min(3200 / Math.max(region.width, region.height), Math.sqrt(6_000_000 / (region.width * region.height)));
      const scale = Math.min(pass.scale, maxScale);
      canvas.width = Math.max(1, Math.round(region.width * scale));
      canvas.height = Math.max(1, Math.round(region.height * scale));
      context.imageSmoothingEnabled = pass.threshold !== undefined;
      context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
      // CSS downsampling plus JPEG compression leaves grey module edges.
      // Re-sample at a fractional scale and try two contrast cutoffs after
      // normal decoding fails; preserve the original pixels for earlier passes.
      if (pass.threshold !== undefined) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const grey = pixels.data[i]! * 0.299 + pixels.data[i + 1]! * 0.587 + pixels.data[i + 2]! * 0.114;
          const value = grey < pass.threshold ? 0 : 255;
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
        }
        context.putImageData(pixels, 0, 0);
      }
      for (const reader of readers) {
        try { return reader.decodeFromCanvas(canvas).getText(); }
        catch { /* Retry a different sampler or scale. */ }
      }
      // PURE_BARCODE uses the outermost black pixels as its bounds. Text and
      // icons in a screenshot/tile invalidate those bounds, so retry at most
      // four crops around confirmed finder geometry with two pixel samplers.
      if (pass.locate) for (const region of finderRegions(points, pass.region, scale)) {
        const key = [region.x, region.y, region.width, region.height].map(value => Math.round(value / 8)).join(",");
        if (crops.size >= 4 || crops.has(key)) continue;
        crops.add(key);
        passes.push({ region, scale: 0.75 }, { region, scale: 1, threshold: 160 });
      }
    }
    throw new Error(t("未识别到清晰的二维码。请裁剪到二维码区域、选择原图，或粘贴配对信息。"));
  } finally { canvas.width = canvas.height = 1; }
}
