// Documentation fixture: production viewer, simulated IPC and a synthetic App
// screenshot as the video source. Never captures a desktop or sends OS input.
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { RemoteScreenPanel } from "../../src/RemoteScreenPanel.js";
import type { HubConnection } from "../../src/connection.js";
import { setLocale } from "../../src/i18n.js";
import { writeScreenFrame } from "../../../src/client-protocol/screen-wire.js";
import "../../src/styles.css";
import "../../src/brand-theme.css";
import "../../src/palette-tokens.css";
import "../../src/side-conversation.css";

const fixture = (window as unknown as { readmeScreen: { locale: "zh" | "en"; image: string } }).readmeScreen;
setLocale(fixture.locale);
Object.assign(document.documentElement.dataset, { theme: "light", palette: "mono", monoAccent: "warm-gray" });
const sample = new Image(); sample.src = fixture.image; await sample.decode();
const width = Math.round(sample.naturalWidth / 2), height = Math.round(sample.naturalHeight / 2);
const frameCanvas = document.createElement("canvas"); frameCanvas.width = width; frameCanvas.height = height;
frameCanvas.getContext("2d")!.drawImage(sample, 0, 0, width, height);
class Decoder {
 static async isConfigSupported(config: unknown) { return { supported: true, config }; }
 state = "unconfigured";
 constructor(private readonly handlers: { output: (frame: VideoFrame) => void }) {}
 configure() { this.state = "configured"; }
 close() { this.state = "closed"; }
 decode(chunk: EncodedVideoChunk) { queueMicrotask(() => { if (this.state === "configured") this.handlers.output(new VideoFrame(frameCanvas, { timestamp: chunk.timestamp })); }); }
}
Object.defineProperty(window, "VideoDecoder", { value: Decoder });
const display = { id: "demo-display", nativeId: "1", name: fixture.locale === "zh" ? "演示显示器" : "Demo display", revision: 1, x: 0, y: 0, width, height, scale: 1, rotation: 0 };
const session = { id: "screen_readme", desktopId: "desktop_demo", deviceId: "readme_viewer", deviceName: "Demo viewer", generation: "readme_generation", display, controlAllowed: true, state: "viewing", createdAt: Date.now() };
let port: MessagePort, sequence = 0, generation = 1, timer: number, active = false, pending = false;
const frame = () => { if (active) port.postMessage(writeScreenFrame({ key: true, codec: "vp8", sequence: ++sequence, geometryRevision: 1, streamGeneration: generation, captureMs: Date.now(), width, height }, new Uint8Array([1,2,3])).buffer); };
const stream = () => { port.postMessage({ type: "stream", streamGeneration: generation, geometryRevision: 1, codec: "vp8", codecString: "vp8", width, height, contentRect: { x: 0, y: 0, width, height } }); frame(); };
const status = (controlling = false) => port.postMessage({ type: "state", session: { ...session, state: controlling ? "controlling" : "viewing" }, streamGeneration: generation, serverTime: Date.now(), ...(controlling ? { lease: { id: "l".repeat(43), expiresAt: Date.now() + 6000, challenge: "c".repeat(43), challengeExpiresAt: Date.now() + 3000 } } : {}) });
window.tarobotDesktop = {
 version: 1, engine: "electron", platform: "darwin", on: () => () => {}, openSocket: async () => {},
 invoke: async (command: string, args: { channelId: string }) => {
  if (command === "desktop_window_read") return { fullscreen: false, fullscreenTransitioning: false };
  if (command === "screen_viewer_open") {
   const channel = new MessageChannel(); port = channel.port1; active = true;
   port.onmessage = ({ data }) => {
    if (data.type === "ack") { port.postMessage({ type: "frame-ready", sessionId: session.id, generation: session.generation, streamGeneration: generation, frameSequence: data.frameSequence, expiresAt: Date.now() + 2000 }); if (pending) { pending = false; status(true); } }
    else if (data.type === "control") { pending = true; generation++; stream(); }
    else if (data.type === "release") status();
    else if (data.type === "visibility") { active = data.visible; if (active) stream(); }
    else if (data.type === "disconnect") active = false;
   };
   window.postMessage({ type: "tarobot:screen-port:v1", channelId: args.channelId, sessionId: session.id }, location.origin, [channel.port2]);
   setTimeout(() => { status(); stream(); }, 20); timer = window.setInterval(frame, 500); return { sessionId: session.id };
  }
  if (command === "screen_viewer_close") { active = false; clearInterval(timer); port?.close(); }
  return null;
 },
} as unknown as NonNullable<Window["tarobotDesktop"]>;
const connection = {
 state: { screenAvailable: true, screenQualityAvailable: true }, identity: { hubPublicKey: "readme_fixture" },
 screenStatus: async () => ({ supported: true, enabled: true, canManage: false, permission: "control", desktop: { desktopId: session.desktopId, instanceId: "demo", loginSession: "demo", platform: "macos", capture: "granted", accessibility: true, locked: false, displays: [display] }, sessions: [], serverTime: Date.now() }),
 screenOpen: async (input: { quality?: string }) => ({ join: { quality: input.quality, session, controlTicket: "a".repeat(43), mediaTicket: "b".repeat(43), expiresAt: Date.now() + 30000, serverTime: Date.now() }, network: { url: "https://example.invalid", publicKey: "demo" } }),
 screenStop: async () => { active = false; clearInterval(timer); },
} as unknown as HubConnection;
function App() {
 const dialog = useRef<HTMLDialogElement>(null);
 useEffect(() => { dialog.current?.showModal(); }, []);
 return <dialog ref={dialog} className="preferences-dialog is-movable settings-detail connection-dialog screen-connection-dialog"><RemoteScreenPanel connection={connection} hostName={fixture.locale === "zh" ? "演示工作室" : "Demo Studio"} visible standalone close={() => dialog.current?.close()}/></dialog>;
}
createRoot(document.getElementById("root")!).render(<App/>);
