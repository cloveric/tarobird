import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Workbench editor and authoring resource provenance", () => {
  it("workbench-slides pins Apache-2.0 Open Artifact slides editor with intact LICENSE, NOTICE and file hashes", () => {
    expect(existsSync("client/vendor/baoyu-slides")).toBe(false);
    expect(existsSync("skills/baoyu-ppt")).toBe(false);
    // The Baoyu Design canvas and its skill went in #89: no Baoyu editor or skill is carried any more.
    expect(existsSync("client/vendor/baoyu-design")).toBe(false);
    expect(existsSync("skills/baoyu-design")).toBe(false);
    const vendor = join("client/vendor", "workbench-slides");
    const pin = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
    expect(pin.license).toBe("Apache-2.0");
    expect(pin.repository).toBe("https://github.com/JimLiu/open-artifact");
    expect(pin.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(readFileSync(join(vendor, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(vendor, "NOTICE"), "utf8")).toContain("Apache License, Version 2.0");
    for (const [name, expected] of Object.entries<string>(pin.files)) {
      const digest = createHash("sha256").update(readFileSync(join(vendor, name))).digest("hex");
      expect(digest).toBe(expected);
    }
  });

  it("keeps the pinned bundle out of Git's line-ending conversion, so its hashes hold on a Windows checkout", () => {
    // With `* text=auto` alone, core.autocrlf=true rewrites the bundle's JS, CSS, HTML, LICENSE and NOTICE on
    // checkout, and the build then stops at design_upstream_changed.
    const rule = readFileSync(".gitattributes", "utf8").split(/\r?\n/).find(line => line.startsWith("client/vendor/workbench-slides/** "));
    expect(rule?.split(/\s+/)).toContain("-text");
  });
});
