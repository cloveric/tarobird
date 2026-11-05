import { fileKind } from "./file-kind.js";
import { t } from "./i18n.js";
import "./file-type-icon.css";

/** Local vector artwork: no network fetch or attachment read is needed. */
export function FileTypeIcon({ name, mime, size = 36 }: { name?: string; mime?: string; size?: number }) {
  const { kind, mark, label } = fileKind(name, mime);
  return <svg className="file-type-icon" data-file-kind={kind} viewBox="0 0 40 48" width={size} height={size * 1.2} role="img" aria-label={t("{0}文件", label)} focusable="false">
    <path className="file-type-paper" d="M9 2h16l11 11v30a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"/>
    <path className="file-type-fold" d="M25 2v8a3 3 0 0 0 3 3h8Z"/>
    <path className="file-type-lines" d="M13 18h16M13 22h11"/>
    <rect className="file-type-badge" x="1" y="26" width="34" height="18" rx="3"/>
    <text className="file-type-mark" x="18" y="38.6" textAnchor="middle" style={{ fontSize: mark.length === 1 ? 15 : mark.length > 3 ? 8.5 : 10 }}>{mark}</text>
  </svg>;
}
