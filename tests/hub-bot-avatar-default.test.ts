import { randomInt } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SELECTABLE_BOT_AVATARS, RETIRED_BOT_AVATAR_IDS } from "../src/client-protocol/bot-avatar-catalog.js";
import { assignNewBotAvatar, BOT_AVATAR_DEFAULT_PREFIX } from "../src/hub/bot-avatar-default.js";
import { HubStore } from "../src/hub/store.js";
import { HubAuth } from "../src/hub/auth.js";
import { runHubCli } from "../src/hub/cli.js";

vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});
let directory: string, store: HubStore;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "bot-avatar-default-")); store = await HubStore.open(directory); vi.mocked(randomInt).mockClear(); });
afterEach(async () => { await store.db.close(); await rm(directory, { recursive: true, force: true }); });
async function create(id: string) {
  await store.db.transaction(async () => {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id, id]);
    await assignNewBotAvatar(store.db, id);
  });
}

it("gives the first Bot the fox without drawing randomly", async () => {
  await create("first");
  expect((await store.bots("owner"))[0]?.defaultAvatar).toBe("pastel-fox");
  expect(randomInt).not.toHaveBeenCalled();
});

it("can assign every active member without drawing a retired ID", async () => {
  await create("first");
  for (const [index, avatar] of SELECTABLE_BOT_AVATARS.entries()) {
    vi.mocked(randomInt).mockImplementationOnce(() => index);
    await create(`bot_${index}`);
    expect((await store.bots("owner")).find(bot => bot.id === `bot_${index}`)?.defaultAvatar).toBe(avatar.id);
  }
  expect(vi.mocked(randomInt).mock.calls).toEqual(SELECTABLE_BOT_AVATARS.map(() => [SELECTABLE_BOT_AVATARS.length]));
});

it("preserves a choice across repeated assignment, renaming and database restart; leaves legacy Bots untouched", async () => {
  await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('legacy','Legacy','fixture')");
  vi.mocked(randomInt).mockImplementationOnce(() => SELECTABLE_BOT_AVATARS.length - 1);
  await create("new_bot");
  await store.db.transaction(() => assignNewBotAvatar(store.db, "new_bot"));
  await store.renameBot("owner", "new_bot", { name: "Renamed", expectedName: "new_bot" });
  await store.db.close(); store = await HubStore.open(directory);
  const bots = await store.bots("owner");
  expect(bots.find(bot => bot.id === "new_bot")).toMatchObject({ name: "Renamed", defaultAvatar: SELECTABLE_BOT_AVATARS.at(-1)!.id });
  expect(bots.find(bot => bot.id === "legacy")).not.toHaveProperty("defaultAvatar");
  expect(await store.db.get("SELECT 1 FROM meta WHERE key=?", [BOT_AVATAR_DEFAULT_PREFIX + "legacy"])).toBeUndefined();
  expect(randomInt).toHaveBeenCalledTimes(1);
});

it("rolls back avatar assignment with failed creation and never advertises unknown catalog data", async () => {
  await expect(store.db.transaction(async () => {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('failed','Failed','fixture')");
    await assignNewBotAvatar(store.db, "failed");
    throw new Error("creation_failed");
  })).rejects.toThrow("creation_failed");
  expect(await store.bots("owner")).toEqual([]);
  expect(await store.db.get("SELECT 1 FROM meta WHERE key=?", [BOT_AVATAR_DEFAULT_PREFIX + "failed"])).toBeUndefined();
  await create("new_bot");
  expect((await store.bots("owner"))[0]?.defaultAvatar).toBe("pastel-fox");
  await store.db.run("UPDATE meta SET value='unknown-future-avatar' WHERE key=?", [BOT_AVATAR_DEFAULT_PREFIX + "new_bot"]);
  expect((await store.bots("owner"))[0]).not.toHaveProperty("defaultAvatar");
});

it("uses fox then the active catalog through offline CLI registration as well", async () => {
  await HubAuth.open(store, directory);
  await store.db.close();
  vi.mocked(randomInt).mockImplementationOnce(() => SELECTABLE_BOT_AVATARS.length - 1);
  try {
    await runHubCli(["bots", "register", "registered", "--state-dir", directory, "--key-file", path.join(directory, "registered.key")]);
    await runHubCli(["bots", "register", "second", "--state-dir", directory, "--key-file", path.join(directory, "second.key")]);
  } finally { store = await HubStore.open(directory); }
  expect(await store.bots("owner")).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "registered", defaultAvatar: "pastel-fox" }),
    expect.objectContaining({ id: "second", defaultAvatar: SELECTABLE_BOT_AVATARS.at(-1)!.id }),
  ]));
  expect(randomInt).toHaveBeenCalledExactlyOnceWith(SELECTABLE_BOT_AVATARS.length);
});

it("does not reset first creation after deletion and a database restart", async () => {
  await create("first");
  await store.db.run("INSERT INTO managed_bots VALUES('first','owner','first','{}')");
  await store.deleteBot("owner", "first", "first");
  await store.db.close(); store = await HubStore.open(directory);
  expect(await store.bots("owner")).toEqual([]);
  vi.mocked(randomInt).mockImplementationOnce(() => SELECTABLE_BOT_AVATARS.length - 1);
  await create("second");
  expect((await store.bots("owner"))[0]?.defaultAvatar).toBe(SELECTABLE_BOT_AVATARS.at(-1)!.id);
  expect((await store.bots("owner", true)).find(bot => bot.id === "first")?.defaultAvatar).toBe("pastel-fox");
  expect(randomInt).toHaveBeenCalledExactlyOnceWith(SELECTABLE_BOT_AVATARS.length);
});

it("serializes concurrent creations so only one receives the first-Bot default", async () => {
  vi.mocked(randomInt).mockImplementationOnce(() => SELECTABLE_BOT_AVATARS.length - 1);
  await Promise.all([create("alpha"), create("beta")]);
  expect((await store.bots("owner")).map(bot => bot.defaultAvatar).sort()).toEqual(["pastel-fox", SELECTABLE_BOT_AVATARS.at(-1)!.id].sort());
  expect(randomInt).toHaveBeenCalledExactlyOnceWith(SELECTABLE_BOT_AVATARS.length);
});

it("treats another host independently even when Bot IDs are identical", async () => {
  await create("first");
  const other = await HubStore.open(path.join(directory, "other-host"));
  try {
    await other.db.transaction(async () => {
      await other.db.run("INSERT INTO bots(id,name,secret_hash) VALUES('first','First','fixture')");
      await assignNewBotAvatar(other.db, "first");
    });
    expect((await other.bots("owner"))[0]?.defaultAvatar).toBe("pastel-fox");
    expect(randomInt).not.toHaveBeenCalled();
  } finally { await other.db.close(); }
});

it("retains every retired persisted default across retry, restart and rename", async () => {
  for (const id of RETIRED_BOT_AVATAR_IDS) {
    await store.db.run("INSERT INTO bots(id,name,secret_hash) VALUES(?,?,'fixture')", [id, id]);
    await store.db.run("INSERT INTO meta(key,value) VALUES(?,?)", [BOT_AVATAR_DEFAULT_PREFIX + id, id]);
    await store.db.transaction(() => assignNewBotAvatar(store.db, id));
  }
  await store.renameBot("owner", "pink-bunny", { name: "Still my avatar", expectedName: "pink-bunny" });
  await store.db.close(); store = await HubStore.open(directory);
  const bots = await store.bots("owner");
  for (const id of RETIRED_BOT_AVATAR_IDS) expect(bots.find(bot => bot.id === id)?.defaultAvatar).toBe(id);
  expect(randomInt).not.toHaveBeenCalled();
});
