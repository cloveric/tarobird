import { OFFICIAL_CANVAS_PLUGIN_ID, validCanvasScope } from "./canvas-data-store.js";
import { electronBridge, isElectron } from "./desktop-bridge.js";

type CredentialRequest =
  | { action: "get" | "remove"; scopeId: string; key: string }
  | { action: "set"; scopeId: string; key: string; value: string }
  | { action: "clear"; scopeId: string };

type NativeCredentialRequest = (request: CredentialRequest) => Promise<unknown>;

function nativeCredentialRequest(request: CredentialRequest): Promise<unknown> {
  if (!isElectron()) return Promise.reject(new Error("credentials_unavailable"));
  try {
    return electronBridge().invoke("canvas_credentials", request);
  } catch {
    return Promise.reject(new Error("credentials_unavailable"));
  }
}

/** The trusted app supplies the installation scope. Credential values go
 * directly to the native helper and have no browser database fallback. */
export function createSystemCanvasCredentialVault(native: NativeCredentialRequest = nativeCredentialRequest) {
  async function call(pluginId: string, request: CredentialRequest) {
    if (!validCanvasScope(request.scopeId) || pluginId !== OFFICIAL_CANVAS_PLUGIN_ID) throw new Error("capability_denied");
    try {
      return await native(request);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      switch (code) {
        case "credential_key_invalid":
        case "credential_value_invalid":
        case "credentials_quota_exceeded":
        case "system_keychain_busy":
          throw new Error(code);
        default:
          throw new Error("credentials_unavailable");
      }
    }
  }
  async function change(pluginId: string, request: CredentialRequest) {
    if (await call(pluginId, request) !== true) throw new Error("credentials_unavailable");
  }
  return {
    async getSecret(scopeId: string, pluginId: string, key: string): Promise<string | null> {
      const result = await call(pluginId, { scopeId, action: "get", key });
      if (result === null || typeof result === "string") return result;
      throw new Error("credentials_unavailable");
    },
    setSecret(scopeId: string, pluginId: string, key: string, value: string): Promise<void> {
      return change(pluginId, { scopeId, action: "set", key, value });
    },
    removeSecret(scopeId: string, pluginId: string, key: string): Promise<void> {
      return change(pluginId, { scopeId, action: "remove", key });
    },
    clearPluginSecrets(scopeId: string, pluginId: string): Promise<void> {
      return change(pluginId, { scopeId, action: "clear" });
    },
  };
}
