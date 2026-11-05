/**
 * Central schema version for all instance state files.
 * Bump this when you introduce a breaking change to any state file format.
 *
 * Migration is handled per-store. When bumping, add a migration path in the
 * affected store's load() method that detects the old version and upgrades.
 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface VersionedState {
  schemaVersion?: number;
}

/**
 * Check whether a loaded state file is compatible with the current code.
 * Returns { ok: true } if same version or unversioned legacy data.
 * Returns { ok: false, reason } if newer (downgrade blocked) or incompatible.
 */
export function checkSchemaCompatibility(loaded: VersionedState): { ok: true } | { ok: false; reason: string } {
  const v = loaded.schemaVersion;
  if (v === undefined || v === CURRENT_SCHEMA_VERSION) {
    return { ok: true };
  }
  if (v > CURRENT_SCHEMA_VERSION) {
    return { ok: false, reason: `State file schema version ${v} is newer than supported version ${CURRENT_SCHEMA_VERSION}. Upgrade the bridge.` };
  }
  return { ok: true };
}

/**
 * Attach the current schema version to a state object before writing.
 */
export function withSchemaVersion<T extends object>(state: T): T & { schemaVersion: number } {
  return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION };
}
