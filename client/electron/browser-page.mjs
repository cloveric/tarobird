// Fixed observation/action helpers for managed workbench pages. Main runs these
// in a dedicated isolated world with validated JSON arguments only; neither a
// Bot nor the App renderer can supply script text. Page script cannot read this
// world's element table, and credential-like field values never leave it.
export const PAGE_WORLD = 1093;

function library() {
  const S = globalThis.__tarobotBrowser ??= { refs: new Map(), ids: new WeakMap(), key: '', next: 0, marks: new Map() };
  const squash = value => String(value ?? '').slice(0, 2000).replace(/\s+/g, ' ').trim();
  const clip = (value, max) => value.length > max ? value.slice(0, max) : value;
  const textTypes = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);
  const sensitive = el => el.tagName === 'INPUT' && ['password', 'hidden', 'file'].includes(el.type)
    || /(password|one-time-code|cc-|csc)/i.test(el.getAttribute?.('autocomplete') ?? '');
  const prefix = key => { if (S.key !== key) { S.refs.clear(); S.ids = new WeakMap(); S.key = key; S.next = 0; S.marks.clear(); } };
  const refFor = el => {
    let ref = S.ids.get(el);
    if (!ref) {
      if (S.refs.size > 5000) for (const [key, value] of S.refs) if (!value.deref()?.isConnected) S.refs.delete(key);
      ref = S.key + (++S.next); S.ids.set(el, ref); S.refs.set(ref, new WeakRef(el));
    }
    return ref;
  };
  const resolve = ref => { if (typeof ref !== 'string' || !ref.startsWith(S.key)) return null; const el = S.refs.get(ref)?.deref(); return el?.isConnected ? el : null; };
  const offset = el => {
    let x = 0, y = 0, view = el.ownerDocument.defaultView;
    for (let depth = 0; view && view !== window && depth < 8; depth++) {
      let frame; try { frame = view.frameElement; } catch { return null; }
      if (!frame) return null;
      const r = frame.getBoundingClientRect(); x += r.left + frame.clientLeft; y += r.top + frame.clientTop; view = frame.ownerDocument.defaultView;
    }
    return { x, y };
  };
  const rect = el => { const r = el.getBoundingClientRect(), o = offset(el) ?? { x: 0, y: 0 }; return { x: r.left + o.x, y: r.top + o.y, width: r.width, height: r.height }; };
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (el.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true); };
  const inViewport = r => r.x < innerWidth && r.y < innerHeight && r.x + r.width > 0 && r.y + r.height > 0;
  const within = (node, el) => { for (let n = node, i = 0; n && i < 4096; n = n.parentNode ?? n.host, i++) if (n === el) return true; return false; };
  const role = el => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName, type = el.type;
    if (tag === 'A') return 'link'; if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox'; if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', file: 'button' }[type] ?? 'textbox';
    return el.isContentEditable ? 'textbox' : 'generic';
  };
  const name = el => {
    const doc = el.ownerDocument, labelled = el.getAttribute('aria-labelledby');
    const values = [labelled && labelled.split(/\s+/).map(id => doc.getElementById(id)?.innerText ?? '').join(' '), el.getAttribute('aria-label'),
      el.labels?.[0]?.innerText, el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '',
      el.tagName === 'IMG' ? el.alt : '', ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) ? '' : el.innerText,
      el.getAttribute('placeholder'), el.getAttribute('title'), el.querySelector?.('img[alt]')?.alt];
    for (const value of values) { const text = squash(value); if (text) return clip(text, 160); }
    return '';
  };
  const describe = el => {
    const r = rect(el), item = { ref: refFor(el), role: role(el), name: name(el), tag: el.tagName.toLowerCase() };
    if (el.tagName === 'INPUT') item.type = el.type;
    if (el.tagName === 'A' && el.href) item.href = clip(el.href, 300);
    if (el.tagName === 'INPUT' && el.type === 'file') item.files = el.files?.length ?? 0;
    else if (sensitive(el)) { item.sensitive = true; item.filled = !!el.value; }
    else if (el.tagName === 'INPUT' && textTypes.has(el.type) || el.tagName === 'TEXTAREA') item.value = clip(el.value, 200);
    else if (el.isContentEditable) item.value = clip(squash(el.innerText), 200);
    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
    for (const key of ['checked', 'expanded', 'selected', 'pressed']) { const value = el.getAttribute(`aria-${key}`); if (value) item[key] = value === 'true'; }
    if (el.tagName === 'SELECT') item.options = [...el.options].slice(0, 50).map(option => ({ value: clip(option.value, 120), label: clip(squash(option.label), 120), selected: option.selected }));
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
    if (el.readOnly) item.readonly = true;
    item.rect = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    item.inViewport = inViewport(r);
    return item;
  };
  const brief = el => el ? { tag: el.tagName.toLowerCase(), role: role(el), name: name(el) } : null;
  const documents = () => {
    const found = [document], frames = [];
    for (let i = 0; i < found.length && found.length < 24; i++) for (const frame of found[i].querySelectorAll('iframe,frame')) {
      let inner = null; try { inner = frame.contentDocument; } catch { /* cross-origin */ }
      if (inner?.documentElement) found.push(inner);
      else if (visible(frame)) { let origin = ''; try { origin = new URL(frame.src, found[i].baseURI).origin; } catch { /* opaque */ }
        const r = rect(frame); frames.push({ origin, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, readable: false }); }
    }
    return { documents: found, frames };
  };
  const SELECTOR = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=treeitem],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),[onclick]';
  const interactive = (root, out, limit) => {
    for (const el of root.querySelectorAll(SELECTOR)) { if (out.length >= limit) return; out.push(el); }
    const walker = (root.ownerDocument ?? root).createTreeWalker(root, 1);
    for (let node = walker.nextNode(), seen = 0; node && seen < 50000 && out.length < limit; node = walker.nextNode(), seen++) if (node.shadowRoot) interactive(node.shadowRoot, out, limit);
  };
  const hit = (x, y) => {
    let doc = document, ox = 0, oy = 0, el = null;
    for (let depth = 0; depth < 8; depth++) {
      let found = doc.elementFromPoint(x - ox, y - oy);
      while (found?.shadowRoot) { const inner = found.shadowRoot.elementFromPoint(x - ox, y - oy); if (!inner || inner === found) break; found = inner; }
      el = found;
      if (!found || !['IFRAME', 'FRAME'].includes(found.tagName)) break;
      let inner = null; try { inner = found.contentDocument; } catch { /* cross-origin */ }
      if (!inner) break;
      const r = found.getBoundingClientRect(); ox += r.left + found.clientLeft; oy += r.top + found.clientTop; doc = inner;
    }
    return el;
  };
  const active = () => {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 16; depth++) {
      if (el.shadowRoot?.activeElement) { el = el.shadowRoot.activeElement; continue; }
      if (['IFRAME', 'FRAME'].includes(el.tagName)) { let inner = null; try { inner = el.contentDocument; } catch { /* cross-origin */ } if (inner?.activeElement) { el = inner.activeElement; continue; } }
      break;
    }
    return el;
  };
  const scrollState = () => ({ x: Math.round(scrollX), y: Math.round(scrollY) });
  return { S, squash, clip, sensitive, prefix, refFor, resolve, rect, visible, inViewport, within, role, name, describe, brief, documents, interactive, hit, active, scrollState };
}

function observe(lib, args) {
  lib.prefix(args.prefix);
  const { documents, frames } = lib.documents(), candidates = [];
  for (const doc of documents) lib.interactive(doc, candidates, 4000);
  const elements = [], later = [];
  for (const el of candidates) {
    if (!lib.visible(el)) continue;
    const view = lib.inViewport(lib.rect(el));
    if (view) { if (elements.length < args.maxElements) elements.push(el); } else if (args.mode === 'page' && later.length < args.maxElements) later.push(el);
  }
  const chosen = elements.concat(later).slice(0, args.maxElements).map(el => lib.describe(el));
  let text = '';
  if (args.mode === 'page') text = document.body?.innerText ?? '';
  else {
    const parts = [], blocks = new Map();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, 4), range = document.createRange();
    let size = 0, last;
    for (let node = walker.nextNode(), seen = 0; node && seen < 40000 && size < args.maxText; node = walker.nextNode(), seen++) {
      const value = node.nodeValue; if (!value || !value.trim()) continue;
      const parent = node.parentElement; if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
      range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) continue;
      let block = parent;
      while (block && block !== document.body) {
        let display = blocks.get(block); if (display === undefined) { display = getComputedStyle(block).display; blocks.set(block, display); }
        if (!display.startsWith('inline')) break; block = block.parentElement;
      }
      const piece = value.replace(/\s+/g, ' ');
      parts.push(last && block !== last ? '\n' + piece.trimStart() : piece); last = block; size += piece.length;
    }
    text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const active = lib.active();
  return { url: location.href, title: document.title, viewport: { width: innerWidth, height: innerHeight }, scroll: lib.scrollState(),
    size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    text: lib.clip(text, args.maxText), truncated: text.length > args.maxText, elements: chosen, frames: frames.slice(0, 20),
    focused: active && active !== document.body && lib.S.ids.get(active) || null };
}

function selection(lib, args) {
  lib.prefix(args.prefix);
  for (const doc of lib.documents().documents) {
    const value = doc.getSelection?.(); if (!value || value.isCollapsed) continue;
    const text = value.toString(); if (!text.trim()) continue;
    const anchor = value.anchorNode?.nodeType === 1 ? value.anchorNode : value.anchorNode?.parentElement;
    return { text: lib.clip(text, args.maxText), truncated: text.length > args.maxText, element: anchor ? lib.describe(anchor) : null };
  }
  const el = lib.active();
  if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && !lib.sensitive(el)) {
    try { if (el.selectionStart !== el.selectionEnd) { const text = el.value.slice(el.selectionStart, el.selectionEnd); return { text: lib.clip(text, args.maxText), truncated: text.length > args.maxText, element: lib.describe(el) }; } }
    catch { /* input type without selection */ }
  }
  return { text: '', truncated: false, element: null };
}

function prepare(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { error: 'target_not_interactable', reason: 'disabled' };
  let r = lib.rect(el);
  if (r.x < 0 || r.y < 0 || r.x + r.width > innerWidth || r.y + r.height > innerHeight) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); r = lib.rect(el); }
  if (!lib.visible(el)) return { error: 'target_not_interactable', reason: 'hidden' };
  const doc = el.ownerDocument;
  if (args.op === 'click') {
    let covering;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]]) {
      const x = Math.min(innerWidth - 1, Math.max(0, r.x + r.width * fx)), y = Math.min(innerHeight - 1, Math.max(0, r.y + r.height * fy));
      const target = lib.hit(x, y);
      if (target && (lib.within(target, el) || target.control === el || [...(el.labels ?? [])].includes(target))) {
        const mark = { delivered: false, down: false };
        const onDown = event => { if (event.isTrusted && event.composedPath().includes(el)) mark.down = true; };
        const onClick = event => { if (event.isTrusted && event.composedPath().includes(el)) mark.delivered = true; };
        doc.addEventListener('pointerdown', onDown, true); doc.addEventListener('click', onClick, true);
        mark.dispose = () => { doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('click', onClick, true); };
        lib.S.marks.get(args.token)?.dispose?.(); lib.S.marks.set(args.token, mark);
        return { x, y, target: lib.brief(el) };
      }
      covering ??= target;
    }
    return { error: 'target_not_interactable', reason: 'covered', covering: lib.brief(covering) };
  }
  if (args.op === 'type') {
    const editable = el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color', 'hidden'].includes(el.type);
    if (!editable || el.readOnly) return { error: 'target_not_interactable', reason: 'not_editable' };
    el.focus({ preventScroll: true });
    if (lib.active() !== el) return { error: 'target_not_interactable', reason: 'focus' };
    if (el.isContentEditable) {
      const range = doc.createRange(); range.selectNodeContents(el); if (args.mode === 'append') range.collapse(false);
      const selected = doc.getSelection(); selected.removeAllRanges(); selected.addRange(range);
    } else {
      try { if (args.mode === 'append') el.setSelectionRange(el.value.length, el.value.length); else el.select(); }
      catch { if (args.mode !== 'append') el.select?.(); }
    }
    // Same measure as field(), so an append is judged by real growth.
    return { sensitive: lib.sensitive(el), before: el.isContentEditable ? el.innerText.replace(/\n$/, '').length : el.value.length };
  }
  if (args.op === 'press') return { target: lib.brief(el) };
  return { error: 'unsupported_action' };
}

function keyTarget(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.active() ?? document.body, doc = el?.ownerDocument ?? document;
  const mark = { delivered: false };
  const onKey = event => { if (event.isTrusted && event.key === args.key) mark.delivered = true; };
  doc.addEventListener('keydown', onKey, true);
  mark.dispose = () => doc.removeEventListener('keydown', onKey, true);
  lib.S.marks.get(args.token)?.dispose?.(); lib.S.marks.set(args.token, mark);
  return { target: el && el !== document.body ? lib.describe(el) : null };
}

function pointTarget(lib, args) {
  lib.prefix(args.prefix);
  const target = lib.hit(args.x, args.y), mark = { delivered: false, frame: !!target && ['IFRAME', 'FRAME'].includes(target.tagName) };
  const onClick = event => { if (event.isTrusted && Math.abs(event.clientX - args.x) < 3 && Math.abs(event.clientY - args.y) < 3) mark.delivered = true; };
  document.addEventListener('click', onClick, true);
  mark.dispose = () => document.removeEventListener('click', onClick, true);
  lib.S.marks.get(args.token)?.dispose?.(); lib.S.marks.set(args.token, mark);
  return { scroll: lib.scrollState(), target: lib.brief(target), frame: mark.frame };
}

function settle(lib, args) {
  const mark = lib.S.marks.get(args.token);
  lib.S.marks.delete(args.token); mark?.dispose?.();
  return mark ? { delivered: mark.delivered, down: mark.down ?? false, frame: mark.frame ?? false } : null;
}

function field(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  const value = el.isContentEditable ? el.innerText.replace(/\n$/, '') : el.value;
  const matches = args.mode === 'append' ? value.endsWith(args.text) : value === args.text;
  const sensitive = lib.sensitive(el);
  return { matches, length: value.length, focused: lib.active() === el, sensitive, ...(sensitive ? { filled: !!value } : { value: lib.clip(value, 500) }) };
}

function domType(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  if (el.isContentEditable) { el.ownerDocument.execCommand('insertText', false, args.text); return { method: 'dom' }; }
  const view = el.ownerDocument.defaultView, proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, args.mode === 'append' ? el.value + args.text : args.text);
  el.dispatchEvent(new view.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: args.text }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { method: 'dom' };
}

function scroll(lib, args) {
  lib.prefix(args.prefix);
  let el = null;
  if (args.ref) { el = lib.resolve(args.ref); if (!el) return { error: 'stale_ref' }; }
  if (el && !args.direction && !args.to) {
    const before = lib.rect(el); el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); const after = lib.rect(el);
    return { moved: Math.round(before.y) !== Math.round(after.y) || Math.round(before.x) !== Math.round(after.x), page: lib.scrollState(), target: lib.describe(el) };
  }
  const root = document.scrollingElement ?? document.documentElement;
  let scroller = root;
  for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(style.overflowY + style.overflowX) && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) { scroller = node; break; }
  }
  const position = () => scroller === root ? { x: Math.round(scrollX), y: Math.round(scrollY) } : { x: Math.round(scroller.scrollLeft), y: Math.round(scroller.scrollTop) };
  const before = position();
  const span = { height: scroller === root ? innerHeight : scroller.clientHeight, width: scroller === root ? innerWidth : scroller.clientWidth };
  if (args.to) scroller.scrollTo({ top: args.to === 'top' ? 0 : scroller.scrollHeight, behavior: 'instant' });
  else {
    const direction = args.direction ?? 'down', vertical = direction === 'up' || direction === 'down';
    const unit = vertical ? span.height : span.width;
    const distance = typeof args.amount === 'number' ? args.amount : Math.round(unit * (args.amount === 'half' ? 0.5 : 0.85));
    const sign = direction === 'up' || direction === 'left' ? -1 : 1;
    scroller.scrollBy({ top: vertical ? sign * distance : 0, left: vertical ? 0 : sign * distance, behavior: 'instant' });
  }
  const after = position();
  return { before, after, moved: before.x !== after.x || before.y !== after.y, container: scroller === root ? 'page' : lib.brief(scroller),
    max: { x: scroller.scrollWidth - span.width, y: scroller.scrollHeight - span.height } };
}

function chooseOption(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  if (el.tagName !== 'SELECT' || el.disabled) return { error: 'target_not_interactable', reason: 'not_select' };
  const wanted = args.values ?? args.labels;
  if (!el.multiple && wanted.length > 1) return { error: 'invalid_browser_args' };
  const options = [...el.options], chosen = [];
  for (const want of wanted) {
    const option = options.find(item => !item.disabled && (args.values ? item.value === want : lib.squash(item.label) === lib.squash(want) || lib.squash(item.text) === lib.squash(want)));
    if (!option) return { error: 'option_not_found', available: options.slice(0, 50).map(item => lib.clip(lib.squash(item.label), 120)) };
    chosen.push(option);
  }
  if (el.multiple) for (const option of options) option.selected = chosen.includes(option); else chosen[0].selected = true;
  const view = el.ownerDocument.defaultView;
  el.dispatchEvent(new view.Event('input', { bubbles: true, composed: true })); el.dispatchEvent(new view.Event('change', { bubbles: true }));
  const selected = [...el.selectedOptions].map(option => ({ value: lib.clip(option.value, 120), label: lib.clip(lib.squash(option.label), 120) }));
  return { selected, matches: chosen.every(option => option.selected) && (el.multiple ? selected.length === chosen.length : true) };
}

function markUpload(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  if (el.tagName !== 'INPUT' || el.type !== 'file' || el.disabled) return { error: 'target_not_interactable', reason: 'not_file_input' };
  if (el.getRootNode() !== document) return { error: 'target_not_interactable', reason: 'unsupported_frame' };
  if (!el.multiple && args.count > 1) return { error: 'target_not_interactable', reason: 'single_file' };
  el.setAttribute('data-tarobot-upload', args.nonce);
  return {};
}

function unmarkUpload(lib, args) {
  lib.prefix(args.prefix);
  const el = lib.resolve(args.ref);
  if (!el) return { error: 'stale_ref' };
  el.removeAttribute('data-tarobot-upload');
  return { count: el.files?.length ?? 0, names: [...(el.files ?? [])].slice(0, 10).map(file => lib.clip(file.name, 240)) };
}

function exitFullscreen() {
  const active = !!document.fullscreenElement;
  if (active) document.exitFullscreen().catch(() => {});
  return { active };
}

function scrollPosition(lib) { return { ...lib.scrollState(), viewport: { width: innerWidth, height: innerHeight } }; }

const operations = { observe, selection, prepare, keyTarget, pointTarget, settle, field, domType, scroll, chooseOption, markUpload, unmarkUpload, scrollPosition, exitFullscreen };
export const PAGE_OPERATIONS = Object.freeze(Object.keys(operations));

/** Build the fixed script for one named operation. Arguments are JSON data. */
export function pageScript(operation, args = {}) {
  const fn = operations[operation];
  if (!fn) throw new Error('unsupported_page_operation');
  return `(() => { const lib = (${library})(); return (${fn})(lib, ${JSON.stringify(args)}); })()`;
}
