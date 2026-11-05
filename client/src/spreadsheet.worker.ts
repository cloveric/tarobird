import { spreadsheetReader } from "./spreadsheet-data.js";
let reader: ReturnType<typeof spreadsheetReader> | undefined;
self.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; sheet?: number; row?: number; column?: number }>) => {
  try {
    if (event.data.bytes) reader = spreadsheetReader(new Uint8Array(event.data.bytes));
    if (!reader) throw new Error("invalid");
    self.postMessage({ page: reader(event.data.sheet, event.data.row, event.data.column) });
  } catch (error) { self.postMessage({ error: error instanceof Error && error.message === "large" ? "large" : "invalid" }); }
};
