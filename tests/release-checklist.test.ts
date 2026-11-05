import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("release checklist", () => {
  it("defines independent product and forbids retired fleet release actions", async () => {
    const checklist = await readFile(path.join(process.cwd(), "docs/release-checklist.md"), "utf8");

    expect(checklist).toContain("GitHub Release");
    expect(checklist).toContain("Retired Telegram/Lark adapters are not shipped");
    expect(checklist).toContain("Do not restart old fleets or migrate their data");
    expect(checklist).toContain("never reinstall the retired SDK");
    expect(checklist).toContain("npm run pack:standalone");
    expect(checklist).toContain("Do not call a release complete");
    expect(checklist).toContain("external package-registry publishing");
  });

  it("keeps package metadata out of registry publishing", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      private?: boolean;
      bin?: Record<string, string>;
      files?: string[];
      publishConfig?: { access?: string };
    };

    expect(packageJson.private).toBe(true);
    expect(packageJson.bin).toEqual({ tarobot: "bin/tarobot.mjs", tarobird: "bin/tarobot.mjs" });
    expect(packageJson.files).toContain("bin");
    expect(packageJson.files).toContain("dist/src");
    expect(packageJson.files).not.toContain("adapters");
    expect(packageJson.publishConfig).toBeUndefined();
  });

  it("keeps package and lockfile release versions aligned", async () => {
    const [packageJson, packageLock] = await Promise.all([
      readFile(path.join(process.cwd(), "package.json"), "utf8").then((raw) => JSON.parse(raw) as { version?: string }),
      readFile(path.join(process.cwd(), "package-lock.json"), "utf8").then((raw) => JSON.parse(raw) as {
        version?: string;
        packages?: Record<string, { version?: string }>;
      }),
    ]);

    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages?.[""]?.version).toBe(packageJson.version);
  });
});
