import { describe, expect, it } from "vitest";
import { designSystemInstall } from "../src/workbench-design-system.js";
import { applyDesignFiles, decodeDesignFile, designTextFile, emptyDesignDocument, validateDesignDocument, type DesignDocument } from "../src/workbench-design.js";

const identity = { scope: JSON.stringify(["private-hub-key", "private-user-id", "private-conversation-id"]), id: "brand", title: "Brand" };
const read = (file: { base64: string }) => new TextDecoder().decode(decodeDesignFile(file));
const metaPath = "project/ds/system-brand/tarobot-source.json";
const brandDocument = () => validateDesignDocument({ schema: 1, id: "brand", format: "design-system", revision: 0, receipts: [], files: {
  "project/README.md": designTextFile("# Brand\n"), "project/tokens.json": designTextFile("{}", "application/json"),
} });

describe("portable design system provenance and assets", () => {
  it.each(["canvas", "slides"] as const)("keeps local routing identities out of copied %s project files", format => {
    const source = brandDocument(), target = emptyDesignDocument("target", "Target", format);
    const installed = applyDesignFiles(target, designSystemInstall(target, source, identity));
    const meta = JSON.parse(read(installed.files[metaPath]!));
    expect(meta).toMatchObject({ schema: 2, sourceRef: expect.stringMatching(/^[a-f0-9]{64}$/), title: "Brand" });
    expect(meta).not.toHaveProperty("scope"); expect(meta).not.toHaveProperty("id");
    const project = Object.values(installed.files).map(read).join("\n");
    for (const privatePart of [identity.scope, encodeURIComponent(identity.scope), "private-hub-key", "private-user-id", "private-conversation-id"]) expect(project).not.toContain(privatePart);
    const synced = applyDesignFiles(installed, designSystemInstall(installed, { ...source, revision: 1 }, identity));
    expect(JSON.parse(read(synced.files[metaPath]!)).sourceRef).toBe(meta.sourceRef);
    expect(() => designSystemInstall(installed, source, { ...identity, scope: "another-host" })).toThrow("design_system_namespace_conflict");
  });

  it("writes asset references that resolve from nested HTML and CSS without duplicating the project directory", () => {
    const source = brandDocument(), asset = designTextFile('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red"/></svg>', "image/svg+xml"), id = asset.sha256.slice(0, 32);
    source.files[`project/assets/${id}`] = asset;
    source.files["project/Logo.dc.html"] = designTextFile(`<img src="/_blob/${id}"><img src="./_blob/${id}">`, "text/html");
    source.files["project/theme.css"] = designTextFile(`.logo{background-image:url(_blob/${id})}`, "text/css");
    const target = emptyDesignDocument("target", "Target", "canvas"), installed = applyDesignFiles(target, designSystemInstall(target, source, identity));
    const expected = `/project/ds/system-brand/assets/${id}`;
    expect(read(installed.files["project/ds/system-brand/Logo.dc.html"]!)).toBe(`<img src="${expected}"><img src="${expected}">`);
    expect(read(installed.files["project/ds/system-brand/theme.css"]!)).toContain(`url(${expected})`);
    expect(new URL(expected, "https://design.invalid/project/ds/system-brand/Logo.dc.html").pathname).toBe(expected);
    expect(installed.files[expected.slice(1)]).toEqual(asset);
  });

  it("migrates a matching legacy copy on sync without accepting another source or losing local edits", () => {
    const source = brandDocument(), target = emptyDesignDocument("target", "Target", "canvas");
    const installed = applyDesignFiles(target, designSystemInstall(target, source, identity));
    const hashes = JSON.parse(read(installed.files[metaPath]!)).hashes;
    const index = JSON.parse(read(installed.files["project/canvas.json"]!));
    index.designSystems[0].artifact = `tarobot-design:${encodeURIComponent(identity.scope)}/${identity.id}`;
    const legacy: DesignDocument = { ...installed, files: { ...installed.files,
      [metaPath]: designTextFile(JSON.stringify({ schema: 1, ...identity, revision: 0, hashes }), "application/json"),
      "project/canvas.json": designTextFile(JSON.stringify(index), "application/json"),
    } };
    const migrated = applyDesignFiles(legacy, designSystemInstall(legacy, { ...source, revision: 1 }, identity));
    expect(JSON.parse(read(migrated.files[metaPath]!))).toMatchObject({ schema: 2, revision: 1 });
    expect(Object.values(migrated.files).map(read).join("\n")).not.toContain("private-hub-key");
    expect(() => designSystemInstall(legacy, source, { ...identity, scope: "another-host" })).toThrow("design_system_namespace_conflict");
    const edited = { ...legacy, files: { ...legacy.files, "project/ds/system-brand/README.md": designTextFile("My local edit") } };
    expect(() => designSystemInstall(edited, source, identity)).toThrow("design_system_local_changes");
  });
});
