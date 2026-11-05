/** WebKit can undo a hidden textarea despite a modal's inert background. All
 * current App dialogs use showModal(); ordinary cross-field undo stays native. */
export function blocksModalHistory(inputType: string | undefined, target: EventTarget | null): boolean {
  if (inputType !== "historyUndo" && inputType !== "historyRedo" || !(target instanceof Node)) return false;
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")];
  if (!dialogs.length) return false;
  const owner = document.activeElement?.closest("dialog[open]");
  return owner ? !owner.contains(target) : !dialogs.some(dialog => dialog.contains(target));
}

export function installModalHistoryGuard(): () => void {
  const guard = (event: InputEvent) => {
    if (blocksModalHistory(event.inputType, event.target)) event.preventDefault();
  };
  document.addEventListener("beforeinput", guard, true);
  return () => document.removeEventListener("beforeinput", guard, true);
}
