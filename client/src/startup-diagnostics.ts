// Startup diagnostics are deliberately code-only. Native stderr can contain
// paths, command arguments and credentials, and must never reach this screen.
const codes = new Set([
  "desktop_host_launch_failed", "desktop_host_operation_failed", "desktop_host_input_failed",
  "desktop_host_timeout", "desktop_host_invalid_response", "desktop_host_runtime_missing",
  "host_resources_unavailable", "host_directory_unavailable", "host_path_unavailable",
]);
const reasons = new Set([
  "runtime_update_required", "controller_proof_rejected",
  "state_redirected", "state_shadow_only", "state_conflict", "state_incomplete", "state_probe_failed", "state_foreign_runtime", "state_runtime_update_required",
  "module_missing", "native_module_failed", "permission_denied", "file_missing",
  "database_unavailable", "database_corrupt", "database_busy", "control_key_invalid",
  "control_key_unsafe", "unknown",
  "database_schema_invalid", "control_timeout", "control_closed", "control_response_invalid",
  "resource_busy", "host_not_ready", "selected_runtime_failed", "module_url_invalid", "state_validation_failed",
]);
const errorCodes = new Set([
  "HOST_DIRECTORY_REDIRECTED", "HOST_DIRECTORY_SHADOW_ONLY", "HOST_DIRECTORY_CONFLICT", "HOST_DIRECTORY_INCOMPLETE", "HOST_DIRECTORY_PROBE_FAILED", "HOST_DIRECTORY_FOREIGN_RUNTIME", "HOST_DIRECTORY_RUNTIME_UPDATE_REQUIRED",
  "ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED", "ERR_UNSUPPORTED_ESM_URL_SCHEME",
  "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_IMPORT_NOT_DEFINED", "ERR_REQUIRE_ESM",
  "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_INVALID_URL", "ERR_STREAM_PREMATURE_CLOSE",
  "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "EINVAL", "EBUSY", "EADDRINUSE", "EIO",
  "SQLITE_CORRUPT", "SQLITE_NOTADB", "SQLITE_CANTOPEN", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_ERROR",
]);
const phases = new Set(["desktop_module", "desktop_command"]);
const kinds = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AggregateError", "ZodError"]);
export type StartupAttempt = { action: "resume" | "status" | "start"; code: string; exit?: number; os?: number; reason?: string; error?: string; phase?: string; kind?: string };

export function startupAttempt(action: StartupAttempt["action"], error: unknown): StartupAttempt {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const [code, ...fields] = raw.split("|");
  const result: StartupAttempt = { action, code: codes.has(code) ? code : "native_request_failed" };
  if (!codes.has(code) || raw.length > 256) return result;
  for (const field of fields) {
    const [key, value] = field.split("=");
    if ((key === "exit" || key === "os") && /^-?\d{1,10}$/.test(value ?? "")) result[key] = Number(value);
    if (key === "reason" && reasons.has(value)) result.reason = value;
    if (key === "error" && errorCodes.has(value)) result.error = value;
    if (key === "phase" && phases.has(value)) result.phase = value;
    if (key === "kind" && kinds.has(value)) result.kind = value;
  }
  return result;
}

export class LocalControllerStartupError extends Error {
  constructor(readonly attempts: StartupAttempt[]) { super("local_controller_unavailable"); }
}
