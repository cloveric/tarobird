import { describe, expect, it } from "vitest";
import { DesignShareClient, joinDesignShare, type DesignShareTransport } from "../src/workbench-design-collaboration.js";
import { designTextFile, emptyDesign, type DesignDocument } from "../src/workbench-design.js";
import type { DesignShareServerFrame } from "../../src/client-protocol/workbench-design-sharing.js";

const shareId = `ds_${"d".repeat(24)}`, path = "project/note.txt";
function fixture() {
  let current: DesignDocument = emptyDesign("freshness");
  let receive: (frame: DesignShareServerFrame) => void = () => {};
  let wanted: string | undefined, held: (() => void) | undefined, onHold: (() => void) | undefined;
  const reply = (requestId: string, result: unknown) => receive({ v: 1, type: "design.share.result", requestId, ok: true, result } as DesignShareServerFrame);
  const transport: DesignShareTransport = {
    onFrame(listener) { receive = listener; return () => {}; },
    send(frame) {
      const request = frame.request;
      let result: unknown;
      if (request.op === "join") result = { role: "editor", sourceOnline: true };
      else if (request.op === "leave") result = {};
      else if (request.op === "call" && request.call === "list") result = { id: current.id, format: "canvas", revision: current.revision,
        files: Object.fromEntries(Object.entries(current.files).map(([key, { sha256, size, contentType }]) => [key, { sha256, size, contentType }])) };
      else if (request.op === "fetch") {
        const file = Object.values(current.files).find(item => item.sha256 === request.sha256);
        if (!file) throw new Error("source holds only active files");
        result = { offset: 0, base64: file.base64, eof: true };
        // Source already read the bytes; its reply may arrive after the next change event.
        if (request.sha256 === wanted) { wanted = undefined; held = () => reply(frame.requestId, result); onHold?.(); return; }
      } else throw new Error(`unexpected ${request.op}`);
      queueMicrotask(() => reply(frame.requestId, result));
    },
  };
  return {
    client: new DesignShareClient(transport, 2_000),
    install(text: string) { const file = designTextFile(text); current = { ...current, revision: current.revision + 1, files: { ...current.files, [path]: file } }; return file.sha256; },
    changed() { receive({ v: 1, type: "design.share.event", shareId, generation: 1, event: { type: "changed", revision: current.revision, files: { [path]: current.files[path].sha256 } } } as DesignShareServerFrame); },
    revoke() { receive({ v: 1, type: "design.share.event", shareId, generation: 2, event: { type: "revoked" } } as DesignShareServerFrame); },
    hold(sha: string) { wanted = sha; return new Promise<void>(resolve => { onHold = resolve; }); },
    release() { held?.(); held = undefined; },
  };
}

describe("shared Design manifest freshness", () => {
  it("does not clear a newer change notification when an older file fetch completes", async () => {
    const f = fixture(); f.install("initial");
    const mirror = await joinDesignShare(f.client, { shareId, windowId: "w", user: () => ({ id: "guest", name: "Guest" }) });
    try {
      const older = f.install("first remote edit"), fetching = f.hold(older); f.changed(); await fetching;
      const newest = f.install("second remote edit"); f.changed(); f.release();
      await mirror.session.flush();
      expect(mirror.session.document.files[path].sha256).toBe(newest);
    } finally { await mirror.leave({ discard: true }); f.client.dispose(); }
  });
  it("observes source changes that arrive while the first joined snapshot is loading", async () => {
    const f = fixture(), old = f.install("initial"), fetching = f.hold(old);
    const joining = joinDesignShare(f.client, { shareId, windowId: "w", user: () => ({ id: "guest", name: "Guest" }) });
    await fetching;
    const newest = f.install("edit during join"); f.changed(); f.release();
    const mirror = await joining;
    try { await mirror.session.flush(); expect(mirror.session.document.files[path].sha256).toBe(newest); }
    finally { await mirror.leave({ discard: true }); f.client.dispose(); }
  });
  it("does not return an editable joined copy after revocation during its initial fetch", async () => {
    const f = fixture(), old = f.install("initial"), fetching = f.hold(old);
    const joining = joinDesignShare(f.client, { shareId, windowId: "w", user: () => ({ id: "guest", name: "Guest" }) });
    const outcome = joining.then(mirror => ({ mirror }), (error: Error) => ({ error: error.message }));
    await fetching; f.revoke(); f.release();
    const result = await outcome;
    try { expect(result).toEqual({ error: "design_share_revoked" }); }
    finally { if ("mirror" in result) await result.mirror.leave({ discard: true }); f.client.dispose(); }
  });
});
