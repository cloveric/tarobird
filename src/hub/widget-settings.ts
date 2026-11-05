import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { withFileMutex } from "../state/file-mutex.js";
import { readHostWidgetPolicy, widgetPolicyFile, WidgetPolicyReadError, type HostWidgetPolicy } from "../runtime/widget-policy.js";
import { widgetSettingsUpdateSchema, type WidgetSettingsState, type WidgetSettingsUpdate } from "../client-protocol/widget-settings.js";
import { HubError } from "./store.js";

export class HubWidgetSettings {
  constructor(readonly hostDir: string) {}
  private snapshot(): { policy?: HostWidgetPolicy; revision: string; recoveryRequired: boolean } {
    try { const policy = readHostWidgetPolicy(this.hostDir); return { policy, revision: policy?.revision ?? "default", recoveryRequired: false }; }
    catch (error) {
      if (error instanceof WidgetPolicyReadError && error.recoveryRevision) return { revision: error.recoveryRevision, recoveryRequired: true };
      throw new HubError("widget_settings_unavailable", 503);
    }
  }
  status(requestId?: string): WidgetSettingsState {
    const { policy, revision, recoveryRequired } = this.snapshot(), receipt = requestId ? policy?.receipts.find(r => r.requestId === requestId) : policy?.receipts.at(-1);
    return { revision, enabled: recoveryRequired ? false : policy?.enabled ?? true, recoveryRequired, receipt: receipt ? { requestId: receipt.requestId, revision: receipt.revision } : null, workersNeedingUpdate: [] };
  }
  assertEnabled(): void { if (!this.status().enabled) throw new HubError("widgets_disabled", 409); }
  async update(raw: WidgetSettingsUpdate, commit: (operation: () => Promise<void>) => Promise<void>): Promise<WidgetSettingsState> {
    const command = widgetSettingsUpdateSchema.parse(raw), digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const file = widgetPolicyFile(this.hostDir);
    return withFileMutex(file, async () => {
      const before = this.snapshot(), receipt = before.policy?.receipts.find(r => r.requestId === command.requestId);
      if (receipt) {
        if (receipt.digest !== digest) throw new HubError("widget_request_conflict", 409);
        return this.status(command.requestId);
      }
      if (before.revision !== command.revision) throw new HubError("widget_revision_conflict", 409);
      if (before.recoveryRequired && command.enabled) throw new HubError("widget_recovery_requires_off", 409);
      const revision = randomUUID();
      const next: HostWidgetPolicy = { format: 1, revision, enabled: command.enabled,
        receipts: [...(before.policy?.receipts ?? []), { requestId: command.requestId, digest, revision }].slice(-32) };
      const temporary = `${file}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(JSON.stringify(next)); await handle.sync(); await handle.close(); handle = undefined;
        await commit(async () => {
          if (JSON.stringify(this.snapshot()) !== JSON.stringify(before)) throw new HubError("widget_revision_conflict", 409);
          await rename(temporary, file);
        });
      } finally { await handle?.close(); await unlink(temporary).catch(() => undefined); }
      return this.status(command.requestId);
    }, { waitTimeoutMs: 10_000 });
  }
}
