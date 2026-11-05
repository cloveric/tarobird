import { describe, expect, it } from "vitest";
import { normalizeCodexPermissions, deniedCodexPermissions } from "../src/codex/codex-permissions.js";

const base = { threadId: "thread", turnId: "turn", itemId: "item", cwd: "/workspace", startedAtMs: 123, reason: "Read the requested fixture", environmentId: "local" };
const profile = { network: { enabled: true }, fileSystem: { read: ["/tmp/legacy"], write: null, globScanMaxDepth: 4, entries: [
  { access: "read", path: { type: "path", path: "/tmp/a b.txt" } },
  { access: "deny", path: { type: "glob_pattern", pattern: "/tmp/**/*.key" } },
  { access: "write", path: { type: "special", value: { kind: "project_roots", subpath: "reports" } } },
] } };

describe("Codex additional permissions", () => {
  it("shows and grants the exact profile, including restrictions and native scope", () => {
    const form = normalizeCodexPermissions({ ...base, permissions: profile })!;
    expect(form.approvalScopes).toEqual({ once: "turn", session: "session" });
    expect(form.toolInput).toMatchObject({ cwd: base.cwd, environmentId: "local", permissions: profile });
    for (const scope of [undefined, "once", "session"] as const) {
      expect(form.response({ behavior: "allow", scope, updatedInput: { permissions: { network: { enabled: false } } } })).toEqual({ permissions: profile, scope: scope === "session" ? "session" : "turn" });
    }
    expect(form.response({ behavior: "deny" })).toEqual(deniedCodexPermissions());
  });
  it("does not let callback or response mutation widen the next grant", () => {
    const form = normalizeCodexPermissions({ ...base, permissions: { fileSystem: { read: ["/tmp/one"] } } })!;
    form.toolInput.permissions.fileSystem!.write = ["/"];
    const first = form.response({ behavior: "allow" });
    if ("fileSystem" in first.permissions) first.permissions.fileSystem!.read!.push("/etc");
    expect(form.response({ behavior: "allow" })).toEqual({ permissions: { fileSystem: { read: ["/tmp/one"] } }, scope: "turn" });
  });
  it.each([
    { network: { enabled: true, hosts: ["*"] } },
    { fileSystem: { read: ["/tmp/one"], futureRestriction: true } },
    { fileSystem: { entries: [{ access: "execute", path: { type: "path", path: "/tmp/a" } }] } },
    { fileSystem: { entries: [{ access: "write", path: { type: "future", path: "/" } }] } },
    { shell: true },
  ])("refuses unsupported profiles without dropping restrictions", (permissions) => {
    expect(normalizeCodexPermissions({ ...base, permissions })).toBeUndefined();
  });
  it("does not ask users to approve missing ownership or truncated details", () => {
    expect(normalizeCodexPermissions({ ...base, turnId: null, permissions: profile })).toBeUndefined();
    expect(normalizeCodexPermissions({ ...base, permissions: { fileSystem: { read: Array(20).fill("/" + "中".repeat(300)) } } })).toBeUndefined();
  });
  it("preserves all declared special paths without resolving them on the client", () => {
    const entries = ["root", "minimal", "tmpdir", "slash_tmp"].map((kind) => ({ access: "read", path: { type: "special", value: { kind } } }));
    const permissions = { fileSystem: { entries: [...entries, { access: "deny", path: { type: "special", value: { kind: "unknown", path: "native-scope", subpath: null } } }] }, network: null };
    expect(normalizeCodexPermissions({ ...base, permissions })!.response({ behavior: "allow" })).toEqual({ permissions, scope: "turn" });
  });
});
