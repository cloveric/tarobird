import { expect, it } from "vitest";
import { busFailureDetail, describeBusFailure } from "../src/bus/error-presentation.js";
import { BusProtocolError } from "../src/bus/bus-protocol.js";

it.each(["timeout", "connection_lost", "invalid_response", "response_too_large"])("retains the original %s diagnostic apart from its readable explanation", code => {
  const error = new BusProtocolError({ code, message: "Original detailed diagnostic", retryable: false });
  const recorded = busFailureDetail(error);
  expect(recorded).toBe(`[${code}] Original detailed diagnostic`);
  expect(describeBusFailure(recorded, "zh")).toBe(describeBusFailure(error, "zh"));
  expect(describeBusFailure(error, "zh")).toContain("未自动重发");
  expect(describeBusFailure(error, "en")).toBe("Original detailed diagnostic");
});
it("does not relabel unclassified engine failures", () => {
  const error = new Error("Engine diagnostic with useful detail");
  expect(busFailureDetail(error)).toBe(error.message);
  expect(describeBusFailure(error, "zh")).toBe(error.message);
});

it("explains durable unfinished-stage codes without exposing internal status tokens", () => {
  for (const code of ["agent_bus_interrupted", "agent_bus_stage_unfinished", "agent_bus_not_executed"]) {
    expect(describeBusFailure(code, "zh")).not.toContain("agent_bus_");
    expect(describeBusFailure(code, "zh")).toContain("未自动重发");
    expect(describeBusFailure(code, "en")).toBe(code);
  }
});

it("explains capacity exhaustion separately from connection loss", () => {
  const error = new BusProtocolError({ code: "server_busy", message: "Capacity exhausted", retryable: true });
  expect(describeBusFailure(error, "zh")).toContain("成员当前繁忙");
  expect(describeBusFailure(error, "en")).toBe("Capacity exhausted");
  expect(busFailureDetail(error)).toBe("[server_busy] Capacity exhausted");
});
