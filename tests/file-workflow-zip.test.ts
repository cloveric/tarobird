import { crc32 } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, expect, it } from "vitest";
import { prepareAttachmentWorkflow, prepareArchiveContinueWorkflow } from "../src/runtime/file-workflow.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const lossless = { efs: false, encode: (s: string) => Buffer.from(s, "latin1"), decode: (b: Uint8Array) => Buffer.from(b).toString("latin1") };
function archive(entries: Array<{ raw: Buffer; name?: string; text: string; invalidCrc?: boolean }>) {
  const zip = new AdmZip(undefined, { decoder: lossless });
  for (const item of entries) {
    const entry = zip.addFile(item.raw.toString("latin1"), Buffer.from(item.text));
    if (item.name) {
      const name = Buffer.from(item.name), extra = Buffer.alloc(9 + name.length);
      extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(5 + name.length, 2); extra[4] = 1;
      extra.writeUInt32LE(item.invalidCrc ? 0 : crc32(item.raw), 5); name.copy(extra, 9); entry.extra = extra;
    }
  }
  return zip.toBuffer();
}
async function prepare(bytes: Buffer) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zip-workflow-")); roots.push(root);
  const source = path.join(root, "documents.zip"); await writeFile(source, bytes);
  const stateDir = path.join(root, "state"), uploadsDir = path.join(root, "uploads");
  return { root, source, stateDir, uploadsDir, run: () => prepareAttachmentWorkflow({ stateDir, uploadsDir, chatId: 101, userId: 202, text: "Review the documents", downloadedAttachments: [{ localPath: source, attachment: { kind: "document", fileId: "zip", fileName: "documents.zip" } }] }) };
}

it("reads distinct legacy Chinese names with valid Unicode path fields, then continues with both intact", async () => {
  const fixture = await prepare(archive([
    { raw: Buffer.from("c4bfc2bc2fbcd72e646f6378", "hex"), name: "目录/甲.docx", text: "first document" },
    { raw: Buffer.from("c4bfc2bc2fd2d22e646f6378", "hex"), name: "目录/乙.docx", text: "second document" },
  ]));
  const result = await fixture.run();
  expect(result?.kind).toBe("reply");
  expect(result?.text).toContain("甲.docx"); expect(result?.text).toContain("乙.docx");
  const continued = await prepareArchiveContinueWorkflow({ stateDir: fixture.stateDir, chatId: 101, text: `/continue --upload ${result!.workflowRecordId}`, locale: "zh" });
  expect(continued?.kind).toBe("direct");
  const folder = path.join(fixture.uploadsDir, result!.workflowRecordId!, "extracted", "目录");
  expect((await readdir(folder)).sort()).toEqual(["乙.docx", "甲.docx"]);
  expect(await readFile(path.join(folder, "甲.docx"), "utf8")).toBe("first document");
  expect(await readFile(path.join(folder, "乙.docx"), "utf8")).toBe("second document");
});

it.each([
  { label: "GBK without Unicode metadata", raw: Buffer.from("d7cac1cf2e747874", "hex"), expected: "资料.txt" },
  { label: "unflagged UTF-8", raw: Buffer.from("资料-🙂.txt"), expected: "资料-🙂.txt" },
  { label: "CP437", raw: Buffer.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), expected: "café.txt" },
])("reads $label filenames without losing bytes", async ({ raw, expected }) => {
  const fixture = await prepare(archive([{ raw, text: "exact contents" }]));
  const result = await fixture.run();
  expect(await readFile(path.join(fixture.uploadsDir, result!.workflowRecordId!, "extracted", expected), "utf8")).toBe("exact contents");
});

it("reads flagged UTF-8 and ignores Unicode metadata whose filename CRC does not match", async () => {
  const zip = new AdmZip(); zip.addFile("folder/中文-🙂.txt", Buffer.from("utf8"));
  const a = await prepare(zip.toBuffer()), result = await a.run();
  expect(await readFile(path.join(a.uploadsDir, result!.workflowRecordId!, "extracted", "folder/中文-🙂.txt"), "utf8")).toBe("utf8");
  const b = await prepare(archive([{ raw: Buffer.from("plain.txt"), name: "../outside.txt", invalidCrc: true, text: "original name" }]));
  const second = await b.run();
  expect(await readFile(path.join(b.uploadsDir, second!.workflowRecordId!, "extracted", "plain.txt"), "utf8")).toBe("original name");
});

it.each(["../escape.txt", "..\\escape.txt", "/absolute.txt", "C:\\outside.txt", "safe/../../escape.txt"])("refuses unsafe Unicode paths: %s", async name => {
  const fixture = await prepare(archive([{ raw: Buffer.from("safe.txt"), name, text: "never write" }]));
  await expect(fixture.run()).rejects.toMatchObject({ cause: { code: "path" } });
  const upload = (await readdir(fixture.uploadsDir))[0]!;
  await expect(readdir(path.join(fixture.uploadsDir, upload, "extracted"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readFile(fixture.source)).length).toBeGreaterThan(0);
});

it.each(["same.txt", "SAME.txt", "./same.txt"])("refuses decoded destination collisions: %s", async name => {
  const fixture = await prepare(archive([
    { raw: Buffer.from("a.txt"), name: "same.txt", text: "first" },
    { raw: Buffer.from("b.txt"), name, text: "second" },
  ]));
  await expect(fixture.run()).rejects.toMatchObject({ cause: { code: "duplicate" } });
});

it("reports encrypted, corrupt, and oversized archives with specific bilingual guidance", async () => {
  const { renderCoreUserFacingError } = await import("../src/core/errors.js");
  const original = archive([{ raw: Buffer.from("safe.txt"), text: "small" }]);
  for (const [kind, mutate, zh, en] of [
    ["encrypted", (b: Buffer) => { b.writeUInt16LE(1, 6); b.writeUInt16LE(1, b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8); }, "密码", "password"],
    ["limit", (b: Buffer) => { b.writeUInt32LE(501 * 1024 * 1024, b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 24); }, "500 MiB", "500 MiB"],
    ["invalid", (b: Buffer) => { b.fill(0); }, "无法完整读取", "could not be read"],
  ] as const) {
    const bytes = Buffer.from(original); mutate(bytes);
    const fixture = await prepare(bytes);
    const error = await fixture.run().then(() => undefined, error => error);
    expect(error).toMatchObject({ cause: { code: kind } });
    expect(renderCoreUserFacingError(error, "prepare", "zh")).toContain(zh);
    expect(renderCoreUserFacingError(error, "prepare", "en")).toContain(en);
  }
});

it.skipIf(process.platform === "win32")("preserves ordinary Unix filenames that are reserved only on Windows", async () => {
  const fixture = await prepare(archive([
    { raw: Buffer.from("src/aux.c"), text: "source" },
    { raw: Buffer.from("notes 10:30.txt"), text: "note" },
  ]));
  const result = await fixture.run(), extracted = path.join(fixture.uploadsDir, result!.workflowRecordId!, "extracted");
  expect(await readFile(path.join(extracted, "src/aux.c"), "utf8")).toBe("source");
  expect(await readFile(path.join(extracted, "notes 10:30.txt"), "utf8")).toBe("note");
});

it("ignores a harmless archive root directory entry", async () => {
  const fixture = await prepare(archive([{ raw: Buffer.from("./"), text: "" }, { raw: Buffer.from("readme.txt"), text: "root file" }]));
  const result = await fixture.run();
  expect(await readFile(path.join(fixture.uploadsDir, result!.workflowRecordId!, "extracted", "readme.txt"), "utf8")).toBe("root file");
});


it.skipIf(process.platform !== "win32")("refuses Windows device names and alternate data streams before writing", async () => {
  for (const name of ["folder/NUL.txt", "src/aux.c", "CONIN$", "COM¹.txt", "file.txt:stream"]) {
    const fixture = await prepare(archive([{ raw: Buffer.from("safe.txt"), name, text: "never write" }]));
    await expect(fixture.run()).rejects.toMatchObject({ cause: { code: "path" } });
  }
});
