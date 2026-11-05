import { expect, it } from 'vitest';
import { readWidgetState, saveWidgetState } from '../src/widget-state.js';

it('isolates authored state by owner/message/block and exact source', () => {
  expect(saveWidgetState('hub:user:chat:one:0','hash1','{"selected":[1,2]}')).toBe(true);
  expect(readWidgetState('hub:user:chat:one:0','hash1')).toBe('{"selected":[1,2]}');
  for(const scope of ['other:user:chat:one:0','hub:other:chat:one:0','hub:user:chat:two:0','hub:user:chat:one:1']) expect(readWidgetState(scope,'hash1')).toBeUndefined();
  expect(readWidgetState('hub:user:chat:one:0','changed-source')).toBeUndefined();
});
it('validates bytes and JSON without replacing the last good state', () => {
  saveWidgetState('validation','hash','false');
  for(const value of [{},'undefined','{"bad":',JSON.stringify('中'.repeat(6000)),JSON.stringify('x'.repeat(16384))]) expect(saveWidgetState('validation','hash',value)).toBe(false);
  expect(readWidgetState('validation','hash')).toBe('false');
  expect(saveWidgetState('validation','hash','null')).toBe(true);
});
it('bounds the cache to 64 entries and retains recently read state', () => {
  for(let i=0;i<64;i++) saveWidgetState('lru-'+i,'hash',String(i));
  expect(readWidgetState('lru-0','hash')).toBe('0');
  saveWidgetState('lru-new','hash','true');
  expect(readWidgetState('lru-1','hash')).toBeUndefined();
  expect(readWidgetState('lru-0','hash')).toBe('0');
});
