import { blockSchema, jsonSchema, type Block, type CardElement, type Json } from "../client-protocol/index.js";

type RecordValue = Record<string, Json>;
export type TranslationWarning = { path: string; kind: "unknown_element" | "unknown_property"; name: string };
const record = (v: Json | undefined): RecordValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
const array = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const text = (v: Json | undefined): string => typeof v === "string" ? v : typeof v === "number" ? String(v) : typeof record(v).content === "string" ? record(v).content as string : "";
const layoutFields: Record<string, string> = {
  padding: "padding", margin: "margin", vertical_spacing: "verticalSpacing", horizontal_spacing: "horizontalSpacing", background_style: "background",
  text_size: "textSize", text_color: "textColor", text_align: "textAlign", width: "width", weight: "weight", vertical_align: "verticalAlign",
  horizontal_align: "horizontalAlign", flex_mode: "flexMode", column_spacing: "columnSpacing", border: "border", corner_radius: "borderRadius", direction: "direction", height: "height",
};
const tags: Record<string, CardElement["type"]> = { markdown: "markdown", plain_text: "markdown", div: "markdown", note: "markdown", button: "button", action: "buttonGroup", select_static: "select", multi_select_static: "select", input: "input", form: "form", collapsible_panel: "collapsible", hr: "divider", column_set: "columns", column: "column", standard_icon: "icon", img: "image" };

/** Pure, bounded translation. Raw unknown properties stay JSON, never HTML. */
export function translateCard(input: unknown, warn: (warning: TranslationWarning) => void = () => undefined): Extract<Block, { type: "card" }> {
  const source = record(jsonSchema.parse(input)); let count = 0;
  const properties = (source: RecordValue, used: string[], at: string): { layout?: RecordValue; extra?: RecordValue } => {
    const layout: RecordValue = {}; const extra: RecordValue = {};
    for (const [name, value] of Object.entries(source)) {
      if (layoutFields[name]) layout[layoutFields[name]!] = value;
      else if (!used.includes(name)) { extra[name] = value; warn({ path: at, kind: "unknown_property", name }); }
    }
    return { ...(Object.keys(layout).length ? { layout } : {}), ...(Object.keys(extra).length ? { extra } : {}) };
  };
  const element = (value: Json, at: string, depth: number): CardElement => {
    if (++count > 20_000 || depth > 64) throw new Error("card_complexity_limit");
    const source = record(value); const tag = text(source.tag); const type = tags[tag];
    if (!type) { warn({ path: at, kind: "unknown_element", name: tag }); return { type: "markdown", text: text(source.content) || text(source.text) || `[Unsupported element: ${tag || "unknown"}]`, extra: source }; }
    const header = record(source.header);
    const behaviors = array(source.behaviors).map(record);
    const callback = behaviors.find((behavior) => behavior.type === "callback");
    const openUrl = behaviors.find((behavior) => behavior.type === "open_url");
    const children = array(source.elements ?? source.columns ?? source.actions);
    const result: CardElement = { type, ...properties(source, ["tag", "element_id", "content", "text", "elements", "columns", "actions", "value", "name", "options", "type", "disabled", "required", "confirm", "expanded", "img_key", "url", "multi_url", "min_selected_count", "max_selected_count"], at) };
    if (source.element_id) result.id = text(source.element_id);
    if (source.name) result.name = text(source.name);
    const body = type === "collapsible" ? text(header.title) : type === "image" ? text(source.alt) : type === "icon" ? text(source.token) : text(source.content ?? source.text);
    if (body) result.text = body;
    if (type === "markdown" && tag === "note") result.text = array(source.elements).map((e) => text(e)).join("\n");
    if (children.length) result.children = children.map((e, i) => element(e, `${at}.${i}`, depth + 1));
    if (["button", "select", "input", "form"].includes(type)) {
      result.actionId = text(source.element_id) || text(source.name) || `action:${at}`;
      // Card 2.0 puts the callback payload in behaviors, while legacy cards
      // use value. Keep behaviors in extra as well so no source data is lost.
      const callbackValue = callback?.value ?? source.value;
      if (callbackValue !== undefined) result.value = callbackValue;
      if (source.disabled !== undefined) result.disabled = source.disabled === true;
      if (source.required !== undefined) result.required = source.required === true;
    }
    if (type === "button") {
      result.style = source.type === "primary" || source.type === "danger" ? source.type : "default";
      if (source.confirm) result.confirm = { title: text(record(source.confirm).title), text: text(record(source.confirm).text) };
      const url = text(openUrl?.default_url ?? openUrl?.url ?? source.url ?? record(source.multi_url).url); if (url) result.url = url;
    }
    if (type === "select") {
      result.multiple = tag === "multi_select_static";
      result.options = array(source.options).map((o) => ({ label: text(record(o).text), value: text(record(o).value) }));
      if (typeof source.min_selected_count === "number") result.min = source.min_selected_count;
      if (typeof source.max_selected_count === "number") result.max = source.max_selected_count;
    }
    if (type === "collapsible") result.open = source.expanded === true;
    if (type === "image" && source.img_key) result.attachmentId = text(source.img_key);
    return result;
  };
  const header = record(source.header); const body = record(source.body);
  const elements = array(body.elements ?? source.elements).map((value, i) => element(value, String(i), 0));
  const meta = properties(source, ["header", "body", "elements"], "card");
  // Header, body, and config attributes not yet rendered are still preserved.
  const extra = { ...meta.extra, ...(Object.keys(header).length ? { header } : {}), ...(Object.keys(body).length ? { body: Object.fromEntries(Object.entries(body).filter(([k]) => k !== "elements")) as RecordValue } : {}) };
  return blockSchema.parse({ type: "card", elements, ...(text(header.title) ? { title: text(header.title) } : {}), ...(text(source.summary ?? record(source.config).summary) ? { summary: text(source.summary ?? record(source.config).summary) } : {}), ...(text(header.template) ? { template: text(header.template) } : {}), ...meta, layout: { ...meta.layout, ...properties(body, ["elements"], "body").layout }, extra }) as Extract<Block, { type: "card" }>;
}
