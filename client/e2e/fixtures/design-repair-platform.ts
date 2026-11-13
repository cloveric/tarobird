import { Capacitor } from "@capacitor/core";
import { designFrame } from "../../src/design-frame.js";
import { DesignSession } from "../../src/workbench-design-session.js";
import { emptyDesignDocument, designTextFile } from "../../src/workbench-design.js";
import type { DesignCommentsDoc } from "../../src/workbench-design-comments.js";

// Real editor/frame adapter over in-memory persistence. No pairing or CryptoKey
// storage: this isolates platform presentation, not native App acceptance.
const query = new URLSearchParams(location.search);
Capacitor.getPlatform = () => query.get("platform") ?? "web";
const format = query.get("format") === "slides" ? "slides" : "canvas";
let document = emptyDesignDocument("platform-fixture", "Platform review", format);
const file = query.has("index") ? "project/canvas.json" : format === "canvas" ? "project/Main.dc.html" : "project/slides/cover.html";
const contentType = query.has("index") ? "application/json" : "text/html";
const original = new TextDecoder().decode(Uint8Array.from(atob(document.files[file]!.base64), c => c.charCodeAt(0)));
document.files[file] = designTextFile(query.has("index") ? "{" : format === "canvas"
  ? original.replace("class Component extends DCLogic {}", 'class Component extends DCLogic { renderVals() { throw new Error("PLATFORM_REPAIR_FIXTURE"); } }')
  : "<div>Broken slide fixture</div>", contentType);
let comments: DesignCommentsDoc | undefined;
const fixture = { drafts: 0, session: undefined as DesignSession | undefined, frame: undefined as ReturnType<typeof designFrame> | undefined };
const session = new DesignSession(document, async () => structuredClone(document), async (expected, next) => {
  if (expected !== document.revision) throw new Error("design_revision_conflict");
  document = structuredClone(next);
}, () => {}, {
  title: () => "Platform review", user: () => ({ id: "owner", name: "Owner" }),
  comments: { load: async () => comments, save: async (_expected, next) => { comments = next; } },
  sendToBot: async draft => {
    fixture.drafts++;
    window.document.querySelector<HTMLTextAreaElement>("textarea")!.value += "\n" + draft.text;
    return "opened";
  },
});
const frame = designFrame(session);
frame.attach(window.document.getElementById("editor")!, () => {}, () => {});
Object.assign(fixture, { session, frame, restore: () => session.request("publish", { files: { [file]: { base64: designTextFile(original, contentType).base64, contentType, ifMatch: session.document.files[file]!.sha256 } } }) });
Object.assign(window, { repairPlatform: fixture });
