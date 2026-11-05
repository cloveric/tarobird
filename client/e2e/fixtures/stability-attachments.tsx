import { createRoot } from "react-dom/client";
import { AttachmentImage } from "../../src/AttachmentImage.js";
import { LinkPreviewCard } from "../../src/LinkPreview.js";
import { multipleHosts } from "./multiple-hosts.js";
import "../../src/styles.css";
import "../../src/message-images.css";
const container = document.createElement("main"); document.body.append(container);
const root = createRoot(container);
const evidence = { active: 0, peak: 0, started: 0, finished: 0 };
const fixture = {
  evidence,
  observe(host: string) {
    const connection = multipleHosts.connections.get(host)!, read = connection.readAttachment.bind(connection);
    connection.readAttachment = async (...args) => {
      evidence.active++; evidence.started++; evidence.peak = Math.max(evidence.peak, evidence.active);
      try { return await read(...args); } finally { evidence.active--; evidence.finished++; }
    };
  },
  render(host: string, ids: string[]) {
    const connection = multipleHosts.connections.get(host)!;
    root.render(<div className="image-grid">{ids.map((id, index) => <AttachmentImage key={`${id}:${index}`} connection={connection} id={id} title={`Image ${index + 1}`}/>)}</div>);
  },
  renderLink(host: string, id: string) {
    root.render(<LinkPreviewCard connection={multipleHosts.connections.get(host)!} url="https://example.org/" preview={{ url: "https://example.org/", status: "ready", title: "Link cover", siteName: "Example", imageAttachmentId: id }}/>);
  },
};
Object.assign(window, { attachmentStability: fixture });
