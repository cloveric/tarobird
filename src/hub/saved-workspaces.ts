import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addSavedWorkspaceSchema,
  savedWorkspaceSchema,
  workspaceBrowseSchema,
  workspaceDisplayName,
  type SavedWorkspace,
  type WorkspaceBrowseEntry,
  type WorkspaceBrowseResult,
} from "../client-protocol/saved-workspaces.js";
import { idSchema } from "../client-protocol/index.js";
import { HubError, newId, type HubStore, type TransactionGuard } from "./store.js";

type SavedWorkspaceRow = {
  id: string;
  owner_id: string;
  name: string;
  path: string;
  created_at: number;
  last_used_at: number;
};

const MAX_SAVED_WORKSPACES = 200;
const MAX_BROWSE_ENTRIES = 200;

async function isDirectory(target: string): Promise<boolean> {
  return stat(target).then(s => s.isDirectory(), () => false);
}

/** Validate and canonicalize a Host directory path for a workspace. */
export async function resolveExistingWorkspaceDirectory(rawPath: string): Promise<string> {
  const trimmed = rawPath.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) throw new HubError("workspace_unavailable", 400);
  const resolved = path.resolve(trimmed);
  if (!await isDirectory(resolved)) throw new HubError("workspace_unavailable", 400);
  return resolved;
}

export class SavedWorkspaces {
  constructor(private readonly store: HubStore) {}

  private async hydrate(rows: SavedWorkspaceRow[]): Promise<SavedWorkspace[]> {
    return Promise.all(rows.map(async row => savedWorkspaceSchema.parse({
      id: row.id,
      name: row.name,
      path: row.path,
      exists: await isDirectory(row.path),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    })));
  }

  async list(userId: string): Promise<SavedWorkspace[]> {
    const rows = await this.store.db.serial(async () => {
      await this.store.requireOwner(userId);
      return this.store.db.all<SavedWorkspaceRow>(
        "SELECT * FROM saved_workspaces WHERE owner_id=? ORDER BY last_used_at DESC, created_at DESC LIMIT ?",
        [userId, MAX_SAVED_WORKSPACES],
      );
    });
    return this.hydrate(rows);
  }

  async add(userId: string, raw: unknown, validate?: TransactionGuard): Promise<{ workspace: SavedWorkspace; items: SavedWorkspace[] }> {
    const input = addSavedWorkspaceSchema.parse(raw);
    const resolved = await resolveExistingWorkspaceDirectory(input.path);
    const derivedName = input.name?.trim() || workspaceDisplayName(resolved) || resolved;
    const name = derivedName.slice(0, 128);
    const now = Date.now();
    const { workspaceRow, rows } = await this.store.db.transaction(async () => {
      await validate?.();
      await this.store.requireOwner(userId);
      const existing = await this.store.db.get<SavedWorkspaceRow>(
        "SELECT * FROM saved_workspaces WHERE owner_id=? AND path=?",
        [userId, resolved],
      );
      let id: string;
      if (existing) {
        id = existing.id;
        const nextName = input.name?.trim() ? name : existing.name;
        await this.store.db.run(
          "UPDATE saved_workspaces SET name=?,last_used_at=? WHERE id=?",
          [nextName, now, id],
        );
      } else {
        const count = await this.store.db.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM saved_workspaces WHERE owner_id=?",
          [userId],
        );
        if ((count?.count ?? 0) >= MAX_SAVED_WORKSPACES) throw new HubError("saved_workspaces_limit", 409);
        id = newId("ws");
        await this.store.db.run(
          "INSERT INTO saved_workspaces(id,owner_id,name,path,created_at,last_used_at) VALUES(?,?,?,?,?,?)",
          [id, userId, name, resolved, now, now],
        );
      }
      const workspaceRow = (await this.store.db.get<SavedWorkspaceRow>("SELECT * FROM saved_workspaces WHERE id=?", [id]))!;
      const rows = await this.store.db.all<SavedWorkspaceRow>(
        "SELECT * FROM saved_workspaces WHERE owner_id=? ORDER BY last_used_at DESC, created_at DESC LIMIT ?",
        [userId, MAX_SAVED_WORKSPACES],
      );
      return { workspaceRow, rows };
    });
    const items = await this.hydrate(rows);
    const workspace = items.find(item => item.id === workspaceRow.id) ?? (await this.hydrate([workspaceRow]))[0]!;
    return { workspace, items };
  }

  async remove(userId: string, id: string, validate?: TransactionGuard): Promise<SavedWorkspace[]> {
    const parsedId = idSchema.parse(id);
    const rows = await this.store.db.transaction(async () => {
      await validate?.();
      await this.store.requireOwner(userId);
      await this.store.db.run("DELETE FROM saved_workspaces WHERE id=? AND owner_id=?", [parsedId, userId]);
      return this.store.db.all<SavedWorkspaceRow>(
        "SELECT * FROM saved_workspaces WHERE owner_id=? ORDER BY last_used_at DESC, created_at DESC LIMIT ?",
        [userId, MAX_SAVED_WORKSPACES],
      );
    });
    return this.hydrate(rows);
  }

  async touch(userId: string, workspacePath: string): Promise<void> {
    const trimmed = workspacePath.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    await this.store.db.serial(() =>
      this.store.db.run("UPDATE saved_workspaces SET last_used_at=? WHERE owner_id=? AND path=?", [Date.now(), userId, resolved]),
    ).catch(() => undefined);
  }

  async browse(userId: string, requestedPath?: string, showHidden = false): Promise<WorkspaceBrowseResult> {
    await this.store.db.serial(() => this.store.requireOwner(userId));
    const home = path.resolve(os.homedir());
    const target = requestedPath?.trim() ? await resolveExistingWorkspaceDirectory(requestedPath) : home;
    const dirEntries = await readdir(target, { withFileTypes: true }).catch(() => {
      throw new HubError("workspace_unavailable", 400);
    });
    const entries: WorkspaceBrowseEntry[] = [];
    for (const entry of dirEntries) {
      if (!showHidden && entry.name.startsWith(".")) continue;
      const full = path.join(target, entry.name);
      const dir = entry.isDirectory() || (entry.isSymbolicLink() && await isDirectory(full));
      if (!dir) continue;
      entries.push({ name: entry.name, path: full });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    const parentCandidate = path.dirname(target);
    const parent = parentCandidate !== target ? parentCandidate : null;
    return workspaceBrowseSchema.parse({
      path: target,
      parent,
      home,
      entries: entries.slice(0, MAX_BROWSE_ENTRIES),
    });
  }
}
