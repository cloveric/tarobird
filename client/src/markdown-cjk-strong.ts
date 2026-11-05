import { attention } from "micromark-core-commonmark";
import type { Plugin } from "unified";

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// CommonMark's punctuation class includes symbols such as the backtick.
const punctuation = /[\p{P}\p{S}]/u;
const eastAsianPunctuation = /[\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/u;
// Micromark may expose one UTF-16 unit of an astral letter/emoji at a boundary.
const prose = /[\p{L}\p{N}\p{S}\p{Cs}]/u;
const matches = (pattern: RegExp, code: number | null): boolean => code !== null && code >= 0 && pattern.test(String.fromCodePoint(code));

/** CJK prose does not require spaces around emphasis. Permit a paired `**`
 * beside punctuation and a CJK letter, e.g. `**结论。**后文` or `前文**“重点”**`.
 * Full-width punctuation also borders mixed-script labels: `**结论：**TaroBird`.
 * Keep micromark's pairing/resolution and source positions: escaped markers,
 * code, links, math, unmatched runs and ordinary Markdown retain their rules.
 * Single-star emphasis and underscore delimiters are intentionally unchanged. */
const strong: typeof attention = {
  ...attention,
  tokenize(effects, ok, nok) {
    const before = this.previous;
    return attention.tokenize.call(this, effects, after => {
      const last = this.events[this.events.length - 1];
      const token = last?.[1];
      if (last?.[0] === "exit" && token.type === "attentionSequence" && token.end.offset - token.start.offset === 2) {
        if (matches(punctuation, after) && (matches(cjk, before)
          || matches(eastAsianPunctuation, after) && matches(prose, before))) token._open = true;
        if (matches(punctuation, before) && (matches(cjk, after)
          || matches(eastAsianPunctuation, before) && matches(prose, after))) token._close = true;
      }
      return ok(after);
    }, nok);
  },
};

export const remarkCjkStrong: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push({ text: { 42: strong } });
};
