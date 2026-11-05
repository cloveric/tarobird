import { useLocale } from "./i18n.js";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { botLabels, readablePreviewBotReferences, type NamedBot } from "./bot-references.js";
const BotLabelsContext = createContext<ReadonlyMap<string, string>>(new Map());
const BotDirectoryContext = createContext<readonly NamedBot[]>([]);
export function BotReferences({ bots, children }: { bots: readonly NamedBot[]; children: ReactNode }) {
  const locale = useLocale();
  const labels = useMemo(() => botLabels(bots), [bots, locale]);
  return <BotDirectoryContext.Provider value={bots}><BotLabelsContext.Provider value={labels}>{children}</BotLabelsContext.Provider></BotDirectoryContext.Provider>;
}
export const useBotLabels = () => useContext(BotLabelsContext);
export const useBotDirectory = () => useContext(BotDirectoryContext);
export function ReferencePreview({ text }: { text: string }) { const labels = useBotLabels(); return <>{readablePreviewBotReferences(text, labels)}</>; }
