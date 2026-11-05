import { expect, it } from "vitest";
import { pairingClockOffset, pairingRemaining } from "../src/pairing-time.js";

it.each([-600000, -120000, 0, 120000, 600000])("keeps the full server lifetime with a %d ms device clock skew, including after reload", skew => {
  const serverNow = Date.parse("2026-10-23T00:00:00Z"), localNow = serverNow + skew;
  const saved = JSON.parse(JSON.stringify({ expiresAt: serverNow + 300000, serverTimeOffset: pairingClockOffset(new Date(serverNow).toUTCString(), localNow) }));
  expect(pairingRemaining(saved.expiresAt, localNow, saved.serverTimeOffset)).toBe(300);
  expect(pairingRemaining(saved.expiresAt, localNow + 240000, saved.serverTimeOffset)).toBe(60);
  expect(pairingRemaining(saved.expiresAt, localNow + 300000, saved.serverTimeOffset)).toBe(0);
});
it("preserves legacy pending codes and handles missing or invalid Date headers", () => {
  expect(pairingClockOffset(null, 1000)).toBeUndefined();
  expect(pairingClockOffset("invalid", 1000)).toBeUndefined();
  expect(pairingRemaining(2000, 1000)).toBe(1);
  expect(pairingRemaining(2000, 3000)).toBe(0);
});
