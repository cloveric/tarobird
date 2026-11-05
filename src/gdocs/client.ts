import { z } from "zod";
import type { Json } from "../client-protocol/index.js";
import { GoogleAuthorization } from "./auth.js";

const documentId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const bodySchema = z.object({ content: z.array(z.object({ endIndex: z.number().int().optional(), paragraph: z.object({ elements: z.array(z.object({ textRun: z.object({ content: z.string() }).optional() })) }).optional() })) });
const documentSchema = z.object({ documentId, title: z.string().optional(), revisionId: z.string(), body: bodySchema.optional(), tabs: z.array(z.object({ documentTab: z.object({ body: bodySchema }).optional() })).optional() });
export type GoogleDocumentLink = { documentId: string; url: string };
export class GoogleDocumentWriteError extends Error { constructor(readonly documentId: string) { super(`Google document exists but its content could not be verified: https://docs.google.com/document/d/${documentId}/edit`); } }
export class GoogleDocs {
  constructor(readonly authorization: GoogleAuthorization, readonly fetcher: typeof fetch = fetch) {}
  private async request(suffix: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.fetcher(`https://docs.googleapis.com/v1/documents${suffix}`, { method, headers: { Authorization: `Bearer ${await this.authorization.token()}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: "error" });
    if (!response.ok) throw new Error(`google_docs_http_${response.status}`);
    return response.json();
  }
  async create(title: string, text: string, created?: (documentId: string) => Promise<void>): Promise<GoogleDocumentLink> {
    z.string().min(1).max(500).parse(title); this.content(text);
    const result = z.object({ documentId }).parse(await this.request("", "POST", { title }));
    try { await created?.(result.documentId); return await this.update(result.documentId, text); }
    catch { throw new GoogleDocumentWriteError(result.documentId); }
  }
  private content(text: string): string { z.string().max(2_000_000).parse(text); return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""); }
  async update(id: string, text: string): Promise<GoogleDocumentLink> {
    documentId.parse(id); const content = this.content(text);
    const document = documentSchema.parse(await this.request(`/${id}?includeTabsContent=true`));
    const body = document.tabs?.[0]?.documentTab?.body ?? document.body; if (!body) throw new Error("google_document_body_missing");
    const end = Math.max(1, ...body.content.map((c) => c.endIndex ?? 1)) - 1;
    const requests: Json[] = [];
    if (end > 1) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end } } });
    if (content) requests.push({ insertText: { location: { index: 1 }, text: content } });
    if (requests.length) await this.request(`/${id}:batchUpdate`, "POST", { requests, writeControl: { requiredRevisionId: document.revisionId } });
    const saved = documentSchema.parse(await this.request(`/${id}?includeTabsContent=true`));
    const actual = (saved.tabs?.[0]?.documentTab?.body ?? saved.body)?.content.flatMap((p) => p.paragraph?.elements.map((e) => e.textRun?.content ?? "") ?? []).join("");
    if (actual !== content + "\n") throw new GoogleDocumentWriteError(id);
    return { documentId: id, url: `https://docs.google.com/document/d/${id}/edit` };
  }
}
