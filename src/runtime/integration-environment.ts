import { parseEnvValue } from "../core/env-parser.js";

/** Private, operator-owned settings accepted by both the Bot and shared config.
 * Keep code-loading, engine-home and proxy controls out of this surface. */
export const INTEGRATION_ENV_KEYS = [
  "ASR_HTTP_URL", "ASR_CLI_PYTHON", "ASR_CLI_SCRIPT", "ASR_MODEL_PATH",
  "ASR_HTTP_TIMEOUT_MS", "ASR_HTTP_RETRY_WINDOW_MS", "ASR_HTTP_RETRY_DELAY_MS",
  "ASR_CHUNK_AFTER_SECONDS", "ASR_CHUNK_SECONDS", "ASR_CLI_CHUNK_SECONDS",
  "ASR_UNKNOWN_DURATION_DIRECT_MAX_BYTES", "ASR_MAX_AUDIO_SECONDS",
  "ASR_SERVICE_COMMAND", "ASR_RESTART_AFTER_FAILURES", "ASR_RESTART_COOLDOWN_MS",
  "TINGWU_ASR_DIR", "ASR_CLOUD_MODE", "ASR_CLOUD_THRESHOLD_SECONDS", "ASR_CLOUD_TASK_TIMEOUT_SECONDS",
  "ASR_CLOUD_JOB_RETENTION_DAYS",
] as const;

export function parseIntegrationEnvironment(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Reuse the existing .env quoting rules without evaluating shell expressions.
  for (const line of content.split(/\r?\n/)) {
    const split = line.indexOf("=");
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    if (!(INTEGRATION_ENV_KEYS as readonly string[]).includes(key)) continue;
    result[key] = parseEnvValue(line.slice(split + 1).trim());
  }
  return result;
}
