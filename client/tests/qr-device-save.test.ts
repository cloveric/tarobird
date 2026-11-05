import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: "android", nativePlatform: true, save: vi.fn(), exported: vi.fn() }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.nativePlatform, getPlatform: () => native.platform },
  registerPlugin: (name: string) => name === "TaroBotQrPhotos" ? { save: native.save } : {},
}));
vi.mock("../src/attachment-export.js", () => ({ exportAttachment: native.exported }));
const { HoldTracker } = await import("../src/qr-hold.js");
const { qrImageName, qrPngBase64, qrSaveError, qrSaveLabel, qrSaveTarget, saveQrImage } = await import("../src/qr-photo-save.js");

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
function timers() {
  const queue: { run: () => void; cleared: boolean }[] = [];
  return { queue, timers: { set: (run: () => void) => { const entry = { run, cleared: false }; queue.push(entry); return entry; }, clear: (entry: unknown) => { (entry as { cleared: boolean }).cleared = true; } }, fire: () => queue.filter(entry => !entry.cleared).forEach(entry => entry.run()) };
}
beforeEach(() => { native.platform = "android"; native.nativePlatform = true; native.save.mockReset(); native.exported.mockReset(); });

it("a still hold opens once; movement, scroll and a new press cancel the old hold", () => {
  const held = vi.fn(), clock = timers(), tracker = new HoldTracker(held, clock.timers);
  tracker.down(1, { x: 10, y: 10 }, 100); tracker.move(1, { x: 15, y: 16 }); clock.fire();
  expect(held).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 10 }); expect(tracker.active).toBe(false);
  held.mockClear(); tracker.down(1, { x: 10, y: 10 }, 100); tracker.move(1, { x: 10, y: 22 }); clock.fire(); expect(held).not.toHaveBeenCalled();
  tracker.down(2, { x: 10, y: 10 }, 100); tracker.scroll(89); clock.fire(); expect(held).not.toHaveBeenCalled();
  tracker.down(3, { x: 10, y: 10 }, 100); tracker.move(4, { x: 90, y: 90 }); tracker.scroll(105); clock.fire(); expect(held).toHaveBeenCalledOnce();
  held.mockClear(); tracker.down(5, { x: 0, y: 0 }, 0); tracker.cancel(); clock.fire(); expect(held).not.toHaveBeenCalled();
});

it("names and image data follow the native savers' bounded contract", () => {
  expect(qrImageName(new Date(2026, 9, 28, 1, 2, 3))).toBe("TaroBot-QR-20261028-010203.png");
  expect(qrPngBase64(png)).toMatch(/^iVBORw0KGgo/);
  for (const bad of ["data:image/jpeg;base64,/9j/4AAQ", "data:image/png;base64,abc*", `data:image/png;base64,${"A".repeat(700_000)}`, "https://example.com/qr.png"]) expect(() => qrPngBase64(bad)).toThrow("photos_image_invalid");
});

it("phones save to Photos only on a native receipt; denial and failure are never success", async () => {
  expect(qrSaveTarget()).toBe("photos"); expect(qrSaveLabel()).toBe("保存到相册");
  native.save.mockResolvedValueOnce({ saved: true });
  await expect(saveQrImage(png, "photos", "TaroBot-QR-20261028-010203.png")).resolves.toEqual({ saved: true, delivery: "photos" });
  expect(native.save).toHaveBeenCalledExactlyOnceWith({ data: qrPngBase64(png), name: "TaroBot-QR-20261028-010203.png" });
  native.save.mockResolvedValueOnce({});
  await expect(saveQrImage(png, "photos")).rejects.toThrow("photos_save_failed");
  native.save.mockRejectedValueOnce(new Error("photos_permission_denied"));
  const denied = await saveQrImage(png, "photos").catch((error: unknown) => error);
  expect(qrSaveError(denied, "photos")).toContain("未获得添加照片的权限");
  expect(native.exported).not.toHaveBeenCalled();
});

it("desktop and browsers use the file saver, never the album wording, and a dismissed dialog is not saved", async () => {
  native.nativePlatform = false; native.platform = "web";
  expect(qrSaveTarget()).toBe("file"); expect(qrSaveLabel()).toBe("保存二维码图片");
  native.exported.mockResolvedValueOnce(false);
  await expect(saveQrImage(png, "file", "TaroBot-QR-20261028-010203.png")).resolves.toEqual({ saved: false });
  native.exported.mockImplementationOnce(async (_blob: Blob, _name: string, report: { delivered?: (delivery: string, path?: string, location?: string) => void }) => { report.delivered?.("saved", "/tmp/qr.png", "下载/TaroBot-QR.png"); return true; });
  await expect(saveQrImage(png, "file")).resolves.toEqual({ saved: true, delivery: "saved", location: "下载/TaroBot-QR.png" });
  const [blob, name] = native.exported.mock.calls[0]!;
  expect((blob as Blob).type).toBe("image/png"); expect(name).toBe("TaroBot-QR-20261028-010203.png");
  expect(qrSaveError(new Error("磁盘空间不足"), "file")).toBe("磁盘空间不足");
  expect(native.save).not.toHaveBeenCalled();
});
