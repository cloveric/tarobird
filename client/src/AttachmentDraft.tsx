import { useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import { ChevronLeft, ChevronRight, Image, Mic, Plus, Video, X } from "lucide-react";
import { t, useLocale } from "./i18n.js";
import { MAX_FILE_BYTES } from "../../src/client-protocol/index.js";
import { formatFileLimit } from "./files.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { DraftAttachmentPreview } from "./DraftAttachmentPreview.js";
import "./attachment-draft.css";

function DraftFile({ file, remove, busy, returnFocus }: { file: File; remove: () => void; busy: boolean; returnFocus?: RefObject<HTMLElement | null> }) {
  const active = useContext(RuntimeHostActiveContext);
  const [url, setUrl] = useState<string>(), [failed, setFailed] = useState(false), [preview, setPreview] = useState(false);
  useLayoutEffect(() => { if (!active) setPreview(false); }, [active]);
  useEffect(() => {
    setFailed(false); setUrl(undefined); setPreview(false);
    if (!file.type.startsWith("image/") && !file.type.startsWith("audio/")) return;
    const objectUrl = URL.createObjectURL(file); setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);
  const opener = useRef<HTMLButtonElement>(null);
  const destination = useRef(returnFocus); destination.current = returnFocus;
  // A preview unmounted with its chat must not focus a different chat's textarea.
  const previewReturn = useRef({ get current() { return opener.current?.isConnected ? destination.current?.current ?? opener.current : null; } }).current;
  const audio = file.type.startsWith("audio/");
  const size = file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`;
  return <li className={`attachment-draft-file ${audio ? "audio-draft" : file.type.startsWith("image/") ? "image-draft" : ""}`}>
    <button ref={opener} type="button" className="draft-file-open" aria-label={t("预览 {0}", file.name)} title={file.name} onClick={() => setPreview(true)}>
      <span className="attachment-draft-thumbnail">{url && !failed && file.type.startsWith("image/") ? <img src={url} alt="" decoding="async" onError={() => setFailed(true)}/> : file.type.startsWith("image/") ? <Image size={26}/> : audio ? <Mic size={26}/> : file.type.startsWith("video/") ? <Video size={26}/> : <FileTypeIcon name={file.name} mime={file.type} size={30}/>}</span>
      <span className="draft-file-name"><strong>{file.name}</strong><small>{size}</small></span>
    </button>
    {url && audio && <audio controls preload="metadata" src={url} aria-label={t("试听 {0}", file.name)}/>}
    <button type="button" className="draft-file-remove" disabled={busy} aria-label={t("移除 {0}", file.name)} title={t("移除 {0}", file.name)} onClick={remove}><X size={14}/></button>
    {preview && active && <DraftAttachmentPreview file={file} returnFocus={previewReturn} close={() => setPreview(false)}/>}
  </li>;
}

export function AttachmentDraft({ files, remove, add, busy, returnFocus, maxFileBytes = MAX_FILE_BYTES }: { files: File[]; remove: (index: number) => void; add: () => void; busy: boolean; maxFileBytes?: number; returnFocus?: RefObject<HTMLElement | null> }) {
  useLocale();
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });
  const measure = () => {
    const node = list.current; if (!node) return;
    const before = node.scrollLeft > 1, after = node.scrollWidth - node.clientWidth - node.scrollLeft > 1;
    setEdges(old => old.before === before && old.after === after ? old : { before, after });
  };
  useEffect(() => {
    const node = list.current; if (!node) return;
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, [files]);
  const oversized = files.some(file => file.size > maxFileBytes);
  return <section className={`attachment-draft${oversized ? " has-oversized-files" : ""}`} aria-label={t("待发送的附件")}>
    <header><span className="draft-attachment-summary"><span>{t("{0} 个附件", files.length)}</span><small>{t("单个附件上限 {0}", formatFileLimit(maxFileBytes))}</small></span><div className="draft-attachment-actions">
      {(edges.before || edges.after) && <><button type="button" disabled={!edges.before} aria-label={t("前面的附件")} onClick={() => list.current?.scrollBy({ left: -list.current.clientWidth })}><ChevronLeft size={16}/></button><button type="button" disabled={!edges.after} aria-label={t("后面的附件")} onClick={() => list.current?.scrollBy({ left: list.current.clientWidth })}><ChevronRight size={16}/></button></>}
      <button type="button" disabled={busy} onClick={add}><Plus size={14}/>{t("添加")}</button>
    </div></header>
    <ul ref={list} className="attachment-chips" onScroll={measure}>{files.map((file, index) => <DraftFile key={`${file.name}-${index}`} file={file} busy={busy} returnFocus={returnFocus} remove={() => remove(index)}/>)}</ul>
  </section>;
}
