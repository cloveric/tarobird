import type { BotCapability } from "../../src/client-protocol/capabilities.js";

export type CapabilityStateFilter = "all" | "active" | "disabled";
export type CapabilityGroup = { id: string; name: string; entries: BotCapability[]; sources: readonly BotCapability[]; total: number };

/** Presentation only: identical Skill names share a disclosure, never an
 * effective configuration. Retain every source and leave MCP entries separate. */
export function groupCapabilities(entries: readonly BotCapability[]): CapabilityGroup[] {
  const groups = new Map<string, CapabilityGroup>();
  for (const entry of entries) {
    const id = entry.kind === "skill" ? `skill:${entry.name}` : `mcp:${entry.id}`;
    let group = groups.get(id);
    if (!group) {
      const sources: BotCapability[] = [];
      group = { id, name: entry.name, entries: sources, sources, total: 0 }; groups.set(id, group);
    }
    group.entries.push(entry); group.total++;
  }
  return [...groups.values()];
}

/** Match each source before grouping: a matching name on one source must not
 * combine with a matching state/scope on another to invent a result. The full
 * sources remain attached so filtering cannot relabel the whole Skill. */
export function filterCapabilityGroups(groups: readonly CapabilityGroup[], query: string, scope: string, state: CapabilityStateFilter = "all"): CapabilityGroup[] {
  const needle = query.trim().toLocaleLowerCase();
  return groups.flatMap(group => {
    const entries = group.entries.filter(entry => (!scope || entry.scope === scope)
      && (!needle || `${entry.name} ${entry.description} ${entry.source}`.toLocaleLowerCase().includes(needle))
      && (state === "all" || (entry.status === "disabled") === (state === "disabled")));
    return entries.length ? [{ ...group, entries }] : [];
  });
}

export function capabilityGroupStatus(entries: readonly BotCapability[]): BotCapability["status"] | "partial-disabled" | "mixed" {
  const statuses = new Set(entries.map(entry => entry.status));
  if (statuses.size === 1) return entries[0]!.status;
  return statuses.has("disabled") ? "partial-disabled" : "mixed";
}
