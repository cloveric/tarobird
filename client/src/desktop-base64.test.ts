import { afterEach, expect, it } from "vitest";
import { encodeDesktopBytes } from "./desktop-base64.js";

const descriptor = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
afterEach(() => {
  if (descriptor) Object.defineProperty(Uint8Array.prototype, "toBase64", descriptor);
  else delete (Uint8Array.prototype as Uint8Array & { toBase64?: () => string }).toBase64;
});
const values = [0, 1, 2, 3, 255, 256, 257, 16383, 16384, 16385, 1024 * 1024 + 2];

it.skipIf(typeof descriptor?.value !== "function")("the actual runtime encoder preserves byte values and offset views", () => {
  for (const size of values) {
    const bytes = Uint8Array.from({ length: size + 11 }, (_, i) => i % 256).subarray(5, size + 5);
    expect(encodeDesktopBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  }
});

it("the compatibility encoder preserves all byte values, padding and view boundaries", () => {
  Object.defineProperty(Uint8Array.prototype, "toBase64", { value: undefined, configurable: true });
  for (const size of values) {
    const storage = Uint8Array.from({ length: size + 11 }, (_, i) => i % 256);
    const bytes = storage.subarray(5, size + 5);
    expect(encodeDesktopBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(Buffer.from(encodeDesktopBytes(bytes), "base64").equals(Buffer.from(bytes))).toBe(true);
  }
});

it("the native encoder receives the exact view as its receiver", () => {
  let receiver: Uint8Array | undefined;
  Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, value(this: Uint8Array) { receiver = this; return Buffer.from(this).toString("base64"); } });
  for (const size of values) {
    const bytes = Uint8Array.from({ length: size + 11 }, (_, i) => i % 256).subarray(5, size + 5);
    expect(encodeDesktopBytes(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(receiver).toBe(bytes);
  }
});

it("does not mask a runtime encoding failure or send partial data", () => {
  Object.defineProperty(Uint8Array.prototype, "toBase64", { configurable: true, value() { throw new Error("encoding failed"); } });
  expect(() => encodeDesktopBytes(new Uint8Array([1]))).toThrow("encoding failed");
});
