import { expect, it } from "vitest";
import { randomNonce } from "../src/identity.js";

it("generates the client challenge accepted by Android and iOS native signers", () => {
  const values = Array.from({ length: 64 }, () => randomNonce());
  for (const nonce of values) {
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
  }
  expect(new Set(values).size).toBe(values.length);
});
