import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "../../src/MarkdownText.js";
import "../../src/styles.css";
import "katex/dist/katex.min.css";
function Fixture() {
  const [text, setText] = useState("start"), [key, setKey] = useState(0);
  Object.assign(window, { setMarkdown: setText, remountMarkdown: (value: string) => { setKey((k) => k + 1); setText(value); } });
  return <MarkdownText key={key} text={text}/>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture/></StrictMode>);
