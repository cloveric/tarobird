import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "../../src/MarkdownText.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
type Row = { id: string; text: string };
function Fixture() {
  const [rows, setRows] = useState<Row[]>([]);
  Object.assign(window, { setMarkdownRows: setRows });
  return <>{rows.map(row => <article key={row.id} data-message={row.id}><MarkdownText text={row.text}/></article>)}</>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture/></StrictMode>);
