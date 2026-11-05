// Export only stable codes and numeric OS/exit status. Raw stderr may contain
// private paths, URLs, credentials or user data and stays out of the WebView.
pub fn io_error(code: &str, error: &std::io::Error) -> String {
    match error.raw_os_error() {
        Some(value) => format!("{code}|os={value}"),
        None => code.to_owned(),
    }
}

pub fn operation_error(exit: Option<i32>, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(&stderr[..stderr.len().min(65_536)]);
    // The JS entrypoint's human message can omit error.code or be localized.
    // Accept only allowlisted fields from its dependency-free bootstrap marker.
    let metadata = text.lines().find_map(|line| line.strip_prefix("TAROBOT_STARTUP_V1|"));
    let field = |key: &str| metadata.and_then(|line| line.split('|').find_map(|part| part.strip_prefix(key)));
    let error = field("error=").filter(|value| matches!(*value,
        "HOST_DIRECTORY_REDIRECTED" | "HOST_DIRECTORY_SHADOW_ONLY" | "HOST_DIRECTORY_CONFLICT" | "HOST_DIRECTORY_INCOMPLETE" | "HOST_DIRECTORY_PROBE_FAILED" | "HOST_DIRECTORY_FOREIGN_RUNTIME" | "HOST_DIRECTORY_RUNTIME_UPDATE_REQUIRED" |
        "ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND" | "ERR_DLOPEN_FAILED" | "ERR_UNSUPPORTED_ESM_URL_SCHEME" |
        "ERR_PACKAGE_PATH_NOT_EXPORTED" | "ERR_PACKAGE_IMPORT_NOT_DEFINED" | "ERR_REQUIRE_ESM" |
        "ERR_INVALID_ARG_TYPE" | "ERR_INVALID_ARG_VALUE" | "ERR_INVALID_URL" | "ERR_STREAM_PREMATURE_CLOSE" |
        "EACCES" | "EPERM" | "ENOENT" | "ENOTDIR" | "EISDIR" | "EINVAL" | "EBUSY" | "EADDRINUSE" | "EIO" |
        "SQLITE_CORRUPT" | "SQLITE_NOTADB" | "SQLITE_CANTOPEN" | "SQLITE_BUSY" | "SQLITE_LOCKED" | "SQLITE_ERROR"));
    let phase = field("phase=").filter(|value| matches!(*value, "desktop_module" | "desktop_command"));
    let kind = field("kind=").filter(|value| matches!(*value, "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "AggregateError" | "ZodError"));
    let known_reason = match error {
        Some("HOST_DIRECTORY_REDIRECTED") => Some("state_redirected"),
        Some("HOST_DIRECTORY_SHADOW_ONLY") => Some("state_shadow_only"),
        Some("HOST_DIRECTORY_CONFLICT") => Some("state_conflict"),
        Some("HOST_DIRECTORY_INCOMPLETE") => Some("state_incomplete"),
        Some("HOST_DIRECTORY_PROBE_FAILED") => Some("state_probe_failed"),
        Some("HOST_DIRECTORY_FOREIGN_RUNTIME") => Some("state_foreign_runtime"),
        Some("HOST_DIRECTORY_RUNTIME_UPDATE_REQUIRED") => Some("state_runtime_update_required"),

        Some("ERR_MODULE_NOT_FOUND" | "MODULE_NOT_FOUND") => Some("module_missing"),
        Some("ERR_DLOPEN_FAILED") => Some("native_module_failed"),
        Some("ERR_UNSUPPORTED_ESM_URL_SCHEME") => Some("module_url_invalid"),
        Some("EACCES" | "EPERM") => Some("permission_denied"),
        Some("ENOENT") => Some("file_missing"),
        Some("EBUSY" | "EADDRINUSE") => Some("resource_busy"),
        Some("SQLITE_CORRUPT" | "SQLITE_NOTADB") => Some("database_corrupt"),
        Some("SQLITE_CANTOPEN") => Some("database_unavailable"),
        Some("SQLITE_BUSY" | "SQLITE_LOCKED") => Some("database_busy"),
        Some("SQLITE_ERROR") => Some("database_schema_invalid"),
        _ => None,
    };
    let reason = if let Some(reason) = known_reason { reason }
    else if text.contains("desktop_host_update_required") || text.contains("host_control_operation_unsupported") {
        "runtime_update_required"
    } else if text.contains("desktop_controller_proof_invalid") || text.contains("desktop_controller_identity_invalid") {
        "controller_proof_rejected"
    } else if text.contains("ERR_MODULE_NOT_FOUND") || text.contains("Cannot find module") || text.contains("Cannot find package") {
        "module_missing"
    } else if text.contains("ERR_DLOPEN_FAILED") || text.contains("Could not locate the bindings file") || text.contains("not a valid Win32 application") {
        "native_module_failed"
    } else if text.contains("EACCES") || text.contains("EPERM") {
        "permission_denied"
    } else if text.contains("SQLITE_CORRUPT") || text.contains("SQLITE_NOTADB") {
        "database_corrupt"
    } else if text.contains("SQLITE_CANTOPEN") {
        "database_unavailable"
    } else if text.contains("SQLITE_BUSY") || text.contains("SQLITE_LOCKED") {
        "database_busy"
    } else if text.contains("SQLITE_ERROR") || text.contains("unsupported_hub_schema_version") {
        "database_schema_invalid"
    } else if text.contains("unsafe_hub_control_key") {
        "control_key_unsafe"
    } else if text.contains("invalid_hub_control_key") {
        "control_key_invalid"
    } else if text.contains("ENOENT") {
        "file_missing"
    } else if text.contains("hub_control_timeout") {
        "control_timeout"
    } else if text.contains("hub_control_closed") {
        "control_closed"
    } else if text.contains("invalid_hub_control") {
        "control_response_invalid"
    } else if text.contains("EBUSY") || text.contains("EADDRINUSE") {
        "resource_busy"
    } else if text.contains("desktop_host_start_failed") || text.contains("Hub did not become ready") {
        "host_not_ready"
    } else if text.contains("desktop_host_selected_runtime_failed") {
        "selected_runtime_failed"
    } else if text.contains("ERR_UNSUPPORTED_ESM_URL_SCHEME") || text.contains("Only URLs with a scheme in:") {
        "module_url_invalid"
    } else if text.contains("ZodError") || (text.trim_start().starts_with('[') && text.contains("\"code\":") && text.contains("\"path\":") && text.contains("\"message\":")) {
        "state_validation_failed"
    } else { "unknown" };
    let mut code = "desktop_host_operation_failed".to_owned();
    if let Some(value) = exit { code.push_str(&format!("|exit={value}")); }
    code.push_str(&format!("|reason={reason}"));
    if let Some(value) = error { code.push_str(&format!("|error={value}")); }
    if let Some(value) = phase { code.push_str(&format!("|phase={value}")); }
    if let Some(value) = kind { code.push_str(&format!("|kind={value}")); }
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_keep_exit_and_os_codes_without_private_stderr() {
        assert_eq!(io_error("desktop_host_launch_failed", &std::io::Error::from_raw_os_error(5)), "desktop_host_launch_failed|os=5");
        assert_eq!(operation_error(Some(-1073741515), b"private path and secret"), "desktop_host_operation_failed|exit=-1073741515|reason=unknown");
        for (raw, reason) in [
            ("desktop_host_update_required: private path", "runtime_update_required"),
            ("host_control_operation_unsupported: private key", "runtime_update_required"),
            ("desktop_controller_proof_invalid: private proof", "controller_proof_rejected"),
            ("desktop_controller_identity_invalid: private key", "controller_proof_rejected"),
            ("Cannot find package 'private-name' imported from C:\\Users\\private", "module_missing"),
            ("ERR_DLOPEN_FAILED: private path", "native_module_failed"),
            ("EACCES: secret path", "permission_denied"),
            ("SQLITE_CANTOPEN: private path", "database_unavailable"),
            ("SQLITE_NOTADB: private content", "database_corrupt"),
            ("SQLITE_BUSY: secret", "database_busy"),
            ("unsafe_hub_control_key", "control_key_unsafe"),
            ("invalid_hub_control_key", "control_key_invalid"),
            ("ENOENT: private path", "file_missing"),
            ("SQLITE_ERROR: no such table: private", "database_schema_invalid"),
            ("hub_control_timeout", "control_timeout"),
            ("hub_control_closed", "control_closed"),
            ("invalid_hub_control", "control_response_invalid"),
            ("EBUSY private path", "resource_busy"),
            ("EADDRINUSE private address", "resource_busy"),
            ("Hub did not become ready. Inspect hub service logs.", "host_not_ready"),
            ("desktop_host_selected_runtime_failed", "selected_runtime_failed"),
            ("Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'c:'", "module_url_invalid"),
            ("[{\"code\":\"invalid_type\",\"path\":[\"private\"],\"message\":\"private value\"}]", "state_validation_failed"),
        ] {
            assert_eq!(operation_error(Some(1), raw.as_bytes()), format!("desktop_host_operation_failed|exit=1|reason={reason}"));
        }
        assert_eq!(operation_error(None, &[255, 255]), "desktop_host_operation_failed|reason=unknown");
    }

    #[test]
    fn bootstrap_codes_survive_localized_messages_without_disclosing_them() {
        let stderr = "TAROBOT_STARTUP_V1|phase=desktop_module|error=ERR_DLOPEN_FAILED|kind=Error\r\n找不到指定的模块。C:\\Users\\private\\secret.node\r\n";
        assert_eq!(operation_error(Some(1), stderr.as_bytes()), "desktop_host_operation_failed|exit=1|reason=native_module_failed|error=ERR_DLOPEN_FAILED|phase=desktop_module|kind=Error");
        let stderr = "TAROBOT_STARTUP_V1|phase=desktop_command|error=private-code|kind=private-name\nprivate data";
        assert_eq!(operation_error(Some(1), stderr.as_bytes()), "desktop_host_operation_failed|exit=1|reason=unknown|phase=desktop_command");
        assert_eq!(operation_error(Some(1), b"TAROBOT_STARTUP_V1|phase=private|kind=TypeError"), "desktop_host_operation_failed|exit=1|reason=unknown|kind=TypeError");
    }

    #[test]
    fn directory_failures_keep_only_the_safe_classification() {
        for reason in ["redirected", "shadow_only", "conflict", "incomplete", "probe_failed", "foreign_runtime", "runtime_update_required"] {
            let error = format!("HOST_DIRECTORY_{}", reason.to_uppercase());
            let stderr = format!("TAROBOT_STARTUP_V1|phase=desktop_command|error={error}|kind=Error\nprivate path and credential");
            let result = operation_error(Some(78), stderr.as_bytes());
            assert_eq!(result, format!("desktop_host_operation_failed|exit=78|reason=state_{reason}|error={error}|phase=desktop_command|kind=Error"));
        }
    }
}
