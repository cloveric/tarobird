import { vi } from "vitest";
import { emptyDesign, type DesignDocument, type DesignFile } from "../src/workbench-design.js";
import { DesignSession, type DesignPersistSidecar, type DesignSessionOptions } from "../src/workbench-design-session.js";
import type { DesignCommentsDoc } from "../src/workbench-design-comments.js";
import type { DesignHistoryIndex } from "../src/workbench-design-history.js";

/** An in-memory stand-in for the proposed storage v13 contract: the document,
 * its history index and objects commit together or not at all; comments are a
 * separate CAS record. A test double, not IndexedDB. */
export function memoryDesign(document: DesignDocument = emptyDesign("design"), options: Partial<DesignSessionOptions> & { noHistory?: boolean; noComments?: boolean } = {}) {
  const store = { design: structuredClone(document), history: undefined as DesignHistoryIndex | undefined, objects: new Map<string, DesignFile>(), comments: undefined as DesignCommentsDoc | undefined, quota: false, persisted: [] as (DesignPersistSidecar | undefined)[] };
  const persist = async (expected: number, next: DesignDocument, sidecar?: DesignPersistSidecar) => {
    store.persisted.push(sidecar);
    if (store.design.revision !== expected || next.revision !== expected + 1) throw new Error("design_revision_conflict");
    if (sidecar?.history) {
      if (store.quota) throw Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
      if ((store.history?.revision ?? -1) !== sidecar.history.expected) throw new Error("design_history_conflict");
    }
    store.design = structuredClone(next);
    if (sidecar?.history) {
      store.history = structuredClone(sidecar.history.next);
      for (const [sha, file] of Object.entries(sidecar.history.put)) store.objects.set(sha, structuredClone(file));
      for (const sha of sidecar.history.drop) store.objects.delete(sha);
    }
  };
  const comments = { load: async () => structuredClone(store.comments), save: vi.fn(async (expected: number, next: DesignCommentsDoc) => { if ((store.comments?.revision ?? 0) !== expected) throw new Error("design_comments_conflict"); store.comments = structuredClone(next); }) };
  const history = { load: async () => structuredClone(store.history), object: async (sha: string) => structuredClone(store.objects.get(sha)) };
  const sendToBot = vi.fn(async () => "opened" as const);
  const session = new DesignSession(structuredClone(store.design), async () => structuredClone(store.design), persist, () => {}, {
    user: () => ({ id: "u1", name: "Ann" }), title: () => "Deck", sendToBot,
    ...(options.noComments ? {} : { comments }), ...(options.noHistory ? {} : { history }), ...options,
  });
  return { session, store, comments, history, sendToBot, persist };
}
export const botPublish = (content: string, path = "project/note.txt") => ({ files: { [path]: { content, contentType: "text/plain" as const } } });
export const bot = { kind: "bot" as const, id: "client_bot1", name: "Helper Bot" };
