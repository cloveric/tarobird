import { decodeBase64 } from "../../src/client-protocol/base64.js";
import { useEffect, useRef, useState } from "react";
import { Excalidraw, CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, restoreElements, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, NonDeleted } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawElementSkeleton } from "@excalidraw/excalidraw/data/transform";
import { exportAttachment } from "./attachment-export.js";
import { boardDocumentSchema, boardSceneSchema, savedBoardState, WORKBENCH_BOARD_BYTES, type BoardDocument, type BoardScene } from "./workbench-model.js";
import { BoardSession, boardFingerprint, type BoardAnnotation, type BoardController, type BoardImageRequest, type BoardImport, type BoardResult } from "./workbench-board.js";
import "@excalidraw/excalidraw/index.css";
import "./workbench-canvas.css";

// Fonts are distributed with the App and cached on first use; no CDN or shared
// drawing service receives content or is needed to reopen an offline canvas.
(window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL("/excalidraw/0.18.1/", window.location.href).href;

export type WorkbenchCanvasProps = {
  scope: string; document: BoardDocument; visible?: boolean; lang?: "zh" | "en";
  /** The stored revision of `document` (lower when it carries a retained unsaved edit). */
  savedRevision?(): number | undefined;
  persist(expectedRevision: number, next: BoardDocument): Promise<void>;
  onDocument?(document: BoardDocument): void;
  onController?(controller: BoardController | null): void;
  onAnnotate?(annotation: BoardAnnotation): Promise<void> | void;
  onImportBoard?(content: BoardImport): Promise<void>;
};
const raster = /^(image\/(?:png|jpeg|webp|gif))$/;
const validatedImages = new WeakSet<object>();
const editableTypes = new Set(["rectangle", "ellipse", "diamond", "text", "line", "arrow", "freedraw", "image", "frame"]);
const jsonCopy = <T,>(value: unknown): T => JSON.parse(JSON.stringify(value)) as T;
function message(error: unknown): string { return error instanceof Error ? error.message : "whiteboard_operation_failed"; }
function validateScene(scene: BoardScene, files: BoardDocument["files"]) {
  boardSceneSchema.parse(scene);
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (typeof element.id !== "string" || !element.id || ids.has(element.id) || !editableTypes.has(String(element.type))) throw new Error("whiteboard_unsupported_element");
    ids.add(element.id);
    if (element.link && (typeof element.link !== "string" || !/^(https?:|mailto:)/i.test(element.link))) throw new Error("whiteboard_unsafe_link");
    if (element.type === "image" && (typeof element.fileId !== "string" || !files[element.fileId])) throw new Error("whiteboard_image_missing");
  }
  const referenced = new Set(scene.elements.filter(element => element.type === "image").map(element => String(element.fileId)));
  for (const id of referenced) {
    const file = files[id];
    if (validatedImages.has(file)) continue;
    if (file.id !== id || typeof file.mimeType !== "string" || !raster.test(file.mimeType) || typeof file.dataURL !== "string" || !file.dataURL.startsWith(`data:${file.mimeType};base64,`)) throw new Error("whiteboard_unsupported_image");
    const payload = file.dataURL.slice(file.dataURL.indexOf(",") + 1);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) throw new Error("whiteboard_invalid_image");
    const header = atob(payload.slice(0, 32));
    if (file.mimeType === "image/png" && !header.startsWith("\x89PNG\r\n\x1a\n") || file.mimeType === "image/jpeg" && !header.startsWith("\xff\xd8\xff") || file.mimeType === "image/gif" && !/^GIF8[79]a/.test(header) || file.mimeType === "image/webp" && !(header.startsWith("RIFF") && header.slice(8, 12) === "WEBP")) throw new Error("whiteboard_invalid_image");
    validatedImages.add(file);
  }
}
async function imageBytes(file: File): Promise<{ dataURL: string; width: number; height: number }> {
  if (!raster.test(file.type) || !file.size || file.size > 16 * 1024 * 1024) throw new Error("whiteboard_image_limit");
  const dataURL = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
  const { width, height } = await new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error("whiteboard_invalid_image")); image.src = dataURL; });
  if (!width || !height || width * height > 64_000_000) throw new Error("whiteboard_image_dimensions");
  return { dataURL, width, height };
}
function originalFile(element: BoardScene["elements"][number], files: BoardDocument["files"]): { file: File; attachmentId?: string } {
  const source = files[String(element.fileId)];
  if (!source || typeof source.dataURL !== "string" || typeof source.mimeType !== "string" || !raster.test(source.mimeType)) throw new Error("whiteboard_image_missing");
  const comma = source.dataURL.indexOf(","), bytes = decodeBase64(source.dataURL.slice(comma + 1));
  const metadata = element.customData && typeof element.customData === "object" && !Array.isArray(element.customData) ? element.customData : {};
  const name = typeof metadata.fileName === "string" ? metadata.fileName : `image-${element.id}.${source.mimeType.split("/")[1]}`;
  return { file: new File([bytes], name, { type: source.mimeType }), ...(typeof metadata.attachmentId === "string" ? { attachmentId: metadata.attachmentId } : {}) };
}

/** Final writes of editors that just closed, by board lock. A reopened board
 * starts only after its previous editor settled, from the state it left. */
const retiringBoards = new Map<string, Promise<void>>();
const RETIRING_WAIT_MS = 10_000;
const boardLock = (scope: string, id: string) => `tarobot-whiteboard:${scope}:${id}`;

/** Imported only when a whiteboard is first opened; no editor or font work in pure chat. */
export function WorkbenchCanvas(props: WorkbenchCanvasProps) {
  const name = boardLock(props.scope, props.document.id), [ready, setReady] = useState(() => !retiringBoards.has(name)), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const previous = retiringBoards.get(name); if (ready || !previous) { setReady(true); return; }
    let alive = true; const timer = setTimeout(() => { if (alive) setReady(true); }, RETIRING_WAIT_MS);
    void previous.finally(() => { clearTimeout(timer); if (alive) setReady(true); });
    return () => { alive = false; clearTimeout(timer); };
  }, [name, ready]);
  if (!ready) return <div className="workbench-canvas" data-board-id={props.document.id}><span className="workbench-canvas-status" role="status">{(props.lang ?? (globalThis.document.documentElement.lang.startsWith("en") ? "en" : "zh")) === "en" ? "Saving the previous edit…" : "正在保存上一次编辑…"}</span></div>;
  return <BoardEditor key={epoch} {...props} restart={() => setEpoch(value => value + 1)}/>;
}
const settledWithin = (promise: Promise<void>, ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); void promise.finally(() => { clearTimeout(timer); resolve(); }); });

function BoardEditor(props: WorkbenchCanvasProps & { restart?(): void }) {
  const callbacks = useRef(props); callbacks.current = props;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null), apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [view, setView] = useState(props.document), [writable, setWritable] = useState(false), [ownership, setOwnership] = useState("waiting");
  const [error, setError] = useState(""), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [annotation, setAnnotation] = useState<{ original: string; selected: string[] } | null>(null);
  const [annotationPreview, setAnnotationPreview] = useState("");
  const themeValue = (): "dark" | "light" => globalThis.document.documentElement.dataset.theme === "dark" || globalThis.document.documentElement.dataset.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const [theme, setTheme] = useState(themeValue);
  const importer = useRef<HTMLInputElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), mounted = useRef(true);
  const sessionRef = useRef<BoardSession | null>(null), controllerRef = useRef<BoardController | null>(null);
  const signature = useRef(""), fileSnapshot = useRef<{ input: BinaryFiles; json: BoardDocument["files"] } | null>(null);
  const pointerDown = useRef(false);
  const language = props.lang ?? (globalThis.document.documentElement.lang.startsWith("en") ? "en" : "zh"), en = language === "en";
  const label = (zh: string, english: string) => en ? english : zh;
  const errorText = (code: string) => {
    const messages: Record<string, [string, string]> = {
      whiteboard_image_limit: ["支持 PNG、JPEG、WebP 和 GIF，单张图片不超过 16 MB。", "Use PNG, JPEG, WebP or GIF images up to 16 MB each."],
      whiteboard_storage_limit: ["白板已超过 32 MB，请减少图片或导出备份后另建白板。", "This board exceeds 32 MB. Remove images or export a backup and create another board."],
      whiteboard_image_dimensions: ["图片分辨率过大，请使用不超过 6400 万像素的图片。", "Use an image with no more than 64 million pixels."],
      whiteboard_invalid_import: ["无法读取此白板文件，请选择有效的 Excalidraw 文件或图片。", "Choose a valid Excalidraw file or image."],
      whiteboard_import_requires_workspace: ["请在工作台中导入此文件，它将打开为一张新白板。", "Import this file from the workbench to open it as a new board."],
      whiteboard_unsupported_image: ["此图片格式暂不支持，请使用 PNG、JPEG、WebP 或 GIF。", "This image format is unsupported. Use PNG, JPEG, WebP or GIF."],
      whiteboard_unsupported_element: ["文件中包含不支持的嵌入内容，原白板仍保留。", "The file contains unsupported embedded content. Your previous board is retained."],
      whiteboard_image_required: ["先在白板中放入要修改的图片。", "Add an image to the board first."],
      whiteboard_reference_limit: ["请将本次选区中的参考图减少到 6 张以内。", "Select no more than 6 reference images."],
      whiteboard_revision_conflict: ["白板已经改变，请重新读取后再修改。", "The board has changed. Read the current version before editing."],
      whiteboard_read_only: ["另一窗口正在编辑此白板，请在该窗口修改。", "Another window is editing this board. Make changes there."],
    };
    return messages[code]?.[en ? 1 : 0] ?? label("未能完成操作，请重试。尚未保存的更改仍保留在当前白板。", "The operation could not finish. Retry; unsaved changes remain in this board.");
  };
  const session = sessionRef.current ??= new BoardSession(props.document,
    (expected, next) => callbacks.current.persist(expected, next), {
      create: values => jsonCopy(convertToExcalidrawElements(values as unknown as ExcalidrawElementSkeleton[], { regenerateIds: false })),
      apply: next => {
        const current = apiRef.current; if (!current) throw new Error("whiteboard_not_ready");
        const elements = restoreElements(next.scene.elements as unknown as ExcalidrawElement[], null);
        next.scene.elements = jsonCopy(elements); boardDocumentSchema.parse(next);
        current.addFiles(Object.values(next.files) as unknown as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
        current.updateScene({ elements, appState: { ...current.getAppState(), ...next.scene.appState } as AppState, captureUpdate: CaptureUpdateAction.NEVER });
        current.history.clear();
      },
      selection: () => Object.keys(apiRef.current?.getAppState().selectedElementIds ?? {}).filter(id => apiRef.current?.getAppState().selectedElementIds[id]),
    }, next => { if (mounted.current) { setView(next); setDirty(sessionRef.current?.dirty() ?? false); } callbacks.current.onDocument?.(next); }, props.savedRevision?.());

  const flush = async () => {
    clearTimeout(timer.current); timer.current = undefined;
    try { await session.flush(); if (mounted.current) { setDirty(session.dirty()); setError(""); } }
    catch (error) { if (mounted.current) { setDirty(true); setError(message(error)); } throw error; }
  };
  const result = (value: BoardResult) => { if (mounted.current) { setView(session.document); setDirty(session.dirty()); setError(value.error ?? ""); } return value; };
  const insertImage = async (request: BoardImageRequest): Promise<BoardResult> => {
    try {
      request.assertActive?.();
      const bytes = await imageBytes(request.file), digest = await boardFingerprint(bytes.dataURL), imageId = `image_${(await boardFingerprint(request.requestId)).slice(0, 24)}`, fileId = `file_${digest.slice(0, 32)}`;
      const value = await session.change(request, { type: "image", revision: request.expectedRevision, file: digest, name: request.file.name, original: request.originalElementId ?? null, replace: !!request.replace, attachmentId: request.attachmentId ?? null }, current => {
        const original = request.originalElementId ? current.scene.elements.find(element => element.id === request.originalElementId && element.type === "image") : undefined;
        if (request.originalElementId && !original) throw new Error("whiteboard_original_missing");
        if (request.replace && (!original || original.locked)) throw new Error("whiteboard_original_read_only");
        const scale = request.replace ? Math.min(Number(original!.width) / bytes.width, Number(original!.height) / bytes.height) : Math.min(1, 900 / Math.max(bytes.width, bytes.height));
        const generated = convertToExcalidrawElements([{ type: "image", id: request.replace ? String(original!.id) : imageId, fileId, x: original ? Number(original.x) + (request.replace ? 0 : Number(original.width) + 48) : 0, y: original ? Number(original.y) : 0, width: bytes.width * scale, height: bytes.height * scale, customData: { fileName: request.file.name, ...(request.attachmentId ? { attachmentId: request.attachmentId } : {}) } } as unknown as ExcalidrawElementSkeleton], { regenerateIds: false });
        current.undo = [...current.undo, structuredClone(current.scene)].slice(-12); current.redo = [];
        current.scene.elements = request.replace ? current.scene.elements.map(element => element.id === original!.id ? jsonCopy(generated[0]) : element) : [...current.scene.elements, jsonCopy(generated[0])];
        current.files[fileId] = { id: fileId, dataURL: bytes.dataURL, mimeType: request.file.type, created: Date.now() };
        return current;
      });
      return result({ ...value, ...(value.status.startsWith("applied") ? { result: { ...value.result, elementId: request.replace ? request.originalElementId : imageId, fileId } } : {}) });
    } catch (error) { return result({ status: "not_executed", revision: session.document.revision, saved: !session.dirty(), error: message(error) }); }
  };
  const controller = controllerRef.current ??= {
    read: () => session.read(), selection: () => session.selection(), flush, ownsEditor: () => !session.readOnly && session.active,
    apply: async request => result(await session.apply(request)), undo: async request => result(await session.undo(request)), redo: async request => result(await session.redo(request)), insertImage,
  };
  useEffect(() => {
    mounted.current = true;
    session.activate(); setDirty(session.dirty());
    let release: (() => void) | undefined, disposed = false;
    const name = boardLock(props.scope, props.document.id);
    const acquire = () => { if (!navigator.locks) { setOwnership("unsupported"); return; } void navigator.locks.request(name, { ifAvailable: true }, async lock => {
      if (disposed) return;
      if (!lock) { setOwnership("other_window"); return; }
      // A previous editor's final write may have stored this revision meanwhile.
      session.syncSaved(callbacks.current.savedRevision?.());
      session.setWritable(true); setWritable(true); setOwnership("owned"); setDirty(session.dirty());
      // A retained unsaved edit (an earlier save failed) is saved again now, as
      // autosave would; a failure stays visible as unsaved with Retry.
      if (session.dirty()) void flush().catch(() => undefined);
      await new Promise<void>(resolve => { release = resolve; });
    }).catch(error => { if (!disposed) { setOwnership("failed"); setError(message(error)); } }); };
    // Unmount and remount in one commit: the previous editor of this board in this
    // window is still writing. Wait for it (bounded); if it left a newer revision
    // than this editor started from, start again from that revision.
    const previous = retiringBoards.get(name);
    if (!previous) acquire();
    else void settledWithin(previous, RETIRING_WAIT_MS).then(() => {
      if (disposed) return;
      if (callbacks.current.document.revision !== session.document.revision && callbacks.current.restart) { callbacks.current.restart(); return; }
      acquire();
    });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (session.dirty()) { event.preventDefault(); event.returnValue = ""; } };
    const background = () => { if (globalThis.document.visibilityState === "hidden") void flush().catch(() => undefined); };
    window.addEventListener("beforeunload", beforeUnload); globalThis.document.addEventListener("visibilitychange", background);
    return () => {
      disposed = true; mounted.current = false; session.dispose(); clearTimeout(timer.current);
      window.removeEventListener("beforeunload", beforeUnload); globalThis.document.removeEventListener("visibilitychange", background);
      callbacks.current.onController?.(null);
      // The surface awaits flush before closing. Retain the lock until a final in-flight write finishes;
      // a reopened editor of this board waits for it (see WorkbenchCanvas).
      const settled = session.flush().catch(() => undefined).finally(() => { release?.(); });
      retiringBoards.set(name, settled);
      void settled.finally(() => { if (retiringBoards.get(name) === settled) retiringBoards.delete(name); });
    };
  }, [props.scope, props.document.id]);
  useEffect(() => { if (api) callbacks.current.onController?.(controller); }, [api, controller]);
  useEffect(() => { if (props.visible !== false) api?.refresh(); }, [props.visible, api]);
  useEffect(() => {
    const update = () => setTheme(themeValue()), observer = new MutationObserver(update), media = matchMedia("(prefers-color-scheme: dark)");
    observer.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] }); media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  useEffect(() => {
    let alive = true, url: string | undefined; setAnnotationPreview("");
    if (annotation) {
      const current = session.document;
      const elements = annotation.selected.length ? current.scene.elements.filter(element => annotation.selected.includes(String(element.id)) || element.id === annotation.original) : current.scene.elements;
      void exportToBlob({ elements: elements as unknown as NonDeleted<ExcalidrawElement>[], files: current.files as unknown as BinaryFiles, appState: { ...current.scene.appState, exportBackground: true }, maxWidthOrHeight: 800 }).then((blob: Blob) => {
        if (!alive) return; url = URL.createObjectURL(blob); setAnnotationPreview(url);
      }).catch((error: unknown) => { if (alive) setError(message(error)); });
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [annotation, view.revision]);

  const change = (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    try {
      const savedState = savedBoardState(appState as unknown as Record<string, unknown>);
      const nextSignature = elements.map(element => `${element.id}:${element.version}:${element.versionNonce}:${element.isDeleted}`).join("|") + JSON.stringify(savedState);
      const cached = fileSnapshot.current;
      const sameFiles = !!cached && Object.keys(files).length === Object.keys(cached.json).length && Object.entries(files).every(([id, value]) => cached.json[id]?.dataURL === value.dataURL);
      if (signature.current === nextSignature && sameFiles) return;
      const data = sameFiles ? cached!.json : jsonCopy<BoardDocument["files"]>(files);
      const scene = { elements: jsonCopy<BoardScene["elements"]>(elements.filter(element => !element.isDeleted)), appState: savedState };
      validateScene(scene, data);
      const normalized = session.initializeView(scene, data);
      signature.current = nextSignature; fileSnapshot.current = { input: files, json: data };
      if (normalized || !writable) return;
      session.local(scene, data); setDirty(session.dirty());
      if (session.dirty() && !pointerDown.current) { clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => undefined), 300); }
    } catch (error) {
      setError(message(error));
      // Reject unsupported paste/import edits visibly and restore the last
      // accepted scene, including any valid gesture still awaiting autosave.
      if (apiRef.current) { try { session.restoreView(); } catch { /* keep the original validation error */ } }
      setDirty(session.dirty());
    }
  };
  const history = async (kind: "undo" | "redo") => {
    await flush(); result(await controller[kind]({ requestId: crypto.randomUUID(), expectedRevision: session.document.revision }));
  };
  const run = (operation: () => Promise<void>) => { setBusy(true); void operation().catch(error => setError(message(error))).finally(() => { if (mounted.current) setBusy(false); }); };
  const importFile = async (file: File) => {
    await flush();
    if (raster.test(file.type)) { result(await insertImage({ file, requestId: crypto.randomUUID(), expectedRevision: session.document.revision })); return; }
    if (file.size > WORKBENCH_BOARD_BYTES) throw new Error("whiteboard_storage_limit");
    const imported = JSON.parse(await file.text()) as { type?: string; version?: number; elements?: unknown; appState?: unknown; files?: unknown };
    if (imported.type !== "excalidraw" || imported.version !== 2 || !Array.isArray(imported.elements)) throw new Error("whiteboard_invalid_import");
    const scene = boardSceneSchema.parse({ elements: imported.elements, appState: savedBoardState(imported.appState && typeof imported.appState === "object" ? imported.appState as Record<string, unknown> : {}) });
    const files = imported.files && typeof imported.files === "object" && !Array.isArray(imported.files) ? imported.files as BoardDocument["files"] : {};
    validateScene(scene, files);
    const normalized = { ...scene, elements: jsonCopy<BoardScene["elements"]>(restoreElements(scene.elements as unknown as ExcalidrawElement[], null)) };
    if (!callbacks.current.onImportBoard) throw new Error("whiteboard_import_requires_workspace");
    await callbacks.current.onImportBoard({ scene: normalized, files, title: file.name.replace(/\.(?:excalidraw|json)$/i, "").slice(0, 128) || label("导入的白板", "Imported board") });
  };
  const exportFile = async (kind: "scene" | "png") => {
    await flush(); const current = session.document;
    if (kind === "scene") await exportAttachment(new Blob([serializeAsJSON(current.scene.elements as unknown as ExcalidrawElement[], current.scene.appState as Partial<AppState>, current.files as unknown as BinaryFiles, "local")], { type: "application/json" }), `${current.id}.excalidraw`);
    else await exportAttachment(await exportToBlob({ elements: current.scene.elements as unknown as NonDeleted<ExcalidrawElement>[], files: current.files as unknown as BinaryFiles, appState: { ...current.scene.appState, exportBackground: true }, maxWidthOrHeight: 2400 }), `${current.id}.png`);
  };
  const startAnnotation = async () => {
    await flush(); const selected = session.selection(), images = session.document.scene.elements.filter(element => element.type === "image");
    if (!images.length) throw new Error("whiteboard_image_required");
    const selectedImages = images.filter(element => selected.includes(String(element.id)));
    setAnnotation({ original: String((selectedImages[0] ?? images[0]).id), selected });
  };
  const sendAnnotation = async () => {
    if (!annotation || !callbacks.current.onAnnotate) return;
    await flush(); const current = session.document, original = current.scene.elements.find(element => element.id === annotation.original && element.type === "image");
    if (!original) throw new Error("whiteboard_original_missing");
    // A selected range includes complete images, never a thumbnail or cropped original.
    const chosen = annotation.selected.length ? current.scene.elements.filter(element => annotation.selected.includes(String(element.id)) || element.id === original.id) : current.scene.elements;
    const references = chosen.filter(element => element.type === "image" && element.id !== original.id).map(element => ({ ...originalFile(element, current.files), elementId: String(element.id) }));
    if (references.length > 6) throw new Error("whiteboard_reference_limit");
    const preview = await exportToBlob({ elements: chosen as unknown as NonDeleted<ExcalidrawElement>[], files: current.files as unknown as BinaryFiles, appState: { ...current.scene.appState, exportBackground: true }, maxWidthOrHeight: 2400, exportPadding: 24 });
    await callbacks.current.onAnnotate({ boardId: current.id, baseRevision: current.revision, originalElementId: String(original.id), original: originalFile(original, current.files), preview: new File([preview], "annotation-preview.png", { type: "image/png" }), references });
    setAnnotation(null);
  };
  return <div className="workbench-canvas" data-board-id={props.document.id} data-board-revision={view.revision} data-board-saved={!dirty} hidden={props.visible === false}
    onKeyDownCapture={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable))) {
        event.preventDefault(); event.stopPropagation(); if (writable && !busy) run(() => history(event.shiftKey ? "redo" : "undo"));
      }
    }}
    onDragOverCapture={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.stopPropagation(); } }}
    onDropCapture={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); event.stopPropagation(); if (writable) { const files = Array.from(event.dataTransfer.files); run(async () => { for (const file of files) await importFile(file); }); } }}>
    <div className="workbench-canvas-tools">
      <span className="workbench-canvas-status" role="status">{!writable ? label(ownership === "waiting" ? "正在打开…" : ownership === "other_window" ? "另一窗口正在编辑 · 只读" : "无法取得编辑锁 · 只读", ownership === "waiting" ? "Opening…" : ownership === "other_window" ? "Editing in another window · Read only" : "Editing lock unavailable · Read only") : dirty ? label("尚未保存", "Unsaved") : label("已保存在本机", "Saved on this device")}</span>
      <button type="button" disabled={!writable || busy || (!view.undo.length && !dirty)} onClick={() => run(() => history("undo"))}>{label("撤销", "Undo")}</button>
      <button type="button" disabled={!writable || busy || !view.redo.length} onClick={() => run(() => history("redo"))}>{label("重做", "Redo")}</button>
      <button type="button" disabled={(!writable && !props.onImportBoard) || busy} onClick={() => importer.current?.click()}>{label("导入", "Import")}</button>
      <button type="button" disabled={busy} onClick={() => run(() => exportFile("scene"))}>{label("导出", "Export")}</button>
      <button type="button" disabled={busy || !view.scene.elements.length} onClick={() => run(() => exportFile("png"))}>PNG</button>
      {props.onAnnotate && <button className="workbench-canvas-send" type="button" disabled={busy || !writable} onClick={() => run(startAnnotation)}>{label("发给 Bot", "Send to Bot")}</button>}
      <input ref={importer} type="file" accept=".excalidraw,.json,image/png,image/jpeg,image/webp,image/gif" multiple hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; run(async () => { for (const file of files) await importFile(file); }); }} />
    </div>
    {error && <div className="workbench-canvas-error" role="alert" title={error}>{errorText(error)}{dirty && <button type="button" onClick={() => run(flush)}>{label("重新保存", "Retry save")}</button>}</div>}
    <div className="workbench-canvas-editor"><Excalidraw initialData={{ elements: props.document.scene.elements as unknown as ExcalidrawElement[], appState: props.document.scene.appState as Partial<AppState>, files: props.document.files as unknown as BinaryFiles }} excalidrawAPI={value => { apiRef.current = value; setApi(value); }} onChange={change} viewModeEnabled={!writable} langCode={en ? "en" : "zh-CN"} handleKeyboardGlobally={false} autoFocus={false} validateEmbeddable={false} aiEnabled={false} theme={theme}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, saveAsImage: false, toggleTheme: false } }} onPointerDown={() => { pointerDown.current = true; clearTimeout(timer.current); }} onPointerUp={() => { pointerDown.current = false; clearTimeout(timer.current); timer.current = setTimeout(() => void flush().catch(() => undefined), 0); }} /></div>
    {annotation && <div className="workbench-annotation-backdrop"><div role="dialog" aria-modal="true" aria-label={label("发送改图材料", "Image editing materials")} className="workbench-annotation-dialog">
      <h3>{label("发送改图材料", "Image editing materials")}</h3><p>{label("原图、标注预览和参考图将加入当前聊天草稿。标注仅说明修改要求，不属于最终图片。", "The original, annotation preview and references will be added to your current draft. Annotations describe edits and are not part of the final image.")}</p>
      <label>{label("要修改的原图", "Original image to edit")}<select value={annotation.original} onChange={event => setAnnotation({ ...annotation, original: event.currentTarget.value })}>{view.scene.elements.filter(element => element.type === "image").map((element, index) => <option key={String(element.id)} value={String(element.id)}>{label("图片", "Image")} {index + 1}</option>)}</select></label>
      {annotationPreview && <img className="workbench-annotation-preview" src={annotationPreview} alt={label("本次标注材料预览", "Preview of annotation materials")} />}
      <p>{annotation.selected.length ? label(`包含选中的 ${annotation.selected.length} 个元素及完整原图。`, `Includes ${annotation.selected.length} selected elements and the complete original.`) : label("未选区，将包含整张白板。", "No selection: includes the entire whiteboard.")}</p>
      <div><button type="button" disabled={busy} onClick={() => setAnnotation(null)}>{label("取消", "Cancel")}</button><button type="button" disabled={busy} onClick={() => run(sendAnnotation)}>{label("加入聊天草稿", "Add to draft")}</button></div>
    </div></div>}
  </div>;
}
export default WorkbenchCanvas;
