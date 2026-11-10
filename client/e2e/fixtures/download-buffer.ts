import { DownloadBuffer, memoryAttachment, sweepTemporaryDownloads } from "../../src/download-buffer.js";
import { clearAttachmentDiskCache, forgetCachedAttachments, readCachedAttachment, storeCachedAttachment } from "../../src/attachment-disk-cache.js";
import { downloadAttachmentSource } from "../../src/downloads.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAttachment } from "../../src/attachment-export.js";
Object.assign(window, { bufferFixture: { DownloadBuffer, memoryAttachment, sweepTemporaryDownloads, downloadAttachmentSource, exportAttachment, readCachedAttachment, storeCachedAttachment, clearAttachmentDiskCache, forgetCachedAttachments, digest: (bytes: Uint8Array) => bytesToHex(sha256(bytes)) } });
