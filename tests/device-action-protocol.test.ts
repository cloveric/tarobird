import { createPublicKey, verify } from "node:crypto";
import { expect, it } from "vitest";
import vector from "./fixtures/device-action-vector.json" with { type: "json" };
import networkVector from "./fixtures/device-network-action-vector.json" with { type: "json" };
import grantVector from "./fixtures/device-message-grant-vector.json" with { type: "json" };
import { boundDeviceActionStatement, deviceActionProofText, deviceActionStatementSchema, deviceActionSchema } from "../src/client-protocol/device-actions.js";

it("matches the desktop-native signing vector and verifies with Node Ed25519", () => {
  const statement = deviceActionStatementSchema.parse(vector.statement);
  expect(deviceActionProofText(statement)).toBe(vector.proofText);
  const key = createPublicKey({ key: Buffer.from(vector.publicKey, "base64"), type: "spki", format: "der" });
  expect(verify(null, Buffer.from(vector.proofText), key, Buffer.from(vector.signature, "base64"))).toBe(true);
  expect(verify(null, Buffer.from(vector.proofText.replace("device-action/v1", "device/v1")), key, Buffer.from(vector.signature, "base64"))).toBe(false);
});

it("binds the network mutation hash to the same strict native signing domain", () => {
  const statement = deviceActionStatementSchema.parse(networkVector.statement);
  expect(deviceActionProofText(statement)).toBe(networkVector.proofText);
  const key = createPublicKey({ key: Buffer.from(networkVector.publicKey, "base64"), type: "spki", format: "der" });
  expect(verify(null, Buffer.from(networkVector.proofText), key, Buffer.from(networkVector.signature, "base64"))).toBe(true);
  expect(boundDeviceActionStatement(statement, statement)).toEqual(statement);
  expect(() => boundDeviceActionStatement(statement, { ...statement, action: { operation: "network", target: "a".repeat(64) } })).toThrow("device_action_invalid");
  expect(verify(null, Buffer.from(deviceActionProofText({ ...statement, action: { operation: "network", target: "a".repeat(64) } })), key, Buffer.from(networkVector.signature, "base64"))).toBe(false);
});

it("verifies the native message grant proof and rejects a substituted operation", () => {
  const statement = deviceActionStatementSchema.parse(grantVector.statement);
  expect(deviceActionProofText(statement)).toBe(grantVector.proofText);
  const key = createPublicKey({ key: Buffer.from(grantVector.publicKey, "base64"), type: "spki", format: "der" });
  expect(verify(null, Buffer.from(grantVector.proofText), key, Buffer.from(grantVector.signature, "base64"))).toBe(true);
  expect(verify(null, Buffer.from(deviceActionProofText({...statement,action:{...statement.action,operation:"network"}})), key, Buffer.from(grantVector.signature, "base64"))).toBe(false);
});

it.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "device_target", "a".repeat(64) + "\n"])("rejects malformed network mutation hashes: %s", (target) => {
  expect(deviceActionSchema.safeParse({ operation: "network", target }).success).toBe(false);
});

it.each(["hubPublicKey", "deviceId", "sessionHash", "operation", "target"])("refuses substituted %s before a device key is used", (field) => {
  const statement = deviceActionStatementSchema.parse(vector.statement);
  const expected = { hubPublicKey: statement.hubPublicKey, deviceId: statement.deviceId, sessionHash: statement.sessionHash, action: statement.action };
  expect(boundDeviceActionStatement(statement, expected)).toEqual(statement);
  const raw = structuredClone(statement);
  if (field === "operation") raw.action = { operation: "revoke", target: statement.action.target };
  else if (field === "target") raw.action.target = "12345678";
  else if (field === "hubPublicKey") raw.hubPublicKey = "A".repeat(59) + "=";
  else if (field === "sessionHash") raw.sessionHash = "0".repeat(64);
  else raw.deviceId = "other_device";
  expect(() => boundDeviceActionStatement(raw, expected)).toThrow("device_action_invalid");
});
