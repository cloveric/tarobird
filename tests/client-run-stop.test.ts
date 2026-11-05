import { expect, it } from "vitest";
import { STOP_CONFIRMATION_MS, stopOutcome } from "../client/src/run-stop.js";

const request = { receipt: { socket: 3, failures: 1 } };

it("keeps a request waiting only while its socket has reported nothing and the deadline is open", () => {
  expect(stopOutcome(request, { socket: 3, failures: 1 }, false)).toBe("waiting");
});

it("leaves a request unconfirmed after any later stop_incomplete, without claiming which Bot failed", () => {
  // The Hub's stop_incomplete has no request, run or Bot ID.
  expect(stopOutcome(request, { socket: 3, failures: 2 }, false)).toBe("unconfirmed");
  // The failure may be drained just before the socket is replaced.
  expect(stopOutcome(request, { socket: 4, failures: 2 }, false)).toBe("unconfirmed");
});

it("leaves a request unconfirmed after a reconnect or the confirmation deadline", () => {
  expect(stopOutcome(request, { socket: 4, failures: 1 }, false)).toBe("unconfirmed");
  expect(stopOutcome(request, { socket: 3, failures: 1 }, true)).toBe("unconfirmed");
});

it("bounds a run's reported stopping phase by the deadline, not by unrelated failures or reconnects", () => {
  const reported = {};
  expect(stopOutcome(reported, { socket: 3, failures: 1 }, false)).toBe("waiting");
  expect(stopOutcome(reported, { socket: 5, failures: 4 }, false)).toBe("waiting");
  // A cancellation the engine never completes must not lock the card.
  expect(stopOutcome(reported, { socket: 3, failures: 1 }, true)).toBe("unconfirmed");
});

it("waits longer than the Hub's 10s Bot stop deadline before calling a stop unconfirmed", () => {
  expect(STOP_CONFIRMATION_MS).toBeGreaterThan(10_000);
});
