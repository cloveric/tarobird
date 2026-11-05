import type { Plugin } from "unified";
import type {} from "micromark-extension-math";

/** Single-dollar math uses Pandoc-style boundaries, so `$10 ... $20` stays
 * prose. Guard the existing tokenizer instead of escaping the source: code,
 * links, escaped dollars and display math keep their normal Markdown semantics.
 * Rejecting the attempted token lets micromark parse later real formulas. */
export const remarkMathBoundaries: Plugin = function () {
  for (const extension of this.data().micromarkExtensions ?? []) {
    const entry = extension.text?.[36];
    for (const construct of Array.isArray(entry) ? entry : entry ? [entry] : []) {
      if (construct.name !== "mathText") continue;
      const tokenize = construct.tokenize;
      construct.tokenize = function (effects, ok, nok) {
        return tokenize.call(this, effects, code => {
          const last = this.events[this.events.length - 1];
          if (last?.[0] === "exit" && last[1].type === "mathText") {
            const raw = this.sliceSerialize(last[1]);
            if (!raw.startsWith("$$") && (
              /\s/.test(raw[1] ?? "") || /\s/.test(raw[raw.length - 2] ?? "") ||
              code !== null && code >= 48 && code <= 57
            )) return nok(code);
          }
          return ok(code);
        }, nok);
      };
    }
  }
};
