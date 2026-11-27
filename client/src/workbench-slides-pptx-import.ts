import { unzipSync } from "fflate";
import { DESIGN_FILE_BYTES } from "../../src/client-protocol/workbench-design.js";
import { designTextFile, encodeDesignFile, validateDesignDocument, type DesignDocument, type DesignFile } from "./workbench-design.js";

/** Limits for untrusted .pptx uploads (zip-bomb and memory safety). */
const MAX_PPTX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_PPTX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_PPTX_ENTRIES = 512;
const MAX_PPTX_ENTRY_NAME_BYTES = 512;
const MAX_SLIDES = 200;
/** Open Artifact slide compiler limits: 24 pinned children per host, 800 elements hard max. */
const MAX_PINNED_PER_HOST = 24;
const MAX_SLIDE_ELEMENTS = 720;
const EMU_PER_PT = 12700;

/** Only inflate OOXML entries that the slides importer actually reads. */
const NEEDED_PPTX_ENTRY = /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|(?:slides|notesSlides|theme|media)\/.+)$/;

type RelMap = Map<string, { target: string; type: string }>;
type ThemeColors = Record<string, string>;

const DEFAULT_THEME_COLORS: ThemeColors = {
  dk1: "#1a1a1a",
  lt1: "#ffffff",
  dk2: "#334155",
  lt2: "#f8fafc",
  tx1: "#1a1a1a",
  bg1: "#ffffff",
  tx2: "#475569",
  bg2: "#f1f5f9",
  accent1: "#2563eb",
  accent2: "#0f766e",
  accent3: "#d97706",
  accent4: "#7c3aed",
  accent5: "#dc2626",
  accent6: "#0891b2",
};

function safeCodePoint(cp: number): string {
  if (
    Number.isInteger(cp) &&
    (cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0x10ffff))
  ) {
    return String.fromCodePoint(cp);
  }
  return "";
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => safeCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeFontFamily(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = decodeXmlEntities(raw).trim();
  if (!trimmed || trimmed.startsWith("+")) return undefined;
  // Drop any CSS injection tail after delimiters, then allow only safe font-name characters.
  const head = trimmed.split(/[;:{}"'\\()<>\r\n\t]/)[0] ?? "";
  const clean = head.replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 64);
  return clean || undefined;
}

function formatFontFamilyCss(font: string): string {
  return `font-family:'${escapeHtml(font)}'`;
}

function getZipEntry(entries: Record<string, Uint8Array>, path: string): Uint8Array | undefined {
  return Object.hasOwn(entries, path) ? entries[path] : undefined;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(tag);
  return m ? decodeXmlEntities(m[1]!) : undefined;
}

function normalizeZipPath(baseDir: string, target: string): string {
  const clean = target.replace(/^\/+/, "");
  const parts = (target.startsWith("/") ? clean : `${baseDir}/${clean}`).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function parseRels(xml: string | undefined): RelMap {
  const map: RelMap = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const id = attr(attrs, "Id");
    const target = attr(attrs, "Target");
    const type = attr(attrs, "Type") ?? "";
    if (id && target) map.set(id, { target, type });
  }
  return map;
}

function parseThemeColors(xml: string | undefined): ThemeColors {
  const colors: ThemeColors = { ...DEFAULT_THEME_COLORS };
  if (!xml) return colors;
  const clrScheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1];
  if (!clrScheme) return colors;
  for (const key of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]) {
    const block = new RegExp(`<a:${key}\\b[^>]*>([\\s\\S]*?)<\\/a:${key}>`).exec(clrScheme)?.[1];
    if (!block) continue;
    const srgb = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const sys = /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const hex = srgb ?? sys;
    if (hex) colors[key] = `#${hex}`;
  }
  colors.tx1 = colors.dk1;
  colors.bg1 = colors.lt1;
  colors.tx2 = colors.dk2;
  colors.bg2 = colors.lt2;
  return colors;
}

function extractColor(xml: string | undefined, theme: ThemeColors): string | undefined {
  if (!xml) return undefined;
  const srgb = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
  if (srgb) return `#${srgb}`;
  const scheme = /<a:schemeClr\b[^>]*val="([^"]+)"/.exec(xml)?.[1];
  if (scheme && Object.hasOwn(theme, scheme)) return theme[scheme];
  return undefined;
}

function extractSolidFill(xml: string | undefined, theme: ThemeColors): string | undefined {
  if (!xml) return undefined;
  const solid = /<a:solidFill\b[^>]*>([\s\S]*?)<\/a:solidFill>/.exec(xml)?.[1];
  return extractColor(solid, theme);
}

/** Extract fill on a shape or cell properties block while ignoring border (<a:ln*>) and effects. */
function extractContainerFill(propsXml: string | undefined, theme: ThemeColors): string | undefined {
  if (!propsXml) return undefined;
  const stripped = propsXml
    .replace(/<a:ln[A-Za-z]*\b[^>]*\/>/g, "")
    .replace(/<a:ln[A-Za-z]*\b[^>]*>[\s\S]*?<\/a:ln[A-Za-z]*>/g, "")
    .replace(/<a:effectLst\b[^>]*>[\s\S]*?<\/a:effectLst>/g, "");
  if (/<a:noFill\b/.test(stripped)) return undefined;
  return extractSolidFill(stripped, theme);
}

/** Extract top-level blocks matching `<tagName ...>...</tagName>` (handles nesting). */
function extractTagBlocks(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
  const closeStr = `</${tagName}>`;
  let pos = 0;
  while (pos < xml.length) {
    openRe.lastIndex = pos;
    const start = openRe.exec(xml);
    if (!start) break;
    if (start[0].endsWith("/>")) {
      results.push(start[0]);
      pos = start.index + start[0].length;
      continue;
    }
    let depth = 1;
    let cursor = start.index + start[0].length;
    while (depth > 0 && cursor < xml.length) {
      openRe.lastIndex = cursor;
      const nextOpen = openRe.exec(xml);
      const nextClose = xml.indexOf(closeStr, cursor);
      if (nextClose < 0) break;
      if (nextOpen && nextOpen.index < nextClose && !nextOpen[0].endsWith("/>")) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose + closeStr.length;
      }
    }
    results.push(xml.slice(start.index, cursor));
    pos = cursor;
  }
  return results;
}

/** Walk direct child XML elements in exact document order. */
function extractDirectChildren(xml: string, wantedTags: ReadonlySet<string>): Array<{ tag: string; xml: string }> {
  const out: Array<{ tag: string; xml: string }> = [];
  const tokenRe = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([A-Za-z0-9_:-]+)\s*>|<([A-Za-z0-9_:-]+)(?:\s[^>]*)?>/g;
  let depth = 0;
  let captureTag: string | undefined;
  let captureStart = 0;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(xml)) !== null) {
    const closeTag = m[1];
    const openTag = m[2];
    const selfClose = m[0].endsWith("/>");
    if (closeTag !== undefined) {
      if (depth > 0) depth--;
      if (depth === 0 && captureTag !== undefined) {
        out.push({ tag: captureTag, xml: xml.slice(captureStart, m.index + m[0].length) });
        captureTag = undefined;
      }
    } else if (openTag !== undefined) {
      if (selfClose) {
        if (depth === 0 && wantedTags.has(openTag)) {
          out.push({ tag: openTag, xml: m[0] });
        }
      } else {
        if (depth === 0 && wantedTags.has(openTag)) {
          captureTag = openTag;
          captureStart = m.index;
        }
        depth++;
      }
    }
  }
  return out;
}

function unwrapOuterTag(xml: string): string {
  const openEnd = xml.indexOf(">");
  const closeStart = xml.lastIndexOf("</");
  if (openEnd < 0 || closeStart <= openEnd) return "";
  return xml.slice(openEnd + 1, closeStart);
}

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

interface EmuTransform {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

function extractXfrm(xml: string, xform: EmuTransform): BoxRect | undefined {
  const xfrm = /<(?:a|p):xfrm\b([^>]*)>([\s\S]*?)<\/(?:a|p):xfrm>/.exec(xml);
  if (!xfrm) return undefined;
  const attrs = xfrm[1] ?? "";
  const inner = xfrm[2] ?? "";
  const offTag = /<a:off\b([^>]*)\/?>/.exec(inner)?.[1];
  const extTag = /<a:ext\b([^>]*)\/?>/.exec(inner)?.[1];
  if (!offTag || !extTag) return undefined;
  const x = Number(attr(offTag, "x") ?? 0);
  const y = Number(attr(offTag, "y") ?? 0);
  const cx = Number(attr(extTag, "cx") ?? 0);
  const cy = Number(attr(extTag, "cy") ?? 0);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) return undefined;
  const rotRaw = Number(attr(attrs, "rot") ?? 0);
  const rot = Number.isFinite(rotRaw) && rotRaw !== 0 ? Math.round((rotRaw / 60000) * 10) / 10 : undefined;
  return {
    x: Math.round(xform.tx + x * xform.sx),
    y: Math.round(xform.ty + y * xform.sy),
    w: Math.max(8, Math.round(cx * xform.sx)),
    h: Math.max(8, Math.round(cy * xform.sy)),
    ...(rot ? { rot } : {}),
  };
}

function composeGroupTransform(grpSpXml: string, parent: EmuTransform): EmuTransform {
  const grpSpPr = /<p:grpSpPr\b[^>]*>([\s\S]*?)<\/p:grpSpPr>/.exec(grpSpXml)?.[1];
  if (!grpSpPr) return parent;
  const xfrmInner = /<a:xfrm\b[^>]*>([\s\S]*?)<\/a:xfrm>/.exec(grpSpPr)?.[1];
  if (!xfrmInner) return parent;
  const offTag = /<a:off\b([^>]*)\/?>/.exec(xfrmInner)?.[1];
  const extTag = /<a:ext\b([^>]*)\/?>/.exec(xfrmInner)?.[1];
  const chOffTag = /<a:chOff\b([^>]*)\/?>/.exec(xfrmInner)?.[1];
  const chExtTag = /<a:chExt\b([^>]*)\/?>/.exec(xfrmInner)?.[1];
  if (!offTag || !extTag || !chOffTag || !chExtTag) return parent;
  const ox = Number(attr(offTag, "x") ?? 0);
  const oy = Number(attr(offTag, "y") ?? 0);
  const ecx = Number(attr(extTag, "cx") ?? 0);
  const ecy = Number(attr(extTag, "cy") ?? 0);
  const chx = Number(attr(chOffTag, "x") ?? 0);
  const chy = Number(attr(chOffTag, "y") ?? 0);
  const chcx = Number(attr(chExtTag, "cx") ?? 0);
  const chcy = Number(attr(chExtTag, "cy") ?? 0);
  if (![ox, oy, ecx, ecy, chx, chy, chcx, chcy].every(Number.isFinite) || ecx <= 0 || ecy <= 0 || chcx <= 0 || chcy <= 0) {
    return parent;
  }
  const sx = parent.sx * (ecx / chcx);
  const sy = parent.sy * (ecy / chcy);
  return {
    tx: parent.tx + ox * parent.sx - chx * sx,
    ty: parent.ty + oy * parent.sy - chy * sy,
    sx,
    sy,
  };
}

interface ParsedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSizePx?: number;
  fontFamily?: string;
}

interface ParsedParagraph {
  runs: ParsedRun[];
  align?: "left" | "center" | "right" | "justify";
  bullet?: "ul" | "ol";
}

function parseParagraphs(txBodyXml: string, theme: ThemeColors, ptToPx: number): ParsedParagraph[] {
  const out: ParsedParagraph[] = [];
  for (const pXml of extractTagBlocks(txBodyXml, "a:p")) {
    const pPrMatch = /<a:pPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:pPr>)/.exec(pXml);
    const pPrAttrs = pPrMatch?.[1] ?? "";
    const pPrBody = pPrMatch?.[2] ?? "";
    const algn = attr(pPrAttrs, "algn");
    const align = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : undefined;
    const hasBuNone = /<a:buNone\b/.test(pPrBody);
    const hasBuAuto = !hasBuNone && /<a:buAutoNum\b/.test(pPrBody);
    const hasBuChar = !hasBuNone && /<a:buChar\b/.test(pPrBody);
    const bullet = hasBuAuto ? "ol" : hasBuChar ? "ul" : undefined;

    const runs: ParsedRun[] = [];
    for (const token of pXml.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>|<a:br\b[^>]*\/?>/g)) {
      if (token[0].startsWith("<a:br")) {
        runs.push({ text: "\n" });
        continue;
      }
      const rXml = token[1] ?? "";
      const textMatch = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/.exec(rXml);
      if (!textMatch) continue;
      const text = decodeXmlEntities(textMatch[1]!);
      if (!text) continue;
      const rPrMatch = /<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/.exec(rXml);
      const rPrAttrs = rPrMatch?.[1] ?? "";
      const rPrBody = rPrMatch?.[2] ?? "";
      const sz = Number(attr(rPrAttrs, "sz") ?? 0);
      const fontSizePx = sz > 0 ? Math.max(12, Math.min(200, Math.round((sz / 100) * ptToPx))) : undefined;
      const bold = attr(rPrAttrs, "b") === "1" || attr(rPrAttrs, "b") === "true";
      const italic = attr(rPrAttrs, "i") === "1" || attr(rPrAttrs, "i") === "true";
      const u = attr(rPrAttrs, "u");
      const underline = !!u && u !== "none";
      const color = extractSolidFill(rPrBody, theme);
      const latin = /<a:latin\b[^>]*typeface="([^"]+)"/.exec(rPrBody)?.[1];
      const ea = /<a:ea\b[^>]*typeface="([^"]+)"/.exec(rPrBody)?.[1];
      const fontFamily = sanitizeFontFamily(latin) ?? sanitizeFontFamily(ea);
      runs.push({ text, bold, italic, underline, color, fontSizePx, fontFamily });
    }
    if (runs.length > 0) out.push({ runs, align, bullet });
  }
  return out;
}

function renderRunHtml(run: ParsedRun, defaultColor?: string): string {
  if (run.text === "\n") return "<br>";
  let html = escapeHtml(run.text);
  if (run.underline) html = `<u>${html}</u>`;
  if (run.italic) html = `<i>${html}</i>`;
  if (run.bold) html = `<b>${html}</b>`;
  if (run.color && run.color !== defaultColor) {
    html = `<span style="color:${run.color}">${html}</span>`;
  }
  return html;
}

function mediaContentType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return undefined;
}

function positionStyle(box: BoxRect): string {
  const parts = [
    "position:absolute",
    `left:${box.x}px`,
    `top:${box.y}px`,
    `width:${box.w}px`,
    `height:${box.h}px`,
  ];
  if (box.rot) parts.push(`transform:rotate(${box.rot}deg)`);
  return parts.join(";");
}

interface RenderedElement {
  html: string;
  /** Approximate count of slide AST elements contributed toward Open Artifact's elementsHard limit. */
  cost: number;
}

function renderShapeHtml(spXml: string, xform: EmuTransform, ptToPx: number, theme: ThemeColors): RenderedElement | undefined {
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(spXml)?.[1] ?? "";
  const box = extractXfrm(spPr, xform);
  const txBody = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/.exec(spXml)?.[1];
  const paragraphs = txBody ? parseParagraphs(txBody, theme, ptToPx) : [];
  const bg = extractContainerFill(spPr, theme);
  const lnBlock = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(spPr);
  const lnColor = lnBlock && !/<a:noFill\b/.test(lnBlock[2] ?? "") ? extractSolidFill(lnBlock[2], theme) : undefined;
  const lnW = lnBlock ? Number(attr(lnBlock[1] ?? "", "w") ?? 0) : 0;
  const borderWidth = lnColor ? Math.max(1, Math.round((lnW / EMU_PER_PT) * ptToPx)) : 0;
  const prst = /<a:prstGeom\b[^>]*prst="([^"]+)"/.exec(spPr)?.[1];
  const phType = /<p:ph\b[^>]*type="([^"]+)"/.exec(spXml)?.[1];

  if (!box && paragraphs.length === 0) return undefined;
  const effectiveBox: BoxRect = box ?? { x: 120, y: 120, w: 1680, h: 160 };

  const shapeStyles: string[] = [positionStyle(effectiveBox), "box-sizing:border-box"];
  if (bg) shapeStyles.push(`background:${bg}`);
  if (lnColor && borderWidth > 0) shapeStyles.push(`border:${borderWidth}px solid ${lnColor}`);
  if (prst === "ellipse") shapeStyles.push("border-radius:50%");
  else if (prst === "roundRect") shapeStyles.push("border-radius:16px");

  // Pure decorative shape without text
  if (paragraphs.length === 0) {
    if (!bg && !lnColor) return undefined;
    return { html: `  <div style="${shapeStyles.join(";")}"></div>`, cost: 1 };
  }

  const firstRun = paragraphs[0]?.runs.find(r => r.text.trim());
  const defaultColor = firstRun?.color;
  const defaultSize = firstRun?.fontSizePx ?? (phType === "title" || phType === "ctrTitle" ? 72 : phType === "subTitle" ? 40 : 32);
  const defaultFont = firstRun?.fontFamily;
  const allBullets = paragraphs.length > 0 && paragraphs.every(p => p.bullet === paragraphs[0]!.bullet && p.bullet !== undefined);

  if (paragraphs.length === 1 && !paragraphs[0]!.bullet && !bg && !lnColor) {
    const p = paragraphs[0]!;
    const tag = phType === "title" || phType === "ctrTitle" || defaultSize >= 64 ? "h1" : defaultSize >= 44 ? "h2" : "p";
    const styles = [
      ...shapeStyles,
      `font-size:${defaultSize}px`,
      "margin:0",
      "line-height:1.25",
    ];
    if (defaultColor) styles.push(`color:${defaultColor}`);
    if (defaultFont) styles.push(formatFontFamilyCss(defaultFont));
    if (p.align) styles.push(`text-align:${p.align}`);
    const inner = p.runs.map(r => renderRunHtml(r, defaultColor)).join("");
    return { html: `  <${tag} style="${styles.join(";")}">${inner}</${tag}>`, cost: 1 };
  }

  if (allBullets && !bg && !lnColor) {
    const listTag = paragraphs[0]!.bullet!;
    const styles = [
      ...shapeStyles,
      `font-size:${defaultSize}px`,
      "margin:0",
      "padding-left:40px",
      "line-height:1.4",
    ];
    if (defaultColor) styles.push(`color:${defaultColor}`);
    if (defaultFont) styles.push(formatFontFamilyCss(defaultFont));
    const items = paragraphs.map(p => `    <li>${p.runs.map(r => renderRunHtml(r, defaultColor)).join("")}</li>`).join("\n");
    return { html: `  <${listTag} style="${styles.join(";")}">\n${items}\n  </${listTag}>`, cost: 1 };
  }

  // Multi-paragraph or boxed text container.
  // Open Artifact's <div data-text> strips styles from child <p>/<ul>/<ol>.
  // Use <div data-text> with unstyled children when all paragraphs share alignment
  // and font size; otherwise use a regular <div> so per-paragraph styles survive.
  const aligns = new Set(paragraphs.map(p => p.align ?? "left"));
  const sizes = new Set(paragraphs.map(p => p.runs.find(r => r.text.trim())?.fontSizePx ?? defaultSize));
  const useDataText = aligns.size <= 1 && sizes.size <= 1;

  const boxStyles = [
    ...shapeStyles,
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    "padding:16px",
    `font-size:${defaultSize}px`,
    "line-height:1.35",
  ];
  if (defaultColor) boxStyles.push(`color:${defaultColor}`);
  if (defaultFont) boxStyles.push(formatFontFamilyCss(defaultFont));
  if (useDataText && paragraphs[0]?.align) boxStyles.push(`text-align:${paragraphs[0].align}`);

  const children: string[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const p = paragraphs[i]!;
    if (p.bullet) {
      const kind = p.bullet;
      const group: ParsedParagraph[] = [];
      while (i < paragraphs.length && paragraphs[i]!.bullet === kind) {
        group.push(paragraphs[i]!);
        i++;
      }
      const items = group.map(item => `      <li>${item.runs.map(r => renderRunHtml(r, defaultColor)).join("")}</li>`).join("\n");
      if (useDataText) {
        children.push(`    <${kind}>\n${items}\n    </${kind}>`);
      } else {
        children.push(`    <${kind} style="margin:0;padding-left:36px">\n${items}\n    </${kind}>`);
      }
    } else {
      const inner = p.runs.map(r => renderRunHtml(r, defaultColor)).join("");
      if (useDataText) {
        children.push(`    <p>${inner}</p>`);
      } else {
        const pStyle = [
          "margin:0",
          ...(p.align ? [`text-align:${p.align}`] : []),
          ...(p.runs[0]?.fontSizePx && p.runs[0].fontSizePx !== defaultSize ? [`font-size:${p.runs[0].fontSizePx}px`] : []),
        ].join(";");
        children.push(`    <p style="${pStyle}">${inner}</p>`);
      }
      i++;
    }
  }
  const openTag = useDataText ? `<div data-text style="${boxStyles.join(";")}">` : `<div style="${boxStyles.join(";")}">`;
  return {
    html: `  ${openTag}\n${children.join("\n")}\n  </div>`,
    cost: useDataText ? 1 : 1 + children.length,
  };
}

function renderTableHtml(frameXml: string, xform: EmuTransform, ptToPx: number, theme: ThemeColors): RenderedElement | undefined {
  const tblXml = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/.exec(frameXml)?.[1];
  if (!tblXml) return undefined;
  const rows = extractTagBlocks(tblXml, "a:tr");
  if (rows.length === 0) return undefined;
  const box = extractXfrm(frameXml, xform) ?? { x: 120, y: 200, w: 1680, h: 500 };
  const trHtml: string[] = [];
  rows.forEach((trXml, rowIndex) => {
    const cells = extractTagBlocks(trXml, "a:tc");
    const tdHtml = cells.map(tcXml => {
      const txBody = /<a:txBody\b[^>]*>([\s\S]*?)<\/a:txBody>/.exec(tcXml)?.[1];
      const tcPr = /<a:tcPr\b[^>]*>([\s\S]*?)<\/a:tcPr>/.exec(tcXml)?.[1];
      const cellBg = extractContainerFill(tcPr, theme);
      const paragraphs = txBody ? parseParagraphs(txBody, theme, ptToPx) : [];
      const text = paragraphs.map(p => p.runs.map(r => renderRunHtml(r)).join("")).join("<br>");
      const cellTag = rowIndex === 0 ? "th" : "td";
      const cellStyle = [
        "padding:14px 18px",
        "border:1px solid #d1d5db",
        "text-align:left",
        ...(cellBg ? [`background:${cellBg}`] : rowIndex === 0 ? ["background:#f3f4f6"] : []),
      ].join(";");
      return `        <${cellTag} style="${cellStyle}">${text}</${cellTag}>`;
    });
    trHtml.push(`      <tr>\n${tdHtml.join("\n")}\n      </tr>`);
  });
  return {
    html: `  <div style="${positionStyle(box)};overflow:hidden">\n    <table style="width:100%;height:100%;border-collapse:collapse;font-size:26px;color:#1a1a1a">\n${trHtml.join("\n")}\n    </table>\n  </div>`,
    cost: 2,
  };
}

function renderPictureHtml(
  picXml: string,
  slideRels: RelMap,
  slideDir: string,
  entries: Record<string, Uint8Array>,
  assets: Record<string, DesignFile>,
  xform: EmuTransform,
): RenderedElement | undefined {
  const embedId = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(picXml)?.[1];
  if (!embedId) return undefined;
  const rel = slideRels.get(embedId);
  if (!rel) return undefined;
  const mediaPath = normalizeZipPath(slideDir, rel.target);
  const bytes = getZipEntry(entries, mediaPath);
  const contentType = mediaContentType(mediaPath);
  if (!bytes || !contentType) return undefined;

  const encoded = encodeDesignFile(bytes, contentType);
  const assetId = encoded.sha256.slice(0, 32);
  const assetPath = `project/assets/${assetId}`;
  if (!Object.hasOwn(assets, assetPath)) assets[assetPath] = encoded;

  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(picXml)?.[1] ?? "";
  const box = extractXfrm(spPr, xform) ?? { x: 160, y: 160, w: 640, h: 480 };
  const cNvPr = /<p:cNvPr\b([^>]*)\/?>/.exec(picXml)?.[1] ?? "";
  const alt = escapeHtml(attr(cNvPr, "descr") ?? attr(cNvPr, "name") ?? "Image");
  return { html: `  <img src="/_blob/${assetId}" alt="${alt}" style="${positionStyle(box)};object-fit:contain">`, cost: 1 };
}

const TREE_NODE_TAGS = new Set(["p:sp", "p:graphicFrame", "p:pic", "p:grpSp", "mc:AlternateContent"]);

function collectTreeElements(
  treeInnerXml: string,
  xform: EmuTransform,
  ptToPx: number,
  theme: ThemeColors,
  slideRels: RelMap,
  slideDir: string,
  entries: Record<string, Uint8Array>,
  assets: Record<string, DesignFile>,
  out: RenderedElement[],
  budget: { used: number },
  depth = 0,
): void {
  if (depth > 16 || budget.used >= MAX_SLIDE_ELEMENTS) return;
  for (const child of extractDirectChildren(treeInnerXml, TREE_NODE_TAGS)) {
    if (budget.used >= MAX_SLIDE_ELEMENTS) break;
    if (child.tag === "p:sp") {
      const rendered = renderShapeHtml(child.xml, xform, ptToPx, theme);
      if (rendered && budget.used + rendered.cost <= MAX_SLIDE_ELEMENTS) {
        out.push(rendered);
        budget.used += rendered.cost;
      }
    } else if (child.tag === "p:graphicFrame") {
      const rendered = renderTableHtml(child.xml, xform, ptToPx, theme);
      if (rendered && budget.used + rendered.cost <= MAX_SLIDE_ELEMENTS) {
        out.push(rendered);
        budget.used += rendered.cost;
      }
    } else if (child.tag === "p:pic") {
      const rendered = renderPictureHtml(child.xml, slideRels, slideDir, entries, assets, xform);
      if (rendered && budget.used + rendered.cost <= MAX_SLIDE_ELEMENTS) {
        out.push(rendered);
        budget.used += rendered.cost;
      }
    } else if (child.tag === "p:grpSp") {
      const nextXform = composeGroupTransform(child.xml, xform);
      collectTreeElements(unwrapOuterTag(child.xml), nextXform, ptToPx, theme, slideRels, slideDir, entries, assets, out, budget, depth + 1);
    } else if (child.tag === "mc:AlternateContent") {
      const choice = /<mc:Choice\b[^>]*>([\s\S]*?)<\/mc:Choice>/.exec(child.xml)?.[1];
      const fallback = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(child.xml)?.[1];
      const branch = choice ?? fallback;
      if (branch) {
        collectTreeElements(branch, xform, ptToPx, theme, slideRels, slideDir, entries, assets, out, budget, depth + 1);
      }
    }
  }
}

/**
 * Open Artifact limits each positioning host to 24 positioned children.
 * Partition larger element lists into position:relative <div> layers (0px flow
 * height when holding only position:absolute children, so every layer keeps
 * exact slide coordinates).
 */
function layoutSlideElements(elements: RenderedElement[]): string[] {
  if (elements.length <= MAX_PINNED_PER_HOST) {
    return elements.map(item => item.html);
  }
  const layers: string[] = [];
  for (let i = 0; i < elements.length; i += MAX_PINNED_PER_HOST) {
    const chunk = elements.slice(i, i + MAX_PINNED_PER_HOST);
    const indented = chunk.map(item => item.html.split("\n").map(line => `  ${line}`).join("\n"));
    layers.push(`  <div style="position:relative">\n${indented.join("\n")}\n  </div>`);
  }
  return layers;
}

function extractNotesText(notesXml: string | undefined, theme: ThemeColors): string {
  if (!notesXml) return "";
  const parts: string[] = [];
  for (const spXml of extractTagBlocks(notesXml, "p:sp")) {
    const phType = /<p:ph\b[^>]*type="([^"]+)"/.exec(spXml)?.[1];
    if (phType && phType !== "body") continue;
    const txBody = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/.exec(spXml)?.[1];
    if (!txBody) continue;
    for (const p of parseParagraphs(txBody, theme, 1)) {
      const line = p.runs.map(r => r.text).join("").trim();
      if (line) parts.push(line);
    }
  }
  return parts.join("\n");
}

function decodeUtf8(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : undefined;
}

/**
 * Converts a PowerPoint `.pptx` binary archive into an editable Workbench
 * Presentation (`project/deck.json` v4 + `project/slides/*.html` + embedded
 * `project/assets/*` images).
 */
export function importPptxToSlides(archiveBytes: Uint8Array, options: { id: string; title?: string }): DesignDocument {
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_PPTX_ARCHIVE_BYTES) {
    throw new Error("slides_invalid_pptx_import");
  }

  let entryCount = 0;
  let declaredUncompressed = 0;
  let filterError: Error | undefined;

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archiveBytes, {
      filter(file) {
        entryCount++;
        if (entryCount > MAX_PPTX_ENTRIES) {
          filterError = new Error("slides_invalid_pptx_import");
          throw filterError;
        }
        const name = file.name;
        if (
          !name ||
          name.length > MAX_PPTX_ENTRY_NAME_BYTES ||
          name.includes("..") ||
          name.startsWith("/") ||
          name.includes("\\") ||
          /[\x00-\x1f]/.test(name)
        ) {
          filterError = new Error("slides_invalid_pptx_import");
          throw filterError;
        }
        const orig = Number(file.originalSize);
        if (!Number.isFinite(orig) || orig < 0) {
          filterError = new Error("slides_invalid_pptx_import");
          throw filterError;
        }
        declaredUncompressed += orig;
        if (declaredUncompressed > MAX_PPTX_UNCOMPRESSED_BYTES) {
          filterError = new Error("slides_invalid_pptx_import");
          throw filterError;
        }
        if (!NEEDED_PPTX_ENTRY.test(name)) return false;
        if (name.startsWith("ppt/media/") && orig > DESIGN_FILE_BYTES) {
          filterError = new Error("design_file_too_large");
          throw filterError;
        }
        return true;
      },
    });
  } catch {
    throw filterError ?? new Error("slides_invalid_pptx_import");
  }

  const names = Object.keys(entries);
  if (entryCount === 0 || names.length === 0 || names.length > MAX_PPTX_ENTRIES) throw new Error("slides_invalid_pptx_import");
  // Re-verify actual inflated byte counts to guard against spoofed central-directory sizes.
  let totalUncompressed = 0;
  for (const name of names) {
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new Error("slides_invalid_pptx_import");
    const data = getZipEntry(entries, name);
    if (!data) continue;
    totalUncompressed += data.byteLength;
    if (totalUncompressed > MAX_PPTX_UNCOMPRESSED_BYTES) throw new Error("slides_invalid_pptx_import");
  }

  const presentationXml = decodeUtf8(getZipEntry(entries, "ppt/presentation.xml"));
  if (!presentationXml) throw new Error("slides_invalid_pptx_import");
  const presentationRels = parseRels(decodeUtf8(getZipEntry(entries, "ppt/_rels/presentation.xml.rels")));

  // Slide size in EMUs (default widescreen 16:9: 12192000 x 6858000 = 960pt x 540pt)
  const sldSzTag = /<p:sldSz\b([^>]*)\/?>/.exec(presentationXml)?.[1] ?? "";
  const cxEmu = Number(attr(sldSzTag, "cx") ?? 12192000) || 12192000;
  const cyEmu = Number(attr(sldSzTag, "cy") ?? 6858000) || 6858000;
  const aspect = cxEmu / cyEmu;
  const is43 = Math.abs(aspect - 4 / 3) < 0.15;
  const targetW = is43 ? 1440 : 1920;
  const targetH = 1080;
  const scaleX = targetW / cxEmu;
  const scaleY = targetH / cyEmu;
  const ptToPx = targetH / (cyEmu / EMU_PER_PT);
  const rootTransform: EmuTransform = { tx: 0, ty: 0, sx: scaleX, sy: scaleY };

  const theme = parseThemeColors(decodeUtf8(getZipEntry(entries, "ppt/theme/theme1.xml")));

  // Resolve slide paths in deck order
  const slidePaths: string[] = [];
  for (const m of presentationXml.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const rId = attr(m[1] ?? "", "r:id");
    const rel = rId ? presentationRels.get(rId) : undefined;
    if (!rel) continue;
    const resolved = normalizeZipPath("ppt", rel.target);
    if (getZipEntry(entries, resolved)) slidePaths.push(resolved);
  }
  if (slidePaths.length === 0) {
    // Fallback: sorted ppt/slides/slide*.xml
    const found = names
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    slidePaths.push(...found);
  }
  if (slidePaths.length === 0 || slidePaths.length > MAX_SLIDES) throw new Error("slides_invalid_pptx_import");

  const files: Record<string, DesignFile> = {};
  const order: string[] = [];

  for (let idx = 0; idx < slidePaths.length; idx++) {
    const slidePath = slidePaths[idx]!;
    const slideXml = decodeUtf8(getZipEntry(entries, slidePath));
    if (!slideXml) continue;
    const slideId = `slide-${idx + 1}`;
    order.push(slideId);

    const slash = slidePath.lastIndexOf("/");
    const slideDir = slash >= 0 ? slidePath.slice(0, slash) : "";
    const slideFile = slash >= 0 ? slidePath.slice(slash + 1) : slidePath;
    const slideRels = parseRels(decodeUtf8(getZipEntry(entries, `${slideDir}/_rels/${slideFile}.rels`)));

    const bgBlock = /<p:bg\b[^>]*>([\s\S]*?)<\/p:bg>/.exec(slideXml)?.[1];
    const bgColor = extractSolidFill(bgBlock, theme) ?? "#ffffff";
    const elements: RenderedElement[] = [];

    const spTree = /<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/.exec(slideXml)?.[1] ?? slideXml;
    collectTreeElements(spTree, rootTransform, ptToPx, theme, slideRels, slideDir, entries, files, elements, { used: 0 });

    // Optional speaker notes
    let notes = "";
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith("/notesSlide")) {
        const notesPath = normalizeZipPath(slideDir, rel.target);
        notes = extractNotesText(decodeUtf8(getZipEntry(entries, notesPath)), theme);
        break;
      }
    }

    const bodyLines = layoutSlideElements(elements);
    const lines = [
      `<section id="${slideId}" style="background:${bgColor};color:#1a1a1a;font-family:Arial,sans-serif">`,
      ...bodyLines,
      ...(notes ? ["  <aside>", `    ${escapeHtml(notes).replace(/\n/g, "\n    ")}`, "  </aside>"] : []),
      "</section>",
      "",
    ];
    files[`project/slides/${slideId}.html`] = designTextFile(lines.join("\n"), "text/html");
  }

  const title = (options.title ?? "").trim().replace(/\.pptx$/i, "").slice(0, 128) || "Presentation";
  const deckIndex = {
    v: 4,
    createdOnFiles: { v: 1, at: new Date().toISOString() },
    lists: "css",
    title,
    ...(is43 ? { size: "4:3" } : {}),
    cover: order[0],
    order,
    sections: {},
    faces: {},
    designSystems: [],
    attachments: {},
  };
  files["project/deck.json"] = designTextFile(JSON.stringify(deckIndex, null, 2) + "\n", "application/json");

  return validateDesignDocument({
    schema: 1,
    format: "slides",
    id: options.id,
    revision: 0,
    receipts: [],
    files,
  });
}
