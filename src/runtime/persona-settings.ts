import { personaErrorSchema, personaPatchSchema } from "../client-protocol/persona.js";
import { botInstructionsRevision, readBotPersona, replaceBotPersona, withBotInstructions, writeBotInstructions } from "./bot-instructions.js";
/** Only the Bot's user-owned persona is editable; no workspace/system prompt
 * paths come from the request. Keep one private backup and reject stale edits. */
export async function personaSettings(stateDir: string, activeTurns: number | (() => number), patch?: unknown) {
  const snapshot = (document: string) => ({ scope: "bot" as const, text: readBotPersona(document), revision: botInstructionsRevision(document), activeTurns: typeof activeTurns === "function" ? activeTurns() : activeTurns });
  try {
    return { ok: true as const, settings: await withBotInstructions(stateDir, async (file, previous) => {
      const before = snapshot(previous);
      if (patch === undefined) return before;
      const update = personaPatchSchema.parse(patch);
      if (update.revision !== before.revision) throw new Error("persona_conflict");
      if (update.text === before.text) return before;
      const document = replaceBotPersona(previous, update.text);
      await writeBotInstructions(`${file}.previous`, previous);
      await writeBotInstructions(file, document);
      return snapshot(document);
    }) };
  } catch (error) {
    const parsed = personaErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!parsed.success) throw error;
    return { ok: false as const, error: parsed.data };
  }
}
