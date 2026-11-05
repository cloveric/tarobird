import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "../../src/MarkdownText.js";
import "../../src/styles.css";

const probe = document.documentElement.dataset.probeBase!;
function Fixture() {
  const [text, setText] = useState(`## Content check\n\n![外部图表](${probe}/tracking-image.png)\n\n![Invalid](javascript:alert%281%29)\n\n$E=mc^2$\n\n\`\`\`js\nconst ready = true;\n\`\`\``);
  const [events, setEvents] = useState<string[]>([]), [image, setImage] = useState(false), [request, setRequest] = useState("Not requested"), [blob, setBlob] = useState<string>();
  useEffect(() => {
    const report = (event: SecurityPolicyViolationEvent) => setEvents(old => [...old, event.effectiveDirective]);
    document.addEventListener("securitypolicyviolation", report);
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="), ch => ch.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([png], { type: "image/png" })); setBlob(url);
    return () => { URL.revokeObjectURL(url); document.removeEventListener("securitypolicyviolation", report); };
  }, []);
  return <main style={{ maxWidth: 700, margin: "24px auto", padding: 20 }}>
    <h1>Mobile content policy check</h1>
    <label>Message text<textarea aria-label="Message text" value={text} onChange={event => setText(event.target.value)} rows={5}/></label>
    <MarkdownText text={text}/>
    <p>Local preview: <img src={blob} alt="Allowed local preview" width="32" height="32"/></p>
    <button onClick={() => setImage(true)}>Try external image</button>
    <button onClick={() => { void fetch(`${probe}/request`).then(() => setRequest("Request succeeded"), () => setRequest("Request blocked")); }}>Try external request</button>
    {image && <img src={`${probe}/passive-image.png`} alt="Policy image probe"/>}
    <p><output aria-label="Request result">{request}</output></p>
    <p><output aria-label="Policy events">{events.join(", ") || "No violations"}</output></p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
