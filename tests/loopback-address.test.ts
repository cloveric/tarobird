import { expect, it } from "vitest";
import { isLoopbackOrUnspecified } from "../src/client-protocol/loopback-address.js";
import { sharedRoutesSchema } from "../src/client-protocol/private-network.js";

it.each(["localhost", "x.localhost.", "127.10.2.3", "0.0.0.0", "::", "0:0:0:0:0:0:0:1", "::ffff:0.0.0.0", "[::ffff:0:0]", "::ffff:127.5.4.3", "0:0:0:0:0:ffff:7f00:1"])("rejects local/unspecified address %s", address => {
  expect(isLoopbackOrUnspecified(address)).toBe(true);
});
it.each(["192.168.1.2", "100.64.1.2", "::ffff:192.168.1.2", "2001:db8::1", "host.example"])("retains supported remote route %s", address => {
  expect(isLoopbackOrUnspecified(address)).toBe(false);
});
it("rejects mapped unspecified literals at signed route admission", () => {
  expect(sharedRoutesSchema.safeParse([{ name: "Direct", url: "https://[::ffff:0.0.0.0]:8788" }]).success).toBe(false);
});
