import { describe, expect, it } from "vitest";

import { redactCoreSensitiveText } from "../src/core/redaction.js";

describe("redactCoreSensitiveText", () => {
  it("redacts credentials from env-style and JSON-style error details", () => {
    const redacted = redactCoreSensitiveText(
      'failed with LARK_APP_SECRET=env-secret "client_secret":"json-secret" access_token: token-secret Authorization: Bearer bearer-secret',
    );

    expect(redacted).not.toContain("env-secret");
    expect(redacted).not.toContain("json-secret");
    expect(redacted).not.toContain("token-secret");
    expect(redacted).not.toContain("bearer-secret");
    expect(redacted).toContain("LARK_APP_SECRET=[redacted]");
    expect(redacted).toContain('"client_secret":"[redacted]"');
    expect(redacted).toContain("access_token: [redacted]");
    expect(redacted).toContain("Authorization: Bearer [redacted]");
  });
});
