import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import QRCode from "qrcode";
import { createServer } from "./fixtures/vite.js";
import { pairingLink, type PairingPayload } from "../src/pairing-link.js";
import { qrPublicCertificate } from "./fixtures/qr-public-certificate.js";
import type { CameraFrame } from "./fixtures/qr-camera.js";

// Diagnostic-only rejected encoding. Keep the original comparison samples in
// evidence without shipping the unverified compact presentation to users.
function pairingQrLink(payload: PairingPayload) {
  const legacy = pairingLink(payload), json = new URL(legacy).searchParams.get("data")!;
  const compact = json.replace(/[%&+#]/g, char => encodeURIComponent(char));
  const invite = payload.kind === "connect" && payload.invite ? `&invite=${payload.invite}` : "";
  return `tarocub://pair?data=${compact}${invite}`;
}

test("live-frame decoding retains legacy successes and reads resolved QR masks", async ({ page }, info) => {
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
  try {
    const payloads: PairingPayload[] = [
      { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" },
      { v: 1, kind: "connect", hubPublicKey: "A".repeat(48), routes: [{ name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority: qrPublicCertificate }], invite: "i".repeat(43) },
    ];
    const frames: CameraFrame[] = [];
    for (const payload of payloads) for (const [format, encode] of [["legacy", pairingLink], ["compact", pairingQrLink]] as const) for (const width of [640, 1280]) for (let mask = 0; mask < 8; mask++) {
      const text = encode(payload), qr = QRCode.create(text, { errorCorrectionLevel: "M", maskPattern: mask });
      const frame = { label: `${payload.kind}-${format}-${width}-${mask}`, text, size: qr.modules.size, modules: Array.from(qr.modules.data), width };
      frames.push(frame);
      if (payload.kind === "connect" && width === 640) frames.push({ ...frame, label: frame.label + "-resolved", minModulePixels: 3 });
    }
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/qr-scanner.html");
    const results = await page.evaluate(async frames => {
      const { compareFrames } = await import("/e2e/fixtures/qr-camera.ts");
      return compareFrames(frames);
    }, frames);
    const evidence = info.outputPath("decoder-comparison.json");
    await writeFile(evidence, JSON.stringify(results, null, 2));
    await info.attach("decoder-comparison", { path: evidence, contentType: "application/json" });
    expect(results.some(r => !r.legacy.ok)).toBe(true);
    // Below 3 pixels/module, capture aliasing can still require moving closer.
    // Keep those samples in the evidence instead of silently dropping failures.
    expect(results.filter(r => (r.modulePixels >= 3 || r.legacy.ok) && !r.current.ok)).toEqual([]);
    expect(results.some(r => !r.legacy.ok && r.current.ok)).toBe(true);
  } finally { await server.close(); }
});

for (const failure of ["draw", "ended"] as const) test(`camera ${failure} failure offers retry and releases its owned tracks`, async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Synthetic canvas captureStream is Chromium-only; decoder coverage also runs in WebKit.");
  const server = await createServer({ server: { host: "127.0.0.1", port: 0 } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0]! + "e2e/fixtures/qr-scanner.html");
    await page.evaluate(failure => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white"; context.fillRect(0, 0, 640, 480);
      const stream = canvas.captureStream(24);
      const paint = setInterval(() => context.fillRect(0, 0, 640, 480), 40);
      stream.getVideoTracks()[0]!.addEventListener("ended", () => clearInterval(paint));
      Object.assign(window, { cameraStream: stream });
      Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => stream;
      if (failure === "draw") {
        const original = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function(...args: Parameters<typeof original>) {
          if (args[0] instanceof HTMLVideoElement) throw new Error("fixture_draw_failure");
          return original.apply(this, args);
        };
      }
    }, failure);
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
    if (failure === "ended") {
      await expect(page.getByRole("button", { name: "正在扫描…", exact: true })).toBeVisible();
      await page.evaluate(() => {
        const stream = (window as unknown as { cameraStream: MediaStream }).cameraStream;
        stream.getVideoTracks()[0]!.dispatchEvent(new Event("ended"));
      });
    }
    await expect(page.getByRole("alert")).toContainText("无法使用摄像头");
    await expect(page.getByRole("button", { name: "打开摄像头", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as unknown as { cameraStream: MediaStream }).cameraStream.getTracks().every(t => t.readyState === "ended"))).toBe(true);
    await expect(page.locator("output")).toBeEmpty();
  } finally { await server.close(); }
});
