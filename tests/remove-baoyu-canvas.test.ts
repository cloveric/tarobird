import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, SERVER_CAPABILITIES } from "../src/client-protocol/index.js";
import {
  WORKBENCH_DESIGN_CAPABILITY,
  WORKBENCH_DESIGN_COMMENTS_CAPABILITY,
  WORKBENCH_DESIGN_HISTORY_CAPABILITY,
  WORKBENCH_DESIGN_OPEN_CAPABILITY,
  WORKBENCH_SLIDES_CAPABILITY,
  workbenchDesignError,
} from "../src/client-protocol/workbench-design.js";
import { workbenchReceiptSchema, type WorkbenchCommandFrame, type WorkbenchRegistration } from "../src/client-protocol/workbench.js";
import { appTurnInstructions } from "../src/gateway/agent-instructions.js";
import { workbenchCanvasRemovedGuidance, workbenchDesignGuidance, workbenchPptRouting } from "../src/gateway/design-guidance.js";
import { HubError, HubStore } from "../src/hub/store.js";
import { WorkbenchBroker, type WorkbenchActor, type WorkbenchPeer } from "../src/hub/workbench.js";
import { DesignShareBroker, metaDesignShareRepository, type DesignSharePeer } from "../src/hub/workbench-design-sharing.js";
import { buildDesignSandbox } from "../client/design-assets.js";
import { WorkbenchController } from "../client/src/workbench-controller.js";
import { emptyDesign, emptySlides, type DesignDocument } from "../client/src/workbench-design.js";
import { createDesignBackup, parseDesignBackup } from "../client/src/workbench-design-backup.js";
import { exportStoredDesign } from "../client/src/workbench-library.js";
import { emptyWorkbench, workbenchScope, type WorkbenchLayout } from "../client/src/workbench-model.js";
import type { HubConnection } from "../client/src/connection.js";

describe("Remove Baoyu Design canvas from Workbench (#89)", () => {
  const controllers: WorkbenchController[] = [];
  afterEach(() => {
    controllers.splice(0).forEach(controller => controller.dispose());
    vi.restoreAllMocks();
  });

  it("rejects format:'canvas' and omitted format on design.create / design.open with design_canvas_removed", () => {
    expect(workbenchDesignError({ operation: "design.create", payload: { format: "canvas" } })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.create", payload: {} })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.open", payload: { format: "canvas" } })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.open", payload: {} })).toBe("design_canvas_removed");
    expect(workbenchDesignError({ operation: "design.create", payload: { format: "slides", title: "Deck" } })).toBeUndefined();
    expect(workbenchDesignError({ operation: "design.open", payload: { format: "slides" } })).toBeUndefined();
  });

  it("retains workbench.design.v1 alongside slides capabilities for cross-version v1.6.0 PPT compatibility", () => {
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(SERVER_CAPABILITIES).toContain(WORKBENCH_DESIGN_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_SLIDES_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_OPEN_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_COMMENTS_CAPABILITY);
    expect(CAPABILITIES).toContain(WORKBENCH_DESIGN_HISTORY_CAPABILITY);
    expect(CAPABILITIES.length).toBeLessThanOrEqual(63);
  });

  it("removes baoyu-design vendor, skill and package.json files entries while keeping the presentation editor", () => {
    expect(existsSync(path.resolve("client/vendor/baoyu-design"))).toBe(false);
    expect(existsSync(path.resolve("skills/baoyu-design"))).toBe(false);
    // #90 replaced the Baoyu slides editor and its skill; the presentation editor that survives is workbench-slides.
    expect(existsSync(path.resolve("client/vendor/workbench-slides/UPSTREAM.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as { files: string[] };
    const skillFiles = pkg.files.filter(entry => entry.startsWith("skills/"));
    expect(skillFiles.some(entry => entry.startsWith("skills/baoyu-design/"))).toBe(false);
    for (const file of skillFiles) expect(existsSync(path.resolve(file)), file).toBe(true);
  });

  it("builds only the slides sandbox and refuses canvas", () => {
    expect(() => buildDesignSandbox("canvas" as never)).toThrow(/design_canvas_removed/);
    const html = buildDesignSandbox("slides");
    expect(html).toContain("<title>Presentation</title>");
  });

  it("injects canvas-removal Bot guidance on canvas-only prompts and keeps PPT guidance intact", () => {
    expect(workbenchDesignGuidance).not.toContain("format:'canvas'");
    expect(workbenchDesignGuidance).not.toContain(".dc.html");
    // Says the canvas was removed and that the user can export a saved project; names no replacement product.
    expect(workbenchDesignGuidance).toContain("explain that the Baoyu Design canvas has been removed; a canvas project already saved in their App can only be exported by the user");
    for (const text of [workbenchDesignGuidance, workbenchPptRouting, workbenchCanvasRemovedGuidance]) expect(text).not.toMatch(/infinite canvas|extension/i);
    expect(workbenchDesignGuidance).toContain("format:'slides'");
    for (const prompt of [
      "请用 Baoyu Design 做一个画布",
      "Please make a canvas with Baoyu Design",
      "用宝玉设计做一个画布",
      "帮我在工作台新建一个画布",
      "Create a Workbench canvas",
    ]) {
      const turn = appTurnInstructions(prompt, { engine: "codex", nativeDelivery: true, nativeWidgets: true });
      expect(turn, prompt).toBeDefined();
      expect(turn, prompt).toContain("tell them the Baoyu Design canvas has been removed from the Workbench.");
      expect(turn, prompt).toContain("the user can export it in the App, from that project's tab or from Settings > Workbench files");
      expect(turn, prompt).not.toMatch(/infinite canvas|extension/i);
      expect(turn, prompt).toContain("design_canvas_removed");
      expect(turn, prompt).not.toContain("PPT selection:");
    }
  });

  it("throws HubError(design_canvas_removed) instead of returning a schema-invalid receipt and preserves New-Host + Old-v1.6.0-App PPT flows", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "remove-canvas-broker-"));
    const store = await HubStore.open(directory);
    const broker = new WorkbenchBroker(store, 1500);
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
      const conversationId = (await store.createConversation("owner", ["bot"], "Mixed", "mixed-conv")).id;
      const commands: WorkbenchCommandFrame[] = [];
      const peer: WorkbenchPeer = { key: {}, userId: "owner", deviceId: "old-app", active: () => true, validate: async () => {}, send: async frame => { if (frame.type === "workbench.command") commands.push(frame); } };
      const actor: WorkbenchActor = { userId: "owner", conversationId, validate: async () => {} };

      // Simulate a v1.6.0 App registering both design.v1 + design.slides.v1 with one slides tab and one legacy canvas tab.
      const v160App: WorkbenchRegistration = {
        windowId: "w-old", generation: "gen", conversationId, visible: true,
        capabilities: ["design.v1", "design.slides.v1", "whiteboard.v1"],
        tabs: [
          { id: "slides-1", kind: "design", designFormat: "slides", title: "Deck", revision: 0 },
          { id: "canvas-1", kind: "design", title: "Legacy Canvas", revision: 0 },
        ],
        activeTabId: "slides-1",
      };
      await broker.register(peer, v160App);

      // Targetless canvas create/open rejects with HubError(400) rather than an invalid receipt.
      for (const req of [
        { requestId: "open-canvas", operation: "design.open", payload: { format: "canvas" } },
        { requestId: "open-default", operation: "design.open", payload: {} },
        { requestId: "create-canvas", operation: "design.create", payload: { format: "canvas" } },
        { requestId: "create-default", operation: "design.create", payload: {} },
      ]) {
        await expect(broker.request(actor, req)).rejects.toMatchObject({ code: "design_canvas_removed", status: 400 });
      }
      // Targeting a legacy canvas tab on the v1.6.0 App also rejects before dispatch.
      await expect(broker.request(actor, { requestId: "read-canvas", operation: "design.read", target: { deviceId: "old-app", windowId: "w-old", tabId: "canvas-1" }, payload: {} })).rejects.toMatchObject({ code: "design_canvas_removed", status: 400 });
      expect(commands).toEqual([]);

      // Slides operations against the same v1.6.0 App still work end-to-end.
      const slidesRead = broker.request(actor, { requestId: "read-slides", operation: "design.read", target: { deviceId: "old-app", windowId: "w-old", tabId: "slides-1" }, payload: {} });
      for (let n = 0; n < 100 && !commands.length; n++) await new Promise(r => setTimeout(r, 5));
      expect(commands).toHaveLength(1);
      const frame = commands.shift()!;
      await broker.admit(peer, frame.dispatchId);
      const receipt = { requestId: "read-slides", target: frame.target, status: "success" as const, revision: 0, result: { files: {} } };
      expect(workbenchReceiptSchema.safeParse(receipt).success).toBe(true);
      await broker.receive(peer, frame.dispatchId, receipt);
      expect(await slidesRead).toMatchObject({ status: "success", target: { tabId: "slides-1" } });
    } finally {
      broker.close();
      await store.db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("negotiates design.v1 conditionally for Old-v1.6.0-Host + New-App and blocks legacy canvas reads/mutations in WorkbenchController", async () => {
    let layout: WorkbenchLayout = {
      ...emptyWorkbench(),
      tabs: [
        { id: "legacy-canvas", kind: "design", title: "Legacy Canvas" },
        { id: "ppt-1", kind: "design", designFormat: "slides", title: "Deck" },
      ],
      visible: ["legacy-canvas"],
      active: "legacy-canvas",
    };
    const designs = new Map<string, DesignDocument>([
      ["legacy-canvas", emptyDesign("legacy-canvas", "Legacy Canvas")],
      ["ppt-1", emptySlides("ppt-1", "Deck")],
    ]);
    const readDesign = vi.fn(async (_scope: string, id: string) => structuredClone(designs.get(id)));
    const saveDesign = vi.fn(async (_scope: string, expected: number, next: DesignDocument) => {
      if ((designs.get(next.id)?.revision ?? -1) !== expected) throw new Error("design_revision_conflict");
      designs.set(next.id, structuredClone(next));
    });
    const frames = new Map<string, WorkbenchCommandFrame>();
    const state: Record<string, unknown> = { status: "online", user: { id: "owner", name: "Owner" }, workbenchAvailable: true, workbenchDesignAvailable: true, workbenchSlidesAvailable: true };
    const connection = {
      identity: { deviceId: "new-app", hubPublicKey: "host" },
      state,
      isClosed: false,
      isReadOnly: false,
      cache: {
        readWorkbench: async () => structuredClone(layout),
        saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => { if (layout.revision !== expected) throw new Error("workbench_revision_conflict"); layout = structuredClone(next); },
        readWorkbenchDesign: readDesign,
        saveWorkbenchDesign: saveDesign,
      },
      subscribe: () => () => undefined,
      conversationRevision: () => 0,
      http: vi.fn(async (_route: string, options: RequestInit) => {
        const frame = frames.get(JSON.parse(String(options.body)).dispatchId)!;
        return { admitted: true, generation: frame.generation, target: frame.target };
      }),
    } as unknown as HubConnection;

    const controller = new WorkbenchController({ connection, conversationId: "conv" });
    controllers.push(controller);
    await controller.initialize();
    controller.setVisible(true);
    await new Promise(r => setTimeout(r, 10));

    // Legacy canvas tab is never loaded into a DesignSession on initialize/setVisible.
    expect(controller.designSession("legacy-canvas")).toBeUndefined();
    expect(readDesign).not.toHaveBeenCalledWith(expect.any(String), "legacy-canvas");

    // Old v1.6.0 Host (design + slides): New App advertises both design.slides.v1 and design.v1, exposing only slides tabs.
    const oldHostReg = controller.getRegistration()!;
    expect(oldHostReg.capabilities).toContain("design.slides.v1");
    expect(oldHostReg.capabilities).toContain("design.v1");
    expect(oldHostReg.tabs.map(t => t.id)).toEqual(["ppt-1"]);
    expect(oldHostReg.activeTabId).toBeUndefined();

    // Pre-slides Host (design only, no slides): New App advertises neither design.v1 nor design.slides.v1.
    state.workbenchSlidesAvailable = false;
    const preSlidesReg = controller.getRegistration()!;
    expect(preSlidesReg.capabilities).not.toContain("design.v1");
    expect(preSlidesReg.capabilities).not.toContain("design.slides.v1");
    expect(preSlidesReg.tabs).toEqual([]);

    // Future slides-only Host (no design.v1): New App advertises design.slides.v1 without design.v1.
    state.workbenchDesignAvailable = false;
    state.workbenchSlidesAvailable = true;
    const slidesOnlyReg = controller.getRegistration()!;
    expect(slidesOnlyReg.capabilities).toContain("design.slides.v1");
    expect(slidesOnlyReg.capabilities).not.toContain("design.v1");

    // Commands targeting the legacy canvas tab reject with design_canvas_removed without reading or mutating IndexedDB.
    const sendCommand = (requestId: string, operation: "design.read" | "design.publish", extra: Record<string, unknown> = {}) => {
      const frame: WorkbenchCommandFrame = {
        v: 1, type: "workbench.command", dispatchId: `disp_${requestId}`, deadline: Date.now() + 5000,
        userId: "owner", conversationId: "conv", generation: controller.getSnapshot().generation,
        target: { deviceId: "new-app", windowId: controller.getSnapshot().windowId, tabId: "legacy-canvas" },
        request: { requestId, operation, payload: {}, ...extra } as WorkbenchCommandFrame["request"],
      };
      frames.set(frame.dispatchId, frame);
      return controller.handleCommand(frame);
    };
    const readReceipt = await sendCommand("legacy-read", "design.read");
    expect(readReceipt).toMatchObject({ status: "not_executed", error: "design_canvas_removed" });
    const pubReceipt = await sendCommand("legacy-publish", "design.publish", { expectedRevision: 0, payload: { files: { "project/Main.dc.html": { content: "<x-dc>mutated</x-dc>", contentType: "text/html" } } } });
    expect(pubReceipt).toMatchObject({ status: "not_executed", error: "design_canvas_removed" });
    expect(saveDesign).not.toHaveBeenCalled();
    expect(designs.get("legacy-canvas")!.revision).toBe(0);
    expect(controller.designSession("legacy-canvas")).toBeUndefined();
  });

  it("exports a legacy canvas project as a project backup while open, read, edit and import stay refused", async () => {
    let layout: WorkbenchLayout = {
      ...emptyWorkbench(),
      tabs: [
        { id: "legacy-canvas", kind: "design", title: "Legacy Canvas" },
        { id: "ppt-1", kind: "design", designFormat: "slides", title: "Deck" },
      ],
      visible: ["legacy-canvas"],
      active: "legacy-canvas",
    };
    const designs = new Map<string, DesignDocument>([
      ["legacy-canvas", emptyDesign("legacy-canvas", "Legacy Canvas")],
      ["orphan-canvas", emptyDesign("orphan-canvas", "Poster")],
      ["ppt-1", emptySlides("ppt-1", "Deck")],
    ]);
    const stored = structuredClone(designs.get("legacy-canvas")!);
    const saveDesign = vi.fn(), createDesign = vi.fn(), saveLayout = vi.fn();
    const frames = new Map<string, WorkbenchCommandFrame>();
    const state: Record<string, unknown> = { status: "online", user: { id: "owner", name: "Owner" }, workbenchAvailable: true, workbenchDesignAvailable: true, workbenchSlidesAvailable: true };
    const connection = {
      identity: { deviceId: "new-app", hubPublicKey: "host" },
      state,
      isClosed: false,
      isReadOnly: false,
      cache: {
        isClosed: false,
        readWorkbench: async () => structuredClone(layout),
        saveWorkbench: async (_scope: string, expected: number, next: WorkbenchLayout) => { saveLayout(); if (layout.revision !== expected) throw new Error("workbench_revision_conflict"); layout = structuredClone(next); },
        readWorkbenchDesign: async (_scope: string, id: string) => structuredClone(designs.get(id)),
        saveWorkbenchDesign: saveDesign,
        createWorkbenchDesignAndLayout: createDesign,
        hasWorkbenchItem: async (_scope: string, _kind: string, id: string) => designs.has(id),
        // As the App's store does: one verified backup of the stored project.
        readWorkbenchDesignBackup: async (_scope: string, id: string, title: string) => {
          const document = designs.get(id); if (!document) throw new Error("design_not_found");
          return createDesignBackup({ title, document: structuredClone(document) });
        },
      },
      subscribe: () => () => undefined,
      conversationRevision: () => 0,
      http: vi.fn(async (_route: string, options: RequestInit) => {
        const frame = frames.get(JSON.parse(String(options.body)).dispatchId)!;
        return { admitted: true, generation: frame.generation, target: frame.target };
      }),
    } as unknown as HubConnection;
    const controller = new WorkbenchController({ connection, conversationId: "conv" });
    controllers.push(controller);
    await controller.initialize();
    controller.setVisible(true);
    await new Promise(r => setTimeout(r, 10));
    const scope = workbenchScope("host", "owner", "conv");
    expect(controller.scope).toBe(scope);

    // The removed-canvas Tab exports the stored project byte for byte, in the "Back up project" envelope.
    const text = await controller.exportRemovedCanvas("legacy-canvas", "Legacy Canvas");
    const backup = JSON.parse(text) as { format: string; version: number; title: string; document: DesignDocument };
    expect(backup).toMatchObject({ format: "tarobot-design", version: 2, title: "Legacy Canvas" });
    expect(backup.document.format).toBeUndefined();
    expect(Object.keys(backup.document.files).sort()).toEqual(["project/Main.dc.html", "project/canvas.json"]);
    expect(backup.document.files).toEqual(stored.files);
    // The file is a valid project backup: the 1.6.0 importer's parser reads the canvas back out of it.
    expect(parseDesignBackup(text, "restored").document.files).toEqual(stored.files);
    // A project without a Tab is exported from Workbench files the same way.
    expect(JSON.parse(await exportStoredDesign(connection, scope, "orphan-canvas", "Poster"))).toMatchObject({ format: "tarobot-design", title: "Poster", document: { id: "orphan-canvas" } });
    // Another user's or Host's scope is never read; a deck keeps its own editor export.
    await expect(exportStoredDesign(connection, workbenchScope("host", "someone-else", "conv"), "legacy-canvas", "Legacy Canvas")).rejects.toThrow("workbench_scope_unavailable");
    await expect(exportStoredDesign(connection, workbenchScope("other-host", "owner", "conv"), "legacy-canvas", "Legacy Canvas")).rejects.toThrow("workbench_scope_unavailable");
    await expect(exportStoredDesign(connection, scope, "missing", "Missing")).rejects.toThrow("design_not_found");
    await expect(controller.exportRemovedCanvas("ppt-1", "Deck")).rejects.toThrow("workbench_wrong_kind");

    // Exporting opened no editor and wrote nothing.
    expect(controller.designSession("legacy-canvas")).toBeUndefined();
    expect(saveDesign).not.toHaveBeenCalled();
    expect(saveLayout).not.toHaveBeenCalled();
    expect(designs.get("legacy-canvas")).toEqual(stored);

    // Open, the editor's own export, Bot read/edit and import of the exported file all stay refused.
    await expect(controller.openLibraryFile({ scope, conversationId: "conv", id: "orphan-canvas", kind: "design", title: "Poster" })).rejects.toThrow("design_canvas_removed");
    await expect(controller.exportDesign("legacy-canvas", "Legacy Canvas")).rejects.toThrow("design_canvas_removed");
    const sendCommand = (requestId: string, operation: "design.read" | "design.publish", extra: Record<string, unknown> = {}) => {
      const frame: WorkbenchCommandFrame = {
        v: 1, type: "workbench.command", dispatchId: `disp_${requestId}`, deadline: Date.now() + 5000,
        userId: "owner", conversationId: "conv", generation: controller.getSnapshot().generation,
        target: { deviceId: "new-app", windowId: controller.getSnapshot().windowId, tabId: "legacy-canvas" },
        request: { requestId, operation, payload: {}, ...extra } as WorkbenchCommandFrame["request"],
      };
      frames.set(frame.dispatchId, frame);
      return controller.handleCommand(frame);
    };
    expect(await sendCommand("export-read", "design.read")).toMatchObject({ status: "not_executed", error: "design_canvas_removed" });
    expect(await sendCommand("export-publish", "design.publish", { expectedRevision: 0, payload: { files: { "project/Main.dc.html": { content: "<x-dc>mutated</x-dc>", contentType: "text/html" } } } })).toMatchObject({ status: "not_executed", error: "design_canvas_removed" });
    await expect(controller.importDesign(new File([text], "Legacy Canvas.tarobot-design.json", { type: "application/json" }))).rejects.toThrow("design_canvas_removed");
    expect(createDesign).not.toHaveBeenCalled();
    expect(saveDesign).not.toHaveBeenCalled();
    expect(layout.tabs.map(tab => tab.id)).toEqual(["legacy-canvas", "ppt-1"]);
  });

  it("rejects opening, attaching, or joining canvas shares in DesignShareBroker while still letting owners close legacy canvas shares", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "remove-canvas-share-"));
    const store = await HubStore.open(directory);
    const repository = metaDesignShareRepository(store.db);
    const broker = new DesignShareBroker({
      requireMember: (userId, conversationId) => store.db.serial(() => store.requireMember(userId, conversationId)),
      userName: async userId => (await store.user(userId))?.name,
      repository,
    });
    try {
      await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('bot','Bot','fixture')");
      await store.db.run("INSERT INTO users VALUES('guest','Guest','member')");
      const conversationId = (await store.createConversation("owner", ["bot"], "Share", "share-conv")).id;
      await store.db.run("INSERT INTO conversation_members VALUES(?,'user','guest',0)", [conversationId]);
      const peer = (userId: string, deviceId: string): DesignSharePeer => ({ key: {}, userId, deviceId, active: () => true, validate: async () => undefined, send: async () => undefined });
      const owner = peer("owner", "mac"), guest = peer("guest", "laptop");

      const opened = await broker.handle(owner, { v: 1, type: "design.share.request", requestId: "open-canvas", request: { op: "open", conversationId, designId: "c1", windowId: "w", title: "Canvas", format: "canvas", revision: 0 } });
      expect(opened).toMatchObject({ ok: false, error: "design_canvas_removed" });

      // Seed a legacy open canvas share record from before #89.
      const legacyShareId = `ds_${"a".repeat(24)}`;
      await repository.put({ v: 1, shareId: legacyShareId, conversationId, ownerUserId: "owner", sourceDeviceId: "mac", designId: "c1", format: "canvas", title: "Legacy Canvas", state: "open", generation: 1, members: { guest: "editor" }, revision: 0, createdAt: 1, updatedAt: 1 });
      const joined = await broker.handle(guest, { v: 1, type: "design.share.request", requestId: "join-legacy", request: { op: "join", shareId: legacyShareId, windowId: "wg" } });
      expect(joined).toMatchObject({ ok: false, error: "design_canvas_removed" });
      const attached = await broker.handle(owner, { v: 1, type: "design.share.request", requestId: "attach-legacy", request: { op: "attach", shareId: legacyShareId, windowId: "w", revision: 0 } });
      expect(attached).toMatchObject({ ok: false, error: "design_canvas_removed" });
      // Owner can still close the orphaned legacy canvas share.
      const closed = await broker.handle(owner, { v: 1, type: "design.share.request", requestId: "close-legacy", request: { op: "close", shareId: legacyShareId } });
      expect(closed).toMatchObject({ ok: true, result: { shareId: legacyShareId, closed: true } });
    } finally {
      broker.close();
      await store.db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
