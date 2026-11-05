import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Keep diagnostic and transcription fallback selection identical during installation. */
export function standardAsrReady(root: string): boolean {
  if (!existsSync(path.join(root, "transcribe.py"))) return false;
  if (!existsSync(path.join(root, "installation.json"))) return true; // pre-metadata installations
  try { return JSON.parse(readFileSync(path.join(root, "installation.json"), "utf8")).ready === true; }
  catch { return false; }
}
