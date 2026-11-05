/** Stable, non-sensitive metadata for the native desktop bootstrap. Keep this
 * dependency-free so a failed host-module import can still report its cause. */
const errorCodes = new Set([
  "HOST_DIRECTORY_REDIRECTED", "HOST_DIRECTORY_SHADOW_ONLY", "HOST_DIRECTORY_CONFLICT", "HOST_DIRECTORY_INCOMPLETE", "HOST_DIRECTORY_PROBE_FAILED", "HOST_DIRECTORY_FOREIGN_RUNTIME", "HOST_DIRECTORY_RUNTIME_UPDATE_REQUIRED",
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_IMPORT_NOT_DEFINED", "ERR_REQUIRE_ESM",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_URL", "ERR_STREAM_PREMATURE_CLOSE",
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EINVAL", "EBUSY", "EADDRINUSE", "EIO",
  "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_ERROR",
]);
const errorKinds = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "ZodError"]);
export type DesktopStartupPhase = "desktop_module" | "desktop_command";

export function desktopStartupError(error: unknown, phase: DesktopStartupPhase): string {
  let current = error, code: string | undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const candidate = "code" in current ? current.code : undefined;
    if (typeof candidate === "string" && errorCodes.has(candidate)) { code = candidate; break; }
    current = "cause" in current ? current.cause : undefined;
  }
  const name = error instanceof Error ? error.name : undefined;
  return `TAROBOT_STARTUP_V1|phase=${phase}${code ? `|error=${code}` : ""}${name && errorKinds.has(name) ? `|kind=${name}` : ""}`;
}
