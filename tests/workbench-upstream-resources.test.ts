import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Workbench editor and authoring resource provenance", () => {
  for (const [editor, skill] of [["baoyu-design", "baoyu-design"], ["baoyu-slides", "baoyu-ppt"]]) {
    it(`${skill} carries the exact references for its bundled editor`, () => {
      const vendor = join("client/vendor", editor), adapted = join("skills", skill);
      const editorPin = JSON.parse(readFileSync(join(vendor, "UPSTREAM.json"), "utf8"));
      const skillPin = JSON.parse(readFileSync(join(adapted, "UPSTREAM.json"), "utf8"));
      for (const key of ["repository", "commit", "version", "component"]) expect(skillPin[key]).toBe(editorPin[key]);
      const references = readdirSync(join(adapted, "references")).sort();
      expect(references).toEqual(readdirSync(join(vendor, "reference")).sort());
      for (const name of references) {
        const bytes = readFileSync(join(adapted, "references", name));
        expect(bytes).toEqual(readFileSync(join(vendor, "reference", name)));
        const digest = createHash("sha256").update(bytes).digest("hex");
        expect(digest).toBe(skillPin.upstreamFiles[`artifact-type/reference/${name}`]);
        expect(digest).toBe(editorPin.files[`reference/${name}`]);
      }
      for (const name of ["LICENSE", "NOTICE.md"]) expect(readFileSync(join(adapted, name))).toEqual(readFileSync(join(vendor, name)));
      // Review helper provenance, but never install the standalone server into
      // the App skill: all writes stay on the existing target/revision bridge.
      expect(skillPin.upstreamFiles["scripts/artifact.mjs"]).toMatch(/^[a-f0-9]{64}$/);
      expect(skillPin.upstreamFiles["scripts/server.mjs"]).toMatch(/^[a-f0-9]{64}$/);
      expect(readdirSync(adapted)).not.toContain("scripts");
    });
  }
});
