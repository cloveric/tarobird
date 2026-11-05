import { expect, it } from "vitest";
import { voiceThresholdSeconds } from "../src/voice-settings-threshold.js";

it("round-trips every supported whole-second policy through minutes", () => {
  for (let seconds = 60; seconds <= 7200; seconds++) {
    expect(voiceThresholdSeconds(String(seconds / 60))).toBe(seconds);
  }
});

it("does not round actual fractional-second inputs into valid policies", () => {
  for (const minutes of ["1.001", "1.01", "99.123"]) expect(Number.isInteger(voiceThresholdSeconds(minutes))).toBe(false);
  expect(voiceThresholdSeconds("1.5")).toBe(90);
  expect(voiceThresholdSeconds("bad")).toBeNaN();
  expect(voiceThresholdSeconds("Infinity")).toBe(Infinity);
  expect(voiceThresholdSeconds("")).toBe(0);
});
