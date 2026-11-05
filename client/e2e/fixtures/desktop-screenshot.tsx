import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/mobile-shell.css";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { ComposerAttachmentButton, useAttachmentPicker } from "../../src/AttachmentPicker.js";
import { AttachmentDraft } from "../../src/AttachmentDraft.js";
import { setLocale, useLocale, t } from "../../src/i18n.js";
document.documentElement.dataset.palette = "mono";
Object.assign(window, { isTauri: true });
let finish: (result: string | null) => void, reject: (error: string) => void;
const calls: unknown[] = [];
const invoke = (command: string, args: unknown) => {
  if (command !== "capture_screenshot") throw new Error(`unexpected_${command}`);
  calls.push(args);
  return new Promise<string | null>((resolve, fail) => { finish = resolve; reject = fail; });
};
if (new URL(location.href).searchParams.get('engine') === 'electron') {
  Object.assign(window, { tarobotDesktop: { version: 1, engine: 'electron', platform: 'darwin', invoke,
    on: () => () => {}, openSocket: () => Promise.reject(new Error('unused_socket')) } });
} else mockIPC(invoke);
function Fixture() {
  useLocale();
  const [scope, setScope] = useState("A"), [hostActive, setHostActive] = useState(true), [active, setActive] = useState(true);
  const [phone, setPhone] = useState(false), [disabled, setDisabled] = useState(false), [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]), [draft, setDraft] = useState(""), [sent, setSent] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const settle = () => { if (!phone) requestAnimationFrame(() => input.current?.focus({ preventScroll: true })); };
  const picker = useAttachmentPicker({ scope, hostActive, active, phone, disabled, add: more => setFiles(old => [...old, ...more]), fail: setError, settle });
  Object.assign(window, { screenshotFixture: { setScope, setHostActive, setActive, setPhone, setDisabled, setLocale, calls,
    finish: (value: string | null) => finish(value), fail: (error: string) => reject(error),
    files: async () => Promise.all(files.map(async f => ({ name: f.name, type: f.type, data: Array.from(new Uint8Array(await f.arrayBuffer())) }))) } });
  return <main data-scope={scope} data-host-active={String(hostActive)} data-active={String(active)} className="conversation-main" style={{ height: "100dvh", padding: 24 }}>
    <h1>Screenshot fixture · {scope}</h1><p>Only the operating system boundary is mocked.</p>
    <div style={{ flex: 1 }}/>
    {error && <p role="alert">{error}</p>}
    <output aria-label="Sent messages">{sent}</output>
    <div className="composer-wrap"><div className="composer">
      {!!files.length && <AttachmentDraft files={files} busy={disabled} add={picker.show} remove={i => setFiles(old => old.filter((_, n) => n !== i))}/>}
      <textarea ref={input} aria-label="Message" value={draft} onChange={e => setDraft(e.target.value)}/>
      <div className="composer-toolbar"><ComposerAttachmentButton picker={picker} label="Attach" disabled={disabled}/><button onClick={() => { setSent(n => n + 1); setFiles([]); setDraft(""); }}>Send</button></div>
    </div></div>{picker.input}{picker.sheet}
  </main>;
}
createRoot(document.getElementById("root")!).render(<StrictMode><Fixture/></StrictMode>);
