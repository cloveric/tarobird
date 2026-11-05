// Isolated native fixture: the real shared viewer, no Host, accounts or messages.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { LocalImagePreview } from "../../src/LocalImagePreview.js";
import { AttachmentDraft } from "../../src/AttachmentDraft.js";
import { MobileViewport } from "../../src/MobileViewport.js";
import { restoreAppearance } from "../../src/appearance.js";
import { installFocusIntent } from "../../src/focus-intent.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/safe-area.css";
import "../../src/viewport.css";
import "../../src/message-images.css";

const image = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#53756b"/><circle cx="800" cy="450" r="300" fill="#dfb788"/><path d="M0 450H1600M800 0V900" stroke="#fff" stroke-width="6"/></svg>'], { type: "image/svg+xml" });
function PhoneReader() {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const addDraft = () => {
    const canvas = document.createElement("canvas"); canvas.width = 1440; canvas.height = 3168;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4b9d70"; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#dfb788"; context.fillRect(0, 0, canvas.width, 700);
    canvas.toBlob(blob => { if (blob) setFiles([new File([blob], "draft-photo.jpg", { type: "image/jpeg" })]); }, "image/jpeg", .9);
  };
  return <><MobileViewport/><main style={{ padding: 32 }}><button id="open-reader" onClick={() => setOpen(true)}>打开验收图片</button>
    <button id="add-draft" onClick={addDraft}>添加验收附件</button></main>
    {files.length > 0 && <AttachmentDraft files={files} add={addDraft} remove={() => setFiles([])} busy={false}/>}
    {open && <LocalImagePreview blob={image} name="图片全屏验收" close={() => setOpen(false)} save={() => {}}/>}</>;
}
restoreAppearance();
installFocusIntent();
createRoot(document.getElementById("root")!).render(<PhoneReader/>);
