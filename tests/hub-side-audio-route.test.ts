import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HubServer } from "../src/hub/server.js";
import type { AuthSession } from "../src/hub/auth.js";
import type { HubSideSessions } from "../src/hub/side-sessions.js";

let hub: HubServer, root: string;
const session: AuthSession = { deviceId: "desktop", userId: "owner", expiresAt: Date.now() + 3600_000 };
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "side-audio-route-")); hub = await HubServer.start({ stateDir: root }); });
afterEach(async () => { await hub.close(); await rm(root, { recursive: true, force: true }); });

it("parses audio=1 only as a refinement of the attachments opt-in", async () => {
  await hub.store.db.run("INSERT INTO devices(id,user_id,name,platform,public_key,created_at,last_seen) VALUES('desktop','owner','desktop','web','fixture',0,0)");
  vi.spyOn(hub.auth, "authorize").mockResolvedValue(session);
  const request = vi.spyOn((hub as unknown as { sideSessions: HubSideSessions }).sideSessions, "request").mockResolvedValue({ ok: true, capability: { supported: false, concurrent: false, liveContext: false, tools: "none" } });
  for (const query of ["attachments=1&audio=1", "attachments=1", "audio=1", ""]) {
    const response = await fetch(`${hub.url}/api/conversations/conv_1/side?botId=bot${query ? `&${query}` : ""}`, { headers: { authorization: "Bearer fixture" } });
    expect(response.status).toBe(200);
  }
  expect(request.mock.calls.map(call => [call[3], call[4]])).toEqual([
    ["side.status", { withAttachments: true, withAudio: true }], ["side.status", { withAttachments: true }], ["side.status", {}], ["side.status", {}],
  ]);
});
