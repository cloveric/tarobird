import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, test } from "vitest";
import { renderCoreConfigCard, isCoreConfigCardActionValue } from "../src/core/config-card.js";
import { withChannelProfile } from "../src/core/channel-profile.js";
function callbacks(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.type === "callback") return [record.value as Record<string, unknown>];
  return Object.values(record).flatMap(callbacks);
}
test("refreshed optional-adapter config buttons survive SDK dedup but keep historical callbacks valid", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "config-revision-"));
  try {
    await writeFile(path.join(stateDir, "config.json"), JSON.stringify({ engine: "claude" }));
    const input = { stateDir, conversationKey: "example", bridgeChatType: "private" as const, larkChatId: "example", bridgeChatId: 1, locale: "en" as const };
    const a = callbacks(await withChannelProfile("feishu", () => renderCoreConfigCard(input)));
    const b = callbacks(await withChannelProfile("feishu", () => renderCoreConfigCard(input)));
    expect(a.length).toBeGreaterThan(10); expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(JSON.stringify(a[i]).slice(0, 128)).not.toBe(JSON.stringify(b[i]).slice(0, 128));
      expect(isCoreConfigCardActionValue(a[i]!)).toBe(true);
      const { revision: _, ...old } = a[i]!; expect(isCoreConfigCardActionValue(old)).toBe(true);
    }
    const rendered = await withChannelProfile("gateway", () => renderCoreConfigCard(input));
    expect(JSON.stringify(rendered)).toContain("TaroBird settings");
    const app = callbacks(rendered);
    expect(app.every(action => action.revision === undefined)).toBe(true);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
