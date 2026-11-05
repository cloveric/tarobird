import { useBotLabels } from "./BotReferences.js";
import { searchExcerptParts } from "./search-highlight.js";
import "./search-highlight.css";

export function SearchExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
  const labels = useBotLabels();
  return <>{searchExcerptParts(excerpt, query, labels).map((part, index) => part.match
    ? <mark className="search-match" key={index}>{part.text}</mark> : part.text)}</>;
}
