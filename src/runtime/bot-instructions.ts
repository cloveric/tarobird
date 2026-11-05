import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERSONA_MAX_LENGTH, personaErrorSchema } from "../client-protocol/persona.js";
import { withFileMutex } from "../state/file-mutex.js";

const START = "<!-- TaroBot persona: start -->";
const END = "<!-- TaroBot persona: end -->";
const MAX_DOCUMENT_BYTES = 1_048_576;

/** Always Bot-owned, including when a conversation uses a shared project. */
export function botInstructionsPath(stateDir: string): string {
  return path.resolve(stateDir, "workspace", "AGENTS.md");
}

export function botInstructionsGuidance(file: string): string {
  return `This Bot's own instructions and persona are in ${JSON.stringify(file)}. If the task permits file access and this file has not been read in this conversation, read it. When the user asks to reload the Bot's instructions or persona, read this exact file again from disk and use the latest contents. An empty persona section removes the earlier persona preferences. Continue following the current project's working rules.`;
}

async function readDocument(file: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<string | null> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("persona_unreadable");
    if (stat.size > maxBytes) throw new Error("persona_too_large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof Error && error.message === "persona_too_large") throw error;
    throw new Error("persona_unreadable");
  }
}

export async function writeBotInstructions(file: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) throw new Error("persona_too_large");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    const handle = await open(temporary, "r+"); try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } catch { throw new Error("persona_unwritable"); }
  finally { await unlink(temporary).catch(() => undefined); }
}

function personaSection(document: string): { start: number; end: number; text: string } | undefined {
  const start = document.indexOf(START), end = document.indexOf(END);
  if (start < 0 && end < 0) return undefined;
  if (start < 0 || end < start || document.indexOf(START, start + START.length) >= 0 || document.indexOf(END, end + END.length) >= 0) throw new Error("persona_unreadable");
  let text = document.slice(start + START.length, end);
  const newline = text.startsWith("\r\n") ? "\r\n" : "\n";
  if (!text.startsWith(newline) || !text.endsWith(newline)) throw new Error("persona_unreadable");
  // Hand-clearing the content can leave the two markers on adjacent lines.
  text = text === newline ? "" : text.slice(newline.length, -newline.length);
  if (text.length > PERSONA_MAX_LENGTH) throw new Error("persona_too_large");
  return { start, end: end + END.length, text };
}

export function readBotPersona(document: string): string { return personaSection(document)?.text ?? ""; }
export function botInstructionsRevision(document: string): string { return createHash("sha256").update(document).digest("hex"); }

export function replaceBotPersona(document: string, text: string): string {
  // Marker text is not a valid persona: it would make later section edits ambiguous.
  if (text.includes(START) || text.includes(END)) throw new Error("persona_unreadable");
  const section = personaSection(document), block = `${START}\n${text}\n${END}`;
  if (section) return document.slice(0, section.start) + block + document.slice(section.end);
  return `${document}${document && !document.endsWith("\n\n") ? (document.endsWith("\n") ? "\n" : "\n\n") : ""}## Bot persona\n\n${block}\n`;
}

/** A single transaction for migration, owner edits and engine startup. The old
 * lock also serializes with released Hosts still saving agent.md during upgrade.
 * The archived file is never an input, so clearing/deleting cannot revive it. */
export async function withBotInstructions<T>(stateDir: string, operation: (file: string, document: string) => Promise<T>): Promise<T> {
  const file = botInstructionsPath(stateDir), workspace = path.dirname(file), legacy = path.resolve(stateDir, "agent.md");
  try {
    await mkdir(workspace, { recursive: true });
    const stat = await lstat(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("persona_unreadable");
  } catch { throw new Error("persona_unreadable"); }
  return withFileMutex(legacy, () => withFileMutex(file, async () => {
    const previous = await readDocument(file);
    let document = previous ?? "";
    const section = personaSection(document);
    const oldPersona = await readDocument(legacy, PERSONA_MAX_LENGTH * 4);
    if (oldPersona !== null) {
      if (oldPersona.length > PERSONA_MAX_LENGTH) throw new Error("persona_too_large");
      let archive = `${legacy}.migrated`, archived = await readDocument(archive, PERSONA_MAX_LENGTH * 4);
      // A supported rollback can recreate agent.md (DeepSeek even creates an
      // empty one). Preserve that version too without replacing the first backup.
      if (archived !== null && archived !== oldPersona) {
        archive += `.${createHash("sha256").update(oldPersona).digest("hex")}`;
        archived = await readDocument(archive, PERSONA_MAX_LENGTH * 4);
      }
      if (archived !== null && archived !== oldPersona) throw new Error("persona_unwritable");
      if (archived === null) await writeBotInstructions(archive, oldPersona);
      if (!section) document = replaceBotPersona(document, oldPersona);
    }
    if (previous === null || document !== previous) {
      if (previous !== null) await writeBotInstructions(`${file}.previous`, previous);
      await writeBotInstructions(file, document);
    }
    if (oldPersona !== null) {
      try { await unlink(legacy); } catch { throw new Error("persona_unwritable"); }
    }
    return operation(file, document);
  }));
}

export async function prepareBotInstructions(stateDir: string): Promise<string> {
  try { return await withBotInstructions(stateDir, async file => file); }
  catch (error) {
    const problem = personaErrorSchema.safeParse(error instanceof Error ? error.message : "");
    if (!problem.success) throw error;
    // Optional user instructions must not become a service-start dependency.
    // The editor still reports the error; do not rewrite ambiguous contents or
    // silently inject the archived/legacy persona as a fallback.
    console.warn(`Bot instructions need manual repair (${problem.data}): ${botInstructionsPath(stateDir)}`);
    return botInstructionsPath(stateDir);
  }
}
