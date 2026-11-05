import { test, expect } from "@playwright/test";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { exportAttachment, openAttachmentExternally, openSavedAttachment, shareAttachment } from "../src/attachment-export.js";
let platform = "android", fail = "", opened: any[] = [], shared: any[] = [], saved: any[] = [], cancelSave = false, removed: string[] = [], current = "";
const files = new Map<string, Uint8Array>();
registerPlugin("Filesystem", { web: async () => filesystem, android: async () => filesystem, ios: async () => filesystem });
registerPlugin("Share", { web: async () => share, android: async () => share, ios: async () => share });
registerPlugin("TaroBotAttachmentOpener", { web: async () => ({ open: async (args: any) => { if (fail) throw new Error(fail); opened.push(args); } }) });
registerPlugin("TaroBotAttachmentSaver", { web: async () => ({ save: async (args: any) => { if (fail) throw new Error(fail); saved.push(args); return { saved: !cancelSave, location: "Download/TaroBird/book.xlsx", uri: "content://media/external/downloads/42" }; }, openSaved: async (args: any) => { if (fail) throw new Error(fail); opened.push(args); } }) });
const filesystem = {
  readdir: async () => ({ files: [{ name: "1-abc", type: "directory" }] }),
  rmdir: async ({ path }: any) => { removed.push(path); }, mkdir: async () => {},
  writeFile: async ({ path }: any) => { current = path; files.set(path, new Uint8Array()); },
  appendFile: async ({ path, data }: any) => { const old = files.get(path)!; const next = new Uint8Array(old.length + Buffer.from(data, "base64").length); next.set(old); next.set(Buffer.from(data, "base64"), old.length); files.set(path, next); },
  getUri: async ({ path }: any) => ({ uri: `file:///cache/${path}` }),
};
const share = { share: async (args: any) => { if (fail) throw new Error(fail); shared.push(args); } };
const originalPlatform = Capacitor.getPlatform, originalNative = Capacitor.isNativePlatform;
test.beforeEach(() => { Capacitor.getPlatform = () => platform; Capacitor.isNativePlatform = () => true; platform = "android"; fail = ""; opened = []; shared = []; saved = []; cancelSave = false; removed = []; files.clear(); });
test.afterEach(() => { Capacitor.getPlatform = originalPlatform; Capacitor.isNativePlatform = originalNative; });
test("Android hands an exact cached copy and MIME to the reader chooser without sharing credentials", async () => {
  const bytes = Uint8Array.from({ length: 1024*1024+71 }, (_, i) => i % 251), stages: string[] = [];
  expect(await openAttachmentExternally(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "../../分类账本.xlsx", { stage: value => stages.push(value), delivered: value => stages.push(value) })).toBe(true);
  expect(files.get(current)).toEqual(bytes); expect(current).toMatch(/^tarocub-exports\/\d+-[a-f0-9-]+\/分类账本.xlsx$/);
  expect(opened).toEqual([{ uri: `file:///cache/${current}`, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "用其他应用打开" }]);
  expect(stages).toEqual(["preparing", "opening", "opened"]); expect(shared).toEqual([]); expect(removed).toEqual(["tarocub-exports/1-abc"]);
});
test("missing reader reports no handoff and cleans only this copy", async () => {
  fail = "attachment_reader_missing"; const delivered: string[] = [];
  await expect(openAttachmentExternally(new Blob(["example"]), "book.xlsx", { delivered: value => delivered.push(value) })).rejects.toThrow("请安装对应的阅读应用");
  expect(delivered).toEqual([]); expect(removed.at(-1)).toBe(current.slice(0,current.lastIndexOf("/")));
});
test("iOS open uses its document share sheet; cancellation keeps the copy but claims no save", async () => {
  platform = "ios"; const delivered: string[] = [];
  expect(await openAttachmentExternally(new Blob(["example"]), "book.xlsx", { delivered: value => delivered.push(value) })).toBe(true);
  expect(shared).toHaveLength(1); expect(opened).toEqual([]); expect(delivered).toEqual(["shared"]);
  fail = "Share canceled"; delivered.length = 0;
  expect(await shareAttachment(new Blob(["example"]), "book.xlsx", { delivered: value => delivered.push(value) })).toBe(false);
  expect(delivered).toEqual([]); expect(removed).toEqual(["tarocub-exports/1-abc", "tarocub-exports/1-abc"]);
});
for (const os of ["android", "ios"]) test(`${os} save writes the exact prepared bytes without opening Share or a reader`, async () => {
  platform = os;
  const bytes = Uint8Array.from({ length: 1024 * 1024 + 37 }, (_, i) => i % 239), deliveries: any[] = [];
  expect(await exportAttachment(new Blob([bytes], { type: "application/octet-stream" }), "../../book.xlsx", { delivered: (...args) => deliveries.push(args) })).toBe(true);
  expect(saved).toEqual([{ uri: `file:///cache/${current}`, mime: "application/octet-stream" }]);
  expect(files.get(current)).toEqual(bytes); expect(shared).toEqual([]); expect(opened).toEqual([]);
  expect(deliveries).toEqual([["saved", os === "android" ? "content://media/external/downloads/42" : undefined, "Download/TaroBird/book.xlsx"]]);
  expect(removed.at(-1)).toBe(current.slice(0, current.lastIndexOf("/")));
});
test("share is an independent action and retains the temporary copy for receivers", async () => {
  const deliveries: string[] = [];
  expect(await shareAttachment(new Blob(["share this"]), "book.xlsx", { delivered: value => deliveries.push(value) })).toBe(true);
  expect(shared).toHaveLength(1); expect(saved).toEqual([]); expect(deliveries).toEqual(["shared"]);
  expect(removed).toEqual(["tarocub-exports/1-abc"]);
});
test("failed or cancelled native save never claims success or falls back to sharing", async () => {
  const deliveries: string[] = [];
  fail = "disk full";
  await expect(exportAttachment(new Blob(["save this"]), "book.xlsx", { delivered: value => deliveries.push(value) })).rejects.toThrow("保存失败");
  expect(removed.at(-1)).toBe(current.slice(0, current.lastIndexOf("/")));
  fail = ""; cancelSave = true;
  expect(await exportAttachment(new Blob(["save this"]), "book.xlsx", { delivered: value => deliveries.push(value) })).toBe(false);
  expect(deliveries).toEqual([]); expect(shared).toEqual([]);
});

test("Android opens only the native receipt without preparing another cached copy", async () => {
  await openSavedAttachment("content://media/external/downloads/42");
  expect(opened).toEqual([{ uri: "content://media/external/downloads/42" }]);
  expect(files.size).toBe(0); expect(shared).toEqual([]); expect(saved).toEqual([]);
  fail = "attachment_install_permission_required";
  await expect(openSavedAttachment("content://media/external/downloads/42")).rejects.toThrow("允许 TaroBird 安装未知应用");
});
