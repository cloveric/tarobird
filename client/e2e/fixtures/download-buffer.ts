import { DownloadBuffer, sweepTemporaryDownloads } from "../../src/download-buffer.js";
import { downloadAttachmentSource } from "../../src/downloads.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAttachment } from "../../src/attachment-export.js";
Object.assign(window, { bufferFixture: { DownloadBuffer, sweepTemporaryDownloads, downloadAttachmentSource, exportAttachment, digest: (bytes: Uint8Array) => bytesToHex(sha256(bytes)) } });
