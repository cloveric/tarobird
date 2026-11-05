import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { Camera, Shuffle } from "lucide-react";
import { AVATAR_EDGE, avatarKey, type AvatarTarget } from "../../src/client-protocol/avatars.js";
import type { Conversation } from "../../src/client-protocol/index.js";
import { BotPortrait, Avatar, ConversationAvatar, canEditConversationAvatar, Profiles } from "./Avatar.js";
import { BOT_AVATAR_LIBRARY, defaultBotAvatar, randomBotAvatar, type BotAvatar } from "./bot-avatar-catalog.js";
import { botAvatarImage } from "./bot-avatar-images.js";
import { CreationDialog } from "./CreationDialog.js";
import { HubHttpError } from "./http-error.js";
import { t } from "./i18n.js";

function drawCrop(canvas: HTMLCanvasElement, image: HTMLImageElement, zoom: number, x: number, y: number) {
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error(t("此设备无法处理图片"));
  canvas.width = canvas.height = AVATAR_EDGE;
  const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom;
  ctx.drawImage(image, (image.naturalWidth - side) * x, (image.naturalHeight - side) * y, side, side, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
}
export default function CropAvatar({ target, name, label, close, saved, conversation, returnFocus }: { target: AvatarTarget; name: string; label: string; close: () => void; saved: () => void; conversation?: Conversation; returnFocus?: RefObject<HTMLElement | null> }) {
  const { connection, state, defaults } = useContext(Profiles)!;
  const libraryAllowed = target.kind === "bot" || conversation?.type === "direct";
  const editable = conversation ? canEditConversationAvatar(state, conversation) : state.status === "online";
  const current = state.avatars.find((a) => avatarKey(a) === avatarKey(target));
  const [revision, setRevision] = useState(current?.revision ?? 0), [image, setImage] = useState<HTMLImageElement>();
  const [mode, setMode] = useState<"library" | "upload">(libraryAllowed ? "library" : "upload");
  const [preset, setPreset] = useState<BotAvatar>();
  const [zoom, setZoom] = useState(1), [x, setX] = useState(.5), [y, setY] = useState(.5);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null), file = useRef<HTMLInputElement>(null), loadId = useRef(0), sourceUrl = useRef<string | undefined>(undefined);
  const pointer = useRef<{ x: number; y: number; left: number; top: number } | undefined>(undefined);
  useEffect(() => () => { ++loadId.current; if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); }, []);
  useEffect(() => { if (canvas.current && image) drawCrop(canvas.current, image, zoom, x, y); }, [image, zoom, x, y, mode]);
  const select = async (selected?: File) => {
    if (!selected) return; const request = ++loadId.current; setError(""); setLoading(true);
    try {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(selected.type) || selected.size > 10 * 1024 * 1024) throw new Error(t("请选择 10 MB 以内的 PNG、JPEG、WebP 或 GIF 图片"));
      const url = URL.createObjectURL(selected), next = new Image();
      try { await new Promise<void>((resolve, reject) => { next.onload = () => resolve(); next.onerror = () => reject(new Error(t("图片无法读取，请换一张图片"))); next.src = url; }); }
      catch (e) { URL.revokeObjectURL(url); throw e; }
      if (request !== loadId.current) { URL.revokeObjectURL(url); return; }
      if (!next.naturalWidth || !next.naturalHeight || next.naturalWidth * next.naturalHeight > 40_000_000) { URL.revokeObjectURL(url); throw new Error(t("图片尺寸过大，请选择较小的图片")); }
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current); sourceUrl.current = url;
      setImage(next); setPreset(undefined); setMode("upload"); setZoom(1); setX(.5); setY(.5);
    } catch (e) { if (request === loadId.current) setError(e instanceof Error ? e.message : t("图片无法读取，请换一张图片")); }
    finally { if (request === loadId.current) setLoading(false); }
  };
  const stale = revision !== (current?.revision ?? 0);
  const choose = (next: BotAvatar) => { ++loadId.current; setLoading(false); setPreset(next); setImage(undefined); setError(""); };
  const save = async (remove = false) => {
    if (busy || loading || stale || !editable) return;
    setBusy(true); setError("");
    try {
      let png: string | null = null;
      if (!remove) {
        const output = document.createElement("canvas");
        if (mode === "library" && preset) {
          const source = botAvatarImage(preset), animal = new Image(); animal.src = source.url; await animal.decode();
          output.width = output.height = AVATAR_EDGE;
          const ctx = output.getContext("2d"); if (!ctx) throw new Error(t("此设备无法处理图片"));
          ctx.drawImage(animal, source.x, source.y, source.edge, source.edge, 0, 0, AVATAR_EDGE, AVATAR_EDGE);
        } else if (mode === "upload" && image) drawCrop(output, image, zoom, x, y);
        else return;
        png = output.toDataURL("image/png");
      }
      await connection.setAvatar(target, revision, png); saved();
    } catch (e) { setError(e instanceof HubHttpError && e.status === 409 ? t("头像已在另一台设备更改，请确认后再保存") : e instanceof HubHttpError && e.status === 403 ? t("你没有修改此头像的权限") : t("头像保存失败，请检查连接后重试")); }
    finally { setBusy(false); }
  };
  const selectedId = preset?.id ?? (!current?.hasImage && !conversation ? defaultBotAvatar(target.id, defaults.get(target.id)).id : undefined);
  return <CreationDialog mobilePage title={t("编辑{0}", label)} close={close} busy={busy} returnFocus={returnFocus} closeLabel={t("关闭头像编辑")} className={`avatar-editor${mode === "library" ? " avatar-editor-library" : ""}`}>
    <p className="muted">{libraryAllowed ? t("从精灵头像中选一个，也可以上传自己的图片。") : t("选择图片后调整位置和大小，保存后会同步到其他设备。")}</p>
    {conversation?.type === "direct" && <p className="muted">{t("只更改此对话的头像，不影响 Bot 头像。")}</p>}
    {libraryAllowed && <div className="avatar-source-options" role="group" aria-label={t("设置头像")}><button disabled={busy || loading} aria-pressed={mode === "library"} onClick={() => setMode("library")}>{t("系统头像")}</button><button disabled={busy || loading} aria-pressed={mode === "upload"} onClick={() => setMode("upload")}><Camera size={16}/>{t("上传图片")}</button></div>}
    {mode === "library" ? <>
      <div className="avatar-library-preview">{preset ? <span className="profile-avatar profile-avatar-bot"><BotPortrait avatar={preset} alt={t(preset.name)}/></span> : <>{conversation ? <ConversationAvatar conversation={conversation} size={80}/> : <Avatar {...target} name={name} size={80}/>}</>}<div><strong>{preset ? t(preset.name) : name}</strong><button disabled={busy || loading} onClick={() => choose(randomBotAvatar(selectedId))}><Shuffle size={16}/>{t("换一个")}</button></div></div>
      <AvatarChoices selectedId={selectedId} disabled={busy || loading} choose={choose}/>
    </> : <>
    <div className={`avatar-crop-preview ${target.kind}`}>{image ? <canvas ref={canvas} aria-label={t("头像裁剪预览")} onPointerDown={(e) => { if (busy) return; e.currentTarget.setPointerCapture(e.pointerId); pointer.current = { x: e.clientX, y: e.clientY, left: x, top: y }; }} onPointerMove={(e) => { if (!pointer.current || !image) return; const side = Math.min(image.naturalWidth, image.naturalHeight) / zoom, display = e.currentTarget.getBoundingClientRect().width; const p = pointer.current; if (image.naturalWidth > side) setX(Math.max(0, Math.min(1, p.left - (e.clientX - p.x) * side / display / (image.naturalWidth - side)))); if (image.naturalHeight > side) setY(Math.max(0, Math.min(1, p.top - (e.clientY - p.y) * side / display / (image.naturalHeight - side)))); }} onPointerUp={() => { pointer.current = undefined; }} onPointerCancel={() => { pointer.current = undefined; }}/> : <>{conversation ? <ConversationAvatar conversation={conversation} size={224}/> : <Avatar {...target} name={name} size={224}/>}</>}</div>
    </>}
    <input ref={file} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" aria-label={t("选择头像图片")} onChange={(e) => { void select(e.target.files?.[0]); e.target.value = ""; }}/>
    {mode === "upload" && <button className="full" disabled={busy || loading} onClick={() => file.current?.click()}><Camera size={17}/>{loading ? t("正在读取图片…") : image ? t("重新选择图片") : t("选择头像图片")}</button>}
    {mode === "upload" && image && <fieldset className="avatar-crop-controls" disabled={busy || loading}><legend>{t("拖动图片或使用滑块调整裁剪")}</legend><label>{t("缩放")}<input type="range" min="1" max="4" step="0.01" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}/></label><label>{t("水平位置")}<input type="range" min="0" max="1" step="0.01" value={x} onChange={(e) => setX(Number(e.target.value))}/></label><label>{t("垂直位置")}<input type="range" min="0" max="1" step="0.01" value={y} onChange={(e) => setY(Number(e.target.value))}/></label></fieldset>}
    {stale && <div className="avatar-conflict"><p role="alert">{t("头像已在另一台设备更改，请确认后再保存")}</p><>{conversation ? <ConversationAvatar conversation={conversation} size={40}/> : <Avatar {...target} name={name} size={40}/>}</><button onClick={() => { setRevision(current?.revision ?? 0); setError(""); }}>{mode === "library" ? t("保留选择，使用最新版本") : t("保留裁剪，使用最新版本")}</button></div>}
    {conversation && !editable && state.status === "online" && <p role="status">{conversation.type === "direct" && !state.conversationAvatarsAvailable ? t("升级此主机后即可设置对话头像") : t("你没有修改此头像的权限")}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}{state.status !== "online" && <p role="status">{t("连接恢复后即可操作")}</p>}
    <footer className="avatar-editor-actions">{current?.hasImage && <button className="text-danger" disabled={busy || loading || stale || !editable} onClick={() => { if (window.confirm(conversation?.type === "direct" ? t("恢复此对话的默认头像？Bot 头像不会改变。") : target.kind === "bot" ? t("恢复此 Bot 的系统头像？所有设备都会同步。") : t("移除头像并恢复默认图标？所有设备都会同步。"))) void save(true); }}>{conversation?.type === "direct" ? t("恢复默认头像") : target.kind === "bot" ? t("恢复系统头像") : t("移除头像")}</button>}<button disabled={busy} onClick={close}>{t("取消")}</button><button className="primary" disabled={!(mode === "library" ? preset : image) || busy || loading || stale || !editable} onClick={() => { void save(); }}>{busy ? t("保存中…") : t("保存头像")}</button></footer>
  </CreationDialog>;
}

// Shared active display order: newest additions first, retired choices omitted.
// Historical IDs and source-sheet order remain in the canonical catalog.
const AVATAR_CHOICES = BOT_AVATAR_LIBRARY;

function AvatarChoices({ selectedId, disabled, choose }: { selectedId?: string; disabled: boolean; choose: (animal: BotAvatar) => void }) {
  const [focused, setFocused] = useState(0);
  useEffect(() => setFocused(Math.max(0, AVATAR_CHOICES.findIndex((animal) => animal.id === selectedId))), [selectedId]);
  return <div className="avatar-library" role="group" aria-label={t("系统头像")} onKeyDown={(event) => {
    const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(" ").length;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (step === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? AVATAR_CHOICES.length - 1 : Math.max(0, Math.min(AVATAR_CHOICES.length - 1, focused + step!));
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }}>{AVATAR_CHOICES.map((animal, index) => <button key={animal.id} type="button" disabled={disabled} tabIndex={focused === index ? 0 : -1} onFocus={() => setFocused(index)} aria-label={t("选择{0}头像", t(animal.name))} aria-pressed={selectedId === animal.id} title={t(animal.name)} onClick={() => choose(animal)}><BotPortrait avatar={animal} alt=""/></button>)}</div>;
}
