import { createRoot } from "react-dom/client";
import { MessageContent } from "../../src/Content.js";
import type { HubConnection } from "../../src/connection.js";
import type { DownloadOptions } from "../../src/downloads.js";
import type { Message } from "../../../src/client-protocol/index.js";
import "../../src/styles.css";

// Hold only the disk lookup, not the renderer, to reproduce a busy origin.
const state = { calls: 0, lookups: [] as ((saved: unknown) => void)[] };
Object.assign(window, { cancelFixture: state });
const connection = {
  downloadCheckpoints: { load: () => new Promise((resolve) => state.lookups.push(resolve)) },
  file: (_id: string, options: DownloadOptions) => {
    state.calls++;
    return new Promise<Blob>((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  },
} as unknown as HubConnection;
const message: Message = { id: "file", conversationId: "chat", authorId: "bot", authorType: "bot", version: 1, status: "complete", createdAt: 1,
  blocks: [{ type: "file", attachmentId: "file", name: "cancel.bin", size: 125829120, mime: "application/octet-stream" }] };
createRoot(document.getElementById("root")!).render(<MessageContent message={message} connection={connection}/>);
