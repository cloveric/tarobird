import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { deviceProof, hashSecret } from "../src/hub/auth.js";
import { HubServer } from "../src/hub/server.js";
import { attachmentResponse } from "../src/hub/attachment-response.js";

it.each(["bytes=", "bytes=-", "bytes=1-0", "bytes=-0", "bytes=10-", "bytes=0-1,2-3", "bytes=9007199254740992-", "items=0-1"])("rejects invalid or unsatisfiable single range %s", (range) => {
  expect(attachmentResponse(10, "abc", range)).toMatchObject({ status: 416, headers: { "Content-Range": "bytes */10", "Content-Length": 0 } });
});
it("serves authenticated immutable ranges with validators and rechecks membership/revocation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-download-")), hub = await HubServer.start({ stateDir: root });
  try {
    const id = "device", keys = generateKeyPairSync("ed25519"), nonce = randomBytes(32).toString("base64url");
    const pair = await hub.auth.pair({ deviceId: id, name: id, platform: "web", publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, id);
    await hub.auth.approve(pair.code, "local-owner"); const challenge = await hub.auth.challenge(id, id, nonce, id);
    const session = await hub.auth.authenticate(id, sign(null, deviceProof(id, challenge.nonce, nonce), keys.privateKey).toString("base64"));
    await hub.store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('fixture','Fixture',?)", [hashSecret("fixture")]);
    const conversation = await hub.store.createConversation("owner", ["fixture"], "Fixture", "fixture");
    const data = Buffer.from("0123456789"), sha256 = createHash("sha256").update(data).digest("hex"), etag = `"${sha256}"`;
    const attachment = await hub.attachments.importForBot("fixture", { conversationId: conversation.id, name: "John's report (final)*.txt", mime: "text/plain", size: data.length, sha256 }, data);
    const url = `${hub.url}/api/attachments/${attachment}`, headers = { Authorization: `Bearer ${session.token}` };
    expect((await fetch(url, { headers: { Range: "bytes=0-1" } })).status).toBe(401);
    for (const [range, text, contentRange] of [["bytes=2-4", "234", "bytes 2-4/10"], ["bytes=8-99", "89", "bytes 8-9/10"], ["bytes=8-", "89", "bytes 8-9/10"], ["bytes=-2", "89", "bytes 8-9/10"]]) {
      const response = await fetch(url, { headers: { ...headers, Range: range!, "If-Range": etag } });
      expect(response.status).toBe(206); expect(response.headers.get("Content-Range")).toBe(contentRange); expect(response.headers.get("ETag")).toBe(etag); expect(await response.text()).toBe(text);
      expect(response.headers.get("Cache-Control")).toContain("no-store"); expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Content-Range");
    }
    const full = await fetch(url, { headers: { ...headers, Range: "bytes=2-4", "If-Range": '"old-version"' } });
    expect(full.headers.get("Content-Disposition")).toBe("attachment; filename*=UTF-8''John%27s%20report%20%28final%29%2A.txt");
    expect(full.status).toBe(200); expect(await full.text()).toBe(data.toString());
    const invalid = await fetch(url, { headers: { ...headers, Range: "bytes=10-" } }); expect(invalid.status).toBe(416); expect(await invalid.text()).toBe("");
    await hub.store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_type='user'", [conversation.id]);
    expect((await fetch(url, { headers: { ...headers, Range: "bytes=2-4" } })).status).toBe(403);
    await hub.auth.revoke(id, "local-owner"); expect((await fetch(url, { headers: { ...headers, Range: "bytes=2-4" } })).status).toBe(401);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});
