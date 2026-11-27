/** Decks written by the 1.6.0 (Baoyu) slides editor, read by the presentation
 * editor that replaced it. The two share the slide file format; this is the
 * one construct the old editor wrote that the new one does not take.
 *
 * A shape inserted from the 1.6.0 toolbar was stored centred on a point:
 *   <x-shape kind="rect" style="position:absolute; top:50%; left:50%;
 *            width:300px; height:300px; …; transform:translate(-50%, -50%)">
 * The presentation editor accepts only rotate() on <x-shape> and drops the
 * translate, which leaves the shape half its own size down and to the right.
 * The same position is expressible without a transform, so the translate is
 * folded into left/top here.
 *
 * Applied to the text handed to the editor, never to storage: a slide file is
 * rewritten only when the person changes that slide, as with any edit. A style
 * that cannot be folded exactly is returned unchanged. */
export function legacySlideText(html: string): string {
  if (!html.includes("<x-shape") || !html.includes("translate")) return html;
  return html.replace(/<x-shape\b[^>]*>/g, tag => {
    const style = /\sstyle="([^"]*)"/.exec(tag);
    if (!style) return tag;
    const folded = foldShapeTranslate(style[1]);
    return folded === undefined ? tag : tag.replace(style[0], ` style="${folded}"`);
  });
}

const number = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;
const px = new RegExp(`^(${number})(?:px)?$`), percent = new RegExp(`^(${number})%$`);
const calc = new RegExp(String.raw`^calc\(\s*(${number})%\s*([+-])\s*(${number})(?:px)?\s*\)$`);
const round = (value: number) => { const n = Math.round(value * 100) / 100; return Object.is(n, -0) ? 0 : n; };

/** A translate() argument as an offset in px: a length, or a share of the shape's own size. */
function offset(value: string | undefined, size: string | undefined): number | undefined {
  if (value === undefined) return 0;
  const length = px.exec(value); if (length) return Number(length[1]);
  const share = percent.exec(value), extent = size === undefined ? null : px.exec(size);
  return share && extent ? Number(extent[1]) * Number(share[1]) / 100 : undefined;
}
/** left/top moved by `by` px, in the forms the slide format allows: N px, N%, calc(N% ± Npx). */
function moved(position: string | undefined, by: number): string | undefined {
  if (position === undefined) return undefined;
  if (by === 0) return position;
  const length = px.exec(position); if (length) return `${round(Number(length[1]) + by)}px`;
  const share = percent.exec(position), mixed = calc.exec(position);
  if (!share && !mixed) return undefined;
  const part = share ? Number(share[1]) : Number(mixed![1]), rest = round((mixed ? (mixed[2] === "-" ? -1 : 1) * Number(mixed[3]) : 0) + by);
  return rest === 0 ? `${part}%` : `calc(${part}% ${rest < 0 ? "-" : "+"} ${Math.abs(rest)}px)`;
}
function foldShapeTranslate(style: string): string | undefined {
  const rules = style.split(";").map(rule => rule.trim()).filter(Boolean).map(rule => { const at = rule.indexOf(":"); return [rule.slice(0, at).trim().toLowerCase(), rule.slice(at + 1).trim()] as [string, string]; });
  if (rules.some(([name]) => !name)) return undefined;
  const value = (name: string) => { const found = rules.filter(rule => rule[0] === name); return found.length === 1 ? found[0][1] : undefined; };
  const transform = value("transform");
  // translate(x[, y]) | translateX(x) | translateY(y), then at most a rotate(): what the 1.6.0 editor wrote.
  const parsed = transform === undefined ? null : new RegExp(String.raw`^(?:translate\(\s*([^,()\s]+)\s*(?:,\s*([^,()\s]+)\s*)?\)|translateX\(\s*([^,()\s]+)\s*\)|translateY\(\s*([^,()\s]+)\s*\))(?:\s+(rotate\([^()]*\)))?$`, "i").exec(transform);
  if (!parsed) return undefined;
  const dx = offset(parsed[1] ?? parsed[3], value("width")), dy = offset(parsed[1] !== undefined ? parsed[2] : parsed[4], value("height"));
  if (dx === undefined || dy === undefined) return undefined;
  const left = dx === 0 ? value("left") : moved(value("left"), dx), top = dy === 0 ? value("top") : moved(value("top"), dy);
  if (dx !== 0 && left === undefined || dy !== 0 && top === undefined) return undefined;
  return rules.flatMap(([name, text]) => name === "transform" ? (parsed[5] ? [`transform:${parsed[5]}`] : [])
    : name === "left" && dx !== 0 ? [`left:${left}`] : name === "top" && dy !== 0 ? [`top:${top}`] : [`${name}:${text}`]).join("; ");
}
