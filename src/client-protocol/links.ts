import { z } from "zod";

export function normalizedLink(raw: string): string | undefined {
  try { const url = new URL(raw); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || raw.length > 2048 || url.href.length > 2048) return; return url.href; } catch { return; }
}
export const linkUrlSchema = z.string().max(2048).refine((url) => !!normalizedLink(url), "invalid_link_url");
export const linkPreviewStyleSchema = z.enum(["card", "inline"]);
export type LinkPreviewStyle = z.infer<typeof linkPreviewStyleSchema>;
export const linkPreviewSchema = z.object({ url: linkUrlSchema, status: z.enum(["ready", "unavailable"]), title: z.string().max(300), siteName: z.string().max(100), description: z.string().max(500).optional(), imageAttachmentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional() });
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

/** Match the URLs users write, not code examples or inline Markdown images. */
export function extractLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!\[[^\]]*\]\([^\n]*?\)/g, " ");
  const result: string[] = [];
  for (const match of prose.matchAll(/https?:\/\/[^\s<>"'\u3000-\u303f\uff00-\uffef]+/gi)) {
    let raw = match[0].replace(/[.,;:!?]+$/, "");
    while (raw.endsWith(")") && (raw.match(/\)/g)?.length ?? 0) > (raw.match(/\(/g)?.length ?? 0)) raw = raw.slice(0, -1);
    raw = raw.replace(/[\]}]+$/, ""); const url = normalizedLink(raw);
    if (url && !result.includes(url)) result.push(url);
    if (result.length === 5) break;
  }
  return result;
}
