import { useRef, useState, type PointerEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Check, CircleHelp } from 'lucide-react';
import { CreationDialog } from './CreationDialog.js';
import { t, useLocale } from './i18n.js';
import './claude-send-choice.css';
import './codex-desktop-composer.css';

/** Chooses a route only; the existing Send/Enter handler performs the write. */
export function ClaudeSendChoice({ next, lockedToNext, disabled, change, compact, explicitSteering = false }: {
  compact: boolean; next: boolean; lockedToNext: boolean; disabled: boolean; change: (next: boolean) => void; explicitSteering?: boolean;
}) {
  useLocale();
  const helpTrigger = useRef<HTMLButtonElement>(null);
  const summaryTrigger = useRef<HTMLButtonElement>(null);
  const helpFromSummary = useRef(false);
  const [help, setHelp] = useState(false);
  const touch = useRef<{ id: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const suppressPointerClick = useRef(false);
  const keepComposer = (event: PointerEvent<HTMLButtonElement>) => {
    touch.current = undefined; suppressPointerClick.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.closest('.composer-wrap') === event.currentTarget.closest('.composer-wrap')) {
      event.preventDefault();
      if (event.pointerType === 'touch') {
        touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        suppressPointerClick.current = true;
      }
    }
  };
  const moveTouch = (event: PointerEvent<HTMLButtonElement>) => {
    const start = touch.current;
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true;
  };
  const finishTouch = (event: PointerEvent<HTMLButtonElement>, next: boolean) => {
    const start = touch.current; touch.current = undefined;
    if (!start || start.id !== event.pointerId) return;
    // WebKit suppresses click after a prevented touch pointerdown. Complete a
    // genuine tap here while retaining the keyboard; a pan/cancel never selects.
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    if (!start.moved && !disabled && (next || !lockedToNext) && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) change(next);
  };
  const click = (event: MouseEvent<HTMLButtonElement>, next: boolean) => {
    const suppressed = suppressPointerClick.current; suppressPointerClick.current = false;
    if (suppressed && event.detail !== 0) { event.preventDefault(); return; }
    change(next);
  };
  const arrow = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || disabled || lockedToNext) return;
    event.preventDefault();
    const value = event.key === 'Home' ? false : event.key === 'End' ? true : !next;
    change(value);
    event.currentTarget.closest('fieldset')?.querySelector<HTMLButtonElement>(value ? '[data-mode="next"]' : '[data-mode="current"]')?.focus();
  };
  const currentExplanation = lockedToNext ? explicitSteering ? t('这条消息将在当前任务结束后处理') : t('附件和引用将在当前任务结束后处理') : explicitSteering ? t('补充到当前任务，不改变待执行顺序') : t('由 CLI 适时读入，不主动打断当前任务');
  const nextExplanation = t('等待当前任务结束后再处理');
  const explanation = lockedToNext ? currentExplanation : next ? nextExplanation : currentExplanation;
  return <>
    <button ref={summaryTrigger} type="button" className="send-choice-summary" aria-label={t('说明发送方式')} aria-description={explanation} title={explanation} onClick={() => { helpFromSummary.current = true; setHelp(true); }}><span>{explanation}</span></button>
    <div className="claude-send-choice">
    <fieldset disabled={disabled} role="radiogroup" aria-label={t('发送方式')}>
      <button type="button" role="radio" data-mode="current" aria-checked={!next} tabIndex={next ? -1 : 0} disabled={lockedToNext} onPointerDown={keepComposer} onPointerMove={moveTouch} onPointerCancel={() => { touch.current = undefined; }} onPointerUp={event => finishTouch(event, false)} onKeyDown={arrow} onClick={event => click(event, false)} title={currentExplanation}>
        <Check size={13}/>{compact ? t('补充') : t('补充当前')}
      </button>
      <button type="button" role="radio" data-mode="next" aria-checked={next} tabIndex={next ? 0 : -1} onPointerDown={keepComposer} onPointerMove={moveTouch} onPointerCancel={() => { touch.current = undefined; }} onPointerUp={event => finishTouch(event, true)} onKeyDown={arrow} onClick={event => click(event, true)} title={nextExplanation}>
        <Check size={13}/>{compact ? t('排队') : t('排到下一轮')}
      </button>
    </fieldset>
    <button ref={helpTrigger} type="button" className="send-choice-help" aria-label={t('说明发送方式')} onClick={() => { helpFromSummary.current = false; setHelp(true); }}><CircleHelp size={16}/></button>
    {help && <CreationDialog title={t('发送方式')} showHost={false} className="send-choice-explanation" returnFocus={helpFromSummary.current ? summaryTrigger : helpTrigger} closeLabel={t('关闭发送方式说明')} close={() => setHelp(false)}>
      <dl><dt>{t('补充当前')}</dt><dd>{explicitSteering ? t('补充到当前任务，不改变待执行顺序') : t('由 CLI 适时读入，不主动打断当前任务。待处理时间可能很短，模型收到后无法撤回。')}</dd>
        <dt>{t('排到下一轮')}</dt><dd>{t('等待当前任务结束后再处理。在待执行列表中可以编辑、调整顺序或取消；开始处理后不能撤回。')}</dd></dl>
      <p>{t('这里只选择发送方式，点击发送按钮才会发送。同一任务内会记住选择，其他对话互不影响。')}</p>
    </CreationDialog>}
  </div></>;
}
