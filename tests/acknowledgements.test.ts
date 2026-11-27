import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAcknowledgements,
  normalizeRepoUrl,
  runCli,
  updateLicensingMarkdown,
  type AcknowledgementEntry,
} from "../scripts/acknowledgements.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DIR_SYMLINK_TYPE: "junction" | "dir" = process.platform === "win32" ? "junction" : "dir";

function copyCuratedNotices(target: string): void {
  cpSync(path.join(REPO_ROOT, "third-party"), path.join(target, "third-party"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "client", "public", "licenses"), path.join(target, "client", "public", "licenses"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "client", "licenses"), path.join(target, "client", "licenses"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "client", "vendor"), path.join(target, "client", "vendor"), { recursive: true });
  cpSync(path.join(REPO_ROOT, "assets", "product", "fonts"), path.join(target, "assets", "product", "fonts"), { recursive: true });
  for (const license of [
    "deepseek-harness-plugin/LICENSE",
    "integrations/infinite-canvas/LICENSE",
    "integrations/infinite-canvas/notices/BUNDLED_DEPENDENCIES.txt",
    "LICENSING.md",
  ]) {
    cpSync(path.join(REPO_ROOT, license), path.join(target, license));
  }
}

function createIsolatedRepoCopy(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ack-check-"));
  copyCuratedNotices(tmp);
  cpSync(path.join(REPO_ROOT, "package.json"), path.join(tmp, "package.json"));
  cpSync(path.join(REPO_ROOT, "package-lock.json"), path.join(tmp, "package-lock.json"));
  cpSync(path.join(REPO_ROOT, "client", "package.json"), path.join(tmp, "client", "package.json"));
  cpSync(path.join(REPO_ROOT, "client", "package-lock.json"), path.join(tmp, "client", "package-lock.json"));
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(tmp, "node_modules"), DIR_SYMLINK_TYPE);
  symlinkSync(path.join(REPO_ROOT, "client", "node_modules"), path.join(tmp, "client", "node_modules"), DIR_SYMLINK_TYPE);
  return tmp;
}

describe("third-party acknowledgements manifest and build check", () => {
  it("loads all curated and transitive bundled npm entries with valid URLs and genuine full license texts", () => {
    const built = buildAcknowledgements(REPO_ROOT);
    expect(built.curatedCount).toBeGreaterThanOrEqual(40);
    // Must collect transitive runtime npm dependencies from lockfiles, not just direct dependencies.
    expect(built.npmCount).toBeGreaterThanOrEqual(400);
    expect(built.entries.length).toBe(built.curatedCount + built.npmCount);

    const byId = new Map<string, AcknowledgementEntry>();
    for (const entry of built.entries) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(byId.has(entry.id)).toBe(false);
      byId.set(entry.id, entry);
      expect(entry.name.trim().length).toBeGreaterThan(0);
      expect(entry.license.trim().length).toBeGreaterThan(0);
      expect(entry.licenseText.trim().length).toBeGreaterThan(0);
      // Every entry must carry a normalized http(s) URL without credentials.
      const parsed = new URL(entry.repository);
      expect(["http:", "https:"]).toContain(parsed.protocol);
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
    }

    // Coverage across all required categories: assets, vendored, npm, desktop, android, ios.
    const categories = new Set(built.entries.map((entry: AcknowledgementEntry) => entry.category));
    expect(categories).toEqual(new Set(["asset", "vendored", "npm", "desktop", "android", "ios"]));

    // JetBrains Mono records the font asset directory, not the license file path.
    expect(byId.get("jetbrains-mono")?.location).toBe("client/src/assets/fonts/jetbrains-mono/");

    // Previously omitted components are present: Lute, 8 Excalidraw fonts, Desktop Electron/Rust, Android cordova/slf4j-nop.
    for (const requiredId of [
      "lobehub-model-brand-icons",
      "pi-mark",
      "vditor-lute",
      "excalidraw-font-assistant",
      "excalidraw-font-cascadia",
      "excalidraw-font-comic-shanns",
      "excalidraw-font-excalifont",
      "excalidraw-font-lilita-one",
      "excalidraw-font-nunito",
      "excalidraw-font-virgil",
      "excalidraw-font-xiaolai",
      "desktop-electron",
      "desktop-rust-tauri",
      "desktop-rust-tokio",
      "desktop-rust-rustls",
      "desktop-rust-ring",
      "desktop-rust-ed25519-dalek",
      "desktop-rust-minisign-verify",
      "desktop-rust-serde",
      "desktop-rust-napi",
      "desktop-rust-apple-bindings",
      "desktop-rust-windows-rs",
      "android-okhttp",
      "android-slf4j-nop",
      "android-cordova-android",
      "ios-capacitor-swift-pm",
      "npm:react",
      "npm:@radix-ui/react-popover",
    ]) {
      expect(byId.has(requiredId), `Expected entry ${requiredId}`).toBe(true);
    }
    expect(byId.get("infinite-canvas")?.licenseText).toContain("Copyright (c) 2026 basketikun");
    const canvasDependencies = byId.get("infinite-canvas-dependencies")?.licenseText;
    for (const cssDependency of ["shadcn", "tailwindcss", "tw-animate-css"]) {
      expect(canvasDependencies).toContain(cssDependency + "@");
    }
    for (const id of ["quickjs-emscripten-core", "quickjs-ffi-types", "quickjs-singlefile-browser-release-sync"]) {
      expect(byId.get(id)).toMatchObject({ version: "0.32.0", license: "MIT" });
      expect(byId.get(id)?.licenseText).toContain("Jake Teton-Landis");
    }
    expect(byId.get("quickjs-singlefile-browser-release-sync")?.licenseText).toContain("Fabrice Bellard");

    // Multi-version transitive packages (e.g. pako 1.x + 2.x) are preserved with distinct name@version IDs.
    expect(built.entries.filter((entry: AcknowledgementEntry) => entry.name === "pako").length).toBeGreaterThanOrEqual(2);

    // Excalidraw and Tauri plugins carry real full license texts (not synthetic 4-line stubs or 3-line README notes).
    const excalidraw = byId.get("npm:@excalidraw/excalidraw");
    expect(excalidraw?.licenseText).toContain("Copyright (c) 2020 Excalidraw");
    expect(excalidraw?.licenseText).toContain("Permission is hereby granted");

    for (const plugin of ["autostart", "deep-link", "dialog", "fs", "global-shortcut", "notification", "opener", "updater"]) {
      const entry = byId.get(`npm:@tauri-apps/plugin-${plugin}`);
      expect(entry, `Missing @tauri-apps/plugin-${plugin}`).toBeDefined();
      expect(entry?.licenseText).toContain("Permission is hereby granted");
      expect(entry?.licenseText).toContain("Apache License");
    }

    // Shorthand npm repository specs normalize to full https://github.com/... URLs.
    expect(byId.get("npm:react-markdown")?.repository).toBe("https://github.com/remarkjs/react-markdown");
    expect(byId.get("npm:unified")?.repository).toBe("https://github.com/unifiedjs/unified");
    expect(byId.get("npm:yaml")?.repository).toBe("https://github.com/eemeli/yaml");
    expect(byId.get("npm:smol-toml")?.repository).toBe("https://github.com/squirrelchat/smol-toml");

    // Generic Apache-2.0 template and Android entries must not display SheetJS LLC's copyright notice.
    const apacheTemplate = readFileSync(path.join(REPO_ROOT, "third-party", "licenses", "apache-2.0.txt"), "utf8");
    expect(apacheTemplate).not.toMatch(/SheetJS/i);
    expect(apacheTemplate).toContain("Copyright [yyyy] [name of copyright owner]");
    for (const [id, expectedHolder] of [
      ["android-okhttp", "Square, Inc."],
      ["android-unifiedpush", "UnifiedPush"],
      ["android-firebase-messaging", "Google LLC"],
      ["android-androidx", "Android Open Source Project"],
      ["android-cordova-android", "Apache Software Foundation"],
    ] as const) {
      const entry = byId.get(id);
      expect(entry?.licenseText).not.toMatch(/SheetJS/i);
      expect(entry?.noticeText).toContain(expectedHolder);
    }

    expect(runCli(["check", "--root", REPO_ROOT])).toBe(0);
  });

  it("normalizes git, SSH, and npm shorthand repository URLs and rejects unsafe schemes", () => {
    expect(normalizeRepoUrl("remarkjs/react-markdown")).toBe("https://github.com/remarkjs/react-markdown");
    expect(normalizeRepoUrl("github:eemeli/yaml")).toBe("https://github.com/eemeli/yaml");
    expect(normalizeRepoUrl("gitlab:org/project")).toBe("https://gitlab.com/org/project");
    expect(normalizeRepoUrl("bitbucket:team/repo")).toBe("https://bitbucket.org/team/repo");
    expect(normalizeRepoUrl("git+ssh://git@github.com/Brightspace/node-ecdsa-sig-formatter.git")).toBe(
      "https://github.com/Brightspace/node-ecdsa-sig-formatter",
    );
    expect(normalizeRepoUrl("git@github.com:moxystudio/node-cross-spawn.git")).toBe(
      "https://github.com/moxystudio/node-cross-spawn",
    );
    expect(normalizeRepoUrl("git://github.com/beatgammit/base64-js.git")).toBe(
      "https://github.com/beatgammit/base64-js",
    );
    expect(normalizeRepoUrl("javascript:alert(1)")).toBe("");
    expect(normalizeRepoUrl("data:text/html,hello")).toBe("");
    expect(normalizeRepoUrl("https://user:pass@example.com/repo")).toBe("");
  });

  it("preserves Windows CRLF line endings in LICENSING.md during update and check", () => {
    const built = buildAcknowledgements(REPO_ROOT);
    const curated = built.entries.slice(0, built.curatedCount);
    const lfText = readFileSync(path.join(REPO_ROOT, "LICENSING.md"), "utf8").replace(/\r\n/g, "\n");
    const crlfText = lfText.replace(/\n/g, "\r\n");

    expect(updateLicensingMarkdown(lfText, curated)).toBe(lfText);
    expect(updateLicensingMarkdown(crlfText, curated)).toBe(crlfText);

    const tmp = createIsolatedRepoCopy();
    try {
      writeFileSync(path.join(tmp, "LICENSING.md"), crlfText, "utf8");
      expect(runCli(["check", "--root", tmp])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails the build check on missing/empty license files, polluted shared Apache template, or npm package without full license text", () => {
    const tmp = createIsolatedRepoCopy();
    try {
      // Baseline passes in the isolated copy.
      expect(runCli(["check", "--root", tmp])).toBe(0);

      // Removing a license text file makes the check throw / fail.
      const piLicense = path.join(tmp, "third-party", "licenses", "pi-mark.txt");
      const originalText = readFileSync(piLicense, "utf8");
      unlinkSync(piLicense);
      expect(() => runCli(["check", "--root", tmp])).toThrow(/Missing file for pi-mark\.licenseFile/);

      // Writing an empty license file also makes the check throw / fail.
      writeFileSync(piLicense, "   \n", "utf8");
      expect(() => runCli(["check", "--root", tmp])).toThrow(/Empty license\/notice text for pi-mark\.licenseFile/);

      // Restoring the license text restores a clean check.
      writeFileSync(piLicense, originalText, "utf8");
      expect(runCli(["check", "--root", tmp])).toBe(0);

      // Polluting the shared apache-2.0.txt template with an unrelated copyright holder fails the check.
      const apachePath = path.join(tmp, "third-party", "licenses", "apache-2.0.txt");
      const originalApache = readFileSync(apachePath, "utf8");
      writeFileSync(
        apachePath,
        originalApache.replace("Copyright [yyyy] [name of copyright owner]", "Copyright (C) 2012-present   SheetJS LLC"),
        "utf8",
      );
      expect(() => runCli(["check", "--root", tmp])).toThrow(/SheetJS|unrelated copyright/i);
      writeFileSync(apachePath, originalApache, "utf8");

      // An npm package with only a package.json license field / 2-line README / LICENSE.spdx fails instead of synthesizing a stub.
      const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "ack-npm-nolicense-"));
      try {
        copyCuratedNotices(fakeRoot);
        writeFileSync(path.join(fakeRoot, "package.json"), JSON.stringify({
          name: "fake-root",
          dependencies: { "stub-only-pkg": "1.0.0" },
        }));
        const pkgDir = path.join(fakeRoot, "node_modules", "stub-only-pkg");
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({
          name: "stub-only-pkg",
          version: "1.0.0",
          license: "MIT",
          repository: "example/stub-only-pkg",
        }));
        writeFileSync(path.join(pkgDir, "LICENSE.spdx"), "SPDXVersion: SPDX-2.1\nPackageLicenseDeclared: MIT\n");
        writeFileSync(path.join(pkgDir, "README.md"), "# stub-only-pkg\n\n## License\n\nMIT.\n");
        expect(() => buildAcknowledgements(fakeRoot)).toThrow(/stub-only-pkg@1\.0\.0.*missing full license text/i);
      } finally {
        rmSync(fakeRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
