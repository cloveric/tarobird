import { Parser } from "htmlparser2";
import { Script } from "node:vm";
import { widgetInputSchema, type WidgetInput } from "../client-protocol/widget.js";

function checkScript(source: string, label: string, handler = false): void {
  const filename = "widget-check.js";
  try { new Script(handler ? `(function(event){\n${source}\n})` : source, { filename }); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // V8's message alone omits the location. Keep a small, source-local hint
    // in the existing invalid_widget receipt so the author can correct it.
    const match = /^widget-check\.js:(\d+)\b/m.exec(error.stack ?? "");
    const line = match ? Math.max(1, Number(match[1]) - (handler ? 1 : 0)) : undefined;
    const snippet = line ? source.split(/\r\n|\r|\n/)[line - 1]?.trim().slice(0, 160) : undefined;
    throw new SyntaxError(`${label}${line ? `, line ${line}` : ""}: ${error.message.slice(0, 300)}${snippet ? `\n${snippet}` : ""}`);
  }
}

/** Parse classic scripts without executing model code. Widgets are deliberately
 * self-contained: the renderer enforces the real resource/authority boundary. */
export function validateWidget(raw: unknown): WidgetInput {
  const widget = widgetInputSchema.parse(raw);
  if ("report" in widget) return widget;
  let script: string | undefined, scriptNumber = 0;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (["iframe", "frame", "object", "embed", "base", "meta", "link"].includes(name)) throw new Error(`Widget does not support <${name}>; use a self-contained HTML fragment`);
      for (const [attribute, value] of Object.entries(attrs)) {
        if (/^on[a-z]+$/i.test(attribute) && value.trim()) checkScript(value, `<${name}> ${attribute} handler`, true);
      }
      if (name === "script") {
        if (attrs.src || attrs.type && !["text/javascript", "application/javascript"].includes(attrs.type.toLowerCase())) throw new Error("Use inline classic JavaScript; external scripts and modules are unavailable");
        script = ""; scriptNumber++;
      }
    },
    ontext(text) { if (script !== undefined) script += text; },
    onclosetag(name) { if (name === "script" && script !== undefined) { checkScript(script, `Widget script ${scriptNumber}`); script = undefined; } },
  });
  parser.write(widget.html); parser.end();
  return widget;
}
