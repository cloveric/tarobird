/** Run only in the owned main document's isolated preload world. Popups stay
 * denied in main, including those created by widgets or script. */
export function installExternalLinks(listen, open, failed = () => {}) {
  const follow = event => {
    if (!event.isTrusted || event.defaultPrevented || event.type === 'click' && event.button !== 0
      || event.type === 'auxclick' && event.button !== 1) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol) || url.username || url.password) return;
    event.preventDefault();
    void Promise.resolve().then(() => open(url.href)).catch(failed);
  };
  listen('click', follow);
  listen('auxclick', follow);
}
