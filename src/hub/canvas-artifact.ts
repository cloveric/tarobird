import { open } from "node:fs/promises";
import path from "node:path";
import { HubError } from "./store.js";

const releaseAsset = "https://github.com/cloveric/tarobird/releases/download/infinite-canvas-v1.0.0/infinite-canvas-1.0.0.html";
const maximum = 64 * 1024 * 1024;
let pendingDownload: Promise<Buffer> | undefined;

async function download(): Promise<Buffer> {
  const signal = AbortSignal.timeout(90_000);
  const options: RequestInit = { signal, redirect: "manual", credentials: "omit" };
  let response = await fetch(releaseAsset, options);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location") ?? "", releaseAsset);
    await response.body?.cancel();
    if (location.origin !== "https://release-assets.githubusercontent.com" || location.username || location.password) throw new HubError("plugin_download_failed", 502);
    response = await fetch(location, options);
  }
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new HubError("plugin_artifact_unavailable", 503);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new HubError("plugin_artifact_too_large", 502);
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, size);
}

export async function readCanvasArtifact(root: string): Promise<Buffer> {
  const file = await open(path.join(root, "tarobird.infinite-canvas", "1.0.0", "bundle.html"), "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (file) {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw new HubError("plugin_artifact_invalid", 503);
      return await file.readFile();
    } finally { await file.close(); }
  }
  pendingDownload ??= download().finally(() => { pendingDownload = undefined; });
  return pendingDownload;
}
