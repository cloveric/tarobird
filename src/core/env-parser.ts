export const CORE_BRIDGE_RUNTIME_ENV_KEYS = [
  "TAROBOT_ALLOW_ANY_FILE_PATH",
  "TAROBOT_INBOUND_FILE_RETENTION_DAYS",
  "TAROBOT_ELEMENT_STREAM",
  "DSH_EXECUTABLE",
  "KIMI_EXECUTABLE",
  "CCTB_LARK_ALLOW_ANY_FILE_PATH",
  "CCTB_LARK_ELEMENT_STREAM",
  "TINGWU_ASR_DIR",
  "ASR_CLOUD_THRESHOLD_SECONDS",
  "ASR_CLOUD_TASK_TIMEOUT_SECONDS",
  "ASR_CLOUD_JOB_RETENTION_DAYS",
  "ASR_MAX_AUDIO_SECONDS",
  "LARK_INBOUND_FILE_RETENTION_DAYS",
] as const;

export function parseCoreEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    const value = parseEnvValue(line.slice(equalsIndex + 1).trim());
    if (isSupportedCoreEnvKey(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Parse the non-whitelisted (extra) keys from a lark.env file — e.g. MCP API tokens
 * like IFIND_TOKEN that the operator added for the engine. Whitelisted Lark keys are
 * excluded (those are owned by loadLarkRuntimeEnv / written by writeLarkEnvFile).
 * Used both to pass extras through to the engine env and to preserve them across the
 * lark.env regeneration that happens on every service start.
 *
 * `dropped` (optional) collects the NAMES of refused keys so the caller can log
 * them — a silently-ignored operator setting is a support trap. Names only: the
 * values are secrets.
 */
export function parseCoreEnvExtras(content: string, dropped?: string[]): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    // Drop whitelisted Lark keys, invalid env-var names, and anything in a reserved
    // bridge namespace. lark.env extras may ONLY carry engine credentials (MCP API
    // tokens like IFIND_TOKEN) — they must never be able to set a variable the bridge
    // itself reads to control its own behaviour (send URL, active-turn state, doc/chat
    // identity, executables, thread ids, telemetry, …) or that changes how the
    // bridge's own PROCESS loads code/certs/proxies.
    if (isSupportedCoreEnvKey(key)) {
      continue;
    }
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      || (isReservedBridgeEnvKey(key) && !isAllowedKimiCredentialEnvKey(key))
    ) {
      dropped?.push(key);
      continue;
    }
    extras[key] = parseEnvValue(line.slice(equalsIndex + 1).trim());
  }
  return extras;
}

function isSupportedCoreEnvKey(key: string): boolean {
  return key === "TAROBOT_ALLOW_ANY_FILE_PATH" ||
    key === "TAROBOT_INBOUND_FILE_RETENTION_DAYS" ||
    key === "TAROBOT_ELEMENT_STREAM" ||
    key === "LARK_APP_ID" ||
    key === "LARK_APP_SECRET" ||
    key === "LARK_DOMAIN" ||
    key === "CCTB_LARK_STATE_DIR" ||
    key === "CCTB_LARK_INSTANCE" ||
    key === "CCTB_LARK_ALLOW_ANY_FILE_PATH" ||
    key === "CCTB_LARK_ELEMENT_STREAM" ||
    key === "LARK_REQUIRE_MENTION_IN_GROUP" ||
    key === "CCTB_LARK_DEBUG" ||
    key === "TAROCUB_INSTANCE" ||
    key === "CODEX_TELEGRAM_INSTANCE" ||
    // Explicitly whitelisted executable settings. The extras path admits only
    // named Kimi API-key variables; DeepSeek and Kimi endpoint/home/header/plugin
    // controls stay reserved so they cannot reconfigure the bridge process.
    key === "DSH_EXECUTABLE" ||
    key === "KIMI_EXECUTABLE" ||
    // Long-audio cloud ASR: whitelisted so lark.env stays the operator-facing
    // config surface, while TINGWU_/ASR_ remain reserved on the EXTRAS path (an
    // extra must never redirect the subprocess the bridge itself spawns).
    key === "TINGWU_ASR_DIR" ||
    key === "ASR_CLOUD_THRESHOLD_SECONDS" ||
    key === "ASR_CLOUD_TASK_TIMEOUT_SECONDS" ||
    key === "ASR_CLOUD_JOB_RETENTION_DAYS" ||
    // Quoted verbatim in the injected agent instruction so an engine that
    // transcribes a file itself knows where the local ASR cuts off.
    key === "ASR_MAX_AUDIO_SECONDS" ||
    // Inbound-attachment retention window (days); 0 = delete at turn end.
    key === "LARK_INBOUND_FILE_RETENTION_DAYS";
}

// Namespaces the bridge process reads to control its OWN behaviour (transport, active-turn
// state, doc/chat identity, engine executables/home, thread ids, telemetry, queue tuning).
// lark.env passthrough must refuse these so an operator can't accidentally repoint or
// hijack the bridge by dropping a control var in lark.env — extras are engine creds only.
const RESERVED_BRIDGE_ENV_PREFIXES = [
  "CCTB_",
  "TAROBOT_",
  "TAROCUB_",
  "LARK_",
  "CODEX_",
  "CLAUDE_",
  // Harness home, endpoints, and future DSH controls affect the private host
  // that the bridge starts. Only DSH_EXECUTABLE is admitted by the whitelist.
  "DSH_",
  // Kimi exposes endpoint, OAuth-host, custom-header, plugin-marketplace,
  // updater, host-check, and model-provider controls under this namespace.
  // Keep the namespace closed by default and allow only the credential keys
  // listed below; otherwise every new Kimi control variable becomes an
  // implicit shared.env privilege escalation until the bridge learns its name.
  "KIMI_",
  "ANTIGRAVITY_",
  "ASR_",
  "TELEGRAM_",
  // Long-audio cloud ASR (Aliyun Tingwu): TINGWU_ASR_DIR points the bridge at a
  // directory it EXECUTES a python script from, so it must come from a whitelisted
  // service-env key or config — never from a lark.env/shared.env extra.
  "TINGWU_",
] as const;

const ALLOWED_KIMI_CREDENTIAL_ENV_KEYS: ReadonlySet<string> = new Set([
  "KIMI_API_KEY",
  "KIMI_MODEL_API_KEY",
  "KIMI_REGISTRY_API_KEY",
  "KIMI_WEB_FETCH_API_KEY",
  "KIMI_WEB_SEARCH_API_KEY",
]);

function isAllowedKimiCredentialEnvKey(key: string): boolean {
  return ALLOWED_KIMI_CREDENTIAL_ENV_KEYS.has(key.toUpperCase());
}

/**
 * Process-control variables that must never be injected into the BRIDGE's own
 * process. The prefix denylist above only covers the bridge's own namespaces, so
 * these standard, prefix-free names would otherwise sail straight through — and
 * `applyLarkEnvPassthrough` writes into `process.env`, i.e. the bridge's own
 * environment, not a separate child env. Any one of these changes what code the
 * process loads (NODE_OPTIONS / LD_PRELOAD / DYLD_INSERT_LIBRARIES / PYTHONPATH),
 * which binary a subcommand runs (GIT_SSH_COMMAND), where TLS trust comes from
 * (NODE_EXTRA_CA_CERTS / SSL_CERT_FILE), which endpoint the engine talks to
 * (ANTHROPIC_BASE_URL), or routes every outbound request through an attacker
 * (…_PROXY). Matched case-insensitively: the proxy vars are conventionally
 * lowercase and are read in both cases.
 */
const DENIED_PROCESS_CONTROL_ENV_KEYS: ReadonlySet<string> = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PYTHONPATH",
  "GIT_SSH_COMMAND",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "ANTHROPIC_BASE_URL",
  // Kimi's engine home holds config.toml (provider base URL + auth) and the
  // bridge itself reads it (kimi-acp-adapter loads default_model from there).
  // An extra retargeting it is the Kimi equivalent of the denied
  // ANTHROPIC_BASE_URL: one line in shared.env would repoint every Kimi
  // instance's provider endpoint at the next restart. The KIMI_ namespace is
  // otherwise closed by default; only the explicit API-key allowlist above is
  // eligible for passthrough.
  "KIMI_CODE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

function isReservedBridgeEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (DENIED_PROCESS_CONTROL_ENV_KEYS.has(upper)) {
    return true;
  }
  // Compare on the uppercased key: every reserved prefix is uppercase, so this is
  // strictly stricter and a lowercased spelling can't slip past the namespace gate.
  return RESERVED_BRIDGE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export function parseEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    const quoted = value.slice(1, -1);
    let parsed = "";
    for (let index = 0; index < quoted.length; index += 1) {
      const char = quoted[index]!;
      if (char !== "\\" || index + 1 >= quoted.length) {
        parsed += char;
        continue;
      }
      const escaped = quoted[index + 1]!;
      if (escaped === "n") parsed += "\n";
      else if (escaped === "\"" || escaped === "\\" || escaped === "$" || escaped === "`") parsed += escaped;
      else parsed += `\\${escaped}`;
      index += 1;
    }
    return parsed;
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function quoteEnvValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\$/g, "\\$").replace(/`/g, "\\`").replace(/\n/g, "\\n")}"`;
}
