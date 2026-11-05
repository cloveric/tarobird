import { readablePreviewBotReferences } from "./bot-references.js";
import { conversationPreview } from "./conversation-preview.js";

export type SearchTextPart = { text: string; match: boolean };

// Match the Hub's SQLite LIKE/lower semantics: ASCII case-insensitive, literal
// punctuation and exact non-ASCII. Full Unicode lowercasing can change offsets.
const fold = (text: string) => text.replace(/[A-Z]/g, char => char.toLowerCase());

export function searchTextParts(text: string, query: string): SearchTextPart[] {
  if (!query) return [{ text, match: false }];
  const haystack = fold(text), needle = fold(query), parts: SearchTextPart[] = [];
  let at = 0, start = haystack.indexOf(needle);
  while (start !== -1) {
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    at = start + query.length;
    parts.push({ text: text.slice(start, at), match: true });
    start = haystack.indexOf(needle, at);
  }
  if (at < text.length || !parts.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}

export function searchExcerptParts(excerpt: string, query: string, labels: ReadonlyMap<string, string>): SearchTextPart[] {
  const original = searchTextParts(excerpt, query);
  const preview = searchTextParts(readablePreviewBotReferences(conversationPreview(excerpt), labels), query);
  // Keep a URL, Markdown marker, whitespace or Bot ID visible when that is what
  // matched. Cosmetic preview cleanup must not hide the reason for a result.
  return original.filter(part => part.match).length > preview.filter(part => part.match).length ? original : preview;
}
