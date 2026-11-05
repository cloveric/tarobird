import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { WorkbenchTab } from "./workbench-model.js";

/** Draft-only selection: the controller applies it atomically after confirmation. */
export function WorkbenchSplitPicker({ id, tabs, visible, busy, trigger, word, icon, onApply, onClose }: {
  id: string; tabs: WorkbenchTab[]; visible: string[]; busy: boolean; trigger: HTMLElement | null;
  word(zh: string, en: string): string; icon(tab: WorkbenchTab): ReactNode;
  onApply(ids: string[]): void; onClose(): void;
}) {
  const [selected, setSelected] = useState(() => [...visible]);
  // A tab may close while the chooser is open; it must not remain a hidden vote.
  const chosen = tabs.filter(tab => selected.includes(tab.id)).map(tab => tab.id);
  const element = useRef<HTMLDivElement>(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    setSelected(current => current.some(id => !tabs.some(tab => tab.id === id)) ? current.filter(id => tabs.some(tab => tab.id === id)) : current);
  }, [tabs]);
  const wasBusy = useRef(busy);
  useLayoutEffect(() => {
    if (wasBusy.current && !busy && document.activeElement === document.body) {
      (element.current?.querySelector<HTMLElement>(".workbench-split-apply:not(:disabled)") ?? element.current?.querySelector<HTMLElement>("input:not(:disabled)"))?.focus({ preventScroll: true });
    }
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    const picker = element.current!;
    (picker.querySelector<HTMLInputElement>('input:checked:not(:disabled)') ?? picker.querySelector<HTMLInputElement>('input:not(:disabled)'))?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !picker.contains(event.target) && !trigger?.contains(event.target)) close.current();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close.current(); trigger?.focus({ preventScroll: true });
      } else if (event.key === "Tab" && picker.contains(event.target as Node)) {
        const controls = [...picker.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement as HTMLElement), next = index + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= controls.length) {
          // WebKit's default Tab policy can skip buttons and leave the document.
          // Exit to the adjacent toolbar control without losing keyboard focus.
          event.preventDefault();
          const toolbar = [...trigger?.parentElement?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []];
          const from = toolbar.indexOf(trigger as HTMLButtonElement);
          close.current(); (event.shiftKey ? trigger : toolbar[from + 1] ?? trigger)?.focus({ preventScroll: true });
        } else { event.preventDefault(); controls[next].focus(); }
      }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", keys);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", keys); };
  }, [trigger]);
  return <div id={id} ref={element} className="workbench-menu workbench-split-picker" role="dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} aria-busy={busy || undefined} data-workbench-menu data-workbench-overlay>
    <div className="workbench-split-heading"><strong id={`${id}-title`}>{word("选择分屏标签", "Choose split tabs")}</strong><span role="status">{word(`已选 ${chosen.length}/4`, `${chosen.length}/4 selected`)}</span></div>
    <p id={`${id}-hint`}>{chosen.length === 4 ? word("已选满 4 个，取消一项即可更换。", "Four selected. Uncheck one to replace it.") : word("选择 2–4 个标签，按标签顺序排列。", "Choose 2–4 tabs, shown in tab order.")}</p>
    <div className="workbench-split-choices">
      {tabs.map(tab => {
        const checked = chosen.includes(tab.id), disabled = busy || !checked && chosen.length >= 4;
        return <label key={tab.id} className="workbench-split-choice" data-selected={checked} aria-disabled={disabled || undefined}>
          <input type="checkbox" checked={checked} disabled={disabled} onChange={() => setSelected(checked ? chosen.filter(id => id !== tab.id) : [...chosen, tab.id])}/>
          {icon(tab)}<span title={tab.title}>{tab.title}</span>
        </label>;
      })}
    </div>
    <div className="workbench-split-footer"><button disabled={busy} onClick={() => { onClose(); trigger?.focus({ preventScroll: true }); }}>{word("取消", "Cancel")}</button><button className="workbench-split-apply" disabled={busy || chosen.length < 2 || chosen.length > 4} onClick={() => onApply(chosen)}>{word(busy ? "正在应用…" : "应用分屏", busy ? "Applying…" : "Apply split")}</button></div>
  </div>;
}
