// Match the run journal's per-output character budget. This bounds the serialized
// JSON, including escaped identities and metadata, rather than each raw message.
const OUTPUT_LIMIT = 65536;
const AGENT_LIMIT = 128;
type BoundedOutput = { output?: string; truncated?: true };
type Part = { id: string; value: Record<string, unknown>; field?: "message" | "preview"; text?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A source prefix within the escaped JSON string budget, without splitting a
 * valid surrogate pair. Existing lone surrogates remain escaped by JSON.stringify. */
function jsonPrefix(text: string, budget: number): string {
  const prefix = (end: number): string => {
    if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    return text.slice(0, end);
  };
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(prefix(middle)).length - 2 <= budget) low = middle;
    else high = middle - 1;
  }
  return prefix(low);
}

function fallback(preview: string): BoundedOutput {
  const value = { capture: "unrecognized_agent_states", preview: "" };
  value.preview = jsonPrefix(preview, OUTPUT_LIMIT - JSON.stringify(value).length);
  return { output: JSON.stringify(value), truncated: true };
}

/** Preserve an in-budget native snapshot exactly. For oversized snapshots,
 * retain known status/message fields with fair message budgets; unknown shapes
 * stay explicitly marked raw previews, never invented agent reports. Identities
 * are never shortened. Entries whose identity/metadata cannot fit are omitted,
 * as are entries beyond the bounded 128-agent capture, and truncation is explicit. */
export function boundedCodexAgentStates(value: unknown): BoundedOutput {
  if (value === undefined || value === null) return {};
  let original: string | undefined;
  try { original = typeof value === "string" ? value : JSON.stringify(value); }
  catch { return { output: '{"capture":"unserializable_agent_states"}', truncated: true }; }
  if (original === undefined) return {};
  if (original.length <= OUTPUT_LIMIT) return { output: original };
  if (!isRecord(value)) return fallback(original);

  const parts: Part[] = [];
  let baseSize = 2; // enclosing braces
  for (const [id, raw] of Object.entries(value)) {
    if (parts.length >= AGENT_LIMIT) break;
    const known = isRecord(raw) && typeof raw.status === "string" && raw.status.length > 0 && raw.status.length <= 128
      && (raw.message == null || typeof raw.message === "string");
    let part: Part;
    if (known) {
      const state: Record<string, unknown> = { status: raw.status };
      if (raw.message !== undefined) state.message = typeof raw.message === "string" ? "" : null;
      part = { id, value: state, ...(typeof raw.message === "string" ? { field: "message", text: raw.message } as const : {}) };
    } else {
      part = { id, value: { capture: "unrecognized_agent_state", preview: "" }, field: "preview", text: JSON.stringify(raw) ?? "" };
    }
    const size = JSON.stringify(id).length + 1 + JSON.stringify(part.value).length + (parts.length ? 1 : 0);
    // Skipping an unrepresentable id lets later, ordinary ids remain visible.
    if (baseSize + size > OUTPUT_LIMIT) continue;
    baseSize += size;
    parts.push(part);
  }
  if (!parts.length) return fallback(original);

  // Fill short reports first, then share the remaining space equally among
  // larger reports. Unknown previews participate in the same bounded budget.
  const textParts = parts.filter((part): part is Part & { field: "message" | "preview"; text: string } => part.field !== undefined && part.text !== undefined)
    .map(part => ({ part, size: JSON.stringify(part.text).length - 2 })).sort((a, b) => a.size - b.size);
  let remaining = OUTPUT_LIMIT - baseSize;
  for (const [index, { part, size }] of textParts.entries()) {
    const budget = Math.floor(remaining / (textParts.length - index));
    const text = size <= budget ? part.text : jsonPrefix(part.text, budget);
    part.value[part.field] = text;
    remaining -= JSON.stringify(text).length - 2;
  }
  return { output: JSON.stringify(Object.fromEntries(parts.map(part => [part.id, part.value]))), truncated: true };
}
