import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { quotaView } from "../client/src/usage-readings.js";
import { ProcessAntigravityAdapter } from "../src/codex/antigravity-adapter.js";
import { AntigravityAcpAdapter } from "../src/codex/antigravity-acp-adapter.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const adapters = {
  process: (launcher: string, env: NodeJS.ProcessEnv, root: string) =>
    new ProcessAntigravityAdapter(launcher, env, undefined, undefined, undefined, root),
  ACP: (launcher: string, env: NodeJS.ProcessEnv, root: string) =>
    new AntigravityAcpAdapter(launcher, { workspacePath: root, childEnv: env }),
};

const model = "gemini-pro-orchestrator-neon";
const payload = { status: "SUCCESS", num_turns: 0, command: { name: "usage", data: { groups: [
  { name: "Orchestrator", description: "Models within this group: Orchestrator (Neon)", buckets: [
    { id: "weekly", window: "weekly", remaining_fraction: 0.7, reset_time: "1970-01-01T00:00:00Z" },
  ] },
] } } };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agy-audit-"));
  roots.push(root);
  const home = path.join(root, "home");
  const launcher = path.join(root, "alternate-agy");
  await mkdir(path.join(home, ".gemini"), { recursive: true });
  const env = { HOME: home, PATH: root };
  await writeFile(path.join(home, ".gemini", "oauth_creds.json"), '{"fixture":"A"}');
  await writeFile(launcher, `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' '1.5.14' ;;
  -p) printf '%s\\n' '${JSON.stringify(payload)}' ;;
  models)
    read -r account < "$HOME/.gemini/oauth_creds.json"
    case "$account" in
      *A*) printf '%s\\t%s\\n' '${model}' 'Orchestrator (Neon)' ;;
      *B*) printf '%s\\t%s\\n' '${model}' 'Quota Group B' ;;
    esac ;;
esac
`, { mode: 0o755 });
  return { env, root, launcher, home };
}

function reading(snapshot: Awaited<ReturnType<ProcessAntigravityAdapter["getAccountQuota"]>>["snapshot"]) {
  return quotaView({ ...snapshot, engine: "antigravity", revision: "rev", id: "id", sharing: "unverified", label: "agy", botIds: ["bot"] }, model, Date.now());
}

it.skipIf(process.platform === "win32").each(Object.entries(adapters))("%s uses the resolved CLI to read the catalog beside usage", async (_name, create) => {
  const { env, root, launcher } = await fixture();
  const adapter = create(launcher, env, root);
  try {
    const result = await adapter.getAccountQuota({ refresh: true });
    expect(result.snapshot.state).toBe("ready");
    expect(result.snapshot.pools[0]?.windows[0]).not.toHaveProperty("resetsAt");
    expect(reading(result.snapshot)?.left).toBe(70);
  } finally { await adapter.destroy(); }
});

it.skipIf(process.platform === "win32").each(Object.entries(adapters))("%s does not reuse a prior login catalog after a login switch", async (_name, create) => {
  const { env, root, launcher, home } = await fixture();
  const adapter = create(launcher, { ...env, ANTIGRAVITY_EXECUTABLE: launcher }, root);
  try {
    const before = await adapter.getAccountQuota({ refresh: true });
    expect(reading(before.snapshot)?.left).toBe(70);
    await writeFile(path.join(home, ".gemini", "oauth_creds.json"), '{"fixture":"B"}');
    const after = await adapter.getAccountQuota({ refresh: true });
    expect(after.revision).not.toBe(before.revision);
    expect(after.snapshot.state).toBe("ready");
    expect(reading(after.snapshot)).toBeUndefined();
  } finally { await adapter.destroy(); }
});
