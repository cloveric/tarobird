// Fixed main-to-renderer lifecycle messages. No new native command is exposed
// to an editor, web page, or Bot. The App collects its own editor flushes.
export const DESIGN_PREPARE_SCRIPT = `(async () => {
  const detail = { pending: [] };
  window.dispatchEvent(new CustomEvent('tarobot:design-quit', { detail }));
  return (await Promise.all(detail.pending)).every(value => value === true);
})()`;
export const DESIGN_CANCEL_SCRIPT = `window.dispatchEvent(new CustomEvent('tarobot:design-quit', { detail: { pending: [], cancel: true } }))`;

export async function prepareDesignQuit(contents, { timeoutMs = 11000 } = {}) {
  if (contents.isDestroyed() || contents.isCrashed?.()) return true;
  let timer;
  try {
    return await Promise.race([
      contents.executeJavaScript(DESIGN_PREPARE_SCRIPT).then(value => value === true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); }
}

export function cancelDesignQuit(contents) {
  if (!contents.isDestroyed()) void contents.executeJavaScript(DESIGN_CANCEL_SCRIPT).catch(() => {});
}
