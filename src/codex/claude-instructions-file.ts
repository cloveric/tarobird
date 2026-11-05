import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ClaudeInstructionsFile = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function createClaudeInstructionsFile(instructions: string | null, name: "instructions.md" | "app-mcp.json" = "instructions.md"): Promise<ClaudeInstructionsFile | null> {
  const trimmed = instructions?.trim();
  if (!trimmed) {
    return null;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), "cctb-claude-instructions-"));
  const filePath = path.join(dir, name);
  try { await writeFile(filePath, trimmed, { encoding: "utf8", mode: 0o600 }); }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  return {
    path: filePath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
