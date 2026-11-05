/** A fixed, secret-free error: never include JSON contents or parser excerpts. */
export const ENGINE_CONFIG_ERROR_CODE = "engine_config_unreadable";
export class EngineConfigError extends Error {
  constructor(readonly setting: "permissions" | "budget" = "permissions") {
    super(`${ENGINE_CONFIG_ERROR_CODE}: ${setting === "budget" ? "Bot budget configuration is invalid" : "Bot configuration is unreadable or has invalid permission settings"}; execution blocked until config.json is repaired`);
    this.name = "EngineConfigError";
  }
}
