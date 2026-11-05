import type { Root } from "hast";

export type ParsedChunk = { fingerprint: string; tree: Root };
// Parsed results for exact texts, most recently used last. Virtualized rows
// remount while scrolling; reusing a finished parse avoids showing source text
// again and a second height change for the same message. Bounded by text size.
const PARSED_CACHE_CHARS = 800_000, PARSED_CACHE_ENTRY_CHARS = 100_000;
const parsed = new Map<string, ParsedChunk[]>();
let parsedChars = 0;
export function cachedMarkdown(text: string): ParsedChunk[] | undefined {
  const value = parsed.get(text);
  if (value) { parsed.delete(text); parsed.set(text, value); }
  return value;
}
export function rememberMarkdown(text: string, chunks: ParsedChunk[]): void {
  if (!chunks.length || text.length > PARSED_CACHE_ENTRY_CHARS) return;
  if (parsed.has(text)) parsedChars -= text.length;
  parsed.delete(text); parsed.set(text, chunks); parsedChars += text.length;
  for (const [key] of parsed) { if (parsedChars <= PARSED_CACHE_CHARS) break; parsed.delete(key); parsedChars -= key.length; }
}
