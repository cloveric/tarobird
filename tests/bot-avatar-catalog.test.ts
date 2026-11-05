import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RETIRED_BOT_AVATAR_IDS } from "../src/client-protocol/bot-avatar-catalog.js";
import { BOT_AVATARS, SELECTABLE_BOT_AVATARS, BOT_AVATAR_LIBRARY, defaultBotAvatar, randomBotAvatar } from "../client/src/bot-avatar-catalog.js";

describe("Bot mascot identity", () => {
  it("keeps the published v2 mapping stable when names, clients or catalog additions change", () => {
    expect(defaultBotAvatar("alpha").id).toBe("vanilla-swirl");
    expect(defaultBotAvatar("client_0123456789abcdef01234567").id).toBe("rose-flower");
    expect(new Set(BOT_AVATARS.map((avatar) => avatar.id)).size).toBe(145);
    // Published before retirement: pin the historical 144 ordered IDs, including
    // the first 36 hash slots, so filtering/reordering them fails. Later
    // entries may only be appended.
    expect(createHash("sha256").update(BOT_AVATARS.slice(0, 144).map(avatar => avatar.id).join("\n")).digest("hex"))
      .toBe("550c3c958e3869b6ec252ea17c9729347fac9e6e9dc00a3de1bb5634d43ddc54");
    expect(BOT_AVATARS.slice(144).map(avatar => avatar.id)).toEqual(["pastel-phoenix"]);
    // Random creation ids supply the entropy; rendering consumes no randomness.
    const ids = Array.from({ length: 1_000 }, (_, index) => createHash("sha256").update(String(index)).digest("hex"));
    const first = ids.map((id) => defaultBotAvatar(id).id);
    expect(ids.map((id) => defaultBotAvatar(id).id)).toEqual(first);
    expect(new Set(first).size).toBe(36);
  });
  it("renders every assigned avatar and keeps legacy defaults for absent or unknown IDs", () => {
    for (const avatar of BOT_AVATARS) expect(defaultBotAvatar("alpha", avatar.id)).toBe(avatar);
    expect(defaultBotAvatar("alpha", "not-in-this-client")).toEqual(defaultBotAvatar("alpha"));
  });
  it("removes exactly the retired choices from both active pools without changing historical resources", () => {
    // The owner circled numbers in the 144-entry picker order of 2026-10-26.
    const displayed = [...BOT_AVATARS.slice(63, 144), ...BOT_AVATARS.slice(0, 63)];
    const circled = [73, 84, 85, 87, 92, 94, 98, 99, 100, 102, 110, 114, 121, 123, 124, 125, 126, 133, 137, 140, 141];
    expect(RETIRED_BOT_AVATAR_IDS).toEqual([...circled.map(number => displayed[number - 1]!.id), "mini-corgi", "mini-croissant"]);
    const retired = new Set<string>(RETIRED_BOT_AVATAR_IDS);
    expect(SELECTABLE_BOT_AVATARS).toHaveLength(122);
    expect(new Set(SELECTABLE_BOT_AVATARS.map(a => a.id)).size).toBe(122);
    expect(BOT_AVATAR_LIBRARY).toEqual([...BOT_AVATARS.slice(144), ...displayed].filter(a => !retired.has(a.id)));
    expect(BOT_AVATAR_LIBRARY[0]!.id).toBe("pastel-phoenix");
    expect(new Set(BOT_AVATAR_LIBRARY.map(a => a.id))).toEqual(new Set(SELECTABLE_BOT_AVATARS.map(a => a.id)));
    expect(SELECTABLE_BOT_AVATARS.some(a => a.id === "pastel-fox")).toBe(true);
    for (const avatar of BOT_AVATARS) expect(existsSync(new URL(`../client/src/assets/bot-mascots/${avatar.id}.webp`, import.meta.url))).toBe(true);
  });
  it("uses every active shuffle index and excludes both active and retired current selections safely", () => {
    let draw = 0;
    const random = vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(value => { (value as Uint32Array)[0] = draw; return value; });
    try {
      for (const current of [undefined, "pastel-fox", "mini-matcha", ...RETIRED_BOT_AVATAR_IDS]) {
        const expected = SELECTABLE_BOT_AVATARS.filter(a => a.id !== current);
        for (draw = 0; draw < expected.length; draw++) expect(randomBotAvatar(current)).toBe(expected[draw]);
        draw = 0xffffffff;
        expect(expected).toContain(randomBotAvatar(current));
      }
    } finally { random.mockRestore(); }
  });
  it("shuffle always changes the selection to another available mascot", () => {
    for (const current of BOT_AVATARS) {
      const next = randomBotAvatar(current.id);
      expect(next.id).not.toBe(current.id);
      expect(SELECTABLE_BOT_AVATARS).toContain(next);
    }
  });
});
