import { ArrowLeft, X } from 'lucide-react';
import { useLayoutEffect, type RefObject } from 'react';
import { HostLocation } from './RuntimeHost.js';
import { t } from './i18n.js';
import './settings-page.css';

export function captureSettingsPageFocus() {
  const trigger = document.activeElement as HTMLElement | null;
  const scope = trigger?.closest('.app-shell'), entry = trigger?.dataset.settingsEntry;
  return () => {
    const visible = (node?: HTMLElement | null) => !!node?.isConnected && !!node.getClientRects().length && !node.closest('[hidden],[inert]');
    // Phone home remounts across landscape/desktop layout changes. Find its
    // replacement in the originating workspace, never another host's entry.
    const replacement = entry ? [...scope?.querySelectorAll<HTMLElement>('[data-settings-entry]') ?? []].find(node => node.dataset.settingsEntry === entry && visible(node)) : undefined;
    (visible(trigger) ? trigger : replacement)?.focus({ preventScroll: true });
  };
}

/** Keep a focused field inside the page's own scrollport when the keyboard
 * shrinks it. Scrolling the document would displace the persistent back bar. */
export function useSettingsPageViewport(body: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (!matchMedia('(max-width:760px),(hover:none) and (pointer:coarse)').matches) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !node.contains(active) || !active.matches('input,textarea,select')) return;
      const visible = node.getBoundingClientRect(), field = active.getBoundingClientRect();
      if (field.top < visible.top) node.scrollTop -= visible.top - field.top + 12;
      else if (field.bottom > visible.bottom) node.scrollTop += field.bottom - visible.bottom + 12;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [body]);
}

/** Long settings pages keep a phone back bar outside their scrollport.
 * Desktop retains the compact dialog header and close action. */
export function SettingsPageHeader({ title, eyebrow, closeLabel, close, back = close }: {
  title: string; eyebrow?: string; closeLabel: string; close: () => void; back?: () => void;
}) {
  return <header className="settings-page-header">
    <button type="button" className="icon-button settings-page-back" aria-label={t('返回')} onClick={back}><ArrowLeft size={20}/></button>
    <div className="settings-page-title">{eyebrow && <p className="capabilities-eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
    <button type="button" className="icon-button settings-page-close" aria-label={closeLabel} onClick={close}><X size={20}/></button>
    <HostLocation/>
  </header>;
}
