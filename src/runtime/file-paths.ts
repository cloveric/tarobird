import path from "node:path";
import os from "node:os";

export function isAbsoluteFilePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeFilePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isStaticPlaceholderFilePath(value: string): boolean {
  const normalized = normalizeFilePathForMatch(value);
  return (
    /^\/(?:absolute|abs|example|path)(?:\/|$|\.)/.test(normalized) ||
    normalized === "/path/to" ||
    normalized.startsWith("/path/to/") ||
    /^\/users\/[^/]+\/\.cctb\/example(?:\/|$)/.test(normalized)
  );
}

export function isLikelyCopiedPlaceholderFilePath(value: string): boolean {
  const normalized = normalizeFilePathForMatch(value);
  if (isStaticPlaceholderFilePath(normalized)) {
    return true;
  }

  const baseName = path.posix.basename(normalized);
  return (
    (
      normalized.startsWith("/tmp/") ||
      normalized.startsWith("/private/tmp/") ||
      normalized.startsWith("/var/tmp/") ||
      normalized.startsWith("/var/folders/") ||
      normalized.startsWith(`${normalizeFilePathForMatch(os.tmpdir())}/`)
    ) &&
    /^(?:example|sample|placeholder|absolute|abs|path)(?:[._-]|$)/.test(baseName)
  );
}
