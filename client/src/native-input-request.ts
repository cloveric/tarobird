import { z } from "zod";
import { nativeInputControlResultSchema, type NativeInputAction } from "../../src/client-protocol/native-input.js";
import type { HubConnection } from "./connection.js";
import { randomNonce } from "./identity.js";
import { queueRequest } from "./prompt-queue-request.js";

/** Persist before sending; reconnect/checks reuse the exact operation identity. */
export async function controlNativeInput(connection: HubConnection, conversationId: string, messageId: string, action: NativeInputAction) {
  const key = `native-control:${conversationId}:${messageId}:${action}`;
  const existing = await connection.cache.operationRecord(key);
  let requestId = existing ? z.string().regex(/^[A-Za-z0-9_-]+$/).parse(JSON.parse(existing)) : randomNonce();
  if (!existing && !await connection.cache.updateOperationIfMatches(key, "", JSON.stringify(requestId))) requestId = z.string().regex(/^[A-Za-z0-9_-]+$/).parse(JSON.parse(await connection.cache.operationRecord(key)));
  const request = queueRequest([], 15_000);
  try {
    const result = nativeInputControlResultSchema.parse(await request.wait(connection.http(`/api/conversations/${conversationId}/inputs/${messageId}`, {
      method: "POST", body: JSON.stringify({ requestId, action }), signal: request.signal,
    })));
    // Only uncertain operations retain their identity for reconciliation. A
    // confirmed result ends this attempt; a later deliberate click is new.
    if (result.outcome !== "unknown") await connection.cache.clearOperationIfMatches(key, JSON.stringify(requestId));
    return result;
  } catch { return { outcome: "unknown", reason: "uncertain" } as const; }
  finally { request.dispose(); }
}
