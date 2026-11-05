/** An export that finishes after transient activation expires needs a fresh
 * trusted click in the App. Executable project content cannot grant itself one. */
export function designExportPrompt(name: string, save: () => Promise<boolean>) {
  const dialog = document.createElement("dialog"), title = document.createElement("h3"), filename = document.createElement("p"), actions = document.createElement("div");
  const cancel = document.createElement("button"), accept = document.createElement("button");
  const english = document.documentElement.lang.startsWith("en");
  dialog.className = "design-export-prompt"; dialog.setAttribute("aria-label", english ? "Export ready" : "导出已准备好");
  title.textContent = english ? "Export ready" : "导出已准备好"; filename.textContent = name;
  cancel.textContent = english ? "Cancel" : "取消"; accept.textContent = english ? "Save file" : "保存文件";
  actions.append(cancel, accept); dialog.append(title, filename, actions);
  let finished = false, settle!: (saved: boolean) => void, fail!: (error: unknown) => void;
  const result = new Promise<boolean>((resolve, reject) => { settle = resolve; fail = reject; });
  const close = () => { if (finished) return; finished = true; dialog.remove(); settle(false); };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  cancel.addEventListener("click", close);
  accept.addEventListener("click", event => {
    if (!event.isTrusted || !navigator.userActivation?.isActive || finished) return;
    finished = true; dialog.remove();
    // Invoke synchronously inside the trusted click so native pickers inherit it.
    try { void save().then(settle, fail); } catch (error) { fail(error); }
  });
  document.body.appendChild(dialog); dialog.showModal(); accept.focus();
  return { result, cancel: close };
}
