import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { Conversation } from "../client-protocol/index.js";
import { buildCoreConversationKey, stableCoreNumericId } from "../core/message-normalizer.js";
import { withFileMutex } from "../state/file-mutex.js";
import { JsonStore } from "../state/json-store.js";
import { SessionStore } from "../state/session-store.js";

const receiptSchema = z.object({ schemaVersion: z.number().int().positive().optional(), bindingId: z.string(), state: z.enum(["applying", "applied"]) }).strict();
function receiptPath(stateDir: string, conversationId: string): string {
  return path.join(stateDir, "gateway-bindings", `${createHash("sha256").update(buildCoreConversationKey(conversationId)).digest("hex")}.json`);
}
/** A follow-up must queue while a new/uncertain selection is awaiting application. */
export async function gatewaySessionBindingAllowsSteering(stateDir: string, conversation: Conversation): Promise<boolean> {
  if (!conversation.sessionId) return true;
  if (!conversation.bindingId) return false;
  const file = receiptPath(stateDir, conversation.id);
  try {
    return await withFileMutex(file, async () => {
      const receipt = await new JsonStore(file, (value) => receiptSchema.nullable().parse(value)).read(null);
      return !!receipt && receipt.bindingId === conversation.bindingId && receipt.state === "applied";
    });
  } catch { return false; }
}
import { hostT } from "../locales/index.js";
import type { Locale } from "../runtime/locale.js";

export class GatewaySessionBindingError extends Error {
  constructor(readonly code: string) { super(code); }
  userMessage(locale: Locale): string {
    const keys: Record<string, string> = {
      legacy_session_binding_requires_reselection: "旧版恢复选择需要重新确认。",
      session_binding_interrupted_reselect_required: "上次会话恢复被中断，无法确认是否完成。",
      session_not_found_on_instance: "选择的会话已不在此 Bot 的可恢复列表中。",
      session_state_unavailable: "Bot 的会话状态暂时无法读取。",
      session_binding_storage_unavailable: "会话恢复状态暂时无法读写，请检查 Bot 的磁盘空间和文件权限后重试。",
    };
    const reason = hostT(locale, keys[this.code] ?? "会话恢复记录无法读取，原记录已保留。");
    if (this.code === "session_binding_record_unavailable") {
      return hostT(locale, "{0}\n本条消息未交给模型。请打开「对话设置」清除会话选择，再切断或重置会话。之后可使用原生 /resume；再次通过列表绑定前，需要修复恢复记录。", reason);
    }
    return hostT(locale, "{0}\n本条消息未交给模型。请打开「对话设置」重新选择会话，或清除会话选择。清除不会撤销已发生的切换；恢复曾中断时，请先切断或重置，再发送普通消息。", reason);
  }
}
/** A Hub selection is an operation, not a permanent session override. Called
 * after access checks inside the same queue as /resume, /detach and /reset. */
export async function prepareGatewaySessionBinding(stateDir: string, conversation: Conversation): Promise<void> {
  try { await applySelection(stateDir, conversation); }
  catch (error) { throw error instanceof GatewaySessionBindingError ? error : new GatewaySessionBindingError("session_binding_storage_unavailable"); }
}
async function applySelection(stateDir: string, conversation: Conversation): Promise<void> {
  if (!conversation.sessionId) return;
  const sessions = new SessionStore(path.join(stateDir, "session.json"));
  const key = buildCoreConversationKey(conversation.id);
  if (!conversation.bindingId) {
    // Old Hub metadata has no operation identity. It may predate a reset/detach;
    // never silently resurrect it. Existing bindings can continue unchanged.
    if (await sessions.findByConversationKey(key)) return;
    throw new GatewaySessionBindingError("legacy_session_binding_requires_reselection");
  }
  const file = receiptPath(stateDir, conversation.id);
  await withFileMutex(file, async () => {
    const store = new JsonStore<z.infer<typeof receiptSchema> | null>(file, (value) => receiptSchema.nullable().parse(value));
    let receipt: z.infer<typeof receiptSchema> | null;
    try { receipt = await store.read(null); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new GatewaySessionBindingError("session_binding_record_unavailable");
      throw error;
    }
    if (receipt && receipt.bindingId === conversation.bindingId) {
      if (receipt.state !== "applied") throw new GatewaySessionBindingError("session_binding_interrupted_reselect_required");
      return;
    }
    const inspected = await sessions.inspect();
    if (inspected.warning) throw new GatewaySessionBindingError("session_state_unavailable");
    const source = inspected.state.chats.find((record) => record.codexSessionId === conversation.sessionId);
    if (!source) throw new GatewaySessionBindingError("session_not_found_on_instance");
    const current = await sessions.findByConversationKey(key);
    await store.write({ bindingId: conversation.bindingId!, state: "applying" });
    if (current?.codexSessionId !== conversation.sessionId) await sessions.upsert({
      telegramChatId: stableCoreNumericId(key), conversationKey: key,
      codexSessionId: source.codexSessionId, resume: source.resume ?? null,
      status: "idle", updatedAt: new Date().toISOString(),
      // An empty destination is also a previous state. Claude's native detach
      // needs this explicit snapshot when the source has no resume metadata.
      suspendedPrevious: current?.suspendedPrevious ?? { sessionId: current?.codexSessionId ?? null, resume: current?.resume ?? null },
    });
    await store.write({ bindingId: conversation.bindingId!, state: "applied" });
  });
}
