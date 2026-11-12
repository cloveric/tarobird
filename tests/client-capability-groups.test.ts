import { expect, it } from "vitest";
import { capabilityGroupStatus, filterCapabilityGroups, groupCapabilities } from "../client/src/capability-groups.js";
import type { BotCapability } from "../src/client-protocol/capabilities.js";

const entry = (id: string, overrides: Partial<BotCapability> = {}): BotCapability => ({
  id, kind: "skill", name: "report", source: `plugin:${id}/skills/report/SKILL.md`,
  scope: "plugin", status: "discovered", description: "Shared description", ...overrides,
});

it("groups exact Skill names without merging distinct names, namespaces or MCP sources", () => {
  const first = Object.freeze(entry("one")), second = Object.freeze(entry("two", { description: "Different instructions", status: "disabled" }));
  const entries = Object.freeze([first, second, entry("upper", { name: "Report" }), entry("space", { name: " report" }),
    entry("namespace", { name: "plugin:report" }), entry("web", { name: "vercel-react-best-practices" }), entry("native", { name: "vercel-react-native-skills" }),
    entry("mcp-one", { kind: "mcp" }), entry("mcp-two", { kind: "mcp" })]);
  const groups = groupCapabilities(entries);
  expect(groups).toHaveLength(8);
  expect(groups[0]!.entries).toEqual([first, second]);
  expect(groups[0]!.entries[0]).toBe(first);
  expect(groups[0]!.total).toBe(2);
  expect(groups.slice(-2).map(group => group.entries.length)).toEqual([1, 1]);
  expect(groupCapabilities([second, first])[0]!.id).toBe(groups[0]!.id);
});

it("never joins a source match with another source's scope or status", () => {
  const groups = groupCapabilities([entry("alpha", { scope: "user" }), entry("beta", { status: "disabled", description: "Quarterly statements" })]);
  expect(filterCapabilityGroups(groups, "plugin:beta", "", "active")).toEqual([]);
  expect(filterCapabilityGroups(groups, "Quarterly", "user")).toEqual([]);
  const [match] = filterCapabilityGroups(groups, " QUARTERLY ", "plugin", "disabled");
  expect(match!.entries.map(row => row.id)).toEqual(["beta"]);
  expect(match!.total).toBe(2);
  expect(match!.id).toBe(groups[0]!.id);
  expect(match!.sources).toBe(groups[0]!.sources);
  expect(capabilityGroupStatus(match!.sources)).toBe("partial-disabled");
  expect(groups[0]!.entries).toHaveLength(2);
});

it("counts mixed-state Skills once per filter without losing the matching source", () => {
  const groups = groupCapabilities([entry("a"), entry("b", { status: "disabled" }), entry("c", { name: "other" })]);
  expect(filterCapabilityGroups(groups, "", "")).toHaveLength(2);
  expect(filterCapabilityGroups(groups, "", "", "active")).toHaveLength(2);
  const disabled = filterCapabilityGroups(groups, "", "", "disabled");
  expect(disabled).toHaveLength(1);
  expect(disabled[0]!.entries[0]!.source).toBe("plugin:b/skills/report/SKILL.md");
  expect(disabled[0]!.total).toBe(2);
});

it("does not call a mixed configuration enabled or loaded", () => {
  expect(capabilityGroupStatus([entry("a"), entry("b", { status: "disabled" })])).toBe("partial-disabled");
  expect(capabilityGroupStatus([entry("a", { status: "disabled" })])).toBe("disabled");
  expect(capabilityGroupStatus([entry("a"), entry("b", { status: "configured" })])).toBe("mixed");
  expect(capabilityGroupStatus([entry("a"), entry("b")])).toBe("discovered");
});

it("keeps one group across page boundaries and preserves all original records", () => {
  const entries = Array.from({ length: 62 }, (_, index) => entry(String(index), { name: `skill-${index % 31}` }));
  const groups = groupCapabilities(entries);
  expect(groups.slice(0, 30)).toHaveLength(30);
  expect(groups.slice(30)).toHaveLength(1);
  expect(groups.flatMap(group => group.entries).map(row => row.id).sort()).toEqual(entries.map(row => row.id).sort());
});

it("preserves visually similar Unicode names without normalization", () => {
  const groups = groupCapabilities([entry("one", { name: "report" }), entry("two", { name: "report\u200b" }),
    entry("three", { name: "caf\u00e9" }), entry("four", { name: "cafe\u0301" })]);
  expect(groups).toHaveLength(4);
});
