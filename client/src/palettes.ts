// Classic colour direction: Opus 5.5, design/color-palettes/2026-10-03.
// Pure-white palettes include monochrome and five Porcelain accents.
export const colorPalettes = [
  { id: "cli", name: "终端 CLI", description: "等宽 · 命令行转录", family: "expressive" },
  {
    "id": "mono",
    "name": "黑白",
    "description": "纯白 · 墨黑",
    "family": "white"
  },
  {
    "id": "white-blue",
    "name": "白瓷蓝",
    "description": "纯白 · 晴空蓝",
    "family": "white"
  },
  {
    "id": "white-green",
    "name": "白瓷绿",
    "description": "纯白 · 翡翠绿",
    "family": "white"
  },
  {
    "id": "white-violet",
    "name": "白瓷紫",
    "description": "纯白 · 鸢尾紫",
    "family": "white"
  },
  {
    "id": "white-rose",
    "name": "白瓷玫",
    "description": "纯白 · 玫瑰红",
    "family": "white"
  },
  {
    "id": "white-orange",
    "name": "白瓷橙",
    "description": "纯白 · 琥珀橙",
    "family": "white"
  },
  {
    "id": "sage",
    "name": "松绿",
    "description": "鼠尾草 · 松石青",
    "family": "classic"
  },
  {
    "id": "ocean",
    "name": "海雾",
    "description": "石板灰 · 雾蓝",
    "family": "classic"
  },
] as const;
export type ColorPalette = typeof colorPalettes[number]["id"];
export const DEFAULT_PALETTE: ColorPalette = "mono";
export const DEFAULT_THEME = "light" as const;

/** Monochrome only: one muted colour for the marks in Bot replies (list dots,
 * numbers, links, quote rule and divider), working indicators, and light-mode
 * solid black controls. Reports/widgets use coordinated data tones; "none"
 * keeps their data grayscale. */
export const monoAccents = [
  { id: "none", name: "不使用", color: null },
  { id: "graphite", name: "石墨灰", color: "#8e8e8e" },
  { id: "warm-gray", name: "浅暖灰", color: "#e7e2dc" },
  { id: "mist", name: "雾蓝", color: "#7d8ea3" },
  { id: "sage", name: "鼠尾草绿", color: "#dce4d6" },
  { id: "rose", name: "藕粉", color: "#b8958d" },
  { id: "oat", name: "燕麦", color: "#ab9a7f" },
  { id: "mauve", name: "灰紫", color: "#988ea8" },
] as const;
export type MonoAccent = typeof monoAccents[number]["id"];
export const DEFAULT_MONO_ACCENT: MonoAccent = "warm-gray";
export function isMonoAccent(value: unknown): value is MonoAccent { return monoAccents.some((accent) => accent.id === value); }
export function isColorPalette(value: unknown): value is ColorPalette { return colorPalettes.some((palette) => palette.id === value); }
