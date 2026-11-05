import type { LarkDocumentCreateInput } from "./integration-ports.js";
export type { LarkDocumentCreateInput, LarkDocumentCreateResult } from "./integration-ports.js";
export function parseLarkDocumentCreateInput(payload: Record<string, unknown> | null): LarkDocumentCreateInput {
  if (!payload || typeof payload.content !== "string" || payload.content.trim().length === 0) {
    throw new Error("lark.doc.create requires payload.content");
  }
  const docFormat = payload.docFormat === "markdown" || payload.format === "markdown"
    ? "markdown"
    : payload.docFormat === "xml" || payload.format === "xml"
      ? "xml"
      : undefined;
  const as = payload.as === "bot" ? "bot" : payload.as === "user" ? "user" : undefined;
  return {
    content: payload.content,
    ...(typeof payload.title === "string" ? { title: payload.title } : {}),
    ...(docFormat ? { docFormat } : {}),
    ...(as ? { as } : {}),
    ...(typeof payload.parentToken === "string" ? { parentToken: payload.parentToken } : {}),
    ...(typeof payload.parentPosition === "string" ? { parentPosition: payload.parentPosition } : {}),
  };
}
