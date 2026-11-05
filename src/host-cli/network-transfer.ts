import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { networkCanonical, networkCommandResultSchema, networkCommandSchema, type NetworkCommand, type NetworkCommandResult } from "../client-protocol/private-network.js";
import { JsonStore } from "../state/json-store.js";
import { verifyCliNetworkMembership, verifyCliNetworkProposal } from "./network-cli.js";

type TransferRecord = { id: string; status: "prepared" | "complete" | "uncertain"; command: NetworkCommand; createdAt: number;
  outputPath?: string; document?: unknown; result?: NetworkCommandResult; error?: string };
// A durable receipt includes both the request and confirmed result/document,
// with JsonStore formatting. This is larger than any individual wire payload.
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
export class NetworkTransferError extends Error {
  constructor(readonly code: string, readonly receiptPath: string, detail: string) { super(`${detail}\n记录：${receiptPath}`); this.name = "NetworkTransferError"; }
}
function documentFor(command: NetworkCommand, result: NetworkCommandResult): unknown {
  return command.operation === "propose" ? result.proposal
    : command.operation === "admit" ? { membership: result.membership, nonce: command.proposal.proposal.nonce }
    : result;
}

/** Reserve a new output before mutation. Persist every confirmed signed stage
 * before exporting it, so a disk/path error cannot silently discard a nonce. */
export async function executeNetworkTransfer(directory: string, raw: NetworkCommand, outPath: string | undefined,
  execute: () => Promise<NetworkCommandResult>): Promise<{ document: unknown; receiptPath: string; outputPath?: string }> {
  const command = networkCommandSchema.parse(raw);
  if (command.operation === "attest") throw new Error("cli_network_host_controller_only");
  if (command.operation === "admit") verifyCliNetworkProposal(command.proposal);
  if (command.operation === "join") verifyCliNetworkMembership(command.membership);
  const outputPath = outPath === undefined ? undefined : path.resolve(outPath);
  // wx rejects existing files, directories and symlinks without changing them.
  const reserved: FileHandle | undefined = outputPath ? await open(outputPath, "wx", 0o600) : undefined;
  let original: Awaited<ReturnType<FileHandle["stat"]>> | undefined, exported = false;
  const id = randomUUID(), receiptPath = path.join(directory, "cli", "network-transfers", `${id}.json`);
  const store = new JsonStore<TransferRecord>(receiptPath);
  const record: TransferRecord = { id, status: "prepared", command, createdAt: Date.now(), ...(outputPath ? { outputPath } : {}) };
  try {
    original = await reserved?.stat();
    await reserved?.sync();
    await store.write(record); // Failure here must happen before any network write.
    let result: NetworkCommandResult;
    try { result = await execute(); }
    catch (error) {
      // A transport error may occur after server commit. Retain the exact
      // submitted command, including admission/join nonce, without replaying it.
      await store.write({ ...record, status: "uncertain", error: error instanceof Error ? error.message : "network_request_failed" }).catch(() => undefined);
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "network_transfer_request_failed";
      throw new NetworkTransferError(code, receiptPath, `${error instanceof Error ? error.message : "network_request_failed"}。操作未得到可保存的确认；请先检查主机状态，不会自动重试。`);
    }
    const document = documentFor(command, result);
    if (document === undefined) throw new NetworkTransferError("network_transfer_missing_result", receiptPath, "主机没有返回此阶段的签名记录；请检查网络状态，不要直接重复加入。");
    try { await store.write({ ...record, status: "complete", document, result }); }
    catch { throw new NetworkTransferError("network_transfer_persistence_failed", receiptPath, "主机已确认操作，但本机未能保存结果。请先检查网络状态和磁盘，不要直接重复此操作。"); }
    if (reserved) {
      try { await reserved.writeFile(JSON.stringify(document, null, 2) + "\n", "utf8"); await reserved.sync(); exported = true; }
      catch { throw new NetworkTransferError("network_transfer_export_failed", receiptPath, "组网操作已确认，输出文件未写入。请用 network recover --from 此记录 --out 新文件恢复，然后继续下一步。"); }
    }
    return { document, receiptPath, ...(outputPath ? { outputPath } : {}) };
  } finally {
    await reserved?.close();
    if (outputPath && reserved && !exported && original) {
      // Never remove another process's replacement at the same path.
      const current = await lstat(outputPath).catch(() => undefined);
      if (current?.dev === original.dev && current.ino === original.ino) await unlink(outputPath).catch(() => undefined);
    }
  }
}

/** Offline recovery exports the already-confirmed document; it never retries
 * a mutation or fabricates the result of an uncertain request. */
export async function exportNetworkTransfer(receiptFile: string, outFile: string): Promise<{ outputPath: string }> {
  if (!(await lstat(receiptFile)).isFile()) throw new Error("network_transfer_receipt_not_regular");
  const file = await open(receiptFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let raw: Record<string, unknown>;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("network_transfer_receipt_not_regular");
    if (info.size > MAX_RECEIPT_BYTES) throw new Error("network_transfer_receipt_too_large");
    const bytes = Buffer.alloc(info.size + 1); let count = 0;
    while (count < bytes.length) { const chunk = await file.read(bytes, count, bytes.length - count, count); if (!chunk.bytesRead) break; count += chunk.bytesRead; }
    if (count !== info.size) throw new Error("network_transfer_receipt_changed");
    raw = JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { await file.close(); }
  if (raw.status !== "complete") throw new Error("network_transfer_not_confirmed_check_host_status");
  const command = networkCommandSchema.parse(raw.command), result = networkCommandResultSchema.parse(raw.result);
  if (command.operation === "attest") throw new Error("cli_network_host_controller_only");
  if (command.operation === "admit") verifyCliNetworkProposal(command.proposal);
  if (command.operation === "join") verifyCliNetworkMembership(command.membership);
  if (result.view.membership) verifyCliNetworkMembership(result.view.membership, result.view.host.publicKey);
  if (result.membership) verifyCliNetworkMembership(result.membership);
  if (result.proposal) verifyCliNetworkProposal(result.proposal);
  const document = documentFor(command, result);
  if (document === undefined || networkCanonical(document) !== networkCanonical(raw.document)) throw new Error("network_transfer_document_mismatch");
  const outputPath = path.resolve(outFile), target = await open(outputPath, "wx", 0o600);
  const original = await target.stat(); let complete = false;
  try { await target.writeFile(JSON.stringify(document, null, 2) + "\n", "utf8"); await target.sync(); complete = true; }
  finally {
    await target.close();
    if (!complete) { const current = await lstat(outputPath).catch(() => undefined); if (current?.dev === original.dev && current.ino === original.ino) await unlink(outputPath).catch(() => undefined); }
  }
  return { outputPath };
}
