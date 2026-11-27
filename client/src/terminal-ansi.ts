export interface AnsiSegment {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
}

interface TextStyle {
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
}

interface StyledCell {
  ch: string;
  color?: string;
  background?: string;
  bold: boolean;
  dim: boolean;
}

const ANSI_FG_COLORS: Record<number, string> = {
  30: "#52525b", 31: "#f87171", 32: "#4ade80", 33: "#facc15",
  34: "#60a5fa", 35: "#c084fc", 36: "#22d3ee", 37: "#e4e4e7",
  90: "#71717a", 91: "#fca5a5", 92: "#86efac", 93: "#fde047",
  94: "#93c5fd", 95: "#d8b4fe", 96: "#67e8f9", 97: "#ffffff",
};

const ANSI_BG_COLORS: Record<number, string> = {
  40: "#27272a", 41: "#7f1d1d", 42: "#14532d", 43: "#713f12",
  44: "#1e3a8a", 45: "#581c87", 46: "#164e63", 47: "#d4d4d8",
  100: "#3f3f46", 101: "#991b1b", 102: "#166534", 103: "#854d0e",
  104: "#1d4ed8", 105: "#6b21a8", 106: "#155e75", 107: "#f4f4f5",
};

const ANSI_256_BASE = [
  "#52525b", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#c084fc", "#22d3ee", "#e4e4e7",
  "#71717a", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#d8b4fe", "#67e8f9", "#ffffff",
];

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function colorFrom256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_256_BASE[index];
  if (index < 232) {
    const offset = index - 16;
    const r = Math.floor(offset / 36);
    const g = Math.floor((offset % 36) / 6);
    const b = offset % 6;
    const toChannel = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${toChannel(r)}, ${toChannel(g)}, ${toChannel(b)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applySgr(rawParams: string, style: TextStyle): void {
  const tokens = rawParams === "" ? ["0"] : rawParams.split(";");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.includes(":")) {
      // ITU T.416 colon-delimited extended color: 38:5:n, 38:2:r:g:b, 38:2::r:g:b (and 48:...)
      const parts = token.split(":");
      const head = Number(parts[0] || "0");
      const mode = Number(parts[1] || "0");
      if (head === 38 || head === 48) {
        let resolved: string | undefined;
        if (mode === 5 && parts.length >= 3) {
          resolved = colorFrom256(Number(parts[2]));
        } else if (mode === 2) {
          const offset = parts.length >= 6 ? 3 : 2;
          if (parts.length >= offset + 3) {
            resolved = `rgb(${clampByte(Number(parts[offset]))}, ${clampByte(Number(parts[offset + 1]))}, ${clampByte(Number(parts[offset + 2]))})`;
          }
        }
        if (resolved) {
          if (head === 38) style.color = resolved;
          else style.background = resolved;
        }
      }
      continue;
    }

    const code = token === "" ? 0 : Number(token);
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      style.color = undefined;
      style.background = undefined;
      style.bold = false;
      style.dim = false;
    } else if (code === 1) {
      style.bold = true;
    } else if (code === 2) {
      style.dim = true;
    } else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 39) {
      style.color = undefined;
    } else if (code === 49) {
      style.background = undefined;
    } else if (code === 38 || code === 48) {
      const mode = Number(tokens[i + 1]);
      if (mode === 5 && i + 2 < tokens.length) {
        const resolved = colorFrom256(Number(tokens[i + 2]));
        if (resolved) {
          if (code === 38) style.color = resolved;
          else style.background = resolved;
        }
        i += 2;
      } else if (mode === 2 && i + 4 < tokens.length) {
        const r = clampByte(Number(tokens[i + 2]));
        const g = clampByte(Number(tokens[i + 3]));
        const b = clampByte(Number(tokens[i + 4]));
        const resolved = `rgb(${r}, ${g}, ${b})`;
        if (code === 38) style.color = resolved;
        else style.background = resolved;
        i += 4;
      } else if (mode === 5 || mode === 2) {
        // Incomplete extended sequence at end of SGR; stop parsing remaining args as standalone codes.
        break;
      }
    } else if (ANSI_FG_COLORS[code]) {
      style.color = ANSI_FG_COLORS[code];
    } else if (ANSI_BG_COLORS[code]) {
      style.background = ANSI_BG_COLORS[code];
    }
  }
}

/**
 * Parse ANSI SGR (16-color, 256-color, 24-bit truecolor) sequences, handle
 * clear-screen, line-erase, iterative backspaces, and carriage-return overwrites,
 * and strip unsupported OSC/DCS/CSI/charset/keypad escape codes safely.
 */
export function parseAnsiOutput(raw: string): AnsiSegment[] {
  // Handle full clear-screen / reset sequences by keeping content after the last full clear
  const clear2J = raw.lastIndexOf("\x1b[2J");
  const clearReset = raw.lastIndexOf("\x1bc");
  const clearIdx = Math.max(clear2J, clearReset);
  const sliced = clearIdx >= 0
    ? raw.slice(clearIdx + (clearIdx === clearReset ? 2 : 4)).replace(/^(?:\x1b\[(?:1;1|;)?H)+/, "")
    : raw;

  // Strip OSC (\x1b]...\x07 or \x1b]...\x1b\\), DCS/SOS/PM/APC (\x1b[PX^_]...\x1b\\),
  // charset designations (\x1b(B, \x1b)0, etc.), and standalone 2-byte ESC controls (\x1b=, \x1b>, etc.).
  const cleaned = sliced
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78DEMHNZc]/g, "")
    .replace(/\r\n/g, "\n");

  const style: TextStyle = { bold: false, dim: false };
  const lines: StyledCell[][] = [[]];
  let currentLine = lines[0]!;
  let cursor = 0;

  const writeText = (text: string) => {
    for (const ch of text) {
      if (ch === "\n") {
        currentLine = [];
        lines.push(currentLine);
        cursor = 0;
      } else if (ch === "\r") {
        cursor = 0;
      } else if (ch === "\x08") {
        if (cursor > 0) {
          if (cursor === currentLine.length) {
            currentLine.pop();
          }
          cursor -= 1;
        }
      } else if (ch === "\x07") {
        // Ignore terminal bell
      } else {
        const cell: StyledCell = {
          ch,
          ...(style.color ? { color: style.color } : {}),
          ...(style.background ? { background: style.background } : {}),
          bold: style.bold,
          dim: style.dim,
        };
        if (cursor < currentLine.length) {
          currentLine[cursor] = cell;
        } else {
          while (currentLine.length < cursor) {
            currentLine.push({ ch: " ", bold: false, dim: false });
          }
          currentLine.push(cell);
        }
        cursor += 1;
      }
    }
  };

  // Match CSI sequences including private mode prefixes (?, >, !, =) and colon sub-parameters
  const csiRegex = /\x1b\[([0-9;:?<=>!]*)([@A-Za-z`~])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = csiRegex.exec(cleaned)) !== null) {
    if (match.index > lastIndex) {
      writeText(cleaned.slice(lastIndex, match.index));
    }
    lastIndex = csiRegex.lastIndex;
    const params = match[1] ?? "";
    const finalByte = match[2]!;
    if (finalByte === "m" && !/[?<=>!]/.test(params)) {
      applySgr(params, style);
    } else if (finalByte === "K" && !/[?<=>!]/.test(params)) {
      const mode = params === "" ? 0 : Number(params);
      if (mode === 0) {
        currentLine.length = cursor;
      } else if (mode === 1) {
        for (let i = 0; i < Math.min(cursor, currentLine.length); i++) {
          currentLine[i] = { ch: " ", bold: false, dim: false };
        }
      } else if (mode === 2) {
        currentLine.length = 0;
        cursor = 0;
      }
    } else if (finalByte === "G" && !/[?<=>!]/.test(params)) {
      const col = Math.max(1, Number(params || "1"));
      if (Number.isFinite(col)) cursor = col - 1;
    } else if (finalByte === "D" && !/[?<=>!]/.test(params)) {
      const delta = Math.max(1, Number(params || "1"));
      if (Number.isFinite(delta)) cursor = Math.max(0, cursor - delta);
    } else if (finalByte === "C" && !/[?<=>!]/.test(params)) {
      const delta = Math.max(1, Number(params || "1"));
      if (Number.isFinite(delta)) cursor += delta;
    }
  }
  if (lastIndex < cleaned.length) {
    writeText(cleaned.slice(lastIndex));
  }

  const segments: AnsiSegment[] = [];
  const pushCell = (cell: StyledCell) => {
    const prev = segments[segments.length - 1];
    if (
      prev
      && prev.color === cell.color
      && prev.background === cell.background
      && Boolean(prev.bold) === cell.bold
      && Boolean(prev.dim) === cell.dim
    ) {
      prev.text += cell.ch;
    } else {
      segments.push({
        text: cell.ch,
        ...(cell.color ? { color: cell.color } : {}),
        ...(cell.background ? { background: cell.background } : {}),
        ...(cell.bold ? { bold: true } : {}),
        ...(cell.dim ? { dim: true } : {}),
      });
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    for (let i = 0; i < line.length; i++) {
      pushCell(line[i]!);
    }
    if (lineIndex < lines.length - 1) {
      const prev = segments[segments.length - 1];
      if (prev && !prev.color && !prev.background && !prev.bold && !prev.dim) {
        prev.text += "\n";
      } else {
        segments.push({ text: "\n" });
      }
    }
  }
  return segments;
}
