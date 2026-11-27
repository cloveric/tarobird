import { hostT } from "../locales/index.js";
import type { Locale } from "./locale.js";

export interface CodexWebSource {
  refId?: string;
  url: string;
  title?: string;
}

/** A null entry is an ambiguous ID, and must never acquire a guessed URL. */
export type CodexWebSources = Readonly<Record<string, { url: string; title?: string } | null>>;
const MAX_SOURCES = 256;
const MARKER = "cite";
const END = "";
const SEPARATOR = "";
const REF = /^[A-Za-z0-9_-]{1,128}$/u;

function safeUrl(value: string): string | undefined {
  if (value.length > 8192 || /[\u0000-\u0020\u007f<>]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    // Brackets around an IPv6 host are syntax; escape only what follows the host.
    const origin = `${url.protocol}//${url.host}`;
    return origin + url.href.slice(origin.length).replace(/[\[\]`{}\\|]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { return undefined; }
}

/** Only explicit protocol IDs are eligible; source order is not an ID mapping. */
export function addCodexWebSources(
  previous: CodexWebSources | undefined,
  sources: readonly CodexWebSource[] | undefined,
): CodexWebSources | undefined {
  if (!sources?.length) return previous;
  const next = { ...previous };
  let size = Object.keys(next).length;
  for (const source of sources) {
    if (!source.refId || !REF.test(source.refId)) continue;
    const url = safeUrl(source.url);
    if (!url) continue;
    if (Object.hasOwn(next, source.refId)) {
      if (next[source.refId]?.url !== url) next[source.refId] = null;
      continue;
    }
    if (size >= MAX_SOURCES) continue;
    Object.defineProperty(next, source.refId, { value: {
      url,
      ...(source.title?.trim() ? { title: source.title.trim().slice(0, 120) } : {}),
    }, enumerable: true, configurable: true, writable: true });
    size++;
  }
  return next;
}

export interface CodexWebCitationOptions {
  sources?: CodexWebSources;
  streaming?: boolean;
  /** Adapter results resolve known URLs; the localized presentation handles missing ones. */
  preserveUnresolved?: boolean;
}

function link(source: { url: string }): string {
  // Use the destination host, not a site's self-declared title. This also keeps
  // untrusted title text out of the answer's delivery/tool-directive parser.
  const label = new URL(source.url).hostname.replace(/[&<>:{}\[\]\\`*_!|]/gu, char => `&#${char.charCodeAt(0)};`);
  return `[${label}](<${safeUrl(source.url)!}>)`;
}

/** Translate native search controls in prose, preserving fenced and inline Markdown code. */
export function renderCodexWebCitations(
  text: string,
  locale: Locale = "en",
  options: CodexWebCitationOptions = {},
): string {
  if (!text.includes("")) return text;
  const unavailable = hostT(locale, "（来源链接未提供）");
  const renderProse = (prose: string): string => {
    let out = "";
    for (let cursor = 0; cursor < prose.length;) {
      let precedingSlashes = 0;
      if (prose[cursor] === "`") {
        for (let before = cursor - 1; before >= 0 && prose[before] === "\\"; before--) precedingSlashes++;
      }
      if (prose[cursor] === "`" && precedingSlashes % 2 === 0) {
        const run = /^`+/u.exec(prose.slice(cursor))![0];
        let end = cursor + run.length;
        while ((end = prose.indexOf(run, end)) >= 0) {
          if (prose[end - 1] !== "`" && prose[end + run.length] !== "`") break;
          end += run.length;
        }
        if (end >= 0) {
          out += prose.slice(cursor, end + run.length);
          cursor = end + run.length;
          continue;
        }
        out += run;
        cursor += run.length;
        continue;
      }
      if (prose[cursor] !== "") { out += prose[cursor++]; continue; }
      const tail = prose.slice(cursor);
      if (!tail.startsWith(MARKER)) {
        if (MARKER.startsWith(tail) && !options.preserveUnresolved) {
          if (!options.streaming) out += tail === "" ? tail : unavailable;
          break;
        }
        out += prose[cursor++];
        continue;
      }
      const payload = /^[A-Za-z0-9_\-]*/u.exec(tail.slice(MARKER.length))![0];
      const length = MARKER.length + payload.length;
      const complete = tail.slice(length).startsWith(END);
      const raw = tail.slice(0, length + (complete ? END.length : 0));
      if (!complete) {
        out += options.preserveUnresolved ? raw : options.streaming ? "" : unavailable;
      } else {
        const refs = [...new Set(payload.split(SEPARATOR))];
        const rendered = refs.map(ref => {
          const source = options.sources && Object.hasOwn(options.sources, ref) ? options.sources[ref] : undefined;
          return source && safeUrl(source.url) ? link(source) : undefined;
        });
        // A partially resolvable marker keeps valid links and one honest missing-source note.
        const missing = options.preserveUnresolved
          ? `${MARKER}${refs.filter((_, index) => !rendered[index]).join(SEPARATOR)}${END}`
          : unavailable;
        out += [...new Set(rendered.map(value => value ?? missing))].join(" ");
      }
      cursor += raw.length;
    }
    return out;
  };

  let output = "";
  let prose = "";
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? []) {
    const match = /^(?: {0,3}> ?)* {0,3}(`{3,}|~{3,})([^\r\n]*)/u.exec(line);
    if (fence) {
      output += line;
      if (match && match[1]![0] === fence.marker && match[1]!.length >= fence.length && !match[2]!.trim()) fence = undefined;
    } else if (match) {
      output += renderProse(prose) + line;
      prose = "";
      fence = { marker: match[1]![0]!, length: match[1]!.length };
    } else if (/^(?: {0,3}> ?)*[ \t]*(?:\r\n|\n|\r)$/u.test(line)) {
      // An inline span cannot pair delimiters across separate paragraphs.
      output += renderProse(prose) + line;
      prose = "";
    } else prose += line;
  }
  return output + renderProse(prose);
}
