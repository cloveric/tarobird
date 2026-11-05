import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { fileCenterStatusSchema, fileInventorySchema, fileLabelPatchSchema, fileLabelSchema, fileUnitIdSchema, type FileCenterStatus, type FileLabelPatch } from "../client-protocol/file-center.js";
import { collectFileInventory, applyFileInventoryLabels, readFileInventoryLabels, revealFileInventoryUnit, type FileInventoryResult } from "../ui/file-inventory.js";
import { JsonStore } from "../state/json-store.js";
import { withFileMutex } from "../state/file-mutex.js";
import { HubError } from "./store.js";

const stateSchema = z.object({ version: z.literal(1), revision: z.number().int().nonnegative().safe().default(0), units: z.record(fileUnitIdSchema, fileLabelSchema) });
export type FileCenterRoots = { instances: { name: string; stateDir: string }[]; warnings: string[] };
/** Owner-only filesystem inventory. Roots come from registered local workers,
 * never from client paths. One cancellable scan is shared by all devices. */
export class HubFileCenter {
  private base?: FileInventoryResult;
  private work?: Promise<void>;
  private controller?: AbortController;
  private error: FileCenterStatus["error"] = null;
  private stopped = false;
  private readonly epoch = randomUUID();
  private scanRevision = 0;
  private readonly file: string;
  private readonly labels: JsonStore<z.infer<typeof stateSchema>>;
  constructor(directory: string, private readonly roots: () => Promise<FileCenterRoots>, private readonly options: { home?: string; reveal?: (file: string) => void | Promise<void> } = {}) {
    this.file = path.join(directory, "file-center-labels.json");
    this.labels = new JsonStore(this.file, (raw) => stateSchema.parse(raw));
  }
  private readLabels() { return this.labels.read({ version: 1, revision: 0, units: {} }); }
  private revision(labelsRevision: number): string { return `${this.epoch}:${this.scanRevision}:${labelsRevision}:${!!this.work}:${this.error}:${Math.floor(Date.now() / 60_000)}`; }
  async poll(knownRevision?: string): Promise<FileCenterStatus | { unchanged: true }> {
    if (knownRevision && knownRevision === this.revision((await this.readLabels()).revision)) return { unchanged: true };
    return this.status();
  }
  async status(): Promise<FileCenterStatus> {
    const { units: labels, revision } = await this.readLabels();
    const inventory = this.base ? applyFileInventoryLabels(this.base, labels) : null;
    if (inventory) inventory.units = inventory.units.map((unit) => ({ ...unit, labelRevision: labels[unit.id]?.revision ?? 0 }));
    return fileCenterStatusSchema.parse({ revision: this.revision(revision), scanning: !!this.work, inventory, error: this.error, canReveal: !!this.options.reveal || ["darwin", "win32"].includes(process.platform) });
  }
  async start(authorize?: () => Promise<void>): Promise<void> {
    if (this.stopped) throw new HubError("file_center_stopping", 503);
    if (this.work) return;
    await this.readLabels(); // Corrupt authoritative labels are never replaced.
    await authorize?.();
    if (this.work || this.stopped) return;
    const controller = new AbortController(); this.controller = controller; this.error = null;
    this.work = (async () => {
      const source = await this.roots(); controller.signal.throwIfAborted();
      const inventory = await collectFileInventory({ HOME: this.options.home ?? os.homedir() }, { instances: source.instances, labels: {}, signal: controller.signal });
      controller.signal.throwIfAborted();
      const legacy = await readFileInventoryLabels({ HOME: this.options.home ?? os.homedir() }).catch(() => {
        inventory.warnings.push("旧文件标注无法读取，本次未导入旧标注。"); return {} as Awaited<ReturnType<typeof readFileInventoryLabels>>;
      });
      await withFileMutex(`${this.file}.mutex`, async () => {
        const state = await this.readLabels(); let changed = false;
        for (const unit of inventory.units) {
          if (state.units[unit.id] || !legacy[unit.id]) continue;
          const label = legacy[unit.id]!;
          state.units[unit.id] = fileLabelSchema.parse({ ...label, updatedAt: Number.isFinite(Date.parse(label.updatedAt)) ? new Date(label.updatedAt).toISOString() : new Date(0).toISOString(), revision: 1 }); changed = true;
        }
        controller.signal.throwIfAborted();
        if (changed) { state.revision++; await this.labels.write(state); }
      });
      controller.signal.throwIfAborted();
      inventory.warnings.push(...source.warnings);
      this.base = fileInventorySchema.parse(inventory);
      this.scanRevision++;
    })().catch(() => { this.error = controller.signal.aborted ? "scan_cancelled" : "scan_failed"; })
      .finally(() => { this.work = undefined; this.controller = undefined; });
  }
  cancel(): void { this.controller?.abort(); }
  async close(): Promise<void> { this.stopped = true; this.cancel(); await this.work; }
  async label(raw: FileLabelPatch, authorize?: () => Promise<void>): Promise<void> {
    const input = fileLabelPatchSchema.parse(raw);
    if (!this.base?.units.some((unit) => unit.id === input.unitId)) throw new HubError("file_unit_not_found", 404);
    await withFileMutex(`${this.file}.mutex`, async () => {
      const state = await this.readLabels(), previous = state.units[input.unitId];
      await authorize?.();
      if ((previous?.revision ?? 0) !== input.expectedRevision) throw new HubError("file_label_conflict", 409);
      const next = { ...previous, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
      if (input.category !== undefined) { if (input.category === null) delete next.category; else next.category = input.category; }
      if (input.important !== undefined) next.important = input.important;
      if (input.note !== undefined) { if (!input.note) delete next.note; else next.note = input.note; }
      // Keep a revision tombstone after clearing all fields, preventing ABA.
      state.units[input.unitId] = fileLabelSchema.parse(next); state.revision++; await this.labels.write(state);
    });
  }
  async reveal(unitId: string, authorize?: () => Promise<void>): Promise<void> {
    fileUnitIdSchema.parse(unitId);
    if (!this.base?.units.some((unit) => unit.id === unitId)) throw new HubError("file_unit_not_found", 404);
    const source = await this.roots();
    // Re-enumerate current configured roots; an old snapshot cannot authorize a
    // path after its Bot has disconnected or changed workspace.
    if (!await revealFileInventoryUnit({ HOME: this.options.home ?? os.homedir() }, unitId, { instances: source.instances, reveal: this.options.reveal, authorize })) throw new HubError("file_reveal_unavailable", 409);
  }
}
