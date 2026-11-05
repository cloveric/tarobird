import { describe, expect, it } from "vitest";
import { workbenchDesignError } from "../src/client-protocol/workbench-design.js";
import { designCommentsReadSchema } from "../client/src/workbench-design-comments.js";

describe("Host and editor comment pagination", () => {
  it.each([
    { status: "all", offset: 20, limit: 20 },
    { threadId: "c_0123456789", messageOffset: 50, messageLimit: 50 },
  ])("allows the next page returned by the editor: %j", payload => {
    expect(designCommentsReadSchema.safeParse(payload).success).toBe(true);
    expect(workbenchDesignError({ operation: "design.comments.read", payload })).toBeUndefined();
  });
  it.each([{ offset: 501 }, { limit: 0 }, { messageOffset: 201 }, { messageLimit: 201 }, { author: "owner" }])("rejects out-of-bounds or extra fields: %j", payload => {
    expect(workbenchDesignError({ operation: "design.comments.read", payload })).toBe("invalid_design_payload");
  });
});
