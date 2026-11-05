import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blockSchema, type Block } from "../../src/client-protocol/index.js";
/** Opt-in fixture export from the same real constructors as the golden tests. */
export function recordCardVisual(name: string, value: unknown): void {
  const directory = process.env.TAROCUB_VISUAL_FIXTURES;
  if (!directory) return;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("invalid_visual_fixture_name");
  const blocks: Block[] = (Array.isArray(value) ? value : [value]).map((item) => blockSchema.parse(item));
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), JSON.stringify({ name, blocks }, null, 2) + "\n");
}
