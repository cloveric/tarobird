import { hostname } from "node:os";
import { hostNameSchema, hostProfileChangeSchema, hostProfileSchema, type HostProfileState } from "../client-protocol/host-profile.js";
import type { HubDatabase } from "./database.js";
import { HubError } from "./store.js";
import { localDesktopControllersInTransaction } from "./local-controller.js";

export const HOST_PROFILE_KEY = "host-profile:v1";
export function defaultHostName(): string {
  const name = hostNameSchema.safeParse(hostname());
  return name.success ? name.data : "TaroBird host";
}

/** The host owns this name. Client aliases and later OS hostname changes cannot
 * silently overwrite it. Initialization and edits share the SQLite write lock. */
export class HostProfile {
  private readonly initialName: string;
  constructor(private readonly db: HubDatabase, initialName = defaultHostName()) {
    this.initialName = hostNameSchema.parse(initialName);
  }
  private async load(): Promise<HostProfileState> {
    const row = await this.db.get<{ value: string }>("SELECT value FROM meta WHERE key=?", [HOST_PROFILE_KEY]);
    if (row) return hostProfileSchema.parse(JSON.parse(row.value));
    const profile = { name: this.initialName, revision: 0 };
    await this.save(profile);
    return profile;
  }
  private async save(profile: HostProfileState): Promise<void> {
    await this.db.run("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [HOST_PROFILE_KEY, JSON.stringify(profile)]);
    for (const id of (await localDesktopControllersInTransaction(this.db, true)).keys()) {
      await this.db.run("UPDATE devices SET name=? WHERE id=?", [profile.name, id]);
    }
  }
  /** Native enrollment already owns the transaction and has verified the key.
   * A reconnect must never restore the stale name cached by an older App. */
  async syncDesktopNameInTransaction(deviceId: string): Promise<void> {
    if (!(await localDesktopControllersInTransaction(this.db, true)).has(deviceId)) return;
    const profile = await this.load();
    await this.db.run("UPDATE devices SET name=? WHERE id=?", [profile.name, deviceId]);
  }
  read(validate?: () => Promise<unknown>): Promise<HostProfileState> {
    return this.db.transaction(async () => { await validate?.(); return this.load(); });
  }
  update(value: unknown, validate?: () => Promise<unknown>): Promise<HostProfileState> {
    const input = hostProfileChangeSchema.parse(value);
    return this.db.transaction(async () => {
      await validate?.();
      const profile = await this.load();
      if (input.revision !== profile.revision) throw new HubError("host_profile_changed", 409);
      if (profile.revision === Number.MAX_SAFE_INTEGER) throw new HubError("host_profile_revision_exhausted", 409);
      const next = { name: input.name, revision: profile.revision + 1 };
      await this.save(next);
      return next;
    });
  }
}
