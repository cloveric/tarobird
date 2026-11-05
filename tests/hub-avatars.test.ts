import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { avatarPng, HubAvatars } from "../src/hub/avatars.js";
import { HubStore } from "../src/hub/store.js";
import { avatarDataUrl, avatarFixture, pngChunk } from "./helpers/avatar-fixture.js";
let directory: string, store: HubStore, avatars: HubAvatars;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "hub-avatars-")); store = await HubStore.open(directory); avatars = new HubAvatars(store);
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('alpha','Alpha','fixture')");
  await store.db.run("INSERT INTO users VALUES('member','Member','member'),('outsider','Outsider','member')");
});
afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });
it("validates bounded raster data and strips identifying metadata", () => {
  expect(avatarPng(avatarDataUrl(avatarFixture(256, 256, 80, true)))).toEqual(avatarFixture());
  const damaged = avatarFixture(); damaged[50] ^= 255;
  const png = avatarFixture(), tinyHeader = Buffer.from(png.subarray(16, 29)); tinyHeader.writeUInt32BE(1); tinyHeader.writeUInt32BE(1, 4);
  const oversizedRaster = Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", tinyHeader), png.subarray(33)]);
  const apng = Buffer.concat([png.subarray(0, 33), pngChunk("acTL", Buffer.alloc(8)), png.subarray(33)]);
  for (const input of ["https://example.com/avatar.png", "data:image/svg+xml;base64,PHN2Zz4=", avatarDataUrl(damaged), avatarDataUrl(avatarFixture(257)), avatarDataUrl(avatarFixture(32, 64)), avatarDataUrl(png.subarray(0, -1)), avatarDataUrl(apng), avatarDataUrl(oversizedRaster), avatarDataUrl(Buffer.alloc(301 * 1024))]) expect(() => avatarPng(input)).toThrow();
});
it("persists images across restart and uses revisions including removal to reject stale edits", async () => {
  const target = { kind: "user", id: "owner" } as const;
  expect(await avatars.set("owner", target, { expectedRevision: 0, dataUrl: avatarDataUrl() })).toEqual({ ...target, revision: 1, hasImage: true });
  await store.db.close(); store = await HubStore.open(directory); avatars = new HubAvatars(store);
  expect(await avatars.image("owner", target, 1)).toEqual(avatarFixture());
  await expect(avatars.set("owner", target, { expectedRevision: 0, dataUrl: null })).rejects.toMatchObject({ status: 409 });
  expect(await avatars.set("owner", target, { expectedRevision: 1, dataUrl: null })).toMatchObject({ revision: 2, hasImage: false });
  await expect(avatars.image("owner", target, 1)).rejects.toMatchObject({ status: 404 });
  await expect(avatars.set("owner", target, { expectedRevision: 0, dataUrl: avatarDataUrl() })).rejects.toMatchObject({ status: 409 });
  expect(await avatars.list("owner")).toEqual([{ ...target, revision: 2, hasImage: false }]);
  expect(JSON.stringify(await store.db.all("SELECT * FROM audit_log"))).not.toContain("data:image");
});
it("limits self, Bot and group edits and reads to authorized identities", async () => {
  const group = await store.createConversation("owner", ["alpha"], "Team", "team", { type: "group" });
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','member',0)", [group.id]);
  const targets = [{ kind: "user", id: "owner" }, { kind: "bot", id: "alpha" }, { kind: "group", id: group.id }] as const;
  for (const target of targets) {
    await avatars.set("owner", target, { expectedRevision: 0, dataUrl: avatarDataUrl() });
    await expect(avatars.set("member", target, { expectedRevision: 1, dataUrl: null })).rejects.toMatchObject({ status: 403 });
    await expect(avatars.image("outsider", target, 1)).rejects.toMatchObject({ status: 403 });
    expect(await avatars.image("member", target, 1)).toEqual(avatarFixture());
  }
  expect(await avatars.list("outsider")).toEqual([]); expect(await avatars.list("member")).toHaveLength(3);
  await avatars.set("member", { kind: "user", id: "member" }, { expectedRevision: 0, dataUrl: avatarDataUrl() });
  await store.db.run("INSERT INTO bot_grants VALUES('member','alpha')");
  const owned = await store.createConversation("member", ["alpha"], "Owned", "owned", { type: "group" });
  expect(await avatars.set("member", { kind: "group", id: owned.id }, { expectedRevision: 0, dataUrl: avatarDataUrl() })).toMatchObject({ hasImage: true });
  const topic = await store.createConversation("owner", [], "Topic", "topic", { parentId: group.id });
  await expect(avatars.set("owner", { kind: "group", id: topic.id }, { expectedRevision: 0, dataUrl: null })).rejects.toMatchObject({ status: 403 });
  await expect(avatars.set("owner", targets[0], { expectedRevision: 1, dataUrl: null }, { deviceId: "revoked", userId: "owner", expiresAt: Date.now() + 10000 })).rejects.toMatchObject({ status: 401 });
});
it("stores direct conversation pictures independently of Bots and sibling chats, with member-scoped reads and creator edits", async () => {
  await store.db.run("INSERT INTO bot_grants VALUES('member','alpha'),('outsider','alpha')");
  const first = await store.createConversation("member", ["alpha"], "First", "first");
  const second = await store.createConversation("member", ["alpha"], "Second", "second");
  const target = { kind: "group", id: first.id } as const;
  await store.db.run("INSERT INTO conversation_members VALUES(?,'user','owner',0)", [first.id]);
  await avatars.set("owner", { kind: "bot", id: "alpha" }, { expectedRevision: 0, dataUrl: avatarDataUrl(avatarFixture(256, 256, 170)) });
  await avatars.set("member", target, { expectedRevision: 0, dataUrl: avatarDataUrl() });
  expect(await avatars.image("owner", target, 1)).toEqual(avatarFixture());
  // A Bot grant, or the host-owner role alone, does not grant this chat's edit rights.
  for (const user of ["owner", "outsider"]) await expect(avatars.set(user, target, { expectedRevision: 1, dataUrl: null })).rejects.toMatchObject({ status: 403 });
  await expect(avatars.image("outsider", target, 1)).rejects.toMatchObject({ status: 403 });
  expect((await avatars.list("outsider")).some(a => a.id === first.id)).toBe(false);
  await expect(avatars.image("member", { kind: "group", id: second.id }, 1)).rejects.toMatchObject({ status: 404 });
  await store.db.close(); store = await HubStore.open(directory); avatars = new HubAvatars(store);
  expect(await avatars.image("member", target, 1)).toEqual(avatarFixture());
  await expect(avatars.set("member", target, { expectedRevision: 0, dataUrl: null })).rejects.toMatchObject({ status: 409 });
  await avatars.set("member", { kind: "group", id: second.id }, { expectedRevision: 0, dataUrl: avatarDataUrl(avatarFixture(256, 256, 30)) });
  await avatars.set("member", target, { expectedRevision: 1, dataUrl: null });
  expect(await avatars.image("member", { kind: "group", id: second.id }, 1)).toEqual(avatarFixture(256, 256, 30));
  expect(await avatars.image("member", { kind: "bot", id: "alpha" }, 1)).toEqual(avatarFixture(256, 256, 170));
  await store.db.run("DELETE FROM conversation_members WHERE conversation_id=? AND member_id='owner'", [first.id]);
  expect(await avatars.canRead("owner", target)).toBe(false);
});
