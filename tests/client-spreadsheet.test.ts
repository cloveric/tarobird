import { describe, it, expect } from "vitest";
import { utils, write } from "../client/node_modules/xlsx/xlsx.mjs";
import { zipSync, strToU8 } from "../client/node_modules/fflate/esm/browser.js";
import { spreadsheetReader } from "../client/src/spreadsheet-data.js";
function sample(bookType: "xlsx" | "xls" = "xlsx") {
  const book = utils.book_new(), sheet = utils.aoa_to_sheet([["分类账本", "", ""], ["项目", "日期", "金额"], ["交通", 45942, 1234.5], ["合计", "", 1234.5]]);
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  sheet.B3.z = "yyyy-mm-dd"; sheet.C3.z = '"¥"#,##0.00'; sheet.C4.f = "SUM(C3:C3)";
  sheet.A5 = { t: "s", v: '<img src=x onerror="alert(1)">' }; sheet["!ref"] = "A1:C5";
  utils.book_append_sheet(book, sheet, "明细"); utils.book_append_sheet(book, utils.aoa_to_sheet([["第二张表"]]), "汇总");
  return new Uint8Array(write(book, { bookType, type: "buffer" }));
}
describe("Excel local read-only previews", () => {
  for (const format of ["xlsx", "xls"] as const) it(`reads ${format} sheets, merged headings, dates, money and cached formulas`, () => {
    const reader = spreadsheetReader(sample(format)); const page = reader();
    expect(page.names).toEqual(["明细", "汇总"]);
    expect(page.cells[0][0]).toMatchObject({ text: "分类账本", colSpan: 3 }); expect(page.cells[0][1].covered).toBe(true);
    expect(page.cells[2][1].text).toMatch(/^2025-\d\d-\d\d$/); expect(page.cells[2][2].text).toBe("¥1,234.50");
    expect(page.cells[3][2].text).toBe("1234.5"); expect(page.cells[4][0].text).toContain("<img");
    expect(reader(1).cells[0][0].text).toBe("第二张表"); expect(reader(0).cells[2][0].text).toBe("交通");
  });
  it("pages sparse wide data, bounds misleading dimensions, and distinguishes formulas without cached results", () => {
    const book = utils.book_new(), sheet = utils.aoa_to_sheet([["first"]]);
    sheet.A101 = { t: "s", v: "page two" }; sheet.AA101 = { t: "s", v: "next columns" }; sheet.B1 = { t: "n", f: "SUM(C1:D1)" };
    sheet.A5001 = { t: "s", v: "beyond preview" }; sheet["!ref"] = "A1:ZZ5001";
    utils.book_append_sheet(book, sheet, "分页");
    const read = spreadsheetReader(new Uint8Array(write(book, { bookType: "xlsx", type: "buffer" })));
    expect(read().formulaOnly).toBe(true); expect(read().cells[0][1].text).toBe("=SUM(C1:D1)");
    expect(read(0,1).cells[0][0].text).toBe("page two"); expect(read(0,1,1).cells[0][0].text).toBe("next columns");
    expect(read().limited).toBe(true); expect(read(0,999,999)).toMatchObject({ row: 49, column: 7, rows: 5000, columns: 200 });
    expect(() => read(500)).toThrow("invalid");
  });
  it("rejects non-Excel input, encrypted compound containers and oversized ZIP expansion", () => {
    for (const bytes of [strToU8("not Excel"), new Uint8Array(10*1024*1024+1), zipSync({ "note.txt": strToU8("hello") }), new Uint8Array([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])]) expect(() => spreadsheetReader(bytes)).toThrow();
    expect(() => spreadsheetReader(zipSync({ "xl/workbook.xml": new Uint8Array(17*1024*1024), "[Content_Types].xml": strToU8("x") }))).toThrow("large");
  });
});
