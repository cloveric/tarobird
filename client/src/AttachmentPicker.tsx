import { useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Camera, FilePlus2, Image, Paperclip, ScanLine } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { isDesktop } from "./desktop-bridge.js";
import { CreationDialog } from "./CreationDialog.js";
import { DesktopMenu } from "./DesktopMenu.js";
import { captureDesktopScreenshot, screenshotError } from "./desktop-screenshot.js";
import { t } from "./i18n.js";

type Source = "camera" | "images" | "files";

/** One persistent input preserves the native picker callback after the sheet closes.
 * Changing its mode and opening it happen in the same user gesture. */
export function useAttachmentPicker({ scope, hostActive, active, phone, disabled, add, fail, settle }: {
  scope: string; hostActive: boolean; active: boolean; phone: boolean; disabled: boolean; add: (files: File[]) => void; fail: (message: string) => void; settle?(): void;
}) {
  // An unfolded iPhone still needs Camera / Photos / Files.
  const mobilePicker = phone || Capacitor.getPlatform() === "ios";
  const menuId = useId();
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const camera = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const captureBusy = useRef(false);
  const captureEpoch = useRef(0);
  const latest = useRef({ active, disabled, add, fail, settle });
  useLayoutEffect(() => { latest.current = { active, disabled, add, fail, settle }; });
  useLayoutEffect(() => {
    captureEpoch.current++;
    return () => { captureEpoch.current++; };
  }, [scope, hostActive, active]);
  const epoch = useRef(0);
  const origin = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    // Only destination changes invalidate a selection. Rotation can cross the
    // phone breakpoint while the camera is open without changing its target.
    // Host visibility still fences A -> B -> A with identical conversation IDs.
    epoch.current++;
  }, [scope, hostActive]);
  useLayoutEffect(() => { setOpen(false); }, [scope, active, mobilePicker, disabled]);
  const reset = (node: HTMLInputElement) => {
    node.value = "";
    node.multiple = true;
    node.removeAttribute("accept");
    node.removeAttribute("capture");
  };
  useLayoutEffect(() => {
    const node = input.current;
    const cancel = () => {
      const belongsHere = origin.current === epoch.current;
      if (node) reset(node); origin.current = undefined;
      if (belongsHere && latest.current.active && !latest.current.disabled) latest.current.settle?.();
    };
    node?.addEventListener("cancel", cancel);
    return () => node?.removeEventListener("cancel", cancel);
  }, []);
  const choose = (source: Source) => {
    const node = input.current;
    if (!node || disabled || !active) return;
    origin.current = epoch.current;
    reset(node);
    if (source !== "files") node.accept = "image/*";
    if (source === "camera") { node.multiple = false; node.setAttribute("capture", "environment"); }
    // Remove native dialog inertness before opening the system picker, without
    // awaiting an animation or losing the browser's transient user activation.
    flushSync(() => setOpen(false));
    settle?.();
    node.click();
  };
  const capture = async () => {
    if (captureBusy.current || disabled || !active || !hostActive) return;
    const origin = captureEpoch.current;
    captureBusy.current = true;
    flushSync(() => { setOpen(false); setCapturing(true); });
    try {
      const file = await captureDesktopScreenshot();
      if (file && origin === captureEpoch.current && latest.current.active && !latest.current.disabled) latest.current.add([file]);
    } catch (error) {
      if (origin === captureEpoch.current && latest.current.active) latest.current.fail(screenshotError(error));
    } finally {
      captureBusy.current = false;
      setCapturing(false);
      if (origin === captureEpoch.current && latest.current.active && !latest.current.disabled) latest.current.settle?.();
    }
  };
  return {
    trigger, expanded: open, capturing, menuId,
    show: () => {
      if (disabled || !active || captureBusy.current) return;
      if (!mobilePicker && !isDesktop()) { choose("files"); return; }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setOpen(true);
    },
    input: <input ref={input} className="attachment-picker-input" type="file" multiple tabIndex={-1} aria-hidden="true" disabled={disabled}
      onChange={(event) => {
        const chosen = Array.from(event.currentTarget.files ?? []);
        const belongsHere = origin.current === undefined || origin.current === epoch.current;
        reset(event.currentTarget); origin.current = undefined;
        if (chosen.length && active && !disabled && belongsHere) add(chosen);
      }}/>,
    desktopMenu: !mobilePicker && isDesktop() && <DesktopMenu id={menuId} label={t("添加附件")} open={open && active && !disabled} close={() => setOpen(false)} trigger={trigger} placement="up-start" onDismiss={settle}>
      <button type="button" onClick={() => choose("files")}><Paperclip size={17}/>{t("上传附件")}</button>
      <button type="button" onClick={() => void capture()}><ScanLine size={17}/><span className="desktop-menu-text">{t("截屏")}<small>{t("框选后添加到草稿，Esc 取消")}</small></span></button>
    </DesktopMenu>,
    sheet: open && active && mobilePicker && !disabled && <CreationDialog title={t("添加附件")} className="attachment-sheet" closeLabel={t("关闭附件菜单")} close={() => setOpen(false)} returnFocus={trigger} initialFocus={camera}>
      <div className="attachment-source-list">
        <button type="button" ref={camera} onClick={() => choose("camera")}><span><Camera size={21}/></span>{t("拍照")}</button>
        <button type="button" onClick={() => choose("images")}><span><Image size={21}/></span>{t("附加图片")}</button>
        <button type="button" onClick={() => choose("files")}><span><Paperclip size={21}/></span>{t("上传附件")}</button>
      </div>
    </CreationDialog>,
  };
}


/** Keep the native popup and its anchor together in every desktop composer. */
export function ComposerAttachmentButton({ picker, disabled, label = t("添加文件"), title = t("添加图片或文件") }: { picker: ReturnType<typeof useAttachmentPicker>; disabled: boolean; label?: string; title?: string }) {
  return <div className="composer-attachment-menu"><button type="button" ref={picker.trigger} className="icon-button" title={title} aria-label={label} aria-expanded={picker.expanded} aria-controls={picker.expanded ? picker.menuId : undefined} disabled={disabled || picker.capturing} onClick={picker.show}><FilePlus2 size={18}/></button>{picker.desktopMenu}</div>;
}
