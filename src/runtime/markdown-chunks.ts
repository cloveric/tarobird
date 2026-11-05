/** Split Markdown to a caller-owned UTF-16 limit while preserving code fences. */
function utf16Length(text: string): number {
  return text.length;
}

function takeSafePrefixByUnits(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) {
    return text;
  }

  let end = maxUnits;
  if (
    end > 0 &&
    end < text.length &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? "") &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "")
  ) {
    end -= 1;
  }

  if (end <= 0) {
    return Array.from(text)[0] ?? "";
  }

  return text.slice(0, end);
}

function splitLineSegments(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const segments = text.match(/[^\n]*\n?|$/g)?.filter((value) => value.length > 0) ?? [];
  return segments.length > 0 ? segments : [text];
}

export function chunkMarkdown(text: string, limit: number): string[] {
  if (!Number.isInteger(limit) || !Number.isFinite(limit) || limit <= 0) {
    throw new RangeError("limit must be a positive integer");
  }

  if (utf16Length(text) <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let current = "";
  let inFence = false;
  let fenceOpener = "```";
  let fenceDelimiter = "```";

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    chunks.push(current);
    current = "";
  };

  const closeFenceSuffix = () => `${current.endsWith("\n") ? "" : "\n"}${fenceDelimiter}`;
  const reopenFence = () => {
    current = `${fenceOpener}\n`;
    // A reopened chunk must fit its worst-case closer and at least one content
    // unit. Otherwise appendWithinFence would close/reopen forever without
    // consuming any input.
    if (utf16Length(current) + utf16Length(fenceDelimiter) + 1 >= limit) {
      throw new RangeError("limit is too small to safely encode a fenced code block");
    }
  };

  const closeAndReopenFence = () => {
    const suffix = closeFenceSuffix();
    if (utf16Length(current) + utf16Length(suffix) > limit) {
      throw new RangeError("limit is too small to safely encode a fenced code block");
    }
    current += suffix;
    pushCurrent();
    reopenFence();
  };

  const appendWithinFence = (segment: string, closesFence: boolean) => {
    let remaining = segment;
    while (remaining) {
      const rawAvailable = limit - utf16Length(current);
      if (closesFence && utf16Length(remaining) <= rawAvailable) {
        current += remaining;
        return;
      }

      // Reserve the worst-case closer (newline + delimiter). The prefix we add
      // can change a previously newline-terminated chunk into a non-terminated
      // one, so calculating from the pre-append suffix can be one unit short.
      const available = limit - utf16Length(current) - utf16Length(fenceDelimiter) - 1;
      if (available <= 0) {
        closeAndReopenFence();
        continue;
      }
      // Same line-boundary preference inside a fence: if this code line cannot
      // finish in the current chunk but fits a fresh one, close/reopen now
      // instead of splitting the line across two cards.
      const freshAvailable = limit - utf16Length(`${fenceOpener}\n`) - utf16Length(fenceDelimiter) - 1;
      if (utf16Length(remaining) > available && utf16Length(remaining) <= freshAvailable) {
        closeAndReopenFence();
        continue;
      }
      if (utf16Length(remaining) <= available) {
        current += remaining;
        return;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      if (utf16Length(prefix) > available) {
        throw new RangeError("limit is too small to safely encode this message chunk");
      }
      current += prefix;
      remaining = remaining.slice(prefix.length);
      closeAndReopenFence();
    }
  };

  const appendPlain = (segment: string) => {
    let remaining = segment;
    while (remaining) {
      const available = Math.max(1, limit - utf16Length(current));
      if (utf16Length(remaining) <= available) {
        current += remaining;
        return;
      }
      // Prefer breaking at the line boundary we are already on: push the
      // partially-filled chunk and let this line start the next one. Splitting
      // mid-line/mid-word is reserved for a single line that alone exceeds the
      // limit (v0.1.203's fence-safe rewrite dropped this preference and long
      // prose started splitting inside words on both channels).
      if (current) {
        pushCurrent();
        continue;
      }
      const prefix = takeSafePrefixByUnits(remaining, available);
      if (utf16Length(prefix) > available) {
        throw new RangeError("limit is too small to safely encode this message chunk");
      }
      current += prefix;
      pushCurrent();
      remaining = remaining.slice(prefix.length);
    }
  };

  for (const segment of splitLineSegments(text)) {
    const lineWithoutNewline = segment.replace(/\r?\n$/, "");
    const trimmedLine = lineWithoutNewline.trimStart();
    const openingFence = !inFence ? trimmedLine.match(/^(`{3,}|~{3,})/)?.[1] : undefined;
    const closingFence = inFence ? trimmedLine.match(/^(`{3,}|~{3,})\s*$/)?.[1] : undefined;
    const closesFence = closingFence !== undefined &&
      closingFence[0] === fenceDelimiter[0] &&
      closingFence.length >= fenceDelimiter.length;

    if (openingFence !== undefined) {
      const delimiter = openingFence;
      const suffix = `${segment.endsWith("\n") ? "" : "\n"}${delimiter}`;
      if (current && utf16Length(current) + utf16Length(segment) + utf16Length(suffix) > limit) {
        pushCurrent();
      }
      if (utf16Length(segment) + utf16Length(suffix) > limit) {
        throw new RangeError("limit is too small to safely encode a fenced code block");
      }
      current += segment;
      inFence = true;
      fenceOpener = trimmedLine;
      fenceDelimiter = delimiter;
      continue;
    }

    if (inFence) {
      appendWithinFence(segment, closesFence);
    } else {
      appendPlain(segment);
    }

    if (closesFence) {
      inFence = false;
      fenceOpener = "```";
      fenceDelimiter = "```";
    }
  }

  if (current) {
    if (inFence) {
      const suffix = closeFenceSuffix();
      if (utf16Length(current) + utf16Length(suffix) > limit) {
        throw new RangeError("limit is too small to safely encode a fenced code block");
      }
      current += suffix;
    }
    pushCurrent();
  }

  return chunks;
}
