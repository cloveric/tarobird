import { expect, it } from "vitest";
import { redactSecrets } from "../src/runtime/secret-redaction.js";

it.each(["Basic Zml4dHVyZTpzZWNyZXQ=", "Instance alpha:fixture-secret", "basic abc123", "raw-credential"])("redacts the complete authorization value: %s", value => {
  for (const header of ["Authorization", "authorization", "Proxy-Authorization"]) {
    const text = `${header}: ${value}\r\nContent-Type: application/json\r\nX-Trace: 1`;
    expect(redactSecrets(text)).toBe(`${header}: [redacted]\r\nContent-Type: application/json\r\nX-Trace: 1`);
  }
});

it("keeps delimiters, adjacent diagnostics and Bearer compatibility", () => {
  expect(redactSecrets("Authorization: Basic abc, retry=1; next")).toBe("Authorization: [redacted], retry=1; next");
  expect(redactSecrets("Authorization: Bearer abc")).toBe("Authorization: Bearer [redacted]");
  expect(redactSecrets("Authorization:\r\nX-Trace: 1")).toBe("Authorization:\r\nX-Trace: 1");
  for (const text of ["Authorization: tok and more", "Authorization: Instance alpha:secret tail", "Authorization: Bearer abc"]) {
    expect(redactSecrets(redactSecrets(text))).toBe(redactSecrets(text));
  }
});

it("handles quoted auth values without invalidating JSON or consuming later fields", () => {
  const json = '{"authorization":"Basic fixture-secret","status":401}';
  expect(JSON.parse(redactSecrets(json))).toEqual({ authorization: "[redacted]", status: 401 });
  expect(redactSecrets("authorization: 'Instance alpha:fixture-secret', status: 401")).toBe("authorization: '[redacted]', status: 401");
});

it("scrubs pretty-printed, escaped and interrupted quoted auth diagnostics", () => {
  expect(JSON.parse(redactSecrets('{"Authorization" : "Basic pretty-secret", "status":401}'))).toEqual({ Authorization: "[redacted]", status: 401 });
  for (const input of ['"Authorization":"Basic cut-secret', 'Authorization: "Basic cut-secret\nnext diagnostic']) {
    expect(redactSecrets(input)).not.toContain("cut-secret");
  }
  const escaped = String.raw`{\"authorization\":\"Basic escaped-secret\",\"status\":401}`;
  expect(redactSecrets(escaped)).toBe(String.raw`{\"authorization\":\"[redacted]\",\"status\":401}`);
  expect(redactSecrets(String.raw`\"authorization\":\"Basic cut-secret`)).not.toContain("cut-secret");
  expect(redactSecrets(String.raw`\"Proxy-Authorization\":\"Basic proxy-secret\"`)).not.toContain("proxy-secret");
  expect(redactSecrets(String.raw`\"token\":\"escaped-token\"`)).not.toContain("escaped-token");
});

it("redacts a quoted auth value cut off immediately after a backslash", () => {
  for (const suffix of ["", "\nnext diagnostic"]) {
    expect(redactSecrets('"Authorization":"Basic interrupted-secret\\' + suffix)).not.toContain("interrupted-secret");
  }
});
