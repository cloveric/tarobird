import { read, utils, type WorkBook, type WorkSheet } from "xlsx";
import { boundedOfficeArchive, DOCX_MAX_BYTES } from "./docx-archive.js";

export const SHEET_ROWS = 100, SHEET_COLUMNS = 26;
const MAX_ROWS = 5000, MAX_COLUMNS = 200;
export type SheetPage = {
  sheet: number; names: string[]; row: number; column: number; rows: number; columns: number;
  startRow: number; startColumn: number; limited: boolean; formulaOnly: boolean;
  cells: { text: string; numeric: boolean; formula: boolean; rowSpan?: number; colSpan?: number; covered?: boolean }[][];
};
/** Local, read-only conversion. Never create HTML, follow links, run formulas or
 * load embedded objects. ZIP expansion is bounded before SheetJS sees it. */
export function spreadsheetReader(input: Uint8Array) {
  if (input.byteLength > DOCX_MAX_BYTES) throw new Error("large");
  const zip = input[0] === 0x50 && input[1] === 0x4b;
  const compound = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((v, i) => input[i] === v);
  if (!zip && !compound) throw new Error("invalid");
  const bytes = zip ? new Uint8Array(boundedOfficeArchive(input, "xl/workbook.xml")) : input;
  const options = { type: "array" as const, dense: true, cellHTML: false, cellFormula: true, cellText: true, bookVBA: false, bookFiles: false, sheetRows: MAX_ROWS + 1 };
  const index = read(bytes, { ...options, bookSheets: true });
  const names = index.SheetNames;
  if (!names.length || names.length > 100) throw new Error("large");
  let selected = -1, workbook: WorkBook, sheet: WorkSheet;
  return (sheetIndex = 0, rowPage = 0, columnPage = 0): SheetPage => {
    if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= names.length) throw new Error("invalid");
    if (selected !== sheetIndex) {
      workbook = read(bytes, { ...options, sheets: sheetIndex });
      sheet = workbook.Sheets[names[sheetIndex]]!; selected = sheetIndex;
      if (!sheet) throw new Error("invalid");
    }
    const range = utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
    const startRow = Math.min(range.s.r, MAX_ROWS - 1), startColumn = Math.min(range.s.c, MAX_COLUMNS - 1);
    const rows = Math.max(1, Math.min(range.e.r + 1, MAX_ROWS) - startRow), columns = Math.max(1, Math.min(range.e.c + 1, MAX_COLUMNS) - startColumn);
    const row = Math.min(Math.max(0, Math.floor(rowPage) || 0), Math.ceil(rows / SHEET_ROWS) - 1), column = Math.min(Math.max(0, Math.floor(columnPage) || 0), Math.ceil(columns / SHEET_COLUMNS) - 1);
    const r0 = startRow + row * SHEET_ROWS, c0 = startColumn + column * SHEET_COLUMNS;
    const height = Math.min(SHEET_ROWS, rows - row * SHEET_ROWS), width = Math.min(SHEET_COLUMNS, columns - column * SHEET_COLUMNS);
    let formulaOnly = false;
    const cells: SheetPage["cells"] = Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => {
      const cell = sheet["!data"]?.[r0 + r]?.[c0 + c];
      const formula = !!cell?.f && (cell.v === undefined || cell.v === null);
      formulaOnly ||= formula;
      const text = formula ? `=${cell.f}` : cell ? String(cell.w ?? (cell.v == null ? "" : utils.format_cell(cell))) : "";
      return { text: text.length > 4000 ? text.slice(0, 4000) + "…" : text, numeric: cell?.t === "n", formula };
    }));
    // A merge crossing a page boundary is clipped to this page; repeat its
    // original value so later pages do not appear to have lost their heading.
    for (const merge of (sheet["!merges"] ?? []).slice(0, 2000)) {
      const top = Math.max(merge.s.r, r0), left = Math.max(merge.s.c, c0), bottom = Math.min(merge.e.r, r0 + height - 1), right = Math.min(merge.e.c, c0 + width - 1);
      if (top > bottom || left > right) continue;
      const original = sheet["!data"]?.[merge.s.r]?.[merge.s.c];
      const first = cells[top-r0][left-c0];
      first.text = String(original?.w ?? (original ? utils.format_cell(original) : "")).slice(0, 4000);
      first.rowSpan = bottom-top+1; first.colSpan = right-left+1;
      for (let r = top; r <= bottom; r++) for (let c = left; c <= right; c++) if (r !== top || c !== left) cells[r-r0][c-c0].covered = true;
    }
    return { sheet: sheetIndex, names, row, column, rows, columns, startRow, startColumn, cells, formulaOnly, limited: range.e.r >= MAX_ROWS || range.e.c >= MAX_COLUMNS || (sheet["!merges"]?.length ?? 0) > 2000 };
  };
}
