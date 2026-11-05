import { mkdir, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import type { Dir, Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectFileInventory,
  revealFileInventoryUnit,
  updateFileInventoryLabel,
  type FileInventoryResult,
} from "../src/ui/file-inventory.js";
import { handleUiApiRequest } from "../src/ui/ui-api.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const temporaryRoots: string[] = [];

async function makeHome(): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "tarocub-files-ui-")));
  temporaryRoots.push(root);
  return root;
}

async function makeInstance(home: string, name: string, workspacePath?: string): Promise<string> {
  const stateDir = path.join(home, ".cctb", name);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "config.json"), JSON.stringify({
    engine: "codex",
    ...(workspacePath ? { workspacePath } : {}),
  }), "utf8");
  return stateDir;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("file inventory scanner", () => {
  it("labels App working directories without losing legacy paths, IDs or annotations", async () => {
    const home = await makeHome(), stateDir = await makeInstance(home, "GG1"), workspace = path.join(stateDir, "workspace");
    const names = { ".tarobot-files": "收到的附件", ".tarobot-out": "生成文件", ".lark-files": "收到的附件（旧目录）", ".lark-out": "生成文件（旧目录）", ".telegram-files": "收到的附件（旧目录）", ".telegram-out": "生成文件（旧目录）" };
    for (const name of Object.keys(names)) {
      const dir = path.join(workspace, name); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "example.txt"), "preserved");
    }
    const options = { instances: [{ name: "GG1", stateDir }], labels: {} };
    const result = await collectFileInventory({ HOME: home }, options);
    expect(result.units).toHaveLength(Object.keys(names).length);
    for (const unit of result.units) {
      expect(unit.name).toBe(names[unit.relativePath as keyof typeof names]);
      expect(unit).toMatchObject({ category: "temporary", fileCount: 1, instances: ["GG1"] });
      expect(await readFile(path.join(unit.absolutePath, "example.txt"), "utf8")).toBe("preserved");
    }
    const legacy = result.units.find(unit => unit.relativePath === ".lark-files")!;
    const { createHash } = await import("node:crypto");
    expect(legacy.id).toBe(createHash("sha256").update(legacy.absolutePath).digest("hex").slice(0, 24));
    const labeled = await collectFileInventory({ HOME: home }, { ...options, labels: { [legacy.id]: { important: true, note: "Keep this", updatedAt: new Date().toISOString() } } });
    expect(labeled.units.find(unit => unit.id === legacy.id)).toMatchObject({ important: true, note: "Keep this", absolutePath: legacy.absolutePath });
  });

  it("stops root enumeration immediately on cancellation and closes the directory handle", async () => {
    const home = await makeHome(), workspace = path.join(home, "wide-workspace");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const stateDir = await makeInstance(home, "fixture", workspace);
    await Promise.all(Array.from({ length: 64 }, (_, i) => writeFile(path.join(workspace, `${i}.txt`), "fixture")));
    const controller = new AbortController();
    const { opendir: openDirectory } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let visited = 0, handle: Dir | undefined;
    const spy = vi.mocked(fsPromises.opendir).mockImplementation(async (...args) => {
      const directory = await openDirectory(...args);
      if (String(args[0]) === canonicalWorkspace) {
        handle = directory;
        const entries = directory[Symbol.asyncIterator].bind(directory);
        directory[Symbol.asyncIterator] = async function* (): AsyncGenerator<Dirent<string>, undefined> {
          for await (const entry of entries()) {
            visited++;
            if (visited === 1) controller.abort();
            yield entry;
          }
          return undefined;
        };
      }
      return directory;
    });
    try {
      await expect(collectFileInventory({ HOME: home }, { instances: [{ name: "fixture", stateDir }], signal: controller.signal, labels: {} })).rejects.toMatchObject({ name: "AbortError" });
      expect(visited).toBe(1);
      await expect(handle!.read()).rejects.toMatchObject({ code: "ERR_DIR_CLOSED" });
    } finally { spy.mockImplementation(openDirectory); }
  });
  it("groups workspace entries into understandable units without following symlinks", async () => {
    const home = await makeHome();
    const sharedWorkspace = path.join(home, "shared-workspace");
    await mkdir(path.join(sharedWorkspace, "chrome-profile", "Default"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, "chrome-profile", "Local State"), "state", "utf8");
    await writeFile(path.join(sharedWorkspace, "chrome-profile", "Default", "Cookies"), "cookies", "utf8");

    await mkdir(path.join(sharedWorkspace, "finance-project"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, "finance-project", "package.json"), "{}", "utf8");
    await writeFile(path.join(sharedWorkspace, "finance-project", "model.xlsx"), Buffer.alloc(8_192, 1));
    await mkdir(path.join(sharedWorkspace, "finance-project", ".venv"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, "finance-project", ".venv", "pyvenv.cfg"), "home=/tmp", "utf8");
    await mkdir(path.join(sharedWorkspace, "finance-project", "browser-cache", "Default"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, "finance-project", "browser-cache", "Default", "Cookies"), "cookies", "utf8");

    await mkdir(path.join(sharedWorkspace, ".astro-venv", "lib", "package"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, ".astro-venv", "pyvenv.cfg"), "home=/tmp", "utf8");
    await writeFile(path.join(sharedWorkspace, ".astro-venv", "lib", "package", "test.key"), "not-a-user-key", "utf8");

    await mkdir(path.join(sharedWorkspace, "tmp", "embedded-project"), { recursive: true });
    await writeFile(path.join(sharedWorkspace, "tmp", "embedded-project", "package.json"), "{}", "utf8");

    await writeFile(path.join(sharedWorkspace, "loose-report.pdf"), Buffer.alloc(2_048, 4));
    await writeFile(path.join(sharedWorkspace, "loose-image.png"), Buffer.alloc(1_024, 5));
    await writeFile(path.join(sharedWorkspace, "README"), "workspace notes", "utf8");

    const outside = path.join(home, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "must-not-be-counted.bin"), Buffer.alloc(32_768, 2));
    await symlink(outside, path.join(sharedWorkspace, "outside-link"));

    const firstStateDir = await makeInstance(home, "ccfcc1", sharedWorkspace);
    await makeInstance(home, "ccfcc2", sharedWorkspace);
    await mkdir(path.join(firstStateDir, "inbox"), { recursive: true });
    await writeFile(path.join(firstStateDir, "inbox", "attachment.pdf"), Buffer.alloc(4_096, 3));

    const inventory = await collectFileInventory({ HOME: home }, { isProcessAlive: () => false });
    const chrome = inventory.units.find((unit) => unit.name === "chrome-profile");
    const project = inventory.units.find((unit) => unit.name === "finance-project");
    const environment = inventory.units.find((unit) => unit.name === ".astro-venv");
    const linked = inventory.units.find((unit) => unit.name === "outside-link");
    const inbox = inventory.units.find((unit) => unit.rootKind === "inbox");
    const temporary = inventory.units.find((unit) => unit.name === "tmp");
    const documents = inventory.units.find((unit) => unit.name === "根目录散落文档");
    const images = inventory.units.find((unit) => unit.name === "根目录散落图片");
    const otherFiles = inventory.units.find((unit) => unit.name === "根目录其他散落文件");

    expect(chrome).toMatchObject({
      category: "browser",
      safety: "protected",
      instances: ["ccfcc1", "ccfcc2"],
    });
    expect(project).toMatchObject({ category: "project", fileCount: 4 });
    expect(environment).toMatchObject({ category: "environment" });
    expect(environment?.safety).not.toBe("protected");
    expect(temporary).toMatchObject({ category: "temporary" });
    expect(documents).toMatchObject({ kind: "collection", category: "deliverable", fileCount: 1 });
    expect(images).toMatchObject({ kind: "collection", category: "deliverable", fileCount: 1 });
    expect(otherFiles).toMatchObject({
      kind: "collection",
      category: "unknown",
      relativePath: "根目录散落文件/其他",
      fileCount: 1,
    });
    expect(inventory.units.some((unit) => unit.name === "loose-report.pdf")).toBe(false);
    expect(linked).toMatchObject({ kind: "symlink", symlinkCount: 1, fileCount: 0 });
    expect(linked!.allocatedBytes).toBeLessThan(32_768);
    expect(inbox).toMatchObject({ category: "download", origin: "bridge-input", instances: ["ccfcc1"] });
    expect(inventory.totalAllocatedBytes).toBeGreaterThan(0);
    expect(inventory.byCategory.find((bucket) => bucket.key === "browser")?.allocatedBytes).toBeGreaterThan(0);
  });

  it("stores user labels outside the workspace and applies them on the next scan", async () => {
    const home = await makeHome();
    const stateDir = await makeInstance(home, "ccfgg1");
    const project = path.join(stateDir, "workspace", "old-analysis");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "notes.txt"), "research", "utf8");
    const old = new Date("2024-01-01T00:00:00Z");
    await utimes(path.join(project, "notes.txt"), old, old);
    await utimes(project, old, old);

    const before = await collectFileInventory({ HOME: home }, { isProcessAlive: () => false });
    const unit = before.units.find((candidate) => candidate.name === "old-analysis")!;
    expect(unit.category).toBe("project");
    expect(unit.safety).toBe("review");

    await updateFileInventoryLabel({ HOME: home }, {
      unitId: unit.id,
      category: "source",
      important: true,
      note: "长期研究资料",
    });

    const after = await collectFileInventory({ HOME: home }, { isProcessAlive: () => false });
    expect(after.units.find((candidate) => candidate.id === unit.id)).toMatchObject({
      category: "source",
      categorySource: "user",
      safety: "important",
      important: true,
      note: "长期研究资料",
    });
    const saved = JSON.parse(await readFile(path.join(home, ".cctb", "file-inventory-labels.json"), "utf8"));
    expect(saved.units[unit.id]).toMatchObject({ category: "source", important: true });
    await expect(readFile(path.join(project, ".tarocub-metadata.json"), "utf8")).rejects.toThrow();
  });

  it("reveals only a currently indexed unit id", async () => {
    const home = await makeHome();
    const stateDir = await makeInstance(home, "ccfgg3");
    const output = path.join(stateDir, "workspace", "outputs");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "report.pdf"), "pdf", "utf8");
    const inventory = await collectFileInventory({ HOME: home }, { isProcessAlive: () => false });
    const unit = inventory.units.find((candidate) => candidate.name === "outputs")!;
    let revealed = "";

    expect(await revealFileInventoryUnit({ HOME: home }, unit.id, {
      isProcessAlive: () => false,
      reveal: (absolutePath) => { revealed = absolutePath; },
    })).toBe(true);
    expect(revealed).toBe(await realpath(output));
    expect(await revealFileInventoryUnit({ HOME: home }, "0".repeat(24), {
      isProcessAlive: () => false,
      reveal: () => { throw new Error("must not reveal an unknown id"); },
    })).toBe(false);
  });
});

describe("file inventory UI API", () => {
  it("exposes read-only inventory plus labels and Finder reveal, with no delete route", async () => {
    const inventory: FileInventoryResult = {
      generatedAt: new Date(0).toISOString(),
      totalAllocatedBytes: 123,
      totalLogicalBytes: 100,
      unitCount: 0,
      byCategory: [],
      bySafety: [],
      units: [],
      warnings: [],
    };
    let labelInput: unknown;
    let revealedId = "";
    let scanFails = false;
    const deps = {
      collectFileInventory: async () => {
        if (scanFails) throw new Error("scan unavailable");
        return inventory;
      },
      updateFileInventoryLabel: async (_env: unknown, input: unknown) => {
        labelInput = input;
        return { important: true, updatedAt: new Date(0).toISOString() };
      },
      revealFileInventoryUnit: async (_env: unknown, unitId: string) => {
        revealedId = unitId;
        return true;
      },
    };

    const get = await handleUiApiRequest("GET", "/api/files", undefined, {}, deps);
    expect(get).toEqual({ status: 200, json: inventory });

    const label = await handleUiApiRequest("POST", "/api/files/labels", {
      unitId: "a".repeat(24),
      important: true,
    }, {}, deps);
    expect(label.status).toBe(200);
    expect(labelInput).toMatchObject({ unitId: "a".repeat(24), important: true });
    expect(label.json).toMatchObject({ unitId: "a".repeat(24), inventory });

    scanFails = true;
    const savedWithoutRefresh = await handleUiApiRequest("PUT", "/api/files/labels", {
      unitId: "a".repeat(24),
      note: "keep the durable label",
    }, {}, deps);
    expect(savedWithoutRefresh).toMatchObject({
      status: 200,
      json: { unitId: "a".repeat(24), label: { important: true } },
    });
    scanFails = false;

    const reveal = await handleUiApiRequest("POST", "/api/files/reveal", {
      unitId: "b".repeat(24),
    }, {}, deps);
    expect(reveal.status).toBe(200);
    expect(revealedId).toBe("b".repeat(24));

    const remove = await handleUiApiRequest("POST", "/api/files/delete", {
      unitId: "b".repeat(24),
    }, {}, deps);
    expect(remove.status).toBe(404);
  });
});

it("preserves corrupt labels when a mutation is requested", async () => {
  const home = await makeHome(); await makeInstance(home, "fixture");
  const file = path.join(home, ".cctb", "file-inventory-labels.json"), bytes = "{broken labels";
  await writeFile(file, bytes);
  await expect(updateFileInventoryLabel({ HOME: home }, { unitId: "a".repeat(24), note: "new" })).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe(bytes);
});
