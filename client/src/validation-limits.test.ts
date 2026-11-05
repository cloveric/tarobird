import { describe, expect, it } from "vitest";
import { z } from "zod";

// Keep this beside the client so it exercises the dependency Vite dedupes into
// the mobile bundle, independently of the Host's dependency installation.
describe("client validation resource limits", () => {
  const entries = z.array(z.object({ id: z.string(), text: z.string() })).max(10);

  it("rejects oversized input without accumulating an error for every field", () => {
    const result = entries.safeParse(Array.from({ length: 10_000 }, () => ({})));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({ code: "too_big", maximum: 10 });
    }
  });

  it("preserves valid content and reports field errors within the limit", () => {
    const input = [{ id: "one", text: "段落\n  缩进" }];
    expect(entries.parse(input)).toEqual(input);
    const result = entries.safeParse([{ id: 42, text: "text" }]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({ code: "invalid_type", path: [0, "id"] });
    }
  });
});
