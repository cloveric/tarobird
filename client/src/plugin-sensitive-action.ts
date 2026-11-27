import { t } from "./i18n.js";

export type PluginSensitiveAction =
  | { id: string; kind: "clipboard"; text: string }
  | { id: string; kind: "export"; filename: string };

type PendingConsent = { result: Promise<boolean>; cancel(): void };

function showConsent(plugin: string, action: PluginSensitiveAction, run: () => Promise<boolean>, active: () => boolean): PendingConsent {
  const dialog = document.createElement("dialog");
  const heading = document.createElement("h3");
  const detail = document.createElement("p");
  const actions = document.createElement("div");
  const cancel = document.createElement("button");
  const accept = document.createElement("button");
  dialog.className = "design-export-prompt";
  heading.textContent = action.kind === "clipboard" ? t("允许「{0}」写入剪贴板？", plugin) : t("允许「{0}」导出文件？", plugin);
  dialog.setAttribute("aria-label", heading.textContent);
  detail.textContent = action.kind === "export" ? action.filename : action.text.length > 300 ? `${action.text.slice(0, 300)}…` : action.text;
  detail.style.overflowWrap = "anywhere";
  detail.style.whiteSpace = "pre-wrap";
  cancel.textContent = t("取消");
  accept.textContent = action.kind === "clipboard" ? t("复制一次") : t("保存文件");
  actions.append(cancel, accept);
  dialog.append(heading, detail, actions);
  let finished = false, settle!: (allowed: boolean) => void, fail!: (error: unknown) => void;
  const result = new Promise<boolean>((resolve, reject) => { settle = resolve; fail = reject; });
  const close = () => {
    if (finished) return;
    finished = true;
    dialog.remove();
    settle(false);
  };
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  cancel.addEventListener("click", close);
  accept.addEventListener("click", event => {
    if (!event.isTrusted || !navigator.userActivation?.isActive || finished) return;
    if (!active()) { close(); return; }
    finished = true;
    dialog.remove();
    // Invoke before yielding so native clipboard and save pickers inherit the click.
    try { void run().then(settle, fail); } catch (error) { fail(error); }
  });
  document.body.append(dialog);
  try { dialog.showModal(); cancel.focus(); } catch { close(); }
  return { result, cancel: close };
}

/** Bound to one rendered plugin document. Reject duplicates even after dismissal,
 * and refuse concurrent prompts so a plugin cannot substitute a pending action. */
export function createPluginSensitiveActionGate(
  show: typeof showConsent = showConsent,
) {
  const seen = new Set<string>();
  let pending: PendingConsent | undefined;
  return {
    async run(plugin: string, action: PluginSensitiveAction, perform: () => Promise<boolean>, active: () => boolean): Promise<boolean> {
      if (!active() || seen.has(action.id) || seen.size >= 256) return false;
      seen.add(action.id);
      if (pending) return false;
      const consent = show(plugin, action, perform, active);
      pending = consent;
      try { return await consent.result; }
      finally { if (pending === consent) pending = undefined; }
    },
    cancel() { pending?.cancel(); },
  };
}
