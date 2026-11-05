import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { linkPreviewSchema, normalizedLink, type LinkPreview } from "../client-protocol/links.js";
import { readPublicResource, type PublicResource } from "./public-web.js";
import { HubError, type HubStore } from "./store.js";
import type { HubAttachments } from "./attachments.js";

const clean = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export function readPageMetadata(html: string, base: string): { title: string; siteName: string; description?: string; imageUrl?: string } {
  const meta = new Map<string, string>(); let title = "", inTitle = false, ignored = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (["script", "style", "template", "noscript"].includes(name)) ignored++;
      if (ignored) return;
      if (name === "title") inTitle = true;
      if (name === "meta") { const key = (attributes.property ?? attributes.name ?? "").toLowerCase(); if (!meta.has(key) && attributes.content) meta.set(key, attributes.content); }
    },
    ontext(value) { if (inTitle && !ignored && title.length < 1000) title += value; },
    onclosetag(name) { if (["script", "style", "template", "noscript"].includes(name)) ignored = Math.max(0, ignored - 1); if (name === "title") inTitle = false; },
  }, { decodeEntities: true }); parser.end(html);
  const description = clean(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "", 500);
  const image = meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image"); let imageUrl: string | undefined;
  try { if (image) imageUrl = normalizedLink(new URL(image, base).href); } catch { /* A malformed cover does not erase the page title. */ }
  return { title: clean(meta.get("og:title") ?? meta.get("twitter:title") ?? title, 300) || new URL(base).hostname, siteName: clean(meta.get("og:site_name") ?? new URL(base).hostname, 100), ...(description ? { description } : {}), ...(imageUrl ? { imageUrl } : {}) };
}
export type FetchedPreview = Omit<LinkPreview, "imageAttachmentId"> & { image?: { mime: string; body: Buffer } };
export async function fetchLinkPreview(url: string, signal: AbortSignal, read: (url: string, accept: string, maxBytes: number, signal: AbortSignal) => Promise<PublicResource> = readPublicResource): Promise<FetchedPreview> {
  const page = await read(url, "text/html,application/xhtml+xml", 512 * 1024, signal);
  // Decode legacy Chinese page encodings when declared; unknown encodings fall
  // back to UTF-8. The parser never runs page scripts or loads page subresources.
  const charset = page.charset ?? page.body.subarray(0, 4096).toString("latin1").match(/charset\s*=\s*["']?([a-z0-9_-]+)/i)?.[1];
  let html: string; try { html = new TextDecoder(charset ?? "utf-8").decode(page.body); } catch { html = page.body.toString("utf8"); }
  const { imageUrl, ...metadata } = readPageMetadata(html, page.url); let image: FetchedPreview["image"];
  if (imageUrl) try {
    const result = await read(imageUrl, "image/png,image/jpeg,image/webp,image/gif", 512 * 1024, signal);
    const bytes = result.body;
    const valid = result.mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : result.mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 : result.mime === "image/webp" ? bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString());
    if (valid) image = { mime: result.mime, body: bytes };
  } catch { /* Keep the title and description when a cover is unavailable. */ }
  return { url, status: "ready", ...metadata, ...(image ? { image } : {}) };
}

export class HubLinkPreviews {
  read: (url: string, signal: AbortSignal) => Promise<FetchedPreview> = fetchLinkPreview;
  private cache = new Map<string, { until: number; preview: FetchedPreview }>();
  private inflight = new Map<string, Promise<FetchedPreview>>();
  private controller = new AbortController(); private active?: Promise<void>;
  constructor(private store: HubStore, private attachments: HubAttachments) {}
  async prepare(userId: string, conversationId: string, raw: string): Promise<LinkPreview> {
    await this.store.db.serial(() => this.store.requireMember(userId, conversationId));
    const url = normalizedLink(raw); if (!url) throw new HubError("invalid_link_url"); this.controller.signal.throwIfAborted();
    const cached = this.cache.get(url);
    let result = cached && cached.until > Date.now() ? cached.preview : undefined;
    if (!result) {
      let work = this.inflight.get(url);
      if (!work) {
        if (this.inflight.size >= 4) throw new HubError("preview_busy", 429);
        work = this.read(url, AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)])).catch((): FetchedPreview => ({ url, status: "unavailable", title: new URL(url).hostname, siteName: new URL(url).hostname })).then((preview) => {
          if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(url, { until: Date.now() + (preview.status === "ready" ? 60 * 60_000 : 60_000), preview }); return preview;
        }).finally(() => this.inflight.delete(url)); this.inflight.set(url, work);
      }
      result = await work;
    }
    this.controller.signal.throwIfAborted();
    const { image, ...metadata } = result; let imageAttachmentId: string | undefined;
    if (image) {
      try {
        const sha256 = createHash("sha256").update(image.body).digest("hex"), extension = image.mime.split("/")[1]!;
        const upload = await this.attachments.create(userId, { conversationId, name: `link-preview-${sha256.slice(0, 16)}.${extension}`, mime: image.mime, size: image.body.length, sha256 });
        // A forwarded cover has complete bytes but no upload chunk receipts.
        if (!(await this.attachments.status(userId, upload.id)).complete) {
          await this.attachments.putChunk(userId, upload.id, 0, image.body); await this.attachments.complete(userId, upload.id);
        }
        imageAttachmentId = upload.id;
      } catch {
        // The cover is optional. Persist the text preview so a permanently
        // rejected cover cannot occupy the oldest candidates on every sweep.
        this.controller.signal.throwIfAborted();
        await this.store.db.serial(() => this.store.requireMember(userId, conversationId));
      }
    }
    return linkPreviewSchema.parse({ ...metadata, ...(imageAttachmentId ? { imageAttachmentId } : {}) });
  }
  tick(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    this.active ??= (async () => {
      const messages = await this.store.pendingLinkPreviews();
      await Promise.all(messages.map(async (message) => {
        try { const preview = await this.prepare(message.authorId, message.conversationId, message.previewUrl!); if (!this.controller.signal.aborted) await this.store.setLinkPreview(message.id, preview); }
        catch { /* Retry storage/access failures next sweep; never resend the message. */ }
      }));
    })().finally(() => { this.active = undefined; }); return this.active;
  }
  async stop(): Promise<void> {
    this.controller.abort();
    // Even a rejected DB-backed tick must still settle its parallel fetches.
    try { await this.active; } finally { await Promise.allSettled([...this.inflight.values()]); }
  }
}
