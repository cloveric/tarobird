import { createContext, createElement, useMemo, type ReactNode } from "react";
import type { Message } from "../../src/client-protocol/index.js";

/** A widget may prepare text only in the composer that owns its message.
 * This never sends, chooses recipients, changes queue mode or calls the Host. */
export const WidgetComposeContext = createContext<{ scope: string; owner?: string; active?: boolean; compose?: (text: string) => boolean } | undefined>(undefined);

/** A stable value keeps unrelated streaming and draft updates from defeating
 * MessageContent's memo boundary. The dispatcher reads current App state. */
export function WidgetComposeProvider({ scope, owner, active, message, compose, children }: {
  scope: string; owner?: string; active?: boolean; message: Message; compose: (message: Message, text: string) => boolean; children: ReactNode;
}) {
  const value = useMemo(() => ({ scope, owner, active, compose: message.forwardedFrom || message.botSource ? undefined : (text: string) => compose(message, text) }), [scope, owner, active, message, compose]);
  return createElement(WidgetComposeContext.Provider, { value }, children);
}

export function widgetComposeText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4000) return;
  const text = value.trim();
  if (!text || text.startsWith("/") || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return;
  return text;
}

export function appendWidgetDraft(draft: string, text: string): string {
  return draft ? `${draft}${draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n"}${text}` : text;
}
