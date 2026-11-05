import { MAX_PAIRING_LINK_LENGTH, pairingLink, parsePairingLink, type PairingPayload } from "./pairing-link.js";
export { pairingLink, parsePairingLink, type PairingPayload } from "./pairing-link.js";
import { Camera, Copy, ImageDown, ImagePlus, LoaderCircle, ScanLine } from "lucide-react";
import { CreationDialog } from "./CreationDialog.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { HoldTracker, type HoldPoint } from "./qr-hold.js";
import { qrSaveError, qrSaveLabel, qrSaveTarget, saveQrImage } from "./qr-photo-save.js";
import { t, useLocale } from "./i18n.js";
import { useEffect, useId, useRef, useState } from "react";

/** A save is bound to one live invitation: `key` identifies it and `valid`
 * reports, at the moment of the request, that it is neither expired nor replaced. */
export type QrSaveBinding = { key: string; valid: () => boolean };

export function PairingCode({ payload, save }: { payload: PairingPayload; save?: QrSaveBinding }) {
  useLocale();
  const text = pairingLink(payload);
  const [qr, setQr] = useState<{ text: string; url: string }>(); const [error, setError] = useState(false);
  const url = qr?.text === text ? qr.url : "";
  const [copyState, setCopyState] = useState<{ text: string; status: "copied" | "manual" }>();
  const image = useRef<HTMLImageElement>(null), saveButton = useRef<HTMLButtonElement>(null), menuId = useId();
  const target = qrSaveTarget(), saveKey = save?.key;
  const [menu, setMenu] = useState<{ key: string; text: string; point: HoldPoint }>();
  const [saving, setSaving] = useState<{ key: string; busy: boolean; text: string; error?: boolean }>();
  const inflight = useRef(false), alive = useRef(true), current = useRef({ key: saveKey, text });
  current.current = { key: saveKey, text };
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Whole pixels per module and the standard four-module quiet zone keep the
  // finder/timing patterns readable for every automatically selected QR mask.
  useEffect(() => { let alive = true; setQr(undefined); setError(false); void import("qrcode").then((qr) => qr.toDataURL(text, { scale: 6, margin: 4, errorCorrectionLevel: "M" })).then((result) => { if (alive) setQr({ text, url: result }); }).catch(() => { if (alive) setError(true); }); return () => { alive = false; }; }, [text]);
  // A menu belongs to the QR it was opened on; a new invitation closes it.
  useEffect(() => { setMenu(undefined); }, [saveKey, text]);
  useEffect(() => {
    const node = image.current;
    if (!saveKey || !node) return;
    let lastTouch = 0;
    const tracker = new HoldTracker(point => { const live = current.current; if (live.key) setMenu({ key: live.key, text: live.text, point }); });
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse" || !event.isPrimary || event.button !== 0) { tracker.cancel(); return; }
      lastTouch = Date.now();
      tracker.down(event.pointerId, { x: event.clientX, y: event.clientY }, node.getBoundingClientRect().top);
    };
    const move = (event: PointerEvent) => tracker.move(event.pointerId, { x: event.clientX, y: event.clientY });
    const cancel = () => tracker.cancel();
    const scroll = () => tracker.scroll(node.getBoundingClientRect().top);
    // Touch long press is ours; the platform's image callout would bypass the
    // invitation check and receipt. A mouse right click opens the same menu.
    const context = (event: MouseEvent) => {
      event.preventDefault();
      if (tracker.active || Date.now() - lastTouch < 1000 || (event as PointerEvent).pointerType === "touch") return;
      const live = current.current; if (live.key) setMenu({ key: live.key, text: live.text, point: { x: event.clientX, y: event.clientY } });
    };
    const hidden = () => { if (document.hidden) tracker.cancel(); };
    const drag = (event: DragEvent) => event.preventDefault();
    node.addEventListener("pointerdown", down); node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", cancel); node.addEventListener("pointercancel", cancel); node.addEventListener("pointerleave", cancel);
    node.addEventListener("contextmenu", context); node.addEventListener("dragstart", drag);
    document.addEventListener("scroll", scroll, true); document.addEventListener("visibilitychange", hidden); window.addEventListener("blur", cancel);
    return () => {
      tracker.cancel();
      node.removeEventListener("pointerdown", down); node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", cancel); node.removeEventListener("pointercancel", cancel); node.removeEventListener("pointerleave", cancel);
      node.removeEventListener("contextmenu", context); node.removeEventListener("dragstart", drag);
      document.removeEventListener("scroll", scroll, true); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("blur", cancel);
    };
  }, [saveKey, !!url]);
  if (text.length > MAX_PAIRING_LINK_LENGTH) return <p role="alert">{t("配对信息过长，请减少备用线路后再试。")}</p>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopyState({ text, status: "copied" }); }
    catch { setCopyState({ text, status: "manual" }); }
  };
  const busy = !!saving?.busy && saving.key === saveKey;
  /** Writes the image shown for the live invitation, once. Results for a
   * replaced, expired or unmounted invitation are discarded, never shown as its receipt. */
  const saveImage = async () => {
    setMenu(undefined);
    if (!save || inflight.current || !url || !save.valid()) return;
    const key = save.key, png = url;
    inflight.current = true;
    setSaving({ key, busy: true, text: target === "photos" ? t("正在保存到相册…") : t("正在保存二维码图片…") });
    const settled = () => alive.current && current.current.key === key && current.current.text === text;
    try {
      const outcome = await saveQrImage(png, target);
      if (!settled()) return;
      setSaving({ key, busy: false, text: !outcome.saved ? t("已取消保存") : outcome.delivery === "photos" ? t("已保存到相册") : outcome.delivery === "browser" ? t("已交给浏览器下载") : outcome.location ? t("已保存到 {0}", outcome.location) : t("已保存二维码图片") });
    } catch (cause) {
      if (settled()) setSaving({ key, busy: false, error: true, text: qrSaveError(cause, target) });
    } finally { inflight.current = false; }
  };
  const label = qrSaveLabel(target);
  return <>
    {error ? <p role="alert">{t("线路信息过长，无法生成二维码。请复制配对信息，在新设备粘贴。")}</p> : url ? <img ref={image} className="pair-qr" data-save={saveKey ? "hold" : undefined} draggable={false} src={url} width={300} height={300} alt={payload.kind === "connect" ? t("连接二维码") : t("确认新设备二维码")}/> : null}
    <div className="pair-code-actions">
      <button type="button" onClick={() => void copy()}><Copy size={15}/>{payload.kind === "connect" ? t("复制连接信息") : t("复制配对信息")}</button>
      {saveKey && url && <button ref={saveButton} type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void saveImage()}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <ImageDown size={15} aria-hidden="true"/>}{label}</button>}
      {copyState?.text === text && (copyState.status === "copied" ? <small role="status">{t("已复制。在新设备选择「粘贴连接信息」；确认配对时也可粘贴到扫码窗口。")}</small> : <><small role="status">{t("无法自动复制，请选中下方信息复制。")}</small><textarea aria-label={t("可复制的配对信息")} readOnly value={text} onFocus={event => event.currentTarget.select()}/></>)}
      {saving && saving.key === saveKey && <small role={saving.error ? "alert" : "status"} className={saving.error ? "error-text" : undefined}>{saving.text}</small>}
    </div>
    {menu && menu.key === saveKey && menu.text === text && url && <DesktopMenu id={menuId} label={t("二维码操作")} open point={menu.point} placement="down-start" trigger={saveButton} portalTarget={image.current?.closest("dialog")} close={() => setMenu(undefined)}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => void saveImage()}><ImageDown size={16}/>{label}</button>
      <button type="button" role="menuitem" onClick={() => void copy()}><Copy size={16}/>{payload.kind === "connect" ? t("复制连接信息") : t("复制配对信息")}</button>
    </DesktopMenu>}
  </>;
}
function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t("摄像头权限未开启。请在系统设置中允许访问，或选择二维码图片。");
  if (name === "NotFoundError" || name === "OverconstrainedError") return t("没有找到可用的摄像头，请选择二维码图片。");
  if (name === "NotReadableError" || name === "AbortError") return t("摄像头暂时无法使用。请关闭占用摄像头的应用后重试，或选择二维码图片。");
  return t("无法使用摄像头，请重试或选择二维码图片。");
}
export type PairingInputMode = "scan" | "text" | "image";
export function PairingScanner({ receive, close, initialMode = "scan", purpose = "connect" }: { receive: (payload: PairingPayload) => void; close: () => void; initialMode?: PairingInputMode; purpose?: "connect" | "approve" }) {
  useLocale();
  const video = useRef<HTMLVideoElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const controls = useRef<{ stop: () => void } | undefined>(undefined), stream = useRef<MediaStream | undefined>(undefined);
  const operation = useRef(0), done = useRef(false), cameraBusy = useRef(false);
  const [error, setError] = useState(""), [phase, setPhase] = useState<"idle" | "starting" | "live" | "image">("idle");
  const textId = useId();
  const [mode, setMode] = useState<PairingInputMode>(initialMode), [text, setText] = useState("");
  const textMode = mode === "text";
  const stopCamera = () => {
    controls.current?.stop(); controls.current = undefined;
    stream.current?.getTracks().forEach(track => track.stop()); stream.current = undefined;
    if (video.current) video.current.srcObject = null;
    cameraBusy.current = false;
  };
  useEffect(() => { done.current = false; return () => { done.current = true; ++operation.current; stopCamera(); }; }, []);
  const found = (value: string) => {
    if (done.current) return;
    const payload = parsePairingLink(value); receive(payload);
    done.current = true; ++operation.current; stopCamera(); close();
  };
  const scan = async () => {
    if (cameraBusy.current || done.current) return;
    cameraBusy.current = true; const current = ++operation.current;
    const active = () => !done.current && current === operation.current;
    setError(""); setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera_unavailable");
      // Own the stream before giving it to the decoder, so closing during a
      // permission prompt or lazy import cannot leave a late camera running.
      const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 24, max: 30 } }, audio: false });
      if (!active()) { camera.getTracks().forEach(track => track.stop()); return; }
      stream.current = camera;
      const { QrCameraReader, qrFrameMiss, preferContinuousFocus } = await import("./qr-camera.js");
      if (!active() || !video.current) return;
      void preferContinuousFocus(camera);
      const failed = (cause: unknown) => {
        if (!active()) return;
        ++operation.current; stopCamera(); setPhase("idle"); setError(cameraError(cause));
      };
      for (const track of camera.getVideoTracks()) track.addEventListener("ended", () => failed(new Error("camera_ended")), { once: true });
      const reader = new QrCameraReader();
      try {
        const scanner = await reader.decodeFromStream(camera, video.current, (result, error, controller) => {
          if (!active()) { controller.stop(); return; }
          if (error && !qrFrameMiss(error)) { failed(error); controller.stop(); return; }
          if (result) try { found(result.getText()); } catch (e) { setError(e instanceof Error ? e.message : t("二维码无效")); }
        });
        const owned = { stop: () => { scanner.stop(); reader.dispose(); } };
        if (!active()) owned.stop(); else controls.current = owned;
      } catch (cause) { reader.dispose(); throw cause; }
    } catch (e) { if (active()) { stopCamera(); setPhase("idle"); setError(cameraError(e)); } }
  };
  const fromImage = async (file: File) => {
    const current = ++operation.current; stopCamera(); setError(""); setPhase("image");
    const active = () => !done.current && current === operation.current;
    let url: string | undefined;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error(t("二维码图片不能超过 10 MB"));
      url = URL.createObjectURL(file);
      const { decodeQrImage } = await import("./qr-image.js");
      if (!active()) return;
      const decoded = await decodeQrImage(url, active);
      if (!active() || decoded === undefined) return;
      found(decoded);
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : t("无法识别二维码")); }
    finally { if (url) URL.revokeObjectURL(url); if (active()) setPhase("idle"); }
  };
  const toggleText = () => { ++operation.current; stopCamera(); setPhase("idle"); setError(""); setMode(textMode ? "scan" : "text"); };
  const fromText = () => {
    setError("");
    try { found(text); }
    catch (e) { setError(e instanceof Error ? e.message : t("配对二维码无效")); }
  };
  return <CreationDialog title={textMode ? t("粘贴配对信息") : mode === "image" ? t("导入二维码图片") : t("扫描配对二维码")} className="pairing-scanner" close={close} closeLabel={t("关闭")} onPaste={event => { const file = [...event.clipboardData?.files ?? []].find(item => item.type.startsWith("image/")); if (file) { event.preventDefault(); setMode("image"); void fromImage(file); } }} onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => { event.preventDefault(); const file = [...event.dataTransfer.files].find(item => item.type.startsWith("image/")); if (file) { setMode("image"); void fromImage(file); } }}>
    <p className="scanner-description">{textMode ? purpose === "approve" ? t("在新设备的 8 位配对码页面展开「其他确认方式」，复制配对信息并粘贴到这里。") : t("复制已连接设备「添加设备」页面中的连接信息，并粘贴到这里。") : mode === "image" ? t("选择、拖入或粘贴包含二维码的图片。整张截图也可以，无需先裁剪。") : purpose === "approve" ? t("在新设备的 8 位配对码页面展开「其他确认方式」，扫描其中的确认二维码。") : t("扫描已连接手机或电脑「设备与网络 → 添加设备」页面上的二维码。")}</p>
    {textMode ? <div className="scanner-text-label"><label htmlFor={textId}>{t("配对信息")}</label><textarea id={textId} className="scanner-text-input" value={text} maxLength={MAX_PAIRING_LINK_LENGTH} spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder={t("在此粘贴完整的配对信息")} onChange={event => setText(event.target.value)}/></div> : <div className={`scanner-viewfinder${phase === "live" ? " is-live" : ""}`}>
      <video ref={video} className="scanner-video" aria-hidden="true" autoPlay muted playsInline disablePictureInPicture onPlaying={() => { if (!done.current && cameraBusy.current) setPhase("live"); }}/>
      {phase !== "live" && <div className="scanner-placeholder" role="status">
        {phase === "starting" || phase === "image" ? <LoaderCircle size={32} strokeWidth={1.5} className="spin"/> : <ScanLine size={40} strokeWidth={1.25}/>}
        <strong>{phase === "starting" ? t("正在打开摄像头…") : phase === "image" ? t("正在识别图片…") : mode === "image" ? t("导入二维码图片") : t("准备扫描")}</strong>
        <span>{phase === "starting" ? t("如有提示，请允许摄像头访问。") : phase === "image" ? t("识别后会自动填入主机信息。") : mode === "image" ? t("选择原图可以保留更多二维码细节。") : t("打开摄像头，将二维码放入取景框。")}</span>
      </div>}
      {phase === "live" && <div className="scanner-live-hint" role="status">{t("对准二维码，识别后自动继续")}</div>}
    </div>}
    {error && <p role="alert" className="error-text scanner-error">{error}</p>}
    <div className="scanner-actions">
      {textMode ? <button type="button" className="primary full" disabled={!text.trim()} onClick={fromText}>{t("使用配对信息")}</button> : <>
      {mode !== "image" && <button type="button" className="primary full" disabled={phase !== "idle"} onClick={() => { setMode("scan"); void scan(); }}><Camera size={18}/>{phase === "live" ? t("正在扫描…") : phase === "starting" ? t("正在打开摄像头…") : t("打开摄像头")}</button>}
      <button type="button" className="scanner-image-button full" disabled={phase === "image"} onClick={() => imageInput.current?.click()}><ImagePlus size={18}/>{t("选择二维码图片")}</button>
      <input ref={imageInput} className="scanner-file-input" type="file" accept="image/*" aria-label={t("二维码图片")} tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void fromImage(file); }}/>
      </>}
      {mode === "image" && <button type="button" className="scanner-text-button full" onClick={() => { ++operation.current; stopCamera(); setPhase("idle"); setError(""); setMode("scan"); }}>{t("改用摄像头扫描")}</button>}
      <button type="button" className="scanner-text-button full" onClick={toggleText}>{textMode ? t("返回扫码") : t("粘贴配对信息")}</button>
    </div>
  </CreationDialog>;
}
