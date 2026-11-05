import { test, expect } from "@playwright/test";
import { createServer } from "./fixtures/vite.js";
import QRCode from "qrcode";
import { qrPublicCertificate as certificateAuthority } from "./fixtures/qr-public-certificate.js";
import { pairingLink, parsePairingLink, type PairingPayload } from "../src/pairing-link.js";

test("QR image drop opts into copy after the global file navigation guard", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.getByRole("button", { name: "Open scanner" }).click();
    const dataTransfer = await page.evaluateHandle(bytes => {
      const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], "pairing.png", { type: "image/png" }));
      // Constructed drags have no OS drag operation, so the browser ignores
      // native dropEffect writes. Model its writable feedback slot explicitly
      // to test capture/target arbitration; this is not native drag acceptance.
      Object.defineProperty(transfer, "dropEffect", { value: "none", writable: true });
      return transfer;
    }, [...await QRCode.toBuffer(pairingLink(payload))]);
    const outside = await page.evaluate(transfer => {
      const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }); document.body.dispatchEvent(event);
      return { prevented: event.defaultPrevented, effect: transfer.dropEffect };
    }, dataTransfer);
    expect(outside).toEqual({ prevented: true, effect: "none" });
    const inside = await page.locator(".scanner-viewfinder").evaluate((element, transfer) => {
      const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }); element.dispatchEvent(event);
      return { prevented: event.defaultPrevented, effect: transfer.dropEffect };
    }, dataTransfer);
    // Dispatching a drop bypasses the browser's dropEffect decision. Assert
    // acceptance first; the synthetic drop below proves decoding only, not
    // physical Finder or Windows Explorer drag acceptance.
    expect(inside).toEqual({ prevented: true, effect: "copy" });
    await page.locator(".scanner-viewfinder").dispatchEvent("drop", { dataTransfer });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
    const guarded = await page.evaluate(transfer => {
      const event = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }); document.body.dispatchEvent(event);
      return { prevented: event.defaultPrevented, effect: transfer.dropEffect };
    }, dataTransfer);
    expect(guarded).toEqual({ prevented: true, effect: "none" });
  } finally { await server.close(); }
});

test("scanner hides idle video, explains camera denial and supports image retry", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.evaluate(() => { Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => { throw new DOMException("denied", "NotAllowedError"); }; });
    await page.getByRole("button", { name: "Open scanner" }).click();
    await expect(page.locator("video")).toBeHidden();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("准备扫描");
    await expect(page.getByRole("button", { name: "选择二维码图片" })).toBeVisible();
    await expect(page.getByLabel("二维码图片", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("摄像头权限未开启");
    await expect(page.locator("video")).toBeHidden();
    await expect(page.getByRole("button", { name: "打开摄像头", exact: true })).toBeEnabled();
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "选择二维码图片" }).click();
    await (await picker).setFiles({ name: "bad.png", mimeType: "image/png", buffer: await QRCode.toBuffer("https://invalid.test/") });
    await expect(page.getByRole("alert")).toContainText("这不是 TaroBird 配对码");
    const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" };
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "good.png", mimeType: "image/png", buffer: await QRCode.toBuffer(pairingLink(payload)) });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
    await expect(page.getByRole("button", { name: "Open scanner" })).toBeFocused();
  } finally { await server.close(); }
});

test("closing while camera permission is pending stops the late stream", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.evaluate(() => {
      const state = { stopped: 0, requests: 0, resolve: undefined as ((stream: MediaStream) => void) | undefined };
      Object.assign(window, { cameraProbe: state });
      Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = () => { state.requests++; return new Promise(resolve => { state.resolve = resolve; }); };
    });
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { cameraProbe: { requests: number } }).cameraProbe.requests)).toBe(1);
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("正在打开摄像头");
    await expect(page.locator("video")).toBeHidden();
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.evaluate(() => {
      const state = (window as unknown as { cameraProbe: { stopped: number; resolve: (stream: MediaStream) => void } }).cameraProbe;
      state.resolve({ getTracks: () => [{ stop: () => state.stopped++ }] } as unknown as MediaStream);
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { cameraProbe: { stopped: number } }).cameraProbe.stopped)).toBe(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Open scanner" }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("准备扫描");
  } finally { await server.close(); }
});

test("live camera appears only after playback and a decoded QR releases all tracks", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "Canvas camera capture is a Chromium fixture, not physical-camera acceptance.");
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 600;
      canvas.getContext("2d")!.fillRect(0, 0, 600, 600);
      const stream = canvas.captureStream(10);
      Object.assign(window, { cameraProbe: { canvas, stream } });
      Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = async () => stream;
    });
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
    await expect(page.locator("video")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("status")).toHaveText("对准二维码，识别后自动继续");
    const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" };
    await page.evaluate(async url => {
      const canvas = (window as unknown as { cameraProbe: { canvas: HTMLCanvasElement } }).cameraProbe.canvas;
      const image = new Image(); image.src = url; await image.decode();
      canvas.getContext("2d")!.drawImage(image, 0, 0, 600, 600);
    }, await QRCode.toDataURL(pairingLink(payload), { width: 600, margin: 4 }));
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
    expect(await page.evaluate(() => (window as unknown as { cameraProbe: { stream: MediaStream } }).cameraProbe.stream.getTracks().every(track => track.readyState === "ended"))).toBe(true);
  } finally { await server.close(); }
});

test("flat pairing images decode under all eight QR masks and malformed input stays unapproved", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  // Entirely synthetic public key/code. Mask 0 reproduces a perspective-finder
  // failure even on a pristine PNG; the flat-image sampler must still decode it.
  const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=", code: "12345678" };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
      await page.getByRole("button", { name: "Open scanner" }).click();
      const buffer = await QRCode.toBuffer(pairingLink(payload), { scale: 6, margin: 4, errorCorrectionLevel: "M", maskPattern: maskPattern as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 });
      await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: `mask-${maskPattern}.png`, mimeType: "image/png", buffer });
      await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
    }
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: await QRCode.toBuffer("https://untrusted.example.test/") });
    await expect(page.getByRole("alert")).toContainText("这不是 TaroBird 配对码"); await expect(page.getByRole("dialog")).toHaveCount(1); await expect(page.locator("output")).toBeEmpty();
  } finally { await server.close(); }
});

test("connect QR preserves a named primary and multiple backups in priority order", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const payload: PairingPayload = { v: 1, kind: "connect", hubPublicKey: "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=", routes: [{ name: "VPS", label: "东京主站", url: "https://primary.test" }, { name: "VPS", label: "香港备站", url: "https://backup.test" }, { name: "VPS", label: "新加坡备站", url: "https://backup2.test" }] };
  try {
    expect(parsePairingLink(pairingLink(payload))).toEqual(payload);
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html"); await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "multi-vps.png", mimeType: "image/png", buffer: await QRCode.toBuffer(pairingLink(payload), { scale: 6, margin: 4, errorCorrectionLevel: "M" }) });
    await expect(page.getByRole("dialog")).toHaveCount(0); expect(JSON.parse(await page.locator("output").innerText())).toEqual(payload);
  } finally { await server.close(); }
});

test("compressed whole-window screenshot preserves the QR scoped certificate", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/tailscale-pairing.html");
    await page.waitForFunction(() => !!window.tailscaleFixture);
    await page.evaluate(ca => { window.tailscaleFixture.state.certificateAuthority = ca; window.tailscaleFixture.render(); }, certificateAuthority);
    await page.getByRole("button", { name: "生成局域网二维码", exact: true }).click();
    const qr = page.getByRole("img", { name: "连接二维码", exact: true });
    await expect(qr).toBeVisible();
    await qr.scrollIntoViewIfNeeded();
    // Generic pairing codes render at 210 px; include surrounding UI and JPEG compression.
    await page.addStyleTag({ content: ".desktop-host-invite .pair-qr { width: 210px; }" });
    const image = await page.screenshot({ type: "jpeg", quality: 85 });
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "desktop-screenshot.jpg", mimeType: "image/jpeg", buffer: image });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10000 });
    expect(JSON.parse(await page.locator("output").innerText())).toMatchObject({ kind: "connect", routes: [{ certificateAuthority }] });
  } finally { await server.close(); }
});

test("pasted pairing information uses the same strict identity and route validation", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await expect(page.getByRole("button", { name: "使用配对信息" })).toBeDisabled();
    for (const invalid of ["not a URL", "https://example.test", "tarocub://pair?data=%7B", pairingLink({ v: 1, kind: "connect", hubPublicKey: "A".repeat(48), routes: [{ name: "VPS", url: "http://untrusted.test" }] })]) {
      await page.getByLabel("配对信息", { exact: true }).fill(invalid);
      await page.getByRole("button", { name: "使用配对信息" }).click();
      await expect(page.getByRole("alert")).toContainText(/这不是 TaroBird 配对码|配对信息不完整或已损坏/);
      await expect(page.locator("output")).toBeEmpty();
    }
    const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" };
    await page.getByLabel("配对信息", { exact: true }).fill(`\n ${pairingLink(payload)} \n`);
    await page.getByRole("button", { name: "使用配对信息" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
  } finally { await server.close(); }
});

test("copied invites preserve the certificate and clipboard denial offers selectable text", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html?invite");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { Object.assign(window, { copiedInvite: value }); } } }));
    await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
    await expect(page.locator(".pair-code-actions").getByRole("status")).toContainText("已复制");
    const copied = await page.evaluate(() => (window as unknown as { copiedInvite: string }).copiedInvite);
    expect(parsePairingLink(copied)).toMatchObject({ kind: "connect", routes: [{ certificateAuthority }] });
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await page.getByLabel("配对信息", { exact: true }).fill(copied);
    await page.getByRole("button", { name: "使用配对信息" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(JSON.parse(await page.locator("output").innerText())).toMatchObject({ kind: "connect", routes: [{ certificateAuthority }] });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } }));
    await page.getByRole("button", { name: "复制连接信息", exact: true }).click();
    const fallback = page.getByLabel("可复制的配对信息");
    await expect(fallback).toHaveValue(copied);
    await fallback.focus();
    expect(await fallback.evaluate((node: HTMLTextAreaElement) => node.selectionEnd - node.selectionStart)).toBe(copied.length);
  } finally { await server.close(); }
});

test("unreadable and empty images explain recovery without accepting a device", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("broken image") });
    await expect(page.getByRole("alert")).toContainText("无法打开这张图片");
    const blank = await page.evaluate(() => { const canvas = document.createElement("canvas"); canvas.width = canvas.height = 100; const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 100, 100); return canvas.toDataURL().split(",")[1]!; });
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "blank.png", mimeType: "image/png", buffer: Buffer.from(blank, "base64") });
    await expect(page.getByRole("alert")).toContainText("裁剪到二维码区域");
    await expect(page.locator("output")).toBeEmpty();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel("配对信息", { exact: true })).toBeVisible();
  } finally { await server.close(); }
});

test("switching to pasted information cancels a pending camera permission", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    await page.evaluate(() => {
      const state = { stopped: 0, resolve: undefined as ((stream: MediaStream) => void) | undefined };
      Object.assign(window, { cameraProbe: state });
      Object.getPrototypeOf(navigator.mediaDevices).getUserMedia = () => new Promise(resolve => { state.resolve = resolve; });
    });
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByRole("button", { name: "打开摄像头", exact: true }).click();
    await page.getByRole("button", { name: "粘贴配对信息", exact: true }).click();
    await page.evaluate(() => {
      const state = (window as unknown as { cameraProbe: { stopped: number; resolve: (stream: MediaStream) => void } }).cameraProbe;
      state.resolve({ getTracks: () => [{ stop: () => state.stopped++ }] } as unknown as MediaStream);
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { cameraProbe: { stopped: number } }).cameraProbe.stopped)).toBe(1);
    await expect(page.getByLabel("配对信息", { exact: true })).toBeVisible();
    await expect(page.locator("video")).toHaveCount(0);
    await expect(page.locator("output")).toBeEmpty();
    await page.getByRole("button", { name: "返回扫码", exact: true }).click();
    await expect(page.getByRole("button", { name: "打开摄像头", exact: true })).toBeEnabled();
  } finally { await server.close(); }
});

test("a tall full-screen capture retains a small certificate-bearing QR without manual cropping", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const payload: PairingPayload = { v: 1, kind: "connect", hubPublicKey: "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=", routes: [{ name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority }] };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    const source = await QRCode.toDataURL(pairingLink(payload), { scale: 6, margin: 4 });
    const capture = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 2400; canvas.height = 8000;
      const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, 2400, 8000);
      context.fillStyle = "#222"; context.font = "40px sans-serif";
      for (let y = 100; y < 6800; y += 100) context.fillText("TaroBird · Device settings · Connect a new computer", 100, y);
      context.drawImage(image, 975, 7200, 450, 450);
      return canvas.toDataURL("image/png").split(",")[1]!;
    }, source);
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "whole-screen.png", mimeType: "image/png", buffer: Buffer.from(capture, "base64") });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15000 });
    expect(JSON.parse(await page.locator("output").innerText())).toEqual(payload);
  } finally { await server.close(); }
});

test("dense phone screenshots isolate QR pixels from neighboring UI before flat sampling", async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const payload: PairingPayload = { v: 1, kind: "connect", hubPublicKey: "MCowBQYDK2VwAyEA" + "A".repeat(43) + "=", routes: [{ name: "Direct", url: "https://192.168.10.20:8788", certificateAuthority }] };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html");
    // Public synthetic data only. UI text above/below the dense QR contaminates
    // the flat sampler's black-pixel bounds even inside an overlapping tile.
    const source = await QRCode.toDataURL(pairingLink(payload), { scale: 6, margin: 4, errorCorrectionLevel: "M", maskPattern: 6 });
    const capture = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 1440; canvas.height = 3168;
      const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#222"; context.font = "54px sans-serif";
      for (const y of [100, 300, 540, 750, 900, 1090]) context.fillText("TaroBird · Devices and security · Connect a new device", 64, y);
      context.drawImage(image, 124, 1250, 1192, 1192);
      context.fillText("Copy pairing information", 515, 2630); context.fillText("Next", 1150, 2960);
      return canvas.toDataURL("image/jpeg", 0.85).split(",")[1]!;
    }, source);
    await page.getByRole("button", { name: "Open scanner" }).click();
    await page.getByLabel("二维码图片", { exact: true }).setInputFiles({ name: "synthetic-phone.jpg", mimeType: "image/jpeg", buffer: Buffer.from(capture, "base64") });
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 10000 });
    expect(JSON.parse(await page.locator("output").innerText())).toEqual(payload);
  } finally { await server.close(); }
});

for (const method of ["paste", "drop"] as const) test(`image import accepts a screenshot via ${method} without opening the camera`, async ({ page }) => {
  const server = await createServer({ server: { port: 0, strictPort: false, host: "127.0.0.1" } }); await server.listen();
  const payload: PairingPayload = { v: 1, kind: "approve", hubPublicKey: "A".repeat(48), code: "12345678" };
  try {
    await page.goto(server.resolvedUrls!.local[0] + "e2e/fixtures/qr-scanner.html?image");
    await page.getByRole("button", { name: "Open scanner" }).click();
    await expect(page.getByRole("button", { name: "打开摄像头", exact: true })).toHaveCount(0);
    const transfer = await page.evaluateHandle(async url => {
      const bytes = await (await fetch(url)).blob(), data = new DataTransfer();
      data.items.add(new File([bytes], "screenshot.png", { type: "image/png" })); return data;
    }, await QRCode.toDataURL(pairingLink(payload)));
    const target = page.locator(".scanner-description");
    if (method === "paste") {
      // Paste with focus on the dialog title, as immediately after opening.
      await page.getByRole("heading", { name: "导入二维码图片", exact: true }).evaluate((node, data) => node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: data })), transfer);
    } else await target.dispatchEvent("drop", { dataTransfer: transfer });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator("output")).toHaveText(JSON.stringify(payload));
    await transfer.dispose();
  } finally { await server.close(); }
});
