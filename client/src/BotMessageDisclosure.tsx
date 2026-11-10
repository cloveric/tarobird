import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message } from "../../src/client-protocol/index.js";
import type { HubConnection } from "./connection.js";
import { messageExcerpt } from "./MessageReference.js";
import { t, useLocale } from "./i18n.js";
import "./bot-message-disclosure.css";

type FocusRequest = { messageId?: string };
type View = { expanded: boolean; opened: boolean; focus?: FocusRequest };
// Presentation state only. Scrolling a virtualized message out of view must
// not erase its disclosure choice or replay the same locate request.
const views = new Map<string, View>();
function remember(key: string, view: View) {
  views.delete(key); views.set(key, view);
  while (views.size > 128) views.delete(views.keys().next().value!);
}

export function BotMessageDisclosure({ message, connection, focusRequest, children }: {
  message: Message; connection: HubConnection; focusRequest?: FocusRequest; children: ReactNode;
}) {
  useLocale();
  const key = `${connection.identity.hubPublicKey}:${message.conversationId}:${message.id}`;
  const saved = views.get(key), contentId = useId();
  const [expanded, setExpanded] = useState(saved?.expanded ?? false);
  const [opened, setOpened] = useState(saved?.opened ?? false);
  const handledFocus = useRef(saved?.focus);
  useLayoutEffect(() => {
    if (focusRequest?.messageId === message.id && handledFocus.current !== focusRequest) {
      handledFocus.current = focusRequest; setOpened(true); setExpanded(true);
    }
  }, [focusRequest, message.id]);
  useEffect(() => { remember(key, { expanded, opened, focus: handledFocus.current }); }, [key, expanded, opened, focusRequest]);
  const preview = messageExcerpt(message).replace(/\s+/g, " ");
  return <section className="bot-message-disclosure" aria-label={t("协作消息")}>
    <button type="button" className="bot-message-disclosure-toggle" aria-label={t(expanded ? "收起协作消息" : "展开协作消息")}
      aria-expanded={expanded} aria-controls={contentId} onClick={() => { setOpened(true); setExpanded(value => !value); }}>
      {expanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}<strong>{t("协作消息")}</strong><span>{t(expanded ? "收起" : "展开")}</span>
    </button>
    {preview && !expanded && <p className="bot-message-disclosure-preview">{preview}</p>}
    {/* Mount the full reader on first demand, then keep portals and attachment
        state alive while folded. Queue admission and model input are untouched. */}
    <div id={contentId} hidden={!expanded}>{opened && children}</div>
  </section>;
}
