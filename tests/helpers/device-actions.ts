import { sign, type KeyObject } from "node:crypto";
import { deviceActionProofText, deviceActionStatementSchema, type DeviceAction } from "../../src/client-protocol/device-actions.js";

export async function signedDeviceAction(url: string, token: string, key: KeyObject, action: DeviceAction) {
  const response = await fetch(url + "/api/devices/challenge", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(action) });
  if (!response.ok) throw new Error(`device_action_challenge_${response.status}`);
  const statement = deviceActionStatementSchema.parse(await response.json());
  const proof = { nonce: statement.nonce, signature: sign(null, Buffer.from(deviceActionProofText(statement)), key).toString("base64") };
  return { statement, proof, body: { ...(action.operation === "approve" ? { code: action.target } : { deviceId: action.target }), proof } };
}
