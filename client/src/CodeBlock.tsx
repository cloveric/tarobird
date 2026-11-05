import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { t, useLocale } from "./i18n.js";
import "./code-block.css";

/** Raw tool output is escaped text; Markdown supplies its sanitized code tree. */
export function CodeBlock({ children, text, language, className = "", copyLabel }: { children?: ReactNode; text?: string; language?: string; className?: string; copyLabel?: string }) {
  useLocale();
  const root = useRef<HTMLDivElement>(null), alive = useRef(true), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; clearTimeout(timer.current); }; }, []);
  useEffect(() => { setCopied(false); setFailed(false); clearTimeout(timer.current); }, [text, children]);
  const code = Children.toArray(children).find(child => isValidElement<{ className?: string }>(child) && child.type === "code");
  const label = language ?? (isValidElement<{ className?: string }>(code) ? code.props.className?.match(/(?:^|\s)language-([\w+-]+)/)?.[1] : undefined);
  // Only explicit prose labels opt into soft wrapping. Untyped output, code and
  // diagram languages keep their columns; never guess from the text itself.
  const plainText = /^(?:text|txt|plaintext)$/i.test(label ?? "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text ?? root.current?.querySelector("code")?.textContent ?? "");
      if (!alive.current) return;
      setCopied(true); setFailed(false); clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { if (alive.current) { setCopied(false); setFailed(true); } }
  };
  return <div ref={root} className={`code-block readable-code${plainText ? " is-plain-text" : ""} ${className}`}>
    {label && <span className="code-language">{label}</span>}
    <button type="button" className="code-copy" aria-label={copyLabel ?? t("复制代码")} onClick={() => void copy()}>{copied ? <Check size={13}/> : <Copy size={13}/>}<span>{copied ? t("已复制") : t("复制")}</span></button>
    <span className="code-copy-status" role="status">{copied ? t("已复制") : ""}</span>
    <pre>{text !== undefined ? <code>{text}</code> : children}</pre>
    {failed && <small className="code-copy-error" role="alert">{t("复制失败，请手动选择内容。")}</small>}
  </div>;
}
