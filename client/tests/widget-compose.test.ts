import { expect, it } from 'vitest';
import { widgetComposeText, appendWidgetDraft } from '../src/widget-compose.js';

it('accepts only bounded discussion text, never a command or hidden control sequence', () => {
  expect(widgetComposeText('  比较所选 A、B\n预算 500  ')).toBe('比较所选 A、B\n预算 500');
  for (const text of [null, {}, '', '  ', '/stop', '\n /clear', 'x'.repeat(4001), 'a\u0000b', 'a\u001bb']) {
    expect(widgetComposeText(text)).toBeUndefined();
  }
  expect(widgetComposeText('a'.repeat(4000))).toHaveLength(4000);
});

it('appends without altering existing draft whitespace or quoting it as sent', () => {
  expect(appendWidgetDraft('', 'selection')).toBe('selection');
  expect(appendWidgetDraft('  original  ', 'selection')).toBe('  original  \n\nselection');
  expect(appendWidgetDraft('original\n', 'selection')).toBe('original\n\nselection');
  expect(appendWidgetDraft('original\n\n', 'selection')).toBe('original\n\nselection');
});
