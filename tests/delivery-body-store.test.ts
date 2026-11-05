import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readDeliveryBody, writeDeliveryBody } from "../src/state/delivery-body-store.js";
import { markDeliveryDelivered, readDeliveryObligationContent, readDeliveryObligations, recordDeliveryObligation } from "../src/state/delivery-obligation-store.js";
import { redeliverRecoveredCoreObligations } from "../src/core/delivery-recovery.js";
import { withChannelProfile } from "../src/core/channel-profile.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "delivery-body-")); roots.push(dir); return dir; }
const long = "完整正文🙂\n".repeat(100000) + "\ud800尾部完整";

it("opts only Gateway long replies into exact, private, checksummed bodies and leaves a small index", async () => {
  const dir = await root();
  for (const input of [{ channel: "telegram" as const, chatId: "42", allowLargeContent: true }, { channel: "lark" as const, chatId: "oc_feishu", allowLargeContent: true }, { channel: "lark" as const, chatId: "gw_app" }]) {
    expect(await recordDeliveryObligation(dir, { ...input, content: long })).toBeNull();
  }
  const input = { channel: "lark" as const, chatId: "gw_app", replyTo: "msg_1", content: long, allowLargeContent: true };
  const id = await recordDeliveryObligation(dir, input); expect(id).not.toBeNull();
  const row = (await readDeliveryObligations(dir))[0]!; expect(row.content).toBe(""); expect(row.contentRef).toBeDefined();
  expect(await readDeliveryObligationContent(dir, row)).toBe(long);
  const data = await readFile(path.join(dir, "delivery-bodies", `${row.contentRef!.sha256}.json`));
  expect(row.contentRef).toEqual({ sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length });
  expect((await stat(path.join(dir, "delivery-obligations.json"))).size).toBeLessThan(1500);
  if (process.platform !== "win32") {
    expect((await stat(path.join(dir, "delivery-bodies"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(dir, "delivery-bodies", `${row.contentRef!.sha256}.json`))).mode & 0o777).toBe(0o600);
  }
  expect(await recordDeliveryObligation(dir, input)).toBe(id); expect(await readDeliveryObligations(dir)).toHaveLength(1);
  await recordDeliveryObligation(dir, { ...input, replyTo: "msg_2" }); expect(await readDeliveryObligations(dir)).toHaveLength(2); expect(await readdir(path.join(dir, "delivery-bodies"))).toHaveLength(1);
  await expect(readDeliveryObligationContent(dir, { ...row, channel: "telegram" })).rejects.toThrow("destination_invalid");
});

it("never treats a missing, tampered or redirected body as an empty recovered reply", async () => {
  const dir = await root(), ref = await writeDeliveryBody(dir, long), file = path.join(dir, "delivery-bodies", `${ref.sha256}.json`);
  const data = await readFile(file); data[0] = 120; await writeFile(file, data);
  await expect(readDeliveryBody(dir, ref)).rejects.toThrow("checksum_mismatch");
  await writeFile(file, "short"); await expect(readDeliveryBody(dir, ref)).rejects.toThrow("size_mismatch");
  await rm(file); await expect(readDeliveryBody(dir, ref)).rejects.toThrow();
  const outside = path.join(dir, "outside.json"); await writeFile(outside, JSON.stringify(long)); await symlink(outside, file);
  await expect(readDeliveryBody(dir, ref)).rejects.toThrow();
  await expect(readDeliveryBody(dir, { ...ref, sha256: "../outside" })).rejects.toThrow("reference_invalid");
  await expect(readDeliveryBody(dir, { ...ref, bytes: -1 })).rejects.toThrow("reference_invalid");
  await rm(path.join(dir, "delivery-bodies"), { recursive: true }); await mkdir(path.join(dir, "outside")); await symlink(path.join(dir, "outside"), path.join(dir, "delivery-bodies"));
  await expect(writeDeliveryBody(dir, long)).rejects.toThrow("directory_invalid");
  expect(await recordDeliveryObligation(dir, { channel: "lark", chatId: "gw_app", allowLargeContent: true, content: long })).toBeNull();
  expect(await lstat(outside)).toBeDefined();
});

it("retains all referenced/shared bodies and young crash orphans while pruning only expired owned blobs", async () => {
  const dir = await root();
  const id = await recordDeliveryObligation(dir, { channel: "lark", chatId: "gw_app", allowLargeContent: true, content: long });
  const row = (await readDeliveryObligations(dir))[0]!, rootDir = path.join(dir, "delivery-bodies"), file = path.join(rootDir, `${row.contentRef!.sha256}.json`);
  const old = new Date(Date.now() - 8 * 86400000), expired = await writeDeliveryBody(dir, "old orphan"), young = await writeDeliveryBody(dir, "young orphan");
  const oldFile = path.join(rootDir, `${expired.sha256}.json`), youngFile = path.join(rootDir, `${young.sha256}.json`);
  const unrelated = path.join(rootDir, "notes.txt"); await writeFile(unrelated, "keep operator content");
  await utimes(file, old, old); await utimes(oldFile, old, old); await utimes(unrelated, old, old);
  await markDeliveryDelivered(dir, id!);
  expect(await readDeliveryObligationContent(dir, (await readDeliveryObligations(dir))[0]!)).toBe(long);
  await expect(stat(oldFile)).rejects.toThrow(); expect(await stat(youngFile)).toBeDefined(); expect(await readFile(unrelated, "utf8")).toBe("keep operator content");
  // Once its settled index row expires, the same old body may be collected.
  await writeFile(path.join(dir, "delivery-obligations.json"), JSON.stringify({ obligations: [{ ...row, state: "delivered", updatedAt: old.getTime() }] }));
  await recordDeliveryObligation(dir, { channel: "lark", chatId: "gw_app", content: "new short reply" });
  await expect(stat(file)).rejects.toThrow(); expect(await stat(youngFile)).toBeDefined();
});

it("records a failed recovery without sending a success or empty replacement when a body is missing", async () => {
  const dir = await root(); await recordDeliveryObligation(dir, { channel: "lark", chatId: "gw_app", allowLargeContent: true, content: long });
  const row = (await readDeliveryObligations(dir))[0]!;
  await writeFile(path.join(dir, "delivery-obligations.json"), JSON.stringify({ obligations: [{ ...row, ownerPid: 99999999, updatedAt: Date.now() - 60000 }] }));
  await rm(path.join(dir, "delivery-bodies", `${row.contentRef!.sha256}.json`));
  const send = vi.fn(async () => ({ messageId: "must not send" }));
  const result = await redeliverRecoveredCoreObligations({ stateDir: dir, locale: "zh", channel: { profile: "gateway", send, inConversation: (_id, operation) => withChannelProfile("gateway", operation) } });
  expect(result).toEqual({ recovered: 0, failed: 1, abandoned: 0 }); expect(send).not.toHaveBeenCalled();
  expect((await readDeliveryObligations(dir))[0]).toMatchObject({ state: "failed", attempts: 1 });
});
