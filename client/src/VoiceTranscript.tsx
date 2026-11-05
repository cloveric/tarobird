import { useId, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import type { CardElement } from "../../src/client-protocol/index.js";
import { MarkdownText } from "./MarkdownText.js";
import { t, useLocale } from "./i18n.js";
import "./voice-transcript.css";

/** Recognize the existing ASR receipt, including historical named-file cards.
 * Ordinary cards and interactive elements retain their original presentation. */
export function voiceTranscriptElement(elements: CardElement[]): CardElement | undefined {
  if (![2, 3].includes(elements.length) || !elements.every(element => element.type === "markdown" && !element.children?.length)) return;
  if (!/^\*\*(?:音频转写完成|部分转写完成|已停止转写|Audio transcription complete|Partial transcription|Transcription stopped)\*\*$/.test(elements[0]?.text ?? "")) return;
  return elements.at(-1);
}

export function VoiceTranscript({ text, style }: { text: string; style?: CSSProperties }) {
  useLocale();
  const id = useId(), [expanded, setExpanded] = useState(false);
  const trimmed = text.trim();
  const long = trimmed.length > 240 || trimmed.split(/\r?\n/).length > 5;
  // A plain excerpt keeps links and code-copy controls out of the folded area.
  // The original Markdown and message data remain intact for reading/copying.
  const preview = long ? Array.from(trimmed).slice(0, 200).join("").split(/\r?\n/).slice(0, 5).join("\n") + "…" : trimmed;
  return <div className="card-text voice-transcript" style={style}>
    <div id={id}>{long && !expanded ? <p className="voice-transcript-preview">{preview}</p> : <MarkdownText text={text}/>}</div>
    {long && <button type="button" className="voice-transcript-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      <span>{t(expanded ? "收起转写" : "展开转写")}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>}
  </div>;
}
